/**
 * Host-side Code Mode runner.
 *
 * - Strips TypeScript with esbuild (wrap in async fn so top-level return/await
 *   parse, then unwrap — approach borrowed from @tanstack/ai-code-mode).
 * - Spawns a worker_threads Worker (eval'd CommonJS source, memory-capped via
 *   resourceLimits) and bridges `tools.*` calls over an async postMessage RPC.
 *   Multiple bridged calls run concurrently on the host (bounded by
 *   maxConcurrentCalls), so Promise.all in the sandbox is truly parallel.
 * - Abort/timeout terminate the worker (kills even CPU-bound loops) and abort
 *   in-flight tool executions via a linked AbortController.
 * - Maps sandbox stack traces back to user code with a code frame.
 */
import { Worker } from "node:worker_threads";
import { transform } from "esbuild";
import { WORKER_SOURCE } from "./worker-source.js";

export interface BridgeImage {
	data: string;
	mimeType: string;
}

export interface ToolExecutorResult {
	/** JSON-safe value handed back to the sandbox (resolved value of tools.X()). */
	value: unknown;
	/** Image content produced by the tool (e.g. read on a png), collected for the final tool result. */
	images?: BridgeImage[];
}

export type ToolExecutor = (params: unknown, signal: AbortSignal | undefined) => Promise<ToolExecutorResult>;

export interface CallSummary {
	id: number;
	tool: string;
	/** JSON params preview, truncated. */
	params: string;
	durationMs?: number;
	ok?: boolean;
	error?: string;
}

export interface ConsoleEntry {
	level: "log" | "info" | "warn" | "error";
	text: string;
}

export interface RunOutcome {
	ok: boolean;
	/** JSON-safe value returned by the sandbox code (undefined if none). */
	result?: unknown;
	/** Formatted error text (with code frame when mappable). */
	errorText?: string;
	console: ConsoleEntry[];
	calls: CallSummary[];
	images: BridgeImage[];
	durationMs: number;
	timedOut: boolean;
	aborted: boolean;
}

export interface RunOptions {
	/** TypeScript (or JS) source. Top-level return/await allowed. */
	code: string;
	tools: Record<string, ToolExecutor>;
	signal?: AbortSignal;
	/** Wall-clock limit for the whole run. Default 120s. */
	timeoutMs?: number;
	/** Max bridged tool calls executing concurrently on the host. Default 8. */
	maxConcurrentCalls?: number;
	/** Worker heap cap in MB. Default 256. */
	memoryLimitMb?: number;
	onProgress?: (progress: { callsStarted: number; callsFinished: number; lastTool?: string }) => void;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_CONCURRENT_CALLS = 8;
export const DEFAULT_MEMORY_LIMIT_MB = 256;
const PARAMS_PREVIEW_CHARS = 200;

// ── TypeScript stripping ──────────────────────────────────────────────

const WRAPPER_FN = "___PI_CODE_MODE_WRAPPER___";
const WRAPPER_END = "___PI_CODE_MODE_END___";

export type StripResult = { ok: true; js: string } | { ok: false; errorText: string };

/**
 * Strip TypeScript syntax, preserving top-level `return` and `await`.
 */
export async function stripTypeScript(code: string): Promise<StripResult> {
	const normalized = code.replace(/\r\n?/g, "\n");
	const wrapped = `async function ${WRAPPER_FN}() {\n${normalized}\n}; ${WRAPPER_END}`;

	let transformed: string;
	try {
		const result = await transform(wrapped, {
			loader: "ts",
			minify: false,
			keepNames: false,
			target: "es2022",
		});
		transformed = result.code;
	} catch (error) {
		return { ok: false, errorText: formatTransformError(error, normalized) };
	}

	const fnStart = transformed.indexOf(`async function ${WRAPPER_FN}()`);
	const endMarker = transformed.indexOf(WRAPPER_END);
	if (fnStart === -1 || endMarker === -1) {
		return { ok: false, errorText: "TypeScript error: could not locate wrapper in transformed output" };
	}
	const openBrace = transformed.indexOf("{", fnStart);
	const body = transformed.substring(openBrace + 1, endMarker);
	const closingBrace = body.lastIndexOf("}");
	if (openBrace === -1 || closingBrace === -1) {
		return { ok: false, errorText: "TypeScript error: could not locate wrapper braces in transformed output" };
	}
	return { ok: true, js: body.substring(0, closingBrace).trim() };
}

function buildCodeFrame(source: string, line: number, column?: number, radius = 2): string {
	const sourceLines = source.replace(/\r/g, "").split("\n");
	if (line < 1 || line > sourceLines.length) return "";
	const start = Math.max(1, line - radius);
	const end = Math.min(sourceLines.length, line + radius);
	const width = String(end).length;
	const frame: string[] = [];
	for (let current = start; current <= end; current++) {
		const marker = current === line ? ">" : " ";
		frame.push(`${marker} ${String(current).padStart(width)} | ${sourceLines[current - 1]}`);
		if (current === line && column && column > 0) {
			frame.push(`  ${" ".repeat(width)} | ${" ".repeat(Math.max(0, column - 1))}^`);
		}
	}
	return frame.join("\n");
}

function formatTransformError(error: unknown, source: string): string {
	const errors =
		error && typeof error === "object" && "errors" in error && Array.isArray((error as { errors?: unknown[] }).errors)
			? (error as { errors: Array<{ text?: string; location?: { line?: number; column?: number } | null }> }).errors
			: undefined;

	if (!errors || errors.length === 0) {
		return `TypeScript error: ${error instanceof Error ? error.message : String(error)}`;
	}

	return [
		"TypeScript error:",
		...errors.map((entry) => {
			// The wrapper adds one line before user code.
			const line = entry.location?.line ? Math.max(1, entry.location.line - 1) : undefined;
			const column = entry.location?.column !== undefined && entry.location?.column !== null ? entry.location.column + 1 : undefined;
			const location = line ? ` at code-mode.ts:${line}${column ? `:${column}` : ""}` : "";
			const frame = line ? buildCodeFrame(source, line, column) : "";
			return `${entry.text ?? "Unknown TypeScript error"}${location}${frame ? `\n${frame}` : ""}`;
		}),
	].join("\n\n");
}

/**
 * Rewrite worker stack traces so frames inside user code show "code-mode.ts:N"
 * (already line-aligned via vm lineOffset) and attach a code frame.
 */
function formatRuntimeError(error: { name?: string; message: string; stack?: string }, strippedJs: string): string {
	const raw = error.stack || `${error.name ? `${error.name}: ` : ""}${error.message}`;
	const lines = raw.replace(/\r/g, "").split("\n");
	// Keep the message plus frames that reference user code; drop worker internals.
	const kept: string[] = [];
	let firstUserLine: number | undefined;
	let firstUserColumn: number | undefined;
	for (const line of lines) {
		const frameMatch = /at .*?code-mode\.ts:(\d+):(\d+)/.exec(line) ?? /code-mode\.ts:(\d+):(\d+)/.exec(line);
		if (frameMatch) {
			if (firstUserLine === undefined) {
				firstUserLine = Number(frameMatch[1]);
				firstUserColumn = Number(frameMatch[2]);
			}
			kept.push(line);
		} else if (!/^\s+at /.test(line)) {
			kept.push(line);
		}
	}
	const text = kept.join("\n");
	if (firstUserLine === undefined) return text;
	const frame = buildCodeFrame(strippedJs, firstUserLine, firstUserColumn);
	return frame ? `${text}\n\n${frame}` : text;
}

// ── worker protocol types ─────────────────────────────────────────────

type WorkerMessage =
	| { type: "log"; level: ConsoleEntry["level"]; text: string }
	| { type: "call"; id: number; tool: string; params: unknown }
	| { type: "done"; result: unknown }
	| { type: "fail"; error: { name?: string; message: string; stack?: string } };

function previewParams(params: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(params) ?? "undefined";
	} catch {
		text = String(params);
	}
	return text.length > PARAMS_PREVIEW_CHARS ? `${text.slice(0, PARAMS_PREVIEW_CHARS)}…` : text;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── runner ────────────────────────────────────────────────────────────

export async function runCode(options: RunOptions): Promise<RunOutcome> {
	const startedAt = Date.now();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxConcurrent = Math.max(1, options.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS);
	const consoleOutput: ConsoleEntry[] = [];
	const calls: CallSummary[] = [];
	const images: BridgeImage[] = [];

	const stripped = await stripTypeScript(options.code);
	if (!stripped.ok) {
		return {
			ok: false,
			errorText: stripped.errorText,
			console: consoleOutput,
			calls,
			images,
			durationMs: Date.now() - startedAt,
			timedOut: false,
			aborted: false,
		};
	}
	const strippedJs = stripped.js;

	if (options.signal?.aborted) {
		return {
			ok: false,
			errorText: "Aborted before execution started",
			console: consoleOutput,
			calls,
			images,
			durationMs: Date.now() - startedAt,
			timedOut: false,
			aborted: true,
		};
	}

	return new Promise<RunOutcome>((resolve) => {
		const runAbort = new AbortController();
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let callsStarted = 0;
		let callsFinished = 0;

		// simple semaphore for bounded host-side concurrency
		let running = 0;
		const queue: Array<() => void> = [];
		const acquire = (): Promise<void> =>
			new Promise((grant) => {
				if (running < maxConcurrent) {
					running++;
					grant();
				} else {
					queue.push(() => {
						running++;
						grant();
					});
				}
			});
		const release = () => {
			running--;
			const next = queue.shift();
			if (next) next();
		};

		const worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: { code: strippedJs, toolNames: Object.keys(options.tools) },
			resourceLimits: { maxOldGenerationSizeMb: options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB },
		});

		const onExternalAbort = () => {
			aborted = true;
			settle({ ok: false, errorText: "Aborted" });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			settle({ ok: false, errorText: `Execution timed out after ${Math.round(timeoutMs / 1000)}s` });
		}, timeoutMs);

		function settle(outcome: { ok: boolean; result?: unknown; errorText?: string }) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onExternalAbort);
			runAbort.abort();
			void worker.terminate().catch(() => undefined);
			resolve({
				ok: outcome.ok,
				result: outcome.result,
				errorText: outcome.errorText,
				console: consoleOutput,
				calls,
				images,
				durationMs: Date.now() - startedAt,
				timedOut,
				aborted,
			});
		}

		options.signal?.addEventListener("abort", onExternalAbort, { once: true });

		worker.on("message", (message: WorkerMessage) => {
			if (settled || !message) return;

			if (message.type === "log") {
				consoleOutput.push({ level: message.level, text: message.text });
				return;
			}

			if (message.type === "done") {
				settle({ ok: true, result: message.result });
				return;
			}

			if (message.type === "fail") {
				settle({ ok: false, errorText: formatRuntimeError(message.error, strippedJs) });
				return;
			}

			if (message.type === "call") {
				const summary: CallSummary = { id: message.id, tool: message.tool, params: previewParams(message.params) };
				calls.push(summary);
				const callStartedAt = Date.now();
				callsStarted++;
				options.onProgress?.({ callsStarted, callsFinished, lastTool: message.tool });

				const executor = options.tools[message.tool];
				const respond = (ok: boolean, payload: unknown) => {
					summary.durationMs = Date.now() - callStartedAt;
					summary.ok = ok;
					callsFinished++;
					options.onProgress?.({ callsStarted, callsFinished, lastTool: message.tool });
					if (settled) return;
					if (ok) {
						worker.postMessage({ type: "call-result", id: message.id, ok: true, value: payload });
					} else {
						summary.error = String(payload);
						worker.postMessage({
							type: "call-result",
							id: message.id,
							ok: false,
							error: { message: String(payload) },
						});
					}
				};

				if (!executor) {
					respond(false, `Tool is not available in Code Mode: ${message.tool}`);
					return;
				}

				void (async () => {
					await acquire();
					try {
						if (runAbort.signal.aborted) {
							respond(false, "Aborted");
							return;
						}
						const result = await executor(message.params, runAbort.signal);
						if (result.images) images.push(...result.images);
						respond(true, result.value);
					} catch (error) {
						respond(false, errorMessage(error));
					} finally {
						release();
					}
				})();
			}
		});

		worker.on("error", (error) => {
			settle({ ok: false, errorText: `Sandbox worker error: ${errorMessage(error)}` });
		});

		worker.on("exit", (code) => {
			if (!settled && code !== 0) {
				settle({ ok: false, errorText: `Sandbox worker exited unexpectedly with code ${code}` });
			}
		});
	});
}
