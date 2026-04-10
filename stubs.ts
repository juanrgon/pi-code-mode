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

/**
 * Build the system prompt snippet explaining Code Mode to the LLM.
 */
export function buildCodeModeSystemPrompt(tools: ToolSchema[]): string {
	const stubs = generateTypeStubs(tools);

	return `## Code Mode

You have access to an \`execute_typescript\` tool. Instead of calling tools one-by-one, you
can write a short TypeScript program that composes multiple tool calls with loops, conditionals,
Promise.all, and data transformations. The code runs in a V8 isolate sandbox.

### Available external functions

Each of pi's tools is available as an \`external_*\` async function. They accept the same
parameter object as the original tool and return the tool's text result as a string.

\`\`\`typescript
${stubs}
\`\`\`

### Rules

- Your code MUST use \`return\` at the top level to produce a result (the sandbox wraps it in an async function).
- Use \`external_*\` functions to interact with the filesystem and run commands.
- \`console.log()\` output is captured and included in the result.
- TypeScript type annotations are stripped before execution. Write idiomatic TS.
- The sandbox has a 120-second timeout and no network/filesystem access outside of external_* calls.
- Prefer \`Promise.all()\` to parallelize independent operations.
- Prefer computing results (math, aggregation, filtering) in code instead of asking the LLM.

### When to use Code Mode

- When you need to compose 3+ tool calls
- When you need to parallelize operations (e.g. reading multiple files)
- When you need to do math, aggregation, or data transformation on tool results
- When you need loops or conditionals over tool results

### When NOT to use Code Mode

- For a single simple tool call (just call the tool directly)
- When the user is asking a question that doesn't need tools`;
}
