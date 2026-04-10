/**
 * V8 isolate sandbox for executing TypeScript code with external_* tool bridges.
 *
 * TypeScript stripping approach borrowed from @tanstack/ai-code-mode which uses
 * esbuild's transform API for reliable TS→JS conversion.
 *
 * Error handling across the isolate boundary follows TanStack's pattern of
 * serializing tool results as { success, value/error } JSON.
 */
import ivm from "isolated-vm";
import { transform } from "esbuild";

export interface ExternalFunction {
	name: string;
	handler: (paramsJson: string) => Promise<string>;
}

export interface SandboxResult {
	success: boolean;
	result?: string;
	consoleOutput: string[];
	error?: string;
	duration: number;
}

const TIMEOUT_MS = 120_000;
const MEMORY_LIMIT_MB = 128;

/**
 * Strip TypeScript syntax from code using esbuild.
 *
 * The code is wrapped in an async function so top-level `return` and `await`
 * work, then unwrapped after transformation. This approach comes from
 * @tanstack/ai-code-mode's strip-typescript.ts.
 */
const WRAPPER_FN = "___PI_WRAPPER___";
const WRAPPER_END = "___PI_WRAPPER_END___";

async function stripTypeScript(code: string): Promise<string> {
	const wrapped = `async function ${WRAPPER_FN}() {\n${code}\n}; ${WRAPPER_END}`;

	const result = await transform(wrapped, {
		loader: "ts",
		minify: false,
		keepNames: false,
		target: "es2022",
	});

	const transformed = result.code;

	const fnStart = transformed.indexOf(`async function ${WRAPPER_FN}()`);
	if (fnStart === -1) throw new Error("Could not find wrapper function in transformed output");

	const openBrace = transformed.indexOf("{", fnStart);
	if (openBrace === -1) throw new Error("Could not find opening brace in transformed output");

	const endMarker = transformed.indexOf(WRAPPER_END);
	if (endMarker === -1) throw new Error("Could not find end marker in transformed output");

	const body = transformed.substring(openBrace + 1, endMarker);
	const closingBrace = body.lastIndexOf("}");
	if (closingBrace === -1) throw new Error("Could not find closing brace in transformed output");

	return body.substring(0, closingBrace).trim();
}

/**
 * Execute a TypeScript/JavaScript code string inside a V8 isolate.
 *
 * - TypeScript is stripped via esbuild (fast, handles all TS syntax)
 * - external_* functions are bridged as async References
 * - Tool results are serialized as { success, value/error } JSON for safe isolate boundary crossing
 * - console.log/warn/error are captured
 * - The code is wrapped in an async IIFE so top-level `return` works
 */
export async function executeInSandbox(
	code: string,
	externals: ExternalFunction[],
	signal?: AbortSignal,
): Promise<SandboxResult> {
	const start = Date.now();
	const consoleOutput: string[] = [];

	// Strip TypeScript before entering the isolate
	let strippedCode: string;
	try {
		strippedCode = await stripTypeScript(code);
	} catch (err) {
		return {
			success: false,
			error: `TypeScript error: ${err instanceof Error ? err.message : String(err)}`,
			consoleOutput: [],
			duration: Date.now() - start,
		};
	}

	const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });

	try {
		const context = await isolate.createContext();
		const jail = context.global;

		// Set up console capture using Reference.applySync for reliability
		const logRef = new ivm.Reference((msg: string) => {
			consoleOutput.push(msg);
		});
		await jail.set("__logRef", logRef);

		// Set up each external_* function as a Reference
		// Tool results are wrapped in { success, value/error } JSON so errors
		// propagate cleanly across the isolate boundary (pattern from TanStack)
		for (const ext of externals) {
			await jail.set(
				`__ref_${ext.name}`,
				new ivm.Reference(async (paramsJson: string) => {
					try {
						const result = await ext.handler(paramsJson);
						return JSON.stringify({ success: true, value: result });
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return JSON.stringify({ success: false, error: message });
					}
				}),
			);
		}

		// Build bootstrap: console + external function wrappers
		const externalDeclarations = externals
			.map(
				(ext) => `
async function external_${ext.name}(params) {
  const json = await __ref_${ext.name}.applySyncPromise(undefined, [JSON.stringify(params)]);
  const res = JSON.parse(json);
  if (!res.success) throw new Error(res.error);
  return typeof res.value === 'string' ? res.value : res.value;
}`,
			)
			.join("\n");

		const bootstrap = `
const console = {
  log: (...args) => __logRef.applySync(undefined, [args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')]),
  warn: (...args) => __logRef.applySync(undefined, ['[warn] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')]),
  error: (...args) => __logRef.applySync(undefined, ['[error] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')]),
  info: (...args) => __logRef.applySync(undefined, [args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')]),
};
${externalDeclarations}
`;

		// Wrap in async IIFE, serialize result as JSON for safe isolate boundary crossing
		const fullScript = `
${bootstrap}

(async () => {
  try {
    const __result = await (async () => {
${strippedCode}
    })();
    return JSON.stringify(__result);
  } catch (__err) {
    throw __err;
  }
})()
`;

		const script = await isolate.compileScript(fullScript);
		const rawResult = await script.run(context, { timeout: TIMEOUT_MS, promise: true });

		// Parse the JSON-serialized result
		let result: string | undefined;
		if (typeof rawResult === "string") {
			try {
				const parsed = JSON.parse(rawResult);
				result = typeof parsed === "object" ? JSON.stringify(parsed, null, 2) : String(parsed);
			} catch {
				result = rawResult;
			}
		} else if (rawResult !== undefined) {
			result = String(rawResult);
		}

		return {
			success: true,
			result,
			consoleOutput,
			duration: Date.now() - start,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			success: false,
			error: message,
			consoleOutput,
			duration: Date.now() - start,
		};
	} finally {
		isolate.dispose();
	}
}
