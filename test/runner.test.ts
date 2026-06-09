import { describe, expect, test } from "vitest";
import { runCode, stripTypeScript, type ToolExecutor } from "../runner.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function echoTool(): ToolExecutor {
	return async (params) => ({ value: { text: JSON.stringify(params) } });
}

function slowTool(ms: number): ToolExecutor {
	return async () => {
		await sleep(ms);
		return { value: { text: `slept ${ms}` } };
	};
}

describe("stripTypeScript", () => {
	test("strips types, interfaces, and generics while preserving top-level return", async () => {
		const result = await stripTypeScript(`
interface Point { x: number; y: number }
const p = { x: 1, y: 2 } satisfies Point;
const double = <T,>(value: T): T[] => [value, value];
const n: number = p.x + p.y;
return double(n as number);
`);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.js).not.toContain("interface");
			expect(result.js).not.toContain(": number");
			expect(result.js).toContain("return");
		}
	});

	test("reports syntax errors with a code frame", async () => {
		const result = await stripTypeScript(`const x = ;\nreturn x;`);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorText).toContain("TypeScript error");
			expect(result.errorText).toContain("code-mode.ts:1");
			expect(result.errorText).toContain(">");
		}
	});
});

describe("runCode basics", () => {
	test("returns the top-level return value as JSON-safe data", async () => {
		const outcome = await runCode({ code: `return { n: 42, list: [1, 2, 3] };`, tools: {} });
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toEqual({ n: 42, list: [1, 2, 3] });
	});

	test("captures console output with levels", async () => {
		const outcome = await runCode({
			code: `console.log("hello", { a: 1 });\nconsole.warn("careful");\nreturn 1;`,
			tools: {},
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.console[0].level).toBe("log");
		expect(outcome.console[0].text).toContain("hello");
		expect(outcome.console[0].text).toContain("a: 1");
		expect(outcome.console[1]).toEqual({ level: "warn", text: "careful" });
	});

	test("bridges tool calls and records an audit trail", async () => {
		const outcome = await runCode({
			code: `const r = await tools.echo({ path: "x.ts" });\nreturn r.text;`,
			tools: { echo: echoTool() },
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toBe(`{"path":"x.ts"}`);
		expect(outcome.calls).toHaveLength(1);
		expect(outcome.calls[0]).toMatchObject({ tool: "echo", ok: true });
		expect(outcome.calls[0].durationMs).toBeTypeOf("number");
	});

	test("tool errors reject the sandbox promise with the tool's message", async () => {
		const failing: ToolExecutor = async () => {
			throw new Error("boom: file not found");
		};
		const outcome = await runCode({
			code: `try {\n  await tools.fail({});\n  return "no error";\n} catch (err) {\n  return "caught: " + (err as Error).message;\n}`,
			tools: { fail: failing },
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toBe("caught: boom: file not found");
		expect(outcome.calls[0]).toMatchObject({ tool: "fail", ok: false });
	});

	test("tools.try returns an envelope instead of throwing", async () => {
		const failing: ToolExecutor = async () => {
			throw new Error("nope");
		};
		const outcome = await runCode({
			code: `const bad = await tools.try("fail", {});\nconst unknown = await tools.try("missing", {});\nconst good = await tools.try("echo", { a: 1 });\nreturn { bad, unknown, good };`,
			tools: { fail: failing, echo: echoTool() },
		});
		expect(outcome.ok).toBe(true);
		const result = outcome.result as { bad: { ok: boolean; error: string }; unknown: { ok: boolean; error: string }; good: { ok: boolean; text: string } };
		expect(result.bad).toEqual({ ok: false, error: "nope" });
		expect(result.unknown.ok).toBe(false);
		expect(result.unknown.error).toContain("Unknown tool");
		expect(result.unknown.error).toContain("echo");
		expect(result.good).toEqual({ ok: true, text: `{"a":1}` });
	});

	test("runtime errors map to user code with a code frame", async () => {
		const outcome = await runCode({
			code: `const a = 1;\nconst b = 2;\nthrow new Error("kaput");`,
			tools: {},
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.errorText).toContain("kaput");
		expect(outcome.errorText).toContain("code-mode.ts:3");
		expect(outcome.errorText).toContain("> 3 |");
	});

	test("circular return values produce a friendly error", async () => {
		const outcome = await runCode({
			code: `const a: Record<string, unknown> = {};\na.self = a;\nreturn a;`,
			tools: {},
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.errorText).toContain("JSON-serializable");
	});

	test("helpers are available in the sandbox", async () => {
		const outcome = await runCode({
			code: `return [typeof lines, typeof dedent, typeof mapLimit, typeof readJson, typeof bashJson, typeof grepEntries];`,
			tools: {},
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toEqual(["function", "function", "function", "function", "function", "function"]);
	});

	test("mapLimit preserves order with bounded concurrency", async () => {
		const outcome = await runCode({
			code: `const out = await mapLimit([3, 1, 2], 2, async (n: number) => {\n  await new Promise((r) => setTimeout(r, n * 20));\n  return n * 10;\n});\nreturn out;`,
			tools: {},
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.result).toEqual([30, 10, 20]);
	});
});

describe("runCode concurrency", () => {
	test("Promise.all runs bridged calls in parallel (the v1 regression)", async () => {
		const outcome = await runCode({
			code: `await Promise.all([tools.slow({}), tools.slow({})]);\nreturn "done";`,
			tools: { slow: slowTool(800) },
		});
		expect(outcome.ok).toBe(true);
		// Sequential would be >= 1600ms.
		expect(outcome.durationMs).toBeLessThan(1400);
	});

	test("sequential awaits remain sequential", async () => {
		const outcome = await runCode({
			code: `await tools.slow({});\nawait tools.slow({});\nreturn "done";`,
			tools: { slow: slowTool(300) },
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.durationMs).toBeGreaterThanOrEqual(600);
	});

	test("host-side concurrency is bounded by maxConcurrentCalls", async () => {
		let running = 0;
		let peak = 0;
		const gauge: ToolExecutor = async () => {
			running++;
			peak = Math.max(peak, running);
			await sleep(100);
			running--;
			return { value: { text: "ok" } };
		};
		const outcome = await runCode({
			code: `await Promise.all([1, 2, 3, 4, 5, 6].map(() => tools.gauge({})));\nreturn "done";`,
			tools: { gauge },
			maxConcurrentCalls: 2,
		});
		expect(outcome.ok).toBe(true);
		expect(peak).toBe(2);
	});
});

describe("runCode cancellation", () => {
	test("abort kills a CPU-bound infinite loop", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const startedAt = Date.now();
		const outcome = await runCode({
			code: `while (true) {}\nreturn 1;`,
			tools: {},
			signal: controller.signal,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.aborted).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(3000);
	});

	test("abort propagates to in-flight tool executions", async () => {
		const controller = new AbortController();
		let sawAbort = false;
		const hanging: ToolExecutor = (_params, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => {
					sawAbort = true;
					reject(new Error("aborted"));
				});
			});
		setTimeout(() => controller.abort(), 200);
		const outcome = await runCode({
			code: `await tools.hang({});\nreturn 1;`,
			tools: { hang: hanging },
			signal: controller.signal,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.aborted).toBe(true);
		expect(sawAbort).toBe(true);
	});

	test("wall-clock timeout fires even while awaiting forever", async () => {
		const outcome = await runCode({
			code: `await new Promise(() => {});\nreturn 1;`,
			tools: {},
			timeoutMs: 400,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.timedOut).toBe(true);
		expect(outcome.errorText).toContain("timed out");
	});
});
