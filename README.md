# pi-code-mode

A [pi](https://github.com/earendil-works/pi) extension that gives the LLM an `execute_typescript` tool: instead of calling tools one at a time, the model writes a short TypeScript program that composes pi's core tools with loops, conditionals, `Promise.all`, and data transformations — in a single round-trip.

Inspired by [TanStack AI Code Mode](https://tanstack.com/blog/tanstack-ai-code-mode) (Jack Herrington, Alem Tuzlak, Tanner Linsley). The worker/RPC execution architecture is informed by [Hor1zonZzz/pi-codeMode](https://github.com/Hor1zonZzz/pi-codeMode).

## Why

Without Code Mode, each tool call is a full round-trip: the model generates the call, the runtime executes it, the result lands in the context window, the model generates the next call. Intermediate results you only needed transiently stay in context forever, and the model does arithmetic by token prediction.

With Code Mode, the model writes a program:

```typescript
const entries = await grepEntries({ pattern: "TODO", glob: "*.ts" });
const files = [...new Set(entries.map((e) => e.path))];
const sizes = await mapLimit(files, 8, async (path) => {
  const r = await tools.read({ path });
  return { path, lines: lines(r.text).length };
});
return { todos: entries.length, files: sizes };
```

One tool call in the conversation. Intermediate file contents never touch the context window. Counting happens in JavaScript, not in the model's head.

## What v2 does differently

This is a ground-up rewrite of the original isolated-vm version:

- **Real parallelism.** Bridged calls cross the sandbox boundary as async messages, so `Promise.all` / `mapLimit` genuinely run tools concurrently on the host (bounded, default 8). The v1 bridge (`applySyncPromise`) silently serialized everything — two parallel 1s sleeps took ~2s; now they take ~1s. A regression test locks this in.
- **Delegates to pi's real tools.** `tools.read`, `tools.bash`, etc. call pi's actual built-in implementations (`create*ToolDefinition`), inheriting output truncation, the per-file mutation queue (concurrent edits don't clobber each other), image handling, and every future improvement — instead of maintaining a drifting reimplementation. Tools the user disabled stay unavailable inside the sandbox too.
- **Cancellation works.** Esc aborts the run: in-flight tools receive the abort signal and the worker is terminated — even mid-`while(true)`.
- **Output discipline.** The final result is truncated to pi's standard limits (2000 lines / 50KB), with the full output saved to a temp file. Sandbox-side, tool output arrives already truncated by the real tools.
- **Audit trail.** Every bridged call is recorded (tool, params, duration, ok/error) in the tool result details and rendered in the TUI when expanded.
- **No native deps.** `worker_threads` + `node:vm` with a memory cap replaces `isolated-vm` (a native, maintenance-mode dependency). Only runtime dependency is esbuild, used to strip TypeScript.
- **~3× smaller prompt, injected per turn.** One consistent `tools.*` API with structured results replaces the v1 dual surface (`external_*` strings + 25 helper wrappers). The injected prompt dropped from ~450 lines to ~122 (~2K tokens), and it now extends the system prompt for the current turn instead of appending a persistent message to the session on every prompt (a v1 bug that duplicated the whole block each turn).

## Sandbox API

```typescript
tools.read({ path, offset?, limit? })   // → { text, kind: "text" | "image", truncated }
tools.bash({ command, timeout? })       // → { text, truncated, fullOutputPath? }  (throws on non-zero exit)
tools.edit({ path, edits })             // → { text, diff, firstChangedLine? }
tools.write({ path, content })          // → { text }
tools.grep({ pattern, ... })            // → { text, truncated }
tools.find({ pattern, ... })            // → { text, truncated }
tools.ls({ path?, ... })                // → { text, truncated }
tools.try(name, params)                 // → non-throwing: { ok: true, ...result } | { ok: false, error }

// helpers
lines(text)  dedent(text)  mapLimit(items, n, fn)
readJson(path)  bashJson(command)  grepEntries(params)
```

Same parameters and behavior as the normal pi tools. Reading an image attaches it to the final tool result (max 3 per run), so the model can see screenshots collected in a loop.

## Install

```bash
pi install git:github.com/juanrgon/pi-code-mode
```

Or for a one-off test:

```bash
pi -e git:github.com/juanrgon/pi-code-mode
```

## Usage

Code Mode starts enabled (additive) and shows its state in the footer.

- `/code-mode` — pick a mode: `on` (additive), `replace`, or `off`
- `/code-mode on|off|replace` — set directly
- `Ctrl+Alt+C` — quick toggle

**Additive** (default): `execute_typescript` is available alongside the normal tools. The model is told to use it for multi-step work with loops/branching/aggregation and to keep using direct tool calls for single operations.

**Replace**: the bridged built-in tools that were active when you enabled replace are hidden from the model and only reachable through `execute_typescript` (CodeAct-style; saves tool-schema tokens, forces orchestration through code). Leaving replace restores exactly that set — tools you had disabled stay disabled.

**Off**: `execute_typescript` itself is deactivated and the Code Mode prompt is not injected.

## Security model

This is **resource isolation, not a security boundary**. The sandbox (fresh `worker_threads` Worker per run, `node:vm` context, 256MB heap cap, 120s wall-clock timeout, no require/process/network) keeps runs bounded and forces all side effects through the bridged tools — but `tools.bash` is arbitrary command execution, exactly like pi's normal bash tool. Code Mode neither adds nor removes authority; it changes how the model expresses multi-step work.

Known limitations:

- Bridged calls go straight to pi's stock tool implementations, bypassing `tool_call`/`tool_result` extension hooks (e.g. permission-gate extensions) **and** any built-in tool overrides or remote-operation adapters (SSH/sandbox extensions) you may have installed — Code Mode always executes the local built-ins. See [UPSTREAM_PROPOSAL.md](UPSTREAM_PROPOSAL.md) for the `pi.invokeTool()` API that would fix both properly and let Code Mode bridge third-party tools.

## How it works

- **`index.ts`** — extension wiring: registers the tool, command, shortcut, footer status; injects the Code Mode prompt per turn; bridges to pi's real tool definitions; formats and truncates the final output.
- **`runner.ts`** — host side: esbuild TS stripping (top-level `return`/`await` preserved), worker spawn, async postMessage RPC with bounded concurrency, abort/timeout via `worker.terminate()`, runtime errors mapped back to user code with a code frame.
- **`worker-source.ts`** — the eval'd worker bootstrap: `node:vm` context, `tools.*` proxies, helpers, console capture.
- **`stubs.ts`** — generates the system prompt section from the live tool schemas.

## Development

```bash
npm install
npm run check   # tsc
npm test        # vitest — includes the parallelism regression test,
                # abort/timeout tests, and integration tests against
                # pi's real tool implementations
```

## License

MIT
