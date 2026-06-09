/**
 * Worker bootstrap source for Code Mode.
 *
 * This JS string runs in a `worker_threads` Worker created with `eval: true`
 * (CommonJS). It creates a `node:vm` context exposing:
 *
 *   - `tools.<name>(params)`  — bridged pi tools, resolved via postMessage RPC
 *   - `tools.try(name, params)` — non-throwing envelope variant
 *   - a small set of helpers (see SANDBOX_HELPER_NAMES)
 *   - `console.*` capture
 *
 * Tool calls are asynchronous postMessage round-trips, so `Promise.all` inside
 * the sandbox results in genuinely concurrent host-side execution. The host
 * enforces wall-clock timeout and abort by terminating the worker; this file
 * never needs to cooperate with cancellation.
 *
 * Protocol (worker -> host):
 *   { type: "log", level, text }
 *   { type: "call", id, tool, params }
 *   { type: "done", result }            // result is JSON-safe
 *   { type: "fail", error: { name?, message, stack? } }
 *
 * Protocol (host -> worker):
 *   { type: "call-result", id, ok: true, value }
 *   { type: "call-result", id, ok: false, error: { name?, message, stack? } }
 *
 * workerData: { code: string (plain JS body), toolNames: string[] }
 */

/** Helpers defined inside the sandbox, with the bridged tool each requires.
 * Single source of truth shared with stubs.ts (prompt docs) and tests. */
export const SANDBOX_HELPERS = [
	{ name: "lines", requires: undefined },
	{ name: "dedent", requires: undefined },
	{ name: "mapLimit", requires: undefined },
	{ name: "readJson", requires: "read" },
	{ name: "bashJson", requires: "bash" },
	{ name: "grepEntries", requires: "grep" },
] as const;

export const SANDBOX_HELPER_NAMES = SANDBOX_HELPERS.map((h) => h.name);

export const WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const util = require("node:util");

let nextCallId = 1;
const pending = new Map();

function send(message) {
	parentPort.postMessage(message);
}

function serializeError(error) {
	// Errors created inside the vm context are from a different realm, so
	// "instanceof Error" fails. Duck-type instead.
	if (error && typeof error === "object" && typeof error.message === "string") {
		return {
			name: typeof error.name === "string" ? error.name : undefined,
			message: error.message,
			stack: typeof error.stack === "string" ? error.stack : undefined,
		};
	}
	return { message: String(error) };
}

function jsonSafe(value) {
	if (value === undefined) return undefined;
	try {
		const text = JSON.stringify(value);
		return text === undefined ? undefined : JSON.parse(text);
	} catch (error) {
		throw new Error(
			"The returned value must be JSON-serializable (no circular references, BigInt, or class instances): " +
				(error && error.message ? error.message : String(error)),
		);
	}
}

function formatConsoleArg(arg) {
	if (typeof arg === "string") return arg.length > 10000 ? arg.slice(0, 10000) + "…[truncated]" : arg;
	return util.inspect(arg, { depth: 4, maxArrayLength: 50, maxStringLength: 2000, breakLength: 100 });
}

function makeConsole(level) {
	return (...args) => {
		const text = args.map(formatConsoleArg).join(" ");
		send({ type: "log", level, text: text.length > 20000 ? text.slice(0, 20000) + "…[truncated]" : text });
	};
}

function callTool(tool, params) {
	const id = nextCallId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ type: "call", id, tool, params: params === undefined ? {} : params });
	});
}

parentPort.on("message", (message) => {
	if (!message || message.type !== "call-result") return;
	const entry = pending.get(message.id);
	if (!entry) return;
	pending.delete(message.id);
	if (message.ok) {
		entry.resolve(message.value);
	} else {
		const error = new Error((message.error && message.error.message) || "Tool call failed");
		if (message.error && message.error.name) error.name = message.error.name;
		entry.reject(error);
	}
});

// ── tools API ─────────────────────────────────────────────────────────

const toolNames = Array.isArray(workerData.toolNames) ? workerData.toolNames : [];
const tools = {};
for (const name of toolNames) {
	tools[name] = (params) => callTool(name, params);
}
tools.try = async (name, params) => {
	if (!toolNames.includes(name)) {
		return { ok: false, error: "Unknown tool: " + String(name) + ". Available: " + toolNames.join(", ") };
	}
	try {
		const result = await callTool(name, params);
		if (result && typeof result === "object") return Object.assign({ ok: true }, result);
		return { ok: true, text: String(result ?? "") };
	} catch (error) {
		return { ok: false, error: error && error.message ? error.message : String(error) };
	}
};
Object.freeze(tools);

// ── helpers (keep in sync with SANDBOX_HELPER_NAMES) ──────────────────

function lines(text) {
	const normalized = String(text ?? "").replace(/\r/g, "");
	if (!normalized) return [];
	const result = normalized.split("\n");
	if (result.length > 0 && result[result.length - 1] === "") result.pop();
	return result;
}

function dedent(text) {
	const normalized = String(text ?? "").replace(/\r/g, "");
	const all = normalized.split("\n");
	while (all.length > 0 && all[0].trim() === "") all.shift();
	while (all.length > 0 && all[all.length - 1].trim() === "") all.pop();
	const indents = all.filter((line) => line.trim().length > 0).map((line) => (line.match(/^\s*/) || [""])[0].length);
	const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
	return all.map((line) => line.slice(minIndent)).join("\n");
}

async function mapLimit(items, limit, fn) {
	if (!Number.isInteger(limit) || limit <= 0) throw new Error("mapLimit limit must be a positive integer");
	const array = Array.from(items ?? []);
	const results = new Array(array.length);
	let nextIndex = 0;
	async function worker() {
		while (true) {
			const index = nextIndex++;
			if (index >= array.length) return;
			results[index] = await fn(array[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, array.length) }, () => worker()));
	return results;
}

function extractJson(text, sourceLabel) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) throw new Error("No JSON found in empty output" + (sourceLabel ? " from " + sourceLabel : ""));
	try {
		return JSON.parse(trimmed);
	} catch {
		// fall through to balanced-block extraction
	}
	for (let start = 0; start < trimmed.length; start++) {
		const first = trimmed[start];
		if (first !== "{" && first !== "[") continue;
		let depth = 0;
		let inString = false;
		let escaping = false;
		for (let i = start; i < trimmed.length; i++) {
			const ch = trimmed[i];
			if (inString) {
				if (escaping) escaping = false;
				else if (ch === "\\") escaping = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === "{" || ch === "[") depth++;
			if (ch === "}" || ch === "]") {
				depth--;
				if (depth === 0) {
					const candidate = trimmed.slice(start, i + 1);
					try {
						return JSON.parse(candidate);
					} catch {
						break;
					}
				}
			}
		}
	}
	throw new Error(
		"Could not parse JSON" +
			(sourceLabel ? " from " + sourceLabel : "") +
			":\n" +
			trimmed.slice(0, 500) +
			(trimmed.length > 500 ? "…" : ""),
	);
}

async function readJson(path) {
	const result = await tools.read({ path });
	return extractJson(result.text, path);
}

async function bashJson(params) {
	const input = typeof params === "string" ? { command: params } : params;
	const result = await tools.bash(input);
	return extractJson(result.text, "bash output");
}

async function grepEntries(params) {
	const result = await tools.grep(params);
	const entries = [];
	for (const line of lines(result.text)) {
		const match = /^(.*?):(\d+): (.*)$/.exec(line);
		if (match) entries.push({ path: match[1], line: Number(match[2]), text: match[3] });
	}
	return entries;
}

// ── vm context + execution ────────────────────────────────────────────

const contextGlobals = {
	tools,
	console: Object.freeze({
		log: makeConsole("log"),
		info: makeConsole("info"),
		warn: makeConsole("warn"),
		error: makeConsole("error"),
	}),
	setTimeout,
	clearTimeout,
	lines,
	dedent,
	mapLimit,
};
// Helpers that depend on a bridged tool exist only when that tool is bridged.
if (toolNames.includes("read")) contextGlobals.readJson = readJson;
if (toolNames.includes("bash")) contextGlobals.bashJson = bashJson;
if (toolNames.includes("grep")) contextGlobals.grepEntries = grepEntries;

const context = vm.createContext(contextGlobals);

(async () => {
	try {
		// lineOffset -1 makes the first line of user code report as line 1
		// in stack traces (filename "code-mode.ts").
		const script = new vm.Script("(async () => {\n" + workerData.code + "\n})()", {
			filename: "code-mode.ts",
			lineOffset: -1,
		});
		const value = await script.runInContext(context);
		send({ type: "done", result: jsonSafe(value) });
	} catch (error) {
		send({ type: "fail", error: serializeError(error) });
	}
})();
`;
