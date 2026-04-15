/**
 * Generates TypeScript type stubs for all active pi tools so the LLM can
 * write typed code against them inside the sandbox.
 */

export interface ToolSchema {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/**
 * Convert a JSON Schema property to a rough TypeScript type string.
 */
function jsonSchemaToTS(schema: Record<string, unknown>, indent = 0): string {
	const pad = "  ".repeat(indent);

	if (!schema || typeof schema !== "object") return "unknown";

	const type = schema.type as string | undefined;

	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "null") return "null";

	if (type === "array") {
		const items = schema.items as Record<string, unknown> | undefined;
		if (items) return `Array<${jsonSchemaToTS(items, indent)}>`;
		return "unknown[]";
	}

	if (type === "object" || schema.properties) {
		const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
		if (!props || Object.keys(props).length === 0) return "Record<string, unknown>";

		const required = new Set((schema.required as string[]) ?? []);
		const lines: string[] = ["{"];
		for (const [key, propSchema] of Object.entries(props)) {
			const opt = required.has(key) ? "" : "?";
			const desc = propSchema.description ? ` /** ${propSchema.description} */` : "";
			lines.push(`${pad}  ${desc}`);
			lines.push(`${pad}  ${key}${opt}: ${jsonSchemaToTS(propSchema, indent + 1)};`);
		}
		lines.push(`${pad}}`);
		return lines.join("\n");
	}

	// anyOf / oneOf
	const anyOf = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
	if (anyOf) {
		return anyOf.map((s) => jsonSchemaToTS(s, indent)).join(" | ");
	}

	// enum
	if (schema.enum) {
		return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
	}

	return "unknown";
}

/**
 * Build the full TypeScript type stubs and declarations for external_* functions.
 */
export function generateTypeStubs(tools: ToolSchema[]): string {
	const declarations: string[] = [];

	for (const tool of tools) {
		const paramsType = jsonSchemaToTS(tool.parameters);

		declarations.push(`
/**
 * ${tool.description}
 */
declare function external_${tool.name}(params: ${paramsType}): Promise<string>;
`);
	}

	return declarations.join("\n");
}

function generateHelperStubs(): string {
	return `
/** Names of tools directly bridged into Code Mode. */
declare const availableTools: readonly string[];

/** Split text into lines and drop one trailing empty line if present. */
declare function lines(text: string): string[];

/** Remove common indentation from a multiline string. */
declare function dedent(text: string): string;

/** Throw if a condition is falsy. */
declare function assert(condition: unknown, message?: string): asserts condition;

/** Split an array into evenly sized chunks. */
declare function chunk<T>(items: T[], size: number): T[][];

/** Run async work with bounded parallelism while preserving result order. */
declare function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;

/** Try a bridged tool dynamically and get a success/error envelope instead of throwing. */
declare function callTool<T = unknown>(name: string, params: unknown): Promise<{ ok: true; value: T } | { ok: false; error: string }>;

/** Call a bridged tool dynamically and throw on failure. */
declare function mustCallTool<T = unknown>(name: string, params: unknown): Promise<T>;

/** Convenience wrapper around external_read({ path, ...options }). */
declare function readText(path: string, options?: { offset?: number; limit?: number }): Promise<string>;

declare type ReadTextAsset = {
  kind: "read";
  path: string;
  text: string;
  startLine?: number;
  endLine?: number;
  lineCount?: number;
  totalLines?: number;
};

declare type ReadImageAsset = {
  kind: "image";
  path: string;
  text: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: number;
  base64?: string;
};

/** Read a file as a structured asset. Images return metadata and may include base64 for smaller files. */
declare function readAsset(path: string, options?: { offset?: number; limit?: number }): Promise<ReadTextAsset | ReadImageAsset>;

/** Read many files with bounded parallelism and get structured assets back. */
declare function readMany(paths: string[], options?: { concurrency?: number; offset?: number; limit?: number }): Promise<Array<{
  path: string;
  asset: ReadTextAsset | ReadImageAsset;
}>>;

/** Read a text file and split it into lines. */
declare function readLines(path: string, options?: { offset?: number; limit?: number }): Promise<string[]>;

/** Read and parse a JSON file. */
declare function readJson<T = unknown>(path: string): Promise<T>;

/** Read many JSON files with bounded parallelism. */
declare function readJsonMany<T = unknown>(paths: string[], options?: { concurrency?: number }): Promise<Array<{
  path: string;
  value: T;
}>>;

/** Structured result for write operations. */
declare function writeResult(path: string, content: string): Promise<{
  kind: "write";
  text: string;
  path: string;
  bytesWritten?: number;
}>;

/** JSON.stringify(value, null, space) and write it with a trailing newline. */
declare function writeJson(path: string, value: unknown, space?: number): Promise<string>;

/** Structured result for bash commands, including exit code and separated stdout/stderr. */
declare function bashResult(params: Parameters<typeof external_bash>[0]): Promise<{
  kind: "bash";
  text: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
  killed?: boolean;
}>;

/** Run bash and split the combined output into lines. */
declare function bashLines(params: Parameters<typeof external_bash>[0]): Promise<string[]>;

/** Run bash and parse JSON from the output. Accepts either pure JSON or JSON embedded in surrounding text. */
declare function bashJson<T = unknown>(params: Parameters<typeof external_bash>[0]): Promise<T>;

/** Structured grep result. noMatches is not treated as an error. */
declare function grepResult(params: Parameters<typeof external_grep>[0]): Promise<{
  kind: "grep";
  text: string;
  stdout: string;
  stderr: string;
  lines: string[];
  exitCode: number;
  ok: boolean;
  matched: boolean;
  noMatches: boolean;
  error?: string;
}>;

/** Parse grep output lines into path/line/text entries. Context lines are marked with matched=false. */
declare function grepEntries(params: Parameters<typeof external_grep>[0]): Promise<Array<{
  path?: string;
  line?: number;
  text?: string;
  matched: boolean;
  raw: string;
}>>;

/** Run grep and return matching lines as an array. */
declare function grepLines(params: Parameters<typeof external_grep>[0]): Promise<string[]>;

/** Structured find result. noMatches is not treated as an error. */
declare function findResult(params: Parameters<typeof external_find>[0]): Promise<{
  kind: "find";
  text: string;
  stdout: string;
  stderr: string;
  paths: string[];
  exitCode: number;
  ok: boolean;
  matched: boolean;
  noMatches: boolean;
  error?: string;
}>;

/** Run find and return matching paths as an array. */
declare function findPaths(params: Parameters<typeof external_find>[0]): Promise<string[]>;

/** Structured result for ls. */
declare function lsResult(params?: Parameters<typeof external_ls>[0]): Promise<{
  kind: "ls";
  text: string;
  entries: string[];
  path: string;
}>;

/** Run ls and return entries as an array. */
declare function lsEntries(params?: Parameters<typeof external_ls>[0]): Promise<string[]>;

/** Preview an edit without modifying the file, including first changed line and a compact diff. */
declare function previewEdits(path: string, edits: Parameters<typeof external_edit>[0]["edits"]): Promise<{
  kind: "edit-preview";
  path: string;
  edits: Parameters<typeof external_edit>[0]["edits"];
  editsApplied: number;
  firstChangedLine?: number;
  diff: string;
}>;

/** Apply edits to one file and get structured metadata back. */
declare function applyFileEdits(path: string, edits: Parameters<typeof external_edit>[0]["edits"]): Promise<{
  kind: "edit";
  text: string;
  path: string;
  editsApplied: number;
  firstChangedLine?: number;
  diff: string;
  preview: Awaited<ReturnType<typeof previewEdits>>;
}>;

/** Validate all edits first, then apply them sequentially across multiple files. */
declare function batchEdits(changes: Array<{
  path: string;
  edits: Parameters<typeof external_edit>[0]["edits"];
}>): Promise<{
  previews: Array<Awaited<ReturnType<typeof previewEdits>>>;
  results: Array<Awaited<ReturnType<typeof applyFileEdits>>>;
}>;
`;
}

function generateExamples(): string {
	return `
### Helper functions

Code Mode also provides a few built-in helpers so you do less string parsing and boilerplate:

\`\`\`typescript
${generateHelperStubs().trim()}
\`\`\`

### Examples

Read JSON and summarize it:

\`\`\`typescript
const pkg = await readJson<{ name?: string; scripts?: Record<string, string> }>("package.json");
return {
  name: pkg.name,
  scripts: Object.keys(pkg.scripts ?? {}),
};
\`\`\`

Run bounded parallel work across many files:

\`\`\`typescript
const files = await findPaths({ path: "src", pattern: "**/*.ts", limit: 200 });
const summaries = await mapLimit(files, 8, async (file) => {
  const text = await readText(file);
  return { file, lines: lines(text).length };
});
return summaries;
\`\`\`

Read either text or an image asset:

\`\`\`typescript
const asset = await readAsset("screenshot.png");
if (asset.kind === "image") {
  return {
    mimeType: asset.mimeType,
    bytes: asset.bytes,
    hasBase64: !!asset.base64,
  };
}
return { textPreview: asset.text.slice(0, 200) };
\`\`\`

Read many files with bounded parallelism:

\`\`\`typescript
const files = ["package.json", "tsconfig.json"];
const loaded = await readMany(files, { concurrency: 2 });
return loaded.map((entry) => ({
  path: entry.path,
  kind: entry.asset.kind,
}));
\`\`\`

Inspect a bash command without throwing on non-zero exit:

\`\`\`typescript
const result = await bashResult({ command: "git status --short", timeout: 20 });
return {
  ok: result.ok,
  exitCode: result.exitCode,
  lines: lines(result.stdout),
};
\`\`\`

Handle grep/find without guessing whether an empty result is an error:

\`\`\`typescript
const grep = await grepResult({
  pattern: "TODO",
  path: "src",
  glob: "*.ts",
  limit: 20,
});
if (!grep.ok) throw new Error(grep.error ?? "grep failed");
if (grep.noMatches) return [];
return grep.lines;
\`\`\`

Parse grep output into structured entries:

\`\`\`typescript
const entries = await grepEntries({
  pattern: "TODO",
  path: "src",
  glob: "*.ts",
  limit: 20,
});
return entries.filter((entry) => entry.matched);
\`\`\`

Call a bridged tool dynamically:

\`\`\`typescript
const grep = await callTool<{ text: string; lines?: string[] }>("grep", {
  pattern: "TODO",
  path: "src",
  glob: "*.ts",
  limit: 20,
});
if (!grep.ok) return grep;
return grep.value.lines ?? lines(grep.value.text);
\`\`\`

Preview and apply safe multi-file edits:

\`\`\`typescript
const plan = [
  {
    path: "src/a.ts",
    edits: [{ oldText: "foo", newText: "bar" }],
  },
  {
    path: "src/b.ts",
    edits: [{ oldText: "baz", newText: "qux" }],
  },
];

const preview = await batchEdits(plan);
return preview.results.map((result) => ({
  path: result.path,
  firstChangedLine: result.firstChangedLine,
  diff: result.diff,
}));
\`\`\`
`;
}

/**
 * Build the system prompt snippet explaining Code Mode to the LLM.
 */
export function buildCodeModeSystemPrompt(tools: ToolSchema[]): string {
	const stubs = generateTypeStubs(tools);
	const examples = generateExamples();

	return `## Code Mode

You have access to an \`execute_typescript\` tool. Instead of calling tools one-by-one, you
can write a short TypeScript program that composes tools with loops, conditionals,
Promise.all, and data transformations. The code runs in a V8 isolate sandbox.

### Available external functions

Each bridged tool is available as an \`external_*\` async function. They accept the same
parameter object as the original tool and return the tool's text result as a string.

\`\`\`typescript
${stubs}
\`\`\`

${examples}

### Rules

- Your code MUST use \`return\` at the top level to produce a result (the sandbox wraps it in an async function).
- Use \`external_*\` functions to interact with the filesystem and run commands.
- Prefer the built-in helpers (like \`readAsset()\`, \`readMany()\`, \`readJson()\`, \`readJsonMany()\`, \`bashResult()\`, \`bashJson()\`, \`grepResult()\`, \`grepEntries()\`, \`findResult()\`, \`findPaths()\`, \`previewEdits()\`, \`batchEdits()\`, and \`mapLimit()\`) when they reduce boilerplate.
- Use \`callTool()\` / \`mustCallTool()\` when you want dynamic tool selection or structured access to a bridged tool result.
- \`console.log()\` output is captured and included in the result.
- TypeScript type annotations are stripped before execution. Write idiomatic TS.
- The sandbox has a 120-second timeout and no network/filesystem access outside of external_* calls.
- Prefer \`Promise.all()\` to parallelize independent operations.
- Prefer computing results (math, aggregation, filtering) in code instead of asking the LLM.
- Prefer returning structured objects/arrays when useful; Code Mode will pretty-print JSON results.

### When to use Code Mode

- When you need to compose 3+ tool calls
- When you need to parallelize operations (e.g. reading multiple files)
- When you need to do math, aggregation, or data transformation on tool results
- When you need loops or conditionals over tool results
- When helper functions like \`readAsset()\`, \`readMany()\`, \`readJson()\`, \`readJsonMany()\`, \`bashResult()\`, \`grepResult()\`, \`grepEntries()\`, \`findResult()\`, \`findPaths()\`, \`previewEdits()\`, \`batchEdits()\`, or \`mapLimit()\` simplify the task

### When NOT to use Code Mode

- For a single simple tool call (just call the tool directly)
- When the user is asking a question that doesn't need tools`;
}
