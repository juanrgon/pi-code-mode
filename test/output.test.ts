/**
 * Final-output discipline: oversized results must be truncated to pi's
 * standard limits, with the full output saved to a temp file.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { buildResultText } from "../index.js";
import { runCode } from "../runner.js";

describe("final output truncation", () => {
	test("oversized results are truncated and saved to a temp file", async () => {
		const outcome = await runCode({
			code: `return Array.from({ length: 5000 }, (_, i) => "result line " + (i + 1));`,
			tools: {},
		});
		expect(outcome.ok).toBe(true);

		const { text, truncated } = await buildResultText(outcome);
		expect(truncated).toBe(true);
		expect(text.split("\n").length).toBeLessThan(2100);
		const match = /Full output: (.*?)\]/.exec(text);
		expect(match).not.toBeNull();
		const full = await readFile(match![1], "utf-8");
		expect(full).toContain("result line 5000");
	});

	test("small results pass through untruncated with a status line", async () => {
		const outcome = await runCode({
			code: `console.log("note");\nreturn { ok: true };`,
			tools: {},
		});
		const { text, truncated } = await buildResultText(outcome);
		expect(truncated).toBe(false);
		expect(text).toContain("── console ──");
		expect(text).toContain("note");
		expect(text).toContain(`"ok": true`);
		expect(text).toMatch(/✓ 0 tool calls · \d+\.\ds/);
	});
});
