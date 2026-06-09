/**
 * Verifies the injected system prompt matches the actual sandbox runtime:
 * every declared tools.* method and helper must exist, and the prompt must
 * stay small (it is injected on every request while Code Mode is enabled).
 */
import { describe, expect, test } from "vitest";
import { buildCodeModePrompt, type BridgedToolSchema } from "../stubs.js";
import { SANDBOX_HELPER_NAMES } from "../worker-source.js";
import { runCode } from "../runner.js";

const schemas: BridgedToolSchema[] = ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: { path: { type: "string" } } },
}));

describe("prompt / runtime parity", () => {
	test("every declared tools.* method exists in the sandbox", async () => {
		const prompt = buildCodeModePrompt(schemas);
		const declared = [...prompt.matchAll(/^ {2}(\w+)\(params/gm)].map((m) => m[1]);
		expect(declared.sort()).toEqual(schemas.map((s) => s.name).sort());

		const noopTools = Object.fromEntries(schemas.map((s) => [s.name, async () => ({ value: { text: "" } })]));
		const outcome = await runCode({
			code: `return Object.keys(tools).sort();`,
			tools: noopTools,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toEqual([...declared, "try"].sort());
	});

	test("every declared helper exists in the sandbox when all tools are bridged", async () => {
		const prompt = buildCodeModePrompt(schemas);
		for (const helper of SANDBOX_HELPER_NAMES) {
			expect(prompt).toContain(`declare function ${helper}`);
		}
		const noopTools = Object.fromEntries(schemas.map((s) => [s.name, async () => ({ value: { text: "" } })]));
		const outcome = await runCode({
			code: `return [${SANDBOX_HELPER_NAMES.map((h) => `typeof ${h}`).join(", ")}];`,
			tools: noopTools,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toEqual(SANDBOX_HELPER_NAMES.map(() => "function"));
	});

	test("tool-dependent helpers disappear from prompt and sandbox when their tool is not bridged", async () => {
		const withoutBash = schemas.filter((s) => s.name !== "bash");
		const prompt = buildCodeModePrompt(withoutBash);
		expect(prompt).not.toContain("bashJson");
		expect(prompt).toContain("declare function readJson");

		const noopTools = Object.fromEntries(withoutBash.map((s) => [s.name, async () => ({ value: { text: "" } })]));
		const outcome = await runCode({
			code: `return [typeof bashJson, typeof readJson, typeof grepEntries];`,
			tools: noopTools,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toEqual(["undefined", "function", "function"]);
	});

	test("prompt stays small", () => {
		const prompt = buildCodeModePrompt(schemas);
		const lineCount = prompt.split("\n").length;
		expect(lineCount).toBeLessThan(160);
	});
});
