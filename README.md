# debug-that

Debugger CLI built for AI agents. Fast, token-efficient, no fluff.

**Why?** Agents waste tokens on print-debugging. A real debugger gives precise state inspection in minimal output — variables, stack, breakpoints — all via short `@ref` handles.

Inspired by Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser) CLI — the same `@ref` concept, applied to debugging instead of browsing.

## Supported Runtimes & Languages

| Runtime | Language | Status | Protocol |
|---------|----------|--------|----------|
| Node.js | JavaScript | Supported | V8 Inspector (CDP) |
| Node.js + tsx/ts-node | TypeScript | Supported | V8 Inspector (CDP) + Source Maps |
| Bun | JavaScript / TypeScript | Supported | WebKit Inspector (JSC) |
| LLDB | C / C++ / Rust / Swift | Supported | DAP (Debug Adapter Protocol) |
| Deno | JavaScript / TypeScript | Planned | V8 Inspector (CDP) |
| Python (debugpy) | Python | Planned | DAP |
| Go (delve) | Go | Planned | DAP |
| Java (JDWP) | Java / Kotlin | Planned | DAP |

dbg auto-detects the runtime from the launch command and uses the appropriate protocol adapter. For native languages, use `--runtime lldb` to select the DAP adapter.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install --global debug-that
npx skills add theodo-group/debug-that # Install Claude Code skill
```

## Example
```bash
> dbg launch --brk tsx src/app.ts
Session "default" started (pid 70445)
Paused at ./src/app.ts:0:1

> dbg break src/app.ts:19
BP#1 set at src/app.ts:19

> dbg continue
Paused at ./src/app.ts:19:21 (other)

Source:
   16|
   17|const alice: Person = { name: "Alice", age: 30 };
   18|const greeting: string = greet(alice);
 > 19|const sum: number = add(2, 3);
                          ^
   20|console.log(greeting);
   21|console.log("Sum:", sum);
   22|

Locals:
@v1  greet     Function greet(person)
@v2  add       Function add(a,b)
@v3  alice     Object { name: "Alice", age: 30 }
@v4  greeting  "Hello, Alice! Age: 30"

Stack:
@f0  (anonymous)  ./src/app.ts:19:21
@f1  run          node:internal/modules/esm/module_job:413:25

Breakpoints: 1 active
```

## Usage

```bash
# Node.js
dbg launch --brk node app.js

# TypeScript (via tsx)
dbg launch --brk tsx src/app.ts

# Bun
dbg launch --brk bun app.ts

# C/C++ (via LLDB)
dbg launch --brk --runtime lldb ./my_program

# Attach to a running process (any runtime with --inspect)
dbg attach 9229

# Debug loop
dbg break src/handler.ts:42
dbg continue
dbg vars
dbg props @v3
dbg eval "x + 1"
dbg step over
dbg set @v1 100
dbg hotpatch src/handler.ts   # live-edit from disk (JS/TS only)
dbg stop
```

## Commands

| Category | Commands |
|---|---|
| Session | `launch`, `attach`, `stop`, `status`, `sessions` |
| Execution | `continue`, `step [over\|into\|out]`, `pause`, `run-to`, `restart-frame` |
| Inspection | `state`, `vars`, `stack`, `eval`, `props`, `source`, `scripts`, `search`, `console`, `exceptions` |
| Breakpoints | `break`, `break-rm`, `break-ls`, `break-toggle`, `breakable`, `logpoint`, `catch`, `break-fn` (DAP only) |
| Mutation | `set`, `set-return`, `hotpatch` |
| Blackbox | `blackbox`, `blackbox-ls`, `blackbox-rm` |

Run `dbg --help` or `dbg --help-agent` for the full reference.

## Architecture

```
CLI (stateless)  -->  Unix socket IPC  -->  Daemon (per session)
                                              |
                                     DebugSession / DapSession
                                       /                \
                              CDP path (JS)          DAP path (native)
                                 |                       |
                           RuntimeAdapter            DapClient
                            /         \            (stdin/stdout)
                      NodeAdapter    BunAdapter         |
                      (CDP/V8)    (WebKit/JSC)     lldb-dap / etc.
                            \         /
                          CdpClient (WebSocket)
                                 |
                          V8/JSC Inspector
```

The daemon manages two session types:
- **DebugSession** (CDP) — for JavaScript runtimes (Node.js, Bun). Uses `RuntimeAdapter` to handle protocol differences between V8 and JSC.
- **DapSession** (DAP) — for native debuggers (LLDB, etc.). Communicates with a debug adapter over stdin/stdout using the Debug Adapter Protocol.
