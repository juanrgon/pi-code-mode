/**
 * Extension behavior tests against a mock ExtensionAPI:
 * - system prompt injection is per-turn (chained), never a persistent message
 * - off mode deactivates execute_typescript
 * - user-disabled bridged tools are excluded from prompt and sandbox
 * - replace mode snapshots/restores exactly the prior active set
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import codeModeExtension from "../index.js";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
type CommandHandler = (args: string | undefined, ctx: ExtensionContext) => Promise<unknown>;

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
}

const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, RegisteredTool>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	let active = [...BUILTINS];

	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(def: RegisteredTool) {
			tools.set(def.name, def);
			if (!active.includes(def.name)) active.push(def.name);
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		registerShortcut() {},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		getAllTools: () => [...active].map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = [...names];
		},
	};

	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		ui: {
			theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
			notify() {},
			setStatus() {},
		},
		sessionManager: { getEntries: () => entries },
	} as unknown as ExtensionContext;

	return {
		pi,
		ctx,
		entries,
		getActive: () => [...active],
		setActive: (names: string[]) => {
			active = [...names];
		},
		command: (name: string, args?: string) => commands.get(name)!(args, ctx),
		emit: (event: string, eventData: Record<string, unknown> = {}) =>
			Promise.all((handlers.get(event) ?? []).map((h) => h(eventData, ctx))),
		tool: (name: string) => tools.get(name)!,
	};
}

let fake: ReturnType<typeof createFakePi>;

beforeEach(() => {
	fake = createFakePi();
	codeModeExtension(fake.pi as never);
});

describe("system prompt injection", () => {
	test("chains the system prompt instead of injecting a persistent message", async () => {
		const results = (await fake.emit("before_agent_start", { systemPrompt: "BASE PROMPT" })) as Array<
			Record<string, unknown> | undefined
		>;
		const result = results[0] as { systemPrompt?: string; message?: unknown };
		expect(result.message).toBeUndefined();
		expect(result.systemPrompt).toBeDefined();
		expect(result.systemPrompt!.startsWith("BASE PROMPT")).toBe(true);
		expect(result.systemPrompt).toContain("## Code Mode");

		// A second turn chains again from its own base — nothing accumulates in the session.
		const second = (await fake.emit("before_agent_start", { systemPrompt: "BASE PROMPT" })) as Array<{
			systemPrompt?: string;
		}>;
		expect(second[0]!.systemPrompt).toBe(result.systemPrompt);
		expect(fake.entries.filter((e) => e.customType === "code-mode-context")).toHaveLength(0);
	});

	test("returns nothing when disabled", async () => {
		await fake.command("code-mode", "off");
		const results = (await fake.emit("before_agent_start", { systemPrompt: "BASE" })) as unknown[];
		expect(results[0]).toBeUndefined();
	});
});

describe("mode transitions", () => {
	test("off removes execute_typescript from the active tools; on restores it", async () => {
		expect(fake.getActive()).toContain("execute_typescript");
		await fake.command("code-mode", "off");
		expect(fake.getActive()).not.toContain("execute_typescript");
		expect(fake.getActive()).toEqual(expect.arrayContaining(BUILTINS));
		await fake.command("code-mode", "on");
		expect(fake.getActive()).toContain("execute_typescript");
	});

	test("replace hides only the active bridged tools and restores exactly that set", async () => {
		// User disabled bash and has an unrelated tool.
		fake.setActive([...BUILTINS.filter((n) => n !== "bash"), "execute_typescript", "my_custom_tool"]);
		await fake.command("code-mode", "replace");
		const hidden = fake.getActive();
		expect(hidden).toEqual(["execute_typescript", "my_custom_tool"]);

		await fake.command("code-mode", "on");
		const restored = fake.getActive().sort();
		// bash stays disabled — Code Mode must not re-enable it.
		expect(restored).not.toContain("bash");
		expect(restored).toEqual([...BUILTINS.filter((n) => n !== "bash"), "execute_typescript", "my_custom_tool"].sort());
	});

	test("state persists with the replace snapshot", async () => {
		await fake.command("code-mode", "replace");
		const last = fake.entries.filter((e) => e.customType === "code-mode-state").at(-1)!;
		expect(last.data).toEqual({ enabled: true, replace: true, replaceHidden: BUILTINS });
	});

	test("replace then off restores the snapshot and removes execute_typescript", async () => {
		fake.setActive([...BUILTINS.filter((n) => n !== "write"), "execute_typescript"]);
		await fake.command("code-mode", "replace");
		await fake.command("code-mode", "off");
		expect(fake.getActive().sort()).toEqual([...BUILTINS.filter((n) => n !== "write")].sort());
	});

	test("session_shutdown during replace restores the hidden tools", async () => {
		await fake.command("code-mode", "replace");
		expect(fake.getActive()).not.toContain("bash");
		await fake.emit("session_shutdown");
		expect(fake.getActive()).toEqual(expect.arrayContaining(BUILTINS));
	});
});

describe("disabled tools stay unavailable inside the sandbox", () => {
	test("a disabled bash is excluded from the prompt and from the sandbox runtime", async () => {
		fake.setActive([...BUILTINS.filter((n) => n !== "bash"), "execute_typescript"]);

		const results = (await fake.emit("before_agent_start", { systemPrompt: "BASE" })) as Array<{
			systemPrompt?: string;
		}>;
		const injected = results[0]!.systemPrompt!.slice("BASE".length);
		// The entire injected Code Mode section must not advertise bash in any form
		// (tools.bash declaration, bashJson helper, bash examples).
		expect(injected.toLowerCase()).not.toContain("bash");

		// The registered tool metadata must not name specific tools either.
		const meta = fake.tool("execute_typescript");
		const metaText = [meta.description, meta.promptSnippet, ...(meta.promptGuidelines ?? [])].join(" ").toLowerCase();
		expect(metaText).not.toContain("bash");

		const cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-ext-"));
		const ctx = { ...(fake.ctx as object), cwd } as ExtensionContext;
		const result = await fake
			.tool("execute_typescript")
			.execute("t1", { code: `const names = Object.keys(tools).sort();\nconst bash = await tools.try("bash", { command: "echo hi" });\nreturn { names, bashOk: bash.ok, bashJsonType: typeof bashJson };` }, undefined, undefined, ctx);
		const text = result.content[0].text!;
		expect(text).toContain(`"bashOk": false`);
		expect(text).toContain(`"bashJsonType": "undefined"`);
		expect(text).not.toContain(`"bash",`);
		expect(text).toContain(`"read"`);
	});
});
