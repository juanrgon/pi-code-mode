# Upstream proposal: `pi.invokeTool()` — programmatic tool invocation for extensions

*Draft for an issue/PR against [earendil-works/pi](https://github.com/earendil-works/pi).*

## Motivation

A growing class of extensions needs to **execute other tools programmatically**:

- **Code Mode** extensions ([juanrgon/pi-code-mode](https://github.com/juanrgon/pi-code-mode), [Hor1zonZzz/pi-codeMode](https://github.com/Hor1zonZzz/pi-codeMode)): the LLM writes a program that orchestrates many tool calls in one round-trip (the CodeAct / Cloudflare Code Mode / Anthropic "code execution with MCP" pattern).
- **Subagent / workflow extensions** that decompose a task and run tools on the model's behalf.
- **Macro tools** that compose built-ins (e.g. "apply this refactor across N files").

Today there is no public API for this. `pi.getAllTools()` returns metadata only (`ToolInfo`: name, description, parameters, sourceInfo) — no `execute`. Extensions work around it by recreating built-in definitions via `create*ToolDefinition(cwd)` and calling `execute()` directly. That works for the seven core tools, but has three structural problems:

1. **Policy bypass.** Direct `execute()` calls skip `tool_call` / `tool_result` extension hooks. A permission-gate extension that blocks `rm -rf` in `tool_call` never sees a bash command issued from inside a Code Mode program. Users reasonably expect gates to apply to *all* tool executions, however they're initiated.
2. **No access to third-party tools.** Extension-registered tools (MCP bridges, domain tools) can't be recreated from factories — they're simply unreachable. This caps Code Mode at shell-expressible built-ins, which is exactly the slice where it adds least value over `bash`.
3. **No validation/preparation.** The agent runtime validates arguments against the schema and runs `prepareArguments` before `execute`. Callers of raw `execute()` must remember to do this themselves (or silently skip it).

## Proposed API

```typescript
interface ExtensionAPI {
  /**
   * Invoke an active tool programmatically, as if the LLM had called it.
   * Runs argument preparation, schema validation, tool_call hooks (blockable),
   * execution, and tool_result hooks.
   */
  invokeTool(
    name: string,
    input: unknown,
    options?: {
      /** Abort signal; aborts execution like Esc does. */
      signal?: AbortSignal;
      /**
       * Tool call id of the initiating tool, for attribution. Synthetic ids are
       * derived from it (e.g. "<parent>#3"). Events and session entries carry it
       * so UIs can group nested calls under the initiating tool.
       */
      parentToolCallId?: string;
      /** Streaming updates from the tool, same shape as onUpdate. */
      onUpdate?: (partial: AgentToolResult<unknown>) => void;
      /**
       * Whether the invocation appears in the session transcript as a tool
       * result message. Default false: the result is returned to the caller
       * only, and the initiating tool decides what enters context.
       */
      record?: boolean;
    },
  ): Promise<AgentToolResult<unknown>>;
}
```

### Semantics

- **Lookup:** resolves against *active* tools (including extension-registered and overridden tools). Unknown/inactive → throws.
- **Pipeline parity:** runs the same steps as an LLM-initiated call: `prepareArguments` → schema validation → `tool_call` event (a block rejects with the block reason) → `execute` → `tool_result` event (result patches apply). This is the key property: one enforcement path for all tool executions.
- **Context:** results are returned to the caller and do **not** enter the LLM context unless `record: true`. Code Mode's whole point is keeping intermediate results out of context; the initiating tool summarizes.
- **Concurrency:** participates in the same file-mutation queue and any per-tool `executionMode` constraints as normal calls.
- **Reentrancy:** `invokeTool` from inside a tool executed via `invokeTool` is allowed; pi may cap nesting depth defensively.

### Non-goals

- Not a session/transcript manipulation API (that's `sendMessage`/`appendEntry`).
- Not remote execution (that's tool `operations`).
- No UI rendering of nested calls required for v1 — `parentToolCallId` leaves room for it later.

## What this unlocks

With `invokeTool`, a Code Mode extension shrinks (no tool recreation, no validation duplication) and becomes **generic**: it can bridge *every* active tool — web search, MCP tools, domain tools — into the sandbox by generating typed stubs from `pi.getAllTools()` metadata and dispatching through `invokeTool`. That is the configuration where the Code Mode pattern pays off most (Anthropic reports large token reductions orchestrating many MCP tools through code), and it preserves the security/permission model extensions already rely on.

## Alternatives considered

- **Status quo (recreate built-ins via `create*ToolDefinition`):** works for core tools; bypasses hooks; can't reach third-party tools. This is what pi-code-mode v2 ships today.
- **Expose `execute` on `getAllTools()`:** simpler, but encourages exactly the hook-bypassing direct calls this proposal tries to eliminate, and freezes the internal execution pipeline as public API.
- **An events-only contract (emit synthetic tool_call/tool_result):** preserves observability but not blocking semantics, and pushes pipeline-ordering responsibilities onto every extension author.
