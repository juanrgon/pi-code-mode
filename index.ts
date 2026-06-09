/**
 * Code Mode extension for pi.
 *
 * Registers an `execute_typescript` tool: the LLM writes a TypeScript program
 * that composes pi's core tools (`tools.read`, `tools.bash`, ...) with loops,
 * conditionals, Promise.all, and data transformations.
 *
 * v2 architecture:
 * - worker_threads + node:vm sandbox with an async postMessage bridge, so
 *   bridged tool calls run truly concurrently (no native deps).
 * - Bridged tools delegate to pi's real tool implementations
 *   (create*ToolDefinition), inheriting truncation, the per-file mutation
 *   queue, and exact semantics.
 * - Abort/timeout terminate the worker and abort in-flight tools.
 * - Final output is truncated to pi's standard limits (full output saved to a
 *   temp file), with a per-call audit trail in details.
 *
 * Toggle: /code-mode (off | additive | replace) or Ctrl+Alt+C.
 * In replace mode the bridged built-in tools are hidden from the model and
 * only reachable through execute_typescript.
 *
 * Inspired by TanStack AI Code Mode; execution architecture informed by
 * Hor1zonZzz/pi-codeMode.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	formatSize,
	highlightCode,
	keyHint,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { runCode, DEFAULT_TIMEOUT_MS, type BridgeImage, type CallSummary, type RunOutcome, type ToolExecutor } from "./runner.js";
import { buildCodeModePrompt, type BridgedToolSchema } from "./stubs.js";

export const BRIDGED_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type BridgedToolName = (typeof BRIDGED_TOOL_NAMES)[number];
const MAX_RESULT_IMAGES = 3;

/** Loosely-typed view of pi's ToolDefinition to stay resilient across versions. */
interface BridgedDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	prepareArguments?: (args: unknown) => unknown;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown }>;
}

export function createBridgedDefinitions(cwd: string): Record<BridgedToolName, BridgedDefinition> {
	return {
		read: createReadToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	} as unknown as Record<BridgedToolName, BridgedDefinition>;
}

/**
 * Build runner executors that delegate to pi's real tool definitions.
 * Only tools in `allowed` are bridged (respects user-disabled tools).
 * Exported for tests so the test bridge cannot drift from the runtime bridge.
 */
export function createBridgedExecutors(
	defs: Record<BridgedToolName, BridgedDefinition>,
	ctx: ExtensionContext,
	idPrefix: string,
	allowed: readonly BridgedToolName[] = BRIDGED_TOOL_NAMES,
): Record<string, ToolExecutor> {
	let callSequence = 0;
	const executors: Record<string, ToolExecutor> = {};
	for (const name of allowed) {
		executors[name] = async (rawParams, toolSignal) => {
			const def = defs[name];
			const prepared = def.prepareArguments ? def.prepareArguments(rawParams) : rawParams;
			const result = await def.execute(`${idPrefix}#${++callSequence}`, prepared, toolSignal, undefined, ctx);
			const text = (result.content ?? [])
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n");
			const images: BridgeImage[] = (result.content ?? [])
				.filter((block) => block.type === "image" && typeof block.data === "string")
				.map((block) => ({ data: block.data as string, mimeType: (block.mimeType as string) ?? "image/png" }));
			return { value: toBridgeValue(name, text, result.details, images.length > 0), images };
		};
	}
	return executors;
}

/** Shape the bridged tool result into the sandbox-facing value (must match stubs.ts RESULT_EXTRAS). */
function toBridgeValue(
	tool: BridgedToolName,
	text: string,
	details: unknown,
	hasImages: boolean,
): Record<string, unknown> {
	const d = (details ?? {}) as {
		truncation?: { truncated?: boolean };
		fullOutputPath?: string;
		diff?: string;
		firstChangedLine?: number;
		matchLimitReached?: number;
		resultLimitReached?: number;
		entryLimitReached?: number;
	};
	const truncated = !!d.truncation?.truncated;
	switch (tool) {
		case "read":
			return { text, kind: hasImages ? "image" : "text", truncated };
		case "bash":
			return { text, truncated, fullOutputPath: d.fullOutputPath };
		case "edit":
			return { text, diff: d.diff ?? "", firstChangedLine: d.firstChangedLine };
		case "write":
			return { text };
		case "grep":
			return { text, truncated: truncated || d.matchLimitReached !== undefined };
		case "find":
			return { text, truncated: truncated || d.resultLimitReached !== undefined };
		case "ls":
			return { text, truncated: truncated || d.entryLimitReached !== undefined };
	}
}

/**
 * Format a run outcome into the LLM-facing text, applying pi's standard output
 * truncation (full output saved to a temp file). Exported for tests.
 */
export async function buildResultText(outcome: RunOutcome): Promise<{ text: string; truncated: boolean }> {
	const parts: string[] = [];
	if (outcome.console.length > 0) {
		parts.push("── console ──");
		parts.push(
			outcome.console
				.map((entry) => (entry.level === "log" || entry.level === "info" ? entry.text : `[${entry.level}] ${entry.text}`))
				.join("\n"),
		);
		if (outcome.consoleDropped > 0) {
			parts.push(`[console truncated: ${outcome.consoleDropped} more entr${outcome.consoleDropped === 1 ? "y" : "ies"} dropped]`);
		}
	}
	if (outcome.ok) {
		if (outcome.result !== undefined) {
			parts.push("── result ──");
			parts.push(typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result, null, 2));
		} else if (outcome.console.length === 0) {
			parts.push("(no output — end with a top-level `return`)");
		}
	} else {
		parts.push("── error ──");
		parts.push(outcome.errorText ?? "Unknown error");
	}

	const seconds = (outcome.durationMs / 1000).toFixed(1);
	const callCount = outcome.callsTotal;
	const statusLine = `${outcome.ok ? "✓" : "✗"} ${callCount} tool call${callCount === 1 ? "" : "s"} · ${seconds}s`;

	let text = parts.join("\n");
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (truncation.truncated) {
		const fullPath = join(tmpdir(), `pi-code-mode-${Date.now()}.txt`);
		await writeFile(fullPath, text, "utf-8").catch(() => undefined);
		text =
			truncation.content +
			`\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines` +
			` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${fullPath}]`;
	}

	const keptImages = outcome.images.slice(0, MAX_RESULT_IMAGES);
	if (outcome.imagesTotal > keptImages.length) {
		text += `\n[${outcome.imagesTotal - keptImages.length} additional image(s) omitted — read them directly with the read tool]`;
	}
	text += `\n\n${statusLine}`;
	return { text, truncated: truncation.truncated };
}

export default function codeModeExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let replace = false;
	/** Bridged tools hidden by replace mode (snapshot of what was active when replace was enabled). */
	let replaceHidden: BridgedToolName[] = [];
	const definitionsCache = new Map<string, Record<BridgedToolName, BridgedDefinition>>();
	const promptCache = new Map<string, string>();

	function definitionsFor(cwd: string): Record<BridgedToolName, BridgedDefinition> {
		let defs = definitionsCache.get(cwd);
		if (!defs) {
			defs = createBridgedDefinitions(cwd);
			definitionsCache.set(cwd, defs);
		}
		return defs;
	}

	function isBridged(name: string): name is BridgedToolName {
		return (BRIDGED_TOOL_NAMES as readonly string[]).includes(name);
	}

	/** Bridged tools that are currently active (respects tools the user disabled). */
	function activeBridged(): BridgedToolName[] {
		const active = new Set(pi.getActiveTools());
		return BRIDGED_TOOL_NAMES.filter((name) => active.has(name));
	}

	/**
	 * The bridged tools Code Mode may orchestrate right now. In additive mode
	 * this is the currently active bridged set (a tool the user disabled stays
	 * unavailable inside the sandbox too). In replace mode it is the snapshot
	 * taken when replace was enabled.
	 */
	function allowedBridged(): BridgedToolName[] {
		if (enabled && replace) return [...replaceHidden];
		return activeBridged();
	}

	function promptFor(cwd: string, allowed: BridgedToolName[]): string {
		const key = `${cwd}|${allowed.join(",")}`;
		let prompt = promptCache.get(key);
		if (!prompt) {
			const defs = definitionsFor(cwd);
			const schemas: BridgedToolSchema[] = allowed.map((name) => ({
				name,
				description: defs[name].description,
				parameters: defs[name].parameters,
			}));
			prompt = buildCodeModePrompt(schemas);
			promptCache.set(key, prompt);
		}
		return prompt;
	}

	// ── state, status, tool visibility ───────────────────────────────────

	function modeLabel(): string {
		if (!enabled) return "off";
		return replace ? "on (replace)" : "on";
	}

	function updateStatus(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;
		const hint = theme.fg("dim", " — /code-mode or Ctrl+Alt+C");
		ctx.ui.setStatus(
			"code-mode",
			enabled ? theme.fg("accent", `⚡ code mode ${modeLabel()}`) + hint : theme.fg("dim", "⚡ code mode off") + hint,
		);
	}

	/**
	 * Apply mode transitions to the active tool set:
	 * - entering replace: snapshot the active bridged tools and hide them
	 * - leaving replace: restore exactly that snapshot (nothing else)
	 * - enabled controls whether execute_typescript itself is active
	 * Tools the user disabled are never re-enabled by Code Mode.
	 */
	function applyMode(nextEnabled: boolean, nextReplace: boolean): void {
		const wasReplacing = enabled && replace;
		const willReplace = nextEnabled && nextReplace;

		if (wasReplacing && !willReplace) {
			const next = new Set(pi.getActiveTools());
			for (const name of replaceHidden) next.add(name);
			pi.setActiveTools([...next]);
			replaceHidden = [];
		} else if (!wasReplacing && willReplace) {
			replaceHidden = activeBridged();
			const hidden = new Set<string>(replaceHidden);
			pi.setActiveTools(pi.getActiveTools().filter((name) => !hidden.has(name)));
		}

		enabled = nextEnabled;
		replace = nextReplace;

		const active = new Set(pi.getActiveTools());
		if (enabled) active.add("execute_typescript");
		else active.delete("execute_typescript");
		pi.setActiveTools([...active]);
	}

	function persistState(): void {
		pi.appendEntry("code-mode-state", { enabled, replace, replaceHidden });
	}

	function setMode(ctx: ExtensionContext, nextEnabled: boolean, nextReplace: boolean): void {
		applyMode(nextEnabled, nextReplace);
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(`Code Mode: ${modeLabel()}`, "info");
	}

	pi.registerCommand("code-mode", {
		description: "Toggle Code Mode (off | additive | replace built-in tools)",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "replace"].filter((o) => o.startsWith(prefix));
			return options.length > 0 ? options.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "additive") return setMode(ctx, true, false);
			if (arg === "replace") return setMode(ctx, true, true);
			if (arg === "off") return setMode(ctx, false, replace);
			if (ctx.hasUI) {
				const choice = await ctx.ui.select("Code Mode", [
					"on — execute_typescript alongside the normal tools",
					"replace — hide bridged built-in tools, force Code Mode",
					"off",
				]);
				if (choice?.startsWith("on")) return setMode(ctx, true, false);
				if (choice?.startsWith("replace")) return setMode(ctx, true, true);
				if (choice === "off") return setMode(ctx, false, replace);
				return;
			}
			setMode(ctx, !enabled, replace);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("c"), {
		description: "Toggle Code Mode",
		handler: async (ctx) => setMode(ctx, !enabled, replace),
	});

	// ── the execute_typescript tool ──────────────────────────────────────

	pi.registerTool({
		name: "execute_typescript",
		label: "Execute TypeScript",
		description:
			"Execute a TypeScript program in a sandbox. The code orchestrates the bridged pi core " +
			"tools through the tools.* API documented in the Code Mode section of the system prompt " +
			"(same parameters and behavior as the normal tools), composes them with loops and " +
			"conditionals, runs independent calls in parallel via Promise.all, and does " +
			"math/aggregation in code. End with a top-level `return`; console.log output is captured.",
		promptSnippet:
			"Run TypeScript that composes the bridged core tools (tools.* API) with loops, parallelism, and aggregation",
		promptGuidelines: [
			"Use execute_typescript for multi-step work that needs loops, branching on tool results, or aggregation across many files.",
			"Inside execute_typescript, independent tools.* calls run concurrently — use Promise.all or mapLimit.",
			"Do not use execute_typescript for a single tool call; call the tool directly.",
		],
		parameters: Type.Object({
			code: Type.String({
				description:
					"TypeScript code. Call bridged tools via tools.<name>(params). End with a top-level `return` " +
					"producing a JSON-serializable result. console.log output is captured.",
			}),
		}),

		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const code = typeof args?.code === "string" ? args.code.replace(/\r\n?/g, "\n") : "";
			if (!code) {
				text.setText(theme.fg("dim", "⚡ TypeScript — receiving code…"));
				return text;
			}
			const highlighted = highlightCode(code, "typescript");
			const maxLines = context.expanded ? highlighted.length : 14;
			let body = highlighted.slice(0, maxLines).join("\n");
			if (highlighted.length > maxLines) {
				body +=
					"\n" +
					theme.fg("muted", `… ${highlighted.length - maxLines} more lines, `) +
					keyHint("app.tools.expand", "to expand");
			}
			text.setText(theme.fg("toolTitle", theme.bold("⚡ TypeScript")) + "\n" + body);
			return text;
		},

		renderResult(result, options, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const body = result.content?.find((block) => block.type === "text")?.text ?? "";
			const details = result.details as { calls?: CallSummary[] } | undefined;

			if (options.isPartial) {
				text.setText(theme.fg("dim", body || "running…"));
				return text;
			}

			const bodyLines = body.split("\n");
			const maxLines = options.expanded ? bodyLines.length : 10;
			let out = bodyLines.slice(0, maxLines).join("\n");
			if (bodyLines.length > maxLines) {
				out += "\n" + theme.fg("muted", `… ${bodyLines.length - maxLines} more lines, `) + keyHint("app.tools.expand", "to expand");
			}
			if (options.expanded && details?.calls?.length) {
				out += "\n\n" + theme.fg("muted", theme.bold("tool calls"));
				for (const call of details.calls) {
					const status = call.ok === false ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const duration = call.durationMs !== undefined ? theme.fg("dim", ` ${call.durationMs}ms`) : "";
					out += `\n${status} ${theme.fg("accent", call.tool)}${duration} ${theme.fg("dim", call.params)}`;
					if (call.error) out += `\n  ${theme.fg("error", call.error.split("\n")[0].slice(0, 120))}`;
				}
			}
			text.setText(out);
			return text;
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!enabled) {
				return {
					content: [{ type: "text", text: "Code Mode is disabled. Use /code-mode to enable it, then try again." }],
					details: { enabled: false },
				};
			}

			const defs = definitionsFor(ctx.cwd);
			const executors = createBridgedExecutors(defs, ctx, toolCallId, allowedBridged());

			onUpdate?.({ content: [{ type: "text", text: "⚡ running…" }], details: undefined });

			const outcome = await runCode({
				code: params.code,
				tools: executors,
				signal,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				onProgress: ({ callsStarted, callsFinished, lastTool }) => {
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `⚡ running… ${callsStarted} tool call${callsStarted === 1 ? "" : "s"} (${callsFinished} done${lastTool ? `, last: ${lastTool}` : ""})`,
							},
						],
						details: undefined,
					});
				},
			});

			// ── format the final output ──────────────────────────────────
			const { text, truncated } = await buildResultText(outcome);
			const images = outcome.images.slice(0, MAX_RESULT_IMAGES);

			const details = {
				ok: outcome.ok,
				durationMs: outcome.durationMs,
				timedOut: outcome.timedOut,
				aborted: outcome.aborted,
				truncated,
				consoleLines: outcome.console.length,
				calls: outcome.calls,
			};

			if (!outcome.ok) {
				throw new Error(text);
			}

			return {
				content: [
					{ type: "text", text },
					...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
				],
				details,
			};
		},
	});

	// ── system prompt injection (per turn, NOT a persistent message) ────

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		const allowed = allowedBridged();
		if (allowed.length === 0) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${promptFor(ctx.cwd, allowed)}`,
		};
	});

	// ── session lifecycle ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as {
				type: string;
				customType?: string;
				data?: { enabled?: boolean; replace?: boolean; replaceHidden?: string[] };
			};
			if (e.type === "custom" && e.customType === "code-mode-state") {
				enabled = e.data?.enabled ?? true;
				replace = e.data?.replace ?? false;
				replaceHidden = (e.data?.replaceHidden ?? []).filter(isBridged);
			}
		}
		// Re-apply the restored mode to the fresh tool state.
		if (enabled && replace) {
			if (replaceHidden.length === 0) replaceHidden = activeBridged();
			const hidden = new Set<string>(replaceHidden);
			const next = pi.getActiveTools().filter((name) => !hidden.has(name));
			if (!next.includes("execute_typescript")) next.push("execute_typescript");
			pi.setActiveTools(next);
		} else {
			const active = new Set(pi.getActiveTools());
			if (enabled) active.add("execute_typescript");
			else active.delete("execute_typescript");
			pi.setActiveTools([...active]);
		}
		updateStatus(ctx);
	});

	// On shutdown (quit/reload/session switch), restore tools hidden by replace
	// mode so the next runtime starts from the user's real tool set; the
	// persisted state re-hides them on session_start if replace is still on.
	pi.on("session_shutdown", async () => {
		if (enabled && replace && replaceHidden.length > 0) {
			const next = new Set(pi.getActiveTools());
			for (const name of replaceHidden) next.add(name);
			pi.setActiveTools([...next]);
		}
	});
}
