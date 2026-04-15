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
	handler: (paramsJson: string) => Promise<unknown>;
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

function buildCodeFrame(source: string, line: number, column?: number, radius = 2): string {
	const lines = source.replace(/\r/g, "").split("\n");
	if (line < 1 || line > lines.length) return "";
	const start = Math.max(1, line - radius);
	const end = Math.min(lines.length, line + radius);
	const width = String(end).length;
	const frame: string[] = [];

	for (let current = start; current <= end; current++) {
		const marker = current === line ? ">" : " ";
		frame.push(`${marker} ${String(current).padStart(width)} | ${lines[current - 1]}`);
		if (current === line && column && column > 0) {
			frame.push(`  ${" ".repeat(width)} | ${" ".repeat(Math.max(0, column - 1))}^`);
		}
	}

	return frame.join("\n");
}

function formatTransformError(error: unknown, source: string): string {
	const errors =
		error && typeof error === "object" && "errors" in error && Array.isArray((error as { errors?: unknown[] }).errors)
				? (error as { errors: Array<{ text?: string; location?: { line?: number; column?: number } }> }).errors
				: undefined;

	if (!errors || errors.length === 0) {
		return `TypeScript error: ${error instanceof Error ? error.stack || error.message : String(error)}`;
	}

	return [
		"TypeScript error:",
		...errors.map((entry) => {
			const line = entry.location?.line ? Math.max(1, entry.location.line - 1) : undefined;
			const column = entry.location?.column !== undefined ? entry.location.column + 1 : undefined;
			const location = line ? ` at code-mode.ts:${line}${column ? `:${column}` : ""}` : "";
			const frame = line ? buildCodeFrame(source, line, column) : "";
			return `${entry.text ?? "Unknown TypeScript error"}${location}${frame ? `\n${frame}` : ""}`;
		}),
	].join("\n\n");
}

function formatRuntimeError(error: unknown, source: string, userCodeStartLine: number): string {
	const raw = error instanceof Error ? error.stack || error.message : String(error);
	const sourceLines = source.replace(/\r/g, "").split("\n");
	let firstUserLine: number | undefined;
	let firstUserColumn: number | undefined;

	const mapped = raw.replace(/<isolated-vm>:(\d+):(\d+)/g, (full, lineText, columnText) => {
		const absoluteLine = Number(lineText);
		const absoluteColumn = Number(columnText);
		if (!Number.isFinite(absoluteLine) || !Number.isFinite(absoluteColumn)) return full;
		const userLine = absoluteLine - userCodeStartLine + 1;
		if (userLine < 1 || userLine > sourceLines.length) return full;
		if (firstUserLine === undefined) {
			firstUserLine = userLine;
			firstUserColumn = absoluteColumn;
		}
		return `code-mode.ts:${userLine}:${absoluteColumn}`;
	});

	if (firstUserLine === undefined) {
		return mapped;
	}

	const frame = buildCodeFrame(source, firstUserLine, firstUserColumn);
	return frame ? `${mapped}\n\n${frame}` : mapped;
}

const SANDBOX_HELPERS = String.raw`
function __formatForConsole(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function __toolValueToText(name, value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.stdout === "string" || typeof value.stderr === "string") {
      return String(value.stdout ?? "") + String(value.stderr ?? "");
    }
  }
  return __formatForConsole(value);
}

function lines(text) {
  const normalized = String(text ?? "").replace(/\r/g, "");
  if (!normalized) return [];
  const result = normalized.split("\n");
  if (result.length > 0 && result[result.length - 1] === "") result.pop();
  return result;
}

function dedent(text) {
  const normalized = String(text ?? "").replace(/\r/g, "");
  let resultLines = normalized.split("\n");

  while (resultLines.length > 0 && resultLines[0].trim() === "") resultLines.shift();
  while (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() === "") resultLines.pop();

  const indents = resultLines
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.match(/^\s*/) || [""])[0].length);

  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return resultLines.map((line) => line.slice(minIndent)).join("\n");
}

function assert(condition, message = "Assertion failed") {
  if (!condition) throw new Error(message);
}

function chunk(items, size) {
  assert(Number.isInteger(size) && size > 0, "chunk size must be a positive integer");
  const array = Array.from(items ?? []);
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

async function mapLimit(items, limit, fn) {
  assert(Number.isInteger(limit) && limit > 0, "mapLimit limit must be a positive integer");
  const array = Array.from(items ?? []);
  const results = new Array(array.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= array.length) return;
      results[index] = await fn(array[index], index);
    }
  }

  const workerCount = Math.min(limit, array.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function __extractJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("No JSON found in empty output");

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through and attempt to extract the first JSON object/array block.
  }

  for (let start = 0; start < trimmed.length; start++) {
    const first = trimmed[start];
    if (first !== "{" && first !== "[") continue;

    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];

      if (inString) {
        if (escaping) {
          escaping = false;
        } else if (ch === "\\") {
          escaping = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{" || ch === "[") depth++;
      if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error(
    "Could not parse JSON from output:\n" + trimmed.slice(0, 1000) + (trimmed.length > 1000 ? "…" : ""),
  );
}

async function callTool(name, params) {
  const fn = __toolCallers[name];
  if (!fn) {
    return {
      ok: false,
      error: "Unknown tool: " + String(name) + ". Available tools: " + availableTools.join(", "),
    };
  }

  try {
    const res = await fn(params);
    if (!res || res.success !== true) {
      return { ok: false, error: String(res && res.error ? res.error : "Unknown tool error") };
    }
    return { ok: true, value: res.value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function mustCallTool(name, params) {
  const res = await callTool(name, params);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

async function readText(path, options = {}) {
  return external_read({ path, ...options });
}

async function readAsset(path, options = {}) {
  const value = await mustCallTool("read", { path, ...options });
  if (value && typeof value === "object") return value;
  return {
    kind: "read",
    path,
    text: __toolValueToText("read", value),
  };
}

async function readMany(paths, options = {}) {
  const { concurrency = 8, ...readOptions } = options ?? {};
  return mapLimit(paths, concurrency, async (path) => ({
    path,
    asset: await readAsset(path, readOptions),
  }));
}

async function readLines(path, options = {}) {
  return lines(await readText(path, options));
}

async function readJson(path) {
  return __extractJson(await external_read({ path }));
}

async function readJsonMany(paths, options = {}) {
  const { concurrency = 8 } = options ?? {};
  return mapLimit(paths, concurrency, async (path) => ({
    path,
    value: await readJson(path),
  }));
}

async function writeJson(path, value, space = 2) {
  const content = JSON.stringify(value, null, space);
  if (content === undefined) {
    throw new Error("writeJson() received a value that is not JSON-serializable");
  }
  return external_write({ path, content: content.endsWith("\n") ? content : content + "\n" });
}

async function bashResult(params) {
  const value = await mustCallTool("bash", params);
  if (value && typeof value === "object") return value;
  const text = __toolValueToText("bash", value);
  return {
    kind: "bash",
    text,
    stdout: text,
    stderr: "",
    exitCode: 0,
    ok: true,
    killed: false,
  };
}

async function bashLines(params) {
  return lines((await bashResult(params)).text ?? "");
}

async function bashJson(params) {
  return __extractJson((await bashResult(params)).text ?? "");
}

async function grepResult(params) {
  const value = await mustCallTool("grep", params);
  if (value && typeof value === "object") return value;
  const text = __toolValueToText("grep", value);
  const outputLines = lines(text);
  return {
    kind: "grep",
    text,
    stdout: text,
    stderr: "",
    lines: outputLines,
    exitCode: outputLines.length > 0 ? 0 : 1,
    ok: true,
    matched: outputLines.length > 0,
    noMatches: outputLines.length === 0,
  };
}

function __parseGrepLine(line) {
  const match = /^(.*?)([:\-])(\d+)([:\-])(.*)$/.exec(String(line ?? ""));
  if (!match) return { raw: String(line ?? ""), matched: false };
  return {
    path: match[1],
    line: Number(match[3]),
    text: match[5],
    matched: match[2] === ":",
    raw: String(line ?? ""),
  };
}

async function grepLines(params) {
  return (await grepResult(params)).lines ?? [];
}

async function grepEntries(params) {
  return (await grepResult(params)).lines.map(__parseGrepLine);
}

async function findResult(params) {
  const value = await mustCallTool("find", params);
  if (value && typeof value === "object") return value;
  const text = __toolValueToText("find", value);
  const paths = lines(text);
  return {
    kind: "find",
    text,
    stdout: text,
    stderr: "",
    paths,
    exitCode: 0,
    ok: true,
    matched: paths.length > 0,
    noMatches: paths.length === 0,
  };
}

async function findPaths(params) {
  return (await findResult(params)).paths ?? [];
}

async function lsResult(params = {}) {
  const value = await mustCallTool("ls", params);
  if (value && typeof value === "object") return value;
  const text = __toolValueToText("ls", value);
  return {
    kind: "ls",
    text,
    entries: lines(text),
    path: params.path ?? ".",
  };
}

async function lsEntries(params = {}) {
  return (await lsResult(params)).entries ?? [];
}

function __countLinesBefore(text, index) {
  let count = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

function __truncatePreview(text, maxLines = 12, maxChars = 1200) {
  const normalized = String(text ?? "").replace(/\r/g, "");
  const lineList = normalized.split("\n");
  const sliced = lineList.slice(0, maxLines).join("\n");
  const truncatedByLines = lineList.length > maxLines;
  const truncatedByChars = sliced.length > maxChars;
  const body = truncatedByChars ? sliced.slice(0, maxChars) : sliced;
  return body + (truncatedByLines || truncatedByChars ? "\n…" : "");
}

function __normalizeEdits(edits) {
  assert(Array.isArray(edits) && edits.length > 0, "edits must be a non-empty array");
  return edits.map((edit, index) => {
    assert(edit && typeof edit === "object", "edit " + (index + 1) + " must be an object");
    assert(typeof edit.oldText === "string", "edit " + (index + 1) + " is missing oldText");
    assert(typeof edit.newText === "string", "edit " + (index + 1) + " is missing newText");
    return { oldText: edit.oldText, newText: edit.newText };
  });
}

function __buildEditPreview(path, originalContent, editsInput) {
  const edits = __normalizeEdits(editsInput);
  const matches = edits
    .map((edit, index) => {
      const start = originalContent.indexOf(edit.oldText);
      if (start === -1) {
        throw new Error("oldText not found in " + path + ': "' + edit.oldText.slice(0, 80) + '..."');
      }
      const next = originalContent.indexOf(edit.oldText, start + 1);
      if (next !== -1) {
        throw new Error("oldText matched more than once in " + path + ': "' + edit.oldText.slice(0, 80) + '..."');
      }
      return {
        index,
        start,
        end: start + edit.oldText.length,
        oldText: edit.oldText,
        newText: edit.newText,
        line: __countLinesBefore(originalContent, start),
      };
    })
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < matches.length; i++) {
    if (matches[i].start < matches[i - 1].end) {
      throw new Error("edit " + (matches[i].index + 1) + " overlaps another edit in " + path);
    }
  }

  const diff = matches
    .map((match) => {
      const oldPreview = __truncatePreview(match.oldText)
        .split("\n")
        .map((line) => "- " + line);
      const newPreview = __truncatePreview(match.newText)
        .split("\n")
        .map((line) => "+ " + line);
      return ["@@ line " + match.line + " @@", ...oldPreview, ...newPreview].join("\n");
    })
    .join("\n\n");

  return {
    kind: "edit-preview",
    path,
    edits,
    editsApplied: edits.length,
    firstChangedLine: matches[0] ? matches[0].line : undefined,
    diff,
  };
}

async function previewEdits(path, edits) {
  return __buildEditPreview(path, await readText(path), edits);
}

async function applyFileEdits(path, edits) {
  const preview = await previewEdits(path, edits);
  const value = await mustCallTool("edit", { path, edits: preview.edits });
  if (value && typeof value === "object") {
    return {
      ...value,
      firstChangedLine: value.firstChangedLine ?? preview.firstChangedLine,
      diff: value.diff ?? preview.diff,
      preview,
    };
  }
  return {
    kind: "edit",
    text: __toolValueToText("edit", value),
    path,
    editsApplied: preview.editsApplied,
    firstChangedLine: preview.firstChangedLine,
    diff: preview.diff,
    preview,
  };
}

async function writeResult(path, content) {
  const value = await mustCallTool("write", { path, content });
  if (value && typeof value === "object") return value;
  return {
    kind: "write",
    text: __toolValueToText("write", value),
    path,
  };
}

async function batchEdits(changes) {
  assert(Array.isArray(changes), "batchEdits() expects an array of change objects");
  const prepared = [];

  for (const change of changes) {
    assert(change && typeof change === "object", "Each batch edit change must be an object");
    assert(typeof change.path === "string", "Each batch edit change must include a path");
    prepared.push({
      path: change.path,
      preview: await previewEdits(change.path, change.edits),
    });
  }

  const results = [];
  for (const item of prepared) {
    const value = await mustCallTool("edit", { path: item.path, edits: item.preview.edits });
    if (value && typeof value === "object") {
      results.push({
        ...value,
        firstChangedLine: value.firstChangedLine ?? item.preview.firstChangedLine,
        diff: value.diff ?? item.preview.diff,
        preview: item.preview,
      });
    } else {
      results.push({
        kind: "edit",
        text: __toolValueToText("edit", value),
        path: item.path,
        editsApplied: item.preview.editsApplied,
        firstChangedLine: item.preview.firstChangedLine,
        diff: item.preview.diff,
        preview: item.preview,
      });
    }
  }

  return {
    previews: prepared.map((item) => item.preview),
    results,
  };
}
`;

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
			error: formatTransformError(err, code),
			consoleOutput: [],
			duration: Date.now() - start,
		};
	}

	const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
	let userCodeStartLine = 0;

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

		const toolFunctions = externals
			.map((ext) => {
				const lowLevel = `
async function __tool_${ext.name}(params) {
  const json = await __ref_${ext.name}.applySyncPromise(undefined, [JSON.stringify(params)]);
  return JSON.parse(json);
}`;

				const externalWrapper = ext.name === "bash"
					? `
async function external_${ext.name}(params) {
  const value = await mustCallTool("${ext.name}", params);
  const text = __toolValueToText("${ext.name}", value);
  if (value && typeof value === "object" && value.ok === false) {
    throw new Error((text ? text + "\\n\\n" : "") + "Command exited with code " + String(value.exitCode ?? 1));
  }
  return text;
}`
					: ext.name === "grep" || ext.name === "find"
						? `
async function external_${ext.name}(params) {
  const value = await mustCallTool("${ext.name}", params);
  if (value && typeof value === "object" && value.ok === false) {
    throw new Error(String(value.error ?? __toolValueToText("${ext.name}", value) ?? "${ext.name} failed"));
  }
  return __toolValueToText("${ext.name}", value);
}`
						: `
async function external_${ext.name}(params) {
  const value = await mustCallTool("${ext.name}", params);
  return __toolValueToText("${ext.name}", value);
}`;

				return lowLevel + externalWrapper;
			})
			.join("\n");

		const toolRegistryDeclaration = `
const __toolCallers = Object.freeze({
${externals.map((ext) => `  ${JSON.stringify(ext.name)}: __tool_${ext.name},`).join("\n")}
});
const availableTools = Object.freeze(${JSON.stringify(externals.map((ext) => ext.name))});
`;

		const bootstrap = `
const console = {
  log: (...args) => __logRef.applySync(undefined, [args.map(__formatForConsole).join(" ")]),
  warn: (...args) => __logRef.applySync(undefined, ["[warn] " + args.map(__formatForConsole).join(" ")]),
  error: (...args) => __logRef.applySync(undefined, ["[error] " + args.map(__formatForConsole).join(" ")]),
  info: (...args) => __logRef.applySync(undefined, [args.map(__formatForConsole).join(" ")]),
};
${toolFunctions}
${toolRegistryDeclaration}
${SANDBOX_HELPERS}
`;

		const scriptPrefix = `
${bootstrap}

(async () => {
  try {
    const __result = await (async () => {
`;
		const scriptSuffix = `
    })();
    return JSON.stringify(__result);
  } catch (__err) {
    throw __err;
  }
})()
`;
		userCodeStartLine = scriptPrefix.split("\n").length;

		// Wrap in async IIFE, serialize result as JSON for safe isolate boundary crossing
		const fullScript = `${scriptPrefix}${strippedCode}${scriptSuffix}`;

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
		return {
			success: false,
			error: formatRuntimeError(err, strippedCode, userCodeStartLine),
			consoleOutput,
			duration: Date.now() - start,
		};
	} finally {
		isolate.dispose();
	}
}
