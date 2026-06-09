/**
 * Builds the Code Mode system prompt section: typed `tools.*` declarations
 * generated from the live tool schemas, result types, helper declarations,
 * and a couple of examples. Kept deliberately small — this text is injected
 * into every request while Code Mode is enabled.
 */
import { SANDBOX_HELPER_NAMES } from "./worker-source.js";

export interface BridgedToolSchema {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** Convert a JSON Schema to a compact TypeScript type string. */
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
		return items ? `Array<${jsonSchemaToTS(items, indent)}>` : "unknown[]";
	}

	if (type === "object" || schema.properties) {
		const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
		if (!props || Object.keys(props).length === 0) return "Record<string, unknown>";
		const required = new Set((schema.required as string[]) ?? []);
		const out: string[] = ["{"];
		for (const [key, propSchema] of Object.entries(props)) {
			const opt = required.has(key) ? "" : "?";
			const desc = typeof propSchema.description === "string" ? ` /** ${propSchema.description} */` : "";
			out.push(`${pad}  ${key}${opt}: ${jsonSchemaToTS(propSchema, indent + 1)};${desc}`);
		}
		out.push(`${pad}}`);
		return out.join("\n");
	}

	const anyOf = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
	if (anyOf) return anyOf.map((s) => jsonSchemaToTS(s, indent)).join(" | ");
	if (schema.enum) return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
	return "unknown";
}

/** Per-tool result type extras beyond `text` (must match the bridge in index.ts). */
const RESULT_EXTRAS: Record<string, string> = {
	read: `{ kind: "text" | "image"; truncated: boolean }`,
	bash: `{ truncated: boolean; fullOutputPath?: string }`,
	edit: `{ diff: string; firstChangedLine?: number }`,
	write: `{}`,
	grep: `{ truncated: boolean }`,
	find: `{ truncated: boolean }`,
	ls: `{ truncated: boolean }`,
};

const TOOL_NOTES: Record<string, string> = {
	bash: " Throws on non-zero exit (the error message contains the output); use tools.try for fallible commands.",
	read: " Reading an image attaches it to the final result (max 3 per run); result.text is just a marker.",
};

function buildToolsDeclaration(tools: BridgedToolSchema[]): string {
	const methods = tools.map((tool) => {
		const params = jsonSchemaToTS(tool.parameters, 1);
		const extras = RESULT_EXTRAS[tool.name] ?? "{}";
		const result = extras === "{}" ? "ToolText" : `ToolText & ${extras}`;
		const note = TOOL_NOTES[tool.name] ?? "";
		return `  /** ${tool.description.replace(/\n+/g, " ")}${note} */\n  ${tool.name}(params: ${params}): Promise<${result}>;`;
	});

	return `/** Every tool result includes the tool's text output. */
type ToolText = { text: string };

declare const tools: {
${methods.join("\n\n")}

  /** Non-throwing variant for any tool: returns the result with ok: true, or { ok: false, error } instead of throwing. */
  try(name: ${tools.map((t) => JSON.stringify(t.name)).join(" | ")}, params: unknown): Promise<({ ok: true } & ToolText & Record<string, unknown>) | { ok: false; error: string }>;
};`;
}

const HELPERS_DECLARATION = `/** Split text into lines (drops one trailing empty line). */
declare function lines(text: string): string[];
/** Remove common leading indentation (useful for tools.write content). */
declare function dedent(text: string): string;
/** Run async work over items with bounded parallelism, preserving order. */
declare function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
/** tools.read + JSON.parse. */
declare function readJson<T = unknown>(path: string): Promise<T>;
/** tools.bash + parse JSON from the output (accepts a command string or bash params). */
declare function bashJson<T = unknown>(command: string | { command: string; timeout?: number }): Promise<T>;
/** tools.grep + parse output into { path, line, text } entries (use without the context option). */
declare function grepEntries(params: Parameters<typeof tools.grep>[0]): Promise<Array<{ path: string; line: number; text: string }>>;`;

// Compile-time check that the docs above cover exactly the sandbox helpers.
type HelperName = (typeof SANDBOX_HELPER_NAMES)[number];
const documentedHelpers: readonly HelperName[] = ["lines", "dedent", "mapLimit", "readJson", "bashJson", "grepEntries"];
void documentedHelpers;

const EXAMPLES = `Summarize matches across many files (parallel, bounded):

\`\`\`typescript
const entries = await grepEntries({ pattern: "TODO", glob: "*.ts" });
const byFile = [...new Set(entries.map((e) => e.path))];
const sizes = await mapLimit(byFile, 8, async (path) => {
  const r = await tools.read({ path });
  return { path, lines: lines(r.text).length };
});
return { todos: entries.length, files: sizes };
\`\`\`

Run a command, branch on the outcome, then edit:

\`\`\`typescript
const check = await tools.try("bash", { command: "npm run check", timeout: 120 });
if (check.ok) return "check passed, no edits needed";
const fix = await tools.edit({
  path: "src/config.ts",
  edits: [{ oldText: "debug: true", newText: "debug: false" }],
});
return { error: check.error.slice(0, 400), diff: fix.diff };
\`\`\``;

export function buildCodeModePrompt(tools: BridgedToolSchema[]): string {
	return `## Code Mode

You have an \`execute_typescript\` tool. Instead of calling tools one at a time, you can
write a TypeScript program that composes them with loops, conditionals, \`Promise.all\`,
and data transformations. Bridged tool calls execute concurrently on the host, so
\`Promise.all\` / \`mapLimit\` give real parallelism.

### Sandbox API

\`\`\`typescript
${buildToolsDeclaration(tools)}

${HELPERS_DECLARATION}
\`\`\`

These are the same tools you normally call directly (same parameters, same truncation
behavior); failures throw an \`Error\` whose message is the tool's error text.

### Examples

${EXAMPLES}

### Rules

- End with a top-level \`return\` — the returned value (JSON-serializable) is the result shown to you.
- \`console.log/info/warn/error\` output is captured and returned too.
- Compute in code (counting, math, filtering, aggregation) instead of eyeballing it afterwards.
- Prefer \`Promise.all\`/\`mapLimit\` for independent operations; they truly run in parallel.
- Return compact summaries, not entire file contents — the result lands in your context window.
- The sandbox has no network or filesystem access except through \`tools.*\`; it times out after 120s.
- Use Code Mode for multi-step work with loops/branching/aggregation. For a single tool call, call the tool directly.`;
}
