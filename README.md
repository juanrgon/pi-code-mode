# pi-code-mode

A [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that gives the LLM an `execute_typescript` tool. Instead of calling tools one at a time, the model writes a short TypeScript program that composes tools with loops, conditionals, `Promise.all`, and data transforms, then executes it in a V8 isolate sandbox.

Inspired by [TanStack AI Code Mode](https://tanstack.com/blog/tanstack-ai-code-mode).

## Install

```bash
pi install git:github.com/juanrgon/pi-code-mode
```

Or for a one-off test:

```bash
pi -e git:github.com/juanrgon/pi-code-mode
```

## Usage

Once installed, toggle Code Mode with:

- `/code-mode` command
- `Ctrl+Alt+C` shortcut

When enabled, the LLM gets an `execute_typescript` tool in addition to the normal tools. The system prompt is augmented with typed stubs so the model knows exactly how to call `external_read()`, `external_bash()`, etc.

### Example

The model can write code like:

```typescript
const [pkg, readme] = await Promise.all([
  external_read({ path: "package.json" }),
  external_read({ path: "README.md" }),
]);
const deps = JSON.parse(pkg).dependencies;
console.log("Dependencies:", Object.keys(deps).length);
return { deps, readmeLength: readme.length };
```

This executes in a V8 isolate with a 120-second timeout and 128MB memory limit.

## How It Works

- **`index.ts`** — Extension entry point. Registers the `execute_typescript` tool, `/code-mode` command, `Ctrl+Alt+C` shortcut, and bridges pi's tools into the sandbox.
- **`sandbox.ts`** — V8 isolate sandbox using [`isolated-vm`](https://github.com/nicolo-ribaudo/isolated-vm). Handles async tool bridging, console capture, and TypeScript annotation stripping.
- **`stubs.ts`** — Generates typed TypeScript declarations for all active tools, injected into the system prompt so the model writes correct code.

## Credits

This extension is inspired by [TanStack AI Code Mode](https://tanstack.com/blog/tanstack-ai-code-mode) by Jack Herrington, Alem Tuzlak, and Tanner Linsley. The core idea — giving the LLM a code execution tool to compose multiple tool calls in a single round-trip — comes directly from that article.

## License

MIT
