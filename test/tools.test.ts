/**
 * Integration tests against pi's REAL tool implementations — verifies that
 * Code Mode inherits built-in semantics (truncation, mutation queue, image
 * handling) instead of reimplementing them.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BRIDGED_TOOL_NAMES, createBridgedDefinitions, createBridgedExecutors } from "../index.js";
import { runCode } from "../runner.js";

// Core tool implementations don't dereference the extension context.
const ctx = {} as unknown as ExtensionContext;

let cwd: string;
let executors: ReturnType<typeof createBridgedExecutors>;

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

beforeAll(async () => {
	cwd = await mkdtemp(join(tmpdir(), "pi-code-mode-test-"));
	executors = createBridgedExecutors(createBridgedDefinitions(cwd), ctx, "test");
});

describe("real tool delegation", () => {
	test("exposes exactly the bridged tools", () => {
		expect(Object.keys(executors).sort()).toEqual([...BRIDGED_TOOL_NAMES].sort());
	});

	test("read inherits pi's 2000-line truncation", async () => {
		const big = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
		await writeFile(join(cwd, "big.txt"), big, "utf-8");
		const outcome = await runCode({
			code: `const r = await tools.read({ path: "big.txt" });\nreturn { truncated: r.truncated, kind: r.kind, lineCount: lines(r.text).length };`,
			tools: executors,
		});
		expect(outcome.ok).toBe(true);
		const result = outcome.result as { truncated: boolean; kind: string; lineCount: number };
		expect(result.kind).toBe("text");
		expect(result.truncated).toBe(true);
		// 2000 content lines plus pi's truncation notice line(s)
		expect(result.lineCount).toBeLessThan(2010);
	});

	test("bash returns output on success and throws on non-zero exit", async () => {
		const outcome = await runCode({
			code: `const good = await tools.bash({ command: "echo hello" });
const bad = await tools.try("bash", { command: "echo oops >&2; exit 3" });
if (bad.ok) throw new Error("expected failure");
return { good: good.text.trim(), badError: bad.error };`,
			tools: executors,
		});
		expect(outcome.ok).toBe(true);
		const result = outcome.result as { good: string; badError: string };
		expect(result.good).toBe("hello");
		expect(result.badError).toContain("exited with code 3");
		expect(result.badError).toContain("oops");
	});

	test("concurrent edits to the same file both land (mutation queue)", async () => {
		const target = join(cwd, "queue.txt");
		await writeFile(target, "alpha\nbravo\ncharlie\n", "utf-8");
		const outcome = await runCode({
			code: `await Promise.all([
  tools.edit({ path: "queue.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
  tools.edit({ path: "queue.txt", edits: [{ oldText: "charlie", newText: "CHARLIE" }] }),
]);
return "done";`,
			tools: executors,
		});
		expect(outcome.ok).toBe(true);
		const content = await readFile(target, "utf-8");
		expect(content).toContain("ALPHA");
		expect(content).toContain("CHARLIE");
	});

	test("edit exposes pi's diff details and surfaces real edit errors", async () => {
		await writeFile(join(cwd, "edit-me.txt"), "const value = 1;\n", "utf-8");
		const outcome = await runCode({
			code: `const ok = await tools.edit({ path: "edit-me.txt", edits: [{ oldText: "value = 1", newText: "value = 2" }] });
const missing = await tools.try("edit", { path: "edit-me.txt", edits: [{ oldText: "does-not-exist", newText: "x" }] });
return { diff: ok.diff, missingOk: missing.ok, error: missing.ok ? "" : missing.error };`,
			tools: executors,
		});
		expect(outcome.ok).toBe(true);
		const result = outcome.result as { diff: string; missingOk: boolean; error: string };
		expect(result.diff.length).toBeGreaterThan(0);
		expect(result.missingOk).toBe(false);
		expect(result.error.toLowerCase()).toContain("could not find");
	});

	test("write + grep + grepEntries round-trip with pi's grep output format", async () => {
		const outcome = await runCode({
			code: `await tools.write({ path: "notes/todo.md", content: "alpha TODO one\\nplain line\\nbeta TODO two\\n" });
const entries = await grepEntries({ pattern: "TODO", path: "notes" });
return entries.map((e) => ({ line: e.line, text: e.text }));`,
			tools: executors,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toEqual([
			{ line: 1, text: "alpha TODO one" },
			{ line: 3, text: "beta TODO two" },
		]);
	});

	test("find and ls return text the sandbox can split", async () => {
		const outcome = await runCode({
			code: `await tools.write({ path: "pkg/a.ts", content: "export {};\\n" });
await tools.write({ path: "pkg/b.ts", content: "export {};\\n" });
const found = await tools.find({ pattern: "pkg/*.ts" });
const listed = await tools.ls({ path: "pkg" });
return { found: lines(found.text).sort(), listed: lines(listed.text).sort() };`,
			tools: executors,
		});
		expect(outcome.ok).toBe(true);
		const result = outcome.result as { found: string[]; listed: string[] };
		expect(result.found).toEqual(["pkg/a.ts", "pkg/b.ts"]);
		expect(result.listed).toEqual(["a.ts", "b.ts"]);
	});

	test("reading an image collects it for the final result", async () => {
		await writeFile(join(cwd, "pixel.png"), TINY_PNG);
		const outcome = await runCode({
			code: `const r = await tools.read({ path: "pixel.png" });\nreturn { kind: r.kind, marker: r.text };`,
			tools: executors,
		});
		expect(outcome.ok).toBe(true);
		const result = outcome.result as { kind: string; marker: string };
		expect(result.kind).toBe("image");
		expect(result.marker.toLowerCase()).toContain("image");
		expect(outcome.images).toHaveLength(1);
		expect(outcome.images[0].mimeType).toBe("image/png");
		expect(outcome.images[0].data.length).toBeGreaterThan(0);
	});

	test("readJson helper parses files through the real read tool", async () => {
		await writeFile(join(cwd, "data.json"), JSON.stringify({ name: "demo", n: 7 }), "utf-8");
		const outcome = await runCode({
			code: `const data = await readJson<{ name: string; n: number }>("data.json");\nreturn data.n + 1;`,
			tools: executors,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toBe(8);
	});
});
