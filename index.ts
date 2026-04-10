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

import { resolve, dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { executeInSandbox, type ExternalFunction } from "./sandbox.js";
import { buildCodeModeSystemPrompt, type ToolSchema } from "./stubs.js";

export default function codeModeExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let toolsSnapshot: ToolSchema[] = [];

	// ── helpers ──────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (enabled) {
			ctx.ui.setStatus("code-mode", ctx.ui.theme.fg("accent", "⚡ code"));
		} else {
			ctx.ui.setStatus("code-mode", undefined);
		}
	}

	function snapshotTools(): ToolSchema[] {
		return pi
			.getAllTools()
			.filter((t) => t.name !== "execute_typescript")
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

	// ── build external_* bridge for a given tool ────────────────────────

	function buildExternalBridge(tool: ToolSchema, cwd: string, signal?: AbortSignal): ExternalFunction {
		return {
			name: tool.name,
			handler: async (paramsJson: string) => {
				const params = JSON.parse(paramsJson);

				if (tool.name === "bash") {
					const result = await pi.exec("bash", ["-c", params.command], {
						signal,
						timeout: params.timeout ?? 30,
					});
					const output = (result.stdout ?? "") + (result.stderr ?? "");
					if (result.code !== 0) {
						throw new Error(`Command exited with code ${result.code}\n${output}`);
					}
					return output;
				}

				if (tool.name === "read") {
					const filePath = resolve(cwd, params.path);
					const content = await readFile(filePath, "utf-8");
					if (params.offset || params.limit) {
						const lines = content.split("\n");
						const start = (params.offset ?? 1) - 1;
						const end = params.limit ? start + params.limit : lines.length;
						return lines.slice(start, end).join("\n");
					}
					return content;
				}

				if (tool.name === "write") {
					const filePath = resolve(cwd, params.path);
					await mkdir(dirname(filePath), { recursive: true });
					await writeFile(filePath, params.content, "utf-8");
					return `Wrote ${params.content.length} bytes to ${params.path}`;
				}

				if (tool.name === "edit") {
					const filePath = resolve(cwd, params.path);
					let content = await readFile(filePath, "utf-8");
					const edits = params.edits ?? [{ oldText: params.oldText, newText: params.newText }];
					for (const edit of edits) {
						if (!content.includes(edit.oldText)) {
							throw new Error(`oldText not found in ${params.path}: "${edit.oldText.slice(0, 80)}..."`);
						}
						content = content.replace(edit.oldText, edit.newText);
					}
					await writeFile(filePath, content, "utf-8");
					return `Applied ${edits.length} edit(s) to ${params.path}`;
				}

				if (tool.name === "grep") {
					const args: string[] = ["-rn"];
					if (params.include) args.push("--include", params.include);
					args.push(params.pattern);
					args.push(params.path ? resolve(cwd, params.path) : cwd);
					const result = await pi.exec("grep", args, { signal, timeout: 30 });
					return (result.stdout ?? "") + (result.stderr ?? "");
				}

				if (tool.name === "find") {
					const target = params.path ? resolve(cwd, params.path) : cwd;
					const args = [target];
					if (params.pattern) args.push("-name", params.pattern);
					if (params.type) args.push("-type", params.type);
					const result = await pi.exec("find", args, { signal, timeout: 30 });
					return (result.stdout ?? "") + (result.stderr ?? "");
				}

				if (tool.name === "ls") {
					const target = resolve(cwd, params.path ?? ".");
					const result = await pi.exec("ls", ["-la", target], { signal, timeout: 10 });
					return (result.stdout ?? "") + (result.stderr ?? "");
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
