/**
 * Code Mode Extension
 *
 * Gives the LLM an `execute_typescript` tool. Instead of calling tools one at a
 * time, the model writes a short TypeScript program that composes tools with
 * loops, conditionals, Promise.all, and data transforms, then executes it in a
 * V8 isolate sandbox. One call in, one structured result out.
 *
 * Inspired by TanStack AI Code Mode:
 *   https://tanstack.com/blog/tanstack-ai-code-mode
 *
 * Toggle: /code-mode  or  Ctrl+Alt+C
 *
 * When enabled the LLM gets the execute_typescript tool *in addition* to the
 * normal tools. The system prompt is augmented with typed stubs so the model
 * knows exactly how to call external_read(), external_bash(), etc.
 */

import { resolve, dirname, extname } from "node:path";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { executeInSandbox, type ExternalFunction } from "./sandbox.js";
import { buildCodeModeSystemPrompt, type ToolSchema } from "./stubs.js";

export default function codeModeExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let toolsSnapshot: ToolSchema[] = [];
	const bridgedToolNames = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

	// ── helpers ──────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;
		if (enabled) {
			ctx.ui.setStatus(
				"code-mode",
				theme.fg("accent", "⚡ code mode on") + theme.fg("dim", " — /code-mode or Ctrl+Alt+C to turn it off"),
			);
		} else {
			ctx.ui.setStatus(
				"code-mode",
				theme.fg("dim", "⚡ code mode off — /code-mode or Ctrl+Alt+C to turn it on"),
			);
		}
	}

	function snapshotTools(): ToolSchema[] {
		return pi
			.getAllTools()
			.filter((t) => t.name !== "execute_typescript" && bridgedToolNames.has(t.name))
			.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				parameters: (t.parameters ?? {}) as Record<string, unknown>,
			}));
	}

	function toggle(ctx: ExtensionContext): void {
		enabled = !enabled;

		if (enabled) {
			toolsSnapshot = snapshotTools();
			ctx.ui.notify("Code Mode enabled — LLM can now use execute_typescript", "info");
		} else {
			ctx.ui.notify("Code Mode disabled", "info");
		}
		updateStatus(ctx);
		pi.appendEntry("code-mode-state", { enabled });
	}

	function toExecTimeoutMs(seconds: number | undefined, fallbackSeconds: number): number {
		const effectiveSeconds = seconds ?? fallbackSeconds;
		return Math.max(1, Math.ceil(effectiveSeconds * 1000));
	}

	function countLinesBefore(text: string, index: number): number {
		let count = 1;
		for (let i = 0; i < index; i++) {
			if (text[i] === "\n") count++;
		}
		return count;
	}

	function truncatePreview(text: string, maxLines = 12, maxChars = 1200): string {
		const normalized = text.replace(/\r/g, "");
		const lines = normalized.split("\n");
		const sliced = lines.slice(0, maxLines).join("\n");
		const truncatedByLines = lines.length > maxLines;
		const truncatedByChars = sliced.length > maxChars;
		const body = truncatedByChars ? sliced.slice(0, maxChars) : sliced;
		return body + (truncatedByLines || truncatedByChars ? "\n…" : "");
	}

	function getImageMimeType(path: string): string | undefined {
		switch (extname(path).toLowerCase()) {
			case ".png":
				return "image/png";
			case ".jpg":
			case ".jpeg":
				return "image/jpeg";
			case ".gif":
				return "image/gif";
			case ".webp":
				return "image/webp";
			default:
				return undefined;
		}
	}

	// ── build external_* bridge for a given tool ────────────────────────

	function buildExternalBridge(tool: ToolSchema, cwd: string, signal?: AbortSignal): ExternalFunction {
		return {
			name: tool.name,
			handler: async (paramsJson: string) => {
				const params = JSON.parse(paramsJson);

				if (tool.name === "bash") {
					const result = await pi.exec("bash", ["-c", params.command], {
						signal,
						timeout: toExecTimeoutMs(params.timeout, 30),
					});
					const stdout = result.stdout ?? "";
					const stderr = result.stderr ?? "";
					return {
						kind: "bash",
						text: stdout + stderr,
						stdout,
						stderr,
						exitCode: result.code ?? 0,
						ok: (result.code ?? 0) === 0,
						killed: !!result.killed,
					};
				}

				if (tool.name === "read") {
					const filePath = resolve(cwd, params.path);
					const mimeType = getImageMimeType(filePath);

					if (mimeType) {
						const buffer = await readFile(filePath);
						const includeBase64 = buffer.byteLength <= 512 * 1024;
						return {
							kind: "image",
							text: includeBase64
								? `Read image file [${mimeType}]`
								: `Read image file [${mimeType}]\n[Base64 omitted: image exceeds 512KB helper limit.]`,
							path: params.path,
							mimeType,
							bytes: buffer.byteLength,
							base64: includeBase64 ? buffer.toString("base64") : undefined,
						};
					}

					const content = (await readFile(filePath)).toString("utf-8");
					const allLines = content.split("\n");
					const startIndex = Math.max(0, (params.offset ?? 1) - 1);
					if (startIndex >= allLines.length) {
						throw new Error(`Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`);
					}
					const endIndex = params.limit !== undefined ? Math.min(startIndex + params.limit, allLines.length) : allLines.length;
					const selectedLines = allLines.slice(startIndex, endIndex);
					const text = selectedLines.join("\n");
					return {
						kind: "read",
						text,
						path: params.path,
						startLine: startIndex + 1,
						endLine: endIndex,
						lineCount: selectedLines.length,
						totalLines: allLines.length,
					};
				}

				if (tool.name === "write") {
					const filePath = resolve(cwd, params.path);
					await mkdir(dirname(filePath), { recursive: true });
					await writeFile(filePath, params.content, "utf-8");
					return {
						kind: "write",
						text: `Wrote ${params.content.length} bytes to ${params.path}`,
						path: params.path,
						bytesWritten: params.content.length,
					};
				}

				if (tool.name === "edit") {
					const filePath = resolve(cwd, params.path);
					const originalContent = await readFile(filePath, "utf-8");
					const edits = params.edits ?? [{ oldText: params.oldText, newText: params.newText }];

					const matches = edits
						.map((edit: { oldText: string; newText: string }, index: number) => {
							const start = originalContent.indexOf(edit.oldText);
							if (start === -1) {
								throw new Error(`oldText not found in ${params.path}: "${edit.oldText.slice(0, 80)}..."`);
							}
							const next = originalContent.indexOf(edit.oldText, start + 1);
							if (next !== -1) {
								throw new Error(`oldText matched more than once in ${params.path}: "${edit.oldText.slice(0, 80)}..."`);
							}
							return {
								index,
								start,
								end: start + edit.oldText.length,
								oldText: edit.oldText,
								newText: edit.newText,
								line: countLinesBefore(originalContent, start),
							};
						})
						.sort((a, b) => a.start - b.start);

					for (let i = 1; i < matches.length; i++) {
						if (matches[i].start < matches[i - 1].end) {
							throw new Error(`edit ${matches[i].index + 1} overlaps another edit in ${params.path}`);
						}
					}

					let content = originalContent;
					for (const match of [...matches].sort((a, b) => b.start - a.start)) {
						content = content.slice(0, match.start) + match.newText + content.slice(match.end);
					}

					await writeFile(filePath, content, "utf-8");
					const diff = matches
						.map((match) => {
							const oldPreview = truncatePreview(match.oldText)
								.split("\n")
								.map((line) => `- ${line}`);
							const newPreview = truncatePreview(match.newText)
								.split("\n")
								.map((line) => `+ ${line}`);
							return [`@@ line ${match.line} @@`, ...oldPreview, ...newPreview].join("\n");
						})
						.join("\n\n");
					return {
						kind: "edit",
						text: `Applied ${edits.length} edit(s) to ${params.path}`,
						path: params.path,
						editsApplied: edits.length,
						firstChangedLine: matches[0]?.line,
						diff,
					};
				}

				if (tool.name === "grep") {
					const args: string[] = ["-n"];
					if (params.ignoreCase) args.push("-i");
					if (params.literal) args.push("-F");
					if (params.context !== undefined) args.push("-C", String(params.context));
					if (params.glob) args.push("--glob", params.glob);
					if (params.limit !== undefined) args.push("--max-count", String(params.limit));
					args.push(params.pattern);
					args.push(params.path ? resolve(cwd, params.path) : cwd);
					const result = await pi.exec("rg", args, {
						signal,
						timeout: toExecTimeoutMs(undefined, 30),
					});
					const stdout = result.stdout ?? "";
					const stderr = result.stderr ?? "";
					const exitCode = result.code ?? 0;
					const noMatches = exitCode === 1 && stderr.trim() === "";
					const ok = exitCode === 0 || noMatches;
					const text = stdout + stderr;
					return {
						kind: "grep",
						text,
						stdout,
						stderr,
						lines: stdout.split("\n").filter(Boolean),
						exitCode,
						ok,
						matched: stdout.trim().length > 0,
						noMatches,
						error: ok ? undefined : stderr.trim() || `rg exited with code ${exitCode}`,
					};
				}

				if (tool.name === "find") {
					const target = resolve(cwd, params.path ?? ".");
					const args: string[] = ["--files"];
					if (params.pattern) args.push("-g", params.pattern);
					const result = await pi.exec("rg", args, {
						cwd: target,
						signal,
						timeout: toExecTimeoutMs(undefined, 30),
					});
					const stdout = result.stdout ?? "";
					const stderr = result.stderr ?? "";
					const exitCode = result.code ?? 0;
					const paths = stdout.split("\n").filter(Boolean).slice(0, params.limit ?? 1000);
					const ok = exitCode === 0 || (exitCode === 1 && stderr.trim() === "" && paths.length === 0);
					return {
						kind: "find",
						text: stdout + stderr,
						stdout,
						stderr,
						paths,
						exitCode,
						ok,
						matched: paths.length > 0,
						noMatches: paths.length === 0 && ok,
						error: ok ? undefined : stderr.trim() || `find failed with code ${exitCode}`,
					};
				}

				if (tool.name === "ls") {
					const target = resolve(cwd, params.path ?? ".");
					const entries = (await readdir(target, { withFileTypes: true }))
						.sort((a, b) => a.name.localeCompare(b.name))
						.slice(0, params.limit ?? 500)
						.map((entry) => entry.name + (entry.isDirectory() ? "/" : ""));
					return {
						kind: "ls",
						text: entries.join("\n"),
						entries,
						path: params.path ?? ".",
					};
				}

				throw new Error(
					`Tool "${tool.name}" is not directly bridged in Code Mode. ` +
						`Use external_bash() to run it via the command line.`,
				);
			},
		};
	}

	// ── command + shortcut ──────────────────────────────────────────────

	pi.registerCommand("code-mode", {
		description: "Toggle Code Mode (execute_typescript tool)",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("c"), {
		description: "Toggle Code Mode",
		handler: async (ctx) => toggle(ctx),
	});

	// ── the execute_typescript tool ─────────────────────────────────────

	pi.registerTool({
		name: "execute_typescript",
		label: "Execute TypeScript",
		description:
			"Execute a TypeScript program in a V8 sandbox. The code can call " +
			"external_<toolname>(params) to invoke any active pi tool. Use this " +
			"to compose multiple tool calls, parallelize with Promise.all, do " +
			"math/aggregation in JS, and reduce round-trips. Top-level `return` " +
			"produces the result. console.log() output is captured.",
		promptSnippet:
			"Write and execute TypeScript programs that compose tools via external_* calls in a V8 sandbox",
		promptGuidelines: [
			"Use execute_typescript when composing 3+ tool calls, parallelizing reads, or doing math/aggregation.",
			"Inside execute_typescript, call tools via external_read(), external_bash(), external_edit(), etc.",
			"Use Promise.all() to parallelize independent external_* calls.",
			"Use top-level `return` to produce the final result.",
		],
		parameters: Type.Object({
			code: Type.String({
				description:
					"TypeScript code to execute. Use external_<tool>(params) to call tools. " +
					"Top-level `return` produces the result. console.log() is captured.",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!enabled) {
				return {
					content: [
						{
							type: "text",
							text: "Code Mode is disabled. Use /code-mode to enable it, then try again.",
						},
					],
					details: { enabled: false },
				};
			}

			toolsSnapshot = snapshotTools();
			const externals = toolsSnapshot.map((t) => buildExternalBridge(t, ctx.cwd, signal));

			onUpdate?.({
				content: [{ type: "text", text: "Executing TypeScript in V8 sandbox..." }],
			});

			const result = await executeInSandbox(params.code, externals, signal);

			// Format output
			const parts: string[] = [];

			if (result.consoleOutput.length > 0) {
				parts.push("── console output ──");
				parts.push(result.consoleOutput.join("\n"));
			}

			if (result.success) {
				if (result.result !== undefined) {
					parts.push("── result ──");
					parts.push(result.result);
				} else if (result.consoleOutput.length === 0) {
					parts.push("(no output)");
				}
				parts.push(`\n✓ Completed in ${result.duration}ms`);
			} else {
				parts.push("── error ──");
				parts.push(result.error ?? "Unknown error");
				parts.push(`\n✗ Failed after ${result.duration}ms`);
			}

			const text = parts.join("\n");

			if (!result.success) {
				throw new Error(text);
			}

			return {
				content: [{ type: "text", text }],
				details: {
					success: result.success,
					duration: result.duration,
					consoleLines: result.consoleOutput.length,
				},
			};
		},
	});

	// ── inject Code Mode context into the system prompt ─────────────────

	pi.on("before_agent_start", async () => {
		if (!enabled) return;
		toolsSnapshot = snapshotTools();
		return {
			message: {
				customType: "code-mode-context",
				content: buildCodeModeSystemPrompt(toolsSnapshot),
				display: false,
			},
		};
	});

	// ── restore state on session start ──────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as { type: string; customType?: string; data?: { enabled: boolean } };
			if (e.type === "custom" && e.customType === "code-mode-state") {
				enabled = e.data?.enabled ?? false;
			}
		}
		if (enabled) {
			toolsSnapshot = snapshotTools();
		}
		updateStatus(ctx);
	});
}
