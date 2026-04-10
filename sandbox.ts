/**
 * V8 isolate sandbox for executing TypeScript code with external_* tool bridges.
 */
import ivm from "isolated-vm";

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
 * Execute a TypeScript/JavaScript code string inside a V8 isolate.
 *
 * - external_* functions are bridged as async callbacks.
 * - console.log/warn/error are captured.
 * - The code is wrapped in an async function so top-level `return` works.
 * - Type annotations are stripped with a simple regex pass.
 */
export async function executeInSandbox(
	code: string,
	externals: ExternalFunction[],
	signal?: AbortSignal,
): Promise<SandboxResult> {
	const start = Date.now();
	const consoleOutput: string[] = [];

	const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });

	try {
		const context = await isolate.createContext();
		const jail = context.global;

		// Set up console capture
		await jail.set("__consoleLog", new ivm.Callback((msg: string) => {
			consoleOutput.push(msg);
		}));

		// Set up each external_* function as a Reference (v5 async support)
		for (const ext of externals) {
			const refName = `__external_${ext.name}`;
			await jail.set(
				refName,
				new ivm.Reference(async (paramsJson: string) => {
					return await ext.handler(paramsJson);
				}),
			);
		}

		// Build bootstrap script that wires console + external functions
		const externalDeclarations = externals
			.map(
				(ext) => `
async function external_${ext.name}(params) {
  return await __external_${ext.name}.apply(undefined, [JSON.stringify(params)], { result: { promise: true } });
}`,
			)
			.join("\n");

		const bootstrap = `
const console = {
  log: (...args) => __consoleLog(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')),
  warn: (...args) => __consoleLog('[warn] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')),
  error: (...args) => __consoleLog('[error] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')),
  info: (...args) => __consoleLog(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')),
};

${externalDeclarations}
`;

		// Strip TypeScript annotations (simple approach)
		const strippedCode = stripTypeAnnotations(code);

		// Wrap in async IIFE so top-level return works
		const fullScript = `
${bootstrap}

(async () => {
${strippedCode}
})().then(result => {
  if (result !== undefined) {
    return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
  }
  return undefined;
});
`;

		const script = await isolate.compileScript(fullScript);
		const resultRef = await script.run(context, { timeout: TIMEOUT_MS, promise: true });

		const result = typeof resultRef === "string" ? resultRef : resultRef !== undefined ? String(resultRef) : undefined;

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

/**
 * Crude TypeScript annotation stripper. Removes:
 * - `: Type` annotations on parameters and variables
 * - `<Generic>` type parameters
 * - `as Type` casts
 * - `interface` and `type` declarations
 *
 * This is intentionally simple. Full TS→JS requires a real compiler,
 * but for the short snippets the LLM writes, this works well enough.
 */
function stripTypeAnnotations(code: string): string {
	let result = code;

	// Remove interface/type declarations (whole lines)
	result = result.replace(/^(export\s+)?(interface|type)\s+\w+[^{]*\{[^}]*\}/gm, "");
	result = result.replace(/^(export\s+)?type\s+\w+\s*=\s*[^;\n]+;?/gm, "");

	// Remove `as Type` casts
	result = result.replace(/\s+as\s+\w+(\[\])?/g, "");

	// Remove generic type parameters on function calls: fn<Type>(
	result = result.replace(/(\w+)<[^>]+>\(/g, "$1(");

	// Remove parameter type annotations: (param: Type) -> (param)
	// Handle multi-param: (a: string, b: number) -> (a, b)
	// Only match after ( or , (function parameter position) to avoid clobbering
	// object literal keys like { path: "...", limit: 5 }
	result = result.replace(/([,(]\s*)(\w+)\s*:\s*[\w<>\[\]|&\s]+(?=[,)])/g, "$1$2");

	// Remove variable type annotations: const x: Type = -> const x =
	result = result.replace(/(const|let|var)\s+(\w+)\s*:\s*[\w<>\[\]|&\s,{}]+\s*=/g, "$1 $2 =");

	// Remove return type annotations: ): Type => -> ) =>
	result = result.replace(/\)\s*:\s*[\w<>\[\]|&\s,{}]+\s*=>/g, ") =>");

	return result;
}
