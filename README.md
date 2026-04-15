# pi-code-mode

A [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that gives the LLM an `execute_typescript` tool to compose multiple tool calls in a single round-trip.

Inspired by [TanStack AI Code Mode](https://tanstack.com/blog/tanstack-ai-code-mode) by Jack Herrington, Alem Tuzlak, and Tanner Linsley.

## Why

Without Code Mode, the LLM calls tools one at a time. Each tool call is a full round-trip: the model generates the call, the runtime executes it, the result goes back into the context window, and the model generates the next call. Reading 5 files means 5 round-trips, 5 tool-call blocks in the conversation, and the token cost compounds on every subsequent request.

With Code Mode, the LLM writes a short TypeScript program that does all of that in one shot:

```typescript
// Without Code Mode: 5 sequential round-trips
// With Code Mode: 1 round-trip, parallel execution
const files = ["package.json", "tsconfig.json", "README.md", "src/index.ts", "src/utils.ts"];

const contents = await Promise.all(
  files.map(path => external_read({ path }))
);

const summary = files.map((f, i) => `${f}: ${contents[i].split("\n").length} lines`);
return summary.join("\n");
```

The key insight from the [TanStack article](https://tanstack.com/blog/tanstack-ai-code-mode): LLMs are great at writing TypeScript but bad at math and orchestration. Code Mode lets the model do what it's good at (write code) and lets the JavaScript runtime handle what it's bad at (execution, parallelism, arithmetic).

**What changes in practice:**
- **Parallelism** — `Promise.all` instead of sequential tool calls
- **Less context bloat** — one tool call block instead of many, keeping the conversation lean
- **Correct math** — aggregation, counting, and transforms happen in JS, not token prediction
- **Fewer round-trips** — the model thinks once, then code runs to completion

## What's Included

Inside `execute_typescript`, Code Mode directly bridges these core pi tools:

- `external_read()`
- `external_bash()`
- `external_write()`
- `external_edit()`
- `external_grep()`
- `external_find()`
- `external_ls()`

It also injects helper utilities so the model can work at a higher level with less boilerplate, including:

- `readText()`, `readLines()`, `readJson()`, `readMany()`
- `readAsset()` for image-aware reads
- `bashResult()`, `bashLines()`, `bashJson()`
- `grepResult()`, `grepEntries()`, `findPaths()`, `lsEntries()`
- `previewEdits()`, `applyFileEdits()`, `batchEdits()`
- `mapLimit()`, `chunk()`, `lines()`, `dedent()`, `callTool()`, `mustCallTool()`

This merged version also adds safer structured tool results, batched edit helpers, and much better TypeScript/runtime error formatting.

## Install

```bash
pi install git:github.com/juanrgon/pi-code-mode
```

Or for a one-off test:

```bash
pi -e git:github.com/juanrgon/pi-code-mode
```

## Usage

Code Mode starts enabled by default and shows its state in the footer. Toggle it with:

- `/code-mode` command
- `Ctrl+Alt+C` shortcut

When enabled, the LLM gets an `execute_typescript` tool in addition to the normal tools. Inside `execute_typescript`, the sandbox exposes typed `external_*` wrappers for the bridged core tools above, plus the higher-level helper functions.

The code runs in a V8 isolate ([`isolated-vm`](https://github.com/nicolo-ribaudo/isolated-vm)) with a 120-second timeout and 128MB memory limit. Each execution gets a fresh sandbox — no state leaks between calls.

## How It Works

- **`index.ts`** — Extension entry point. Registers the tool, command, shortcut, footer status, and bridges the supported core tools into the sandbox.
- **`sandbox.ts`** — V8 isolate sandbox. Handles async tool bridging via `ivm.Reference`, helper injection, console capture, and better TypeScript/runtime error formatting.
- **`stubs.ts`** — Generates typed `external_*` declarations plus helper stubs/examples, injected into the system prompt so the model writes correct calls without guessing parameter shapes.

## License

MIT
