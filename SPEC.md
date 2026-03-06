# dbg — Node.js Debugger CLI for AI Agents

## Specification v1.0

---

## 1. Vision

`dbg` is a command-line debugger for Node.js designed specifically for AI coding agents (Claude Code, Codex, Cursor, Gemini CLI, etc.). It wraps the V8 Inspector Protocol (Chrome DevTools Protocol) behind a token-efficient, stateless CLI interface that lets agents autonomously set breakpoints, step through code, inspect variables, profile memory, and even hot-patch code — all through bash.

**Core principle:** every tool call should return maximum debugging insight for minimum token cost.

---

## 2. Design Philosophy

### 2.1 Agent-first, human-usable

The primary consumer is an LLM agent operating via bash tool calls. Every design decision optimizes for:

- **Token efficiency** — compact output, no ANSI colors by default, no decorative chrome
- **Minimum round-trips** — composite commands, auto-state-return after execution commands
- **Referenceability** — `@ref` system so agents never type long identifiers
- **Progressive verbosity** — control output granularity per-call with flags
- **Actionable errors** — every error suggests the next valid command

Humans can use it too. `--color` flag enables ANSI colors for terminal use.

### 2.2 CLI over MCP

dbg is a CLI tool, not an MCP server. Rationale:

- **Zero setup** — `npm i -g dbg` or `npx dbg`, no MCP config files
- **Context efficient** — no JSON-RPC overhead, no schema in every call
- **Composable** — can pipe to grep/jq, chain with other bash commands
- **Universal** — works with any agent that has shell access, not just MCP clients
- **Reliable** — no persistent server process to crash or manage

### 2.3 Daemon architecture

Debugging is inherently stateful (a process paused at a breakpoint). dbg uses a background daemon model:

- `dbg launch` starts a daemon that holds the WebSocket connection to the V8 inspector
- All subsequent CLI calls communicate with the daemon via a local Unix socket
- Each CLI invocation is fast and stateless from the agent's perspective
- The daemon manages the debug session lifecycle
- Daemon auto-terminates when the debugged process exits or after an idle timeout

### 2.4 Built with Bun

- Written in TypeScript, compiled with `bun build --compile` to a single standalone binary
- Native WebSocket support for CDP communication
- Fast startup (~5ms for compiled binary)
- No runtime dependency — users don't need Bun or Node installed to use the compiled binary

---

## 3. The @ref System

Inspired by agent-browser's `@e1` element refs, dbg assigns short stable references to every inspectable entity in its output. Agents use these refs instead of long object IDs, file paths, or frame indices.

### 3.1 Ref types

| Prefix | Entity | Example | Lifetime |
|--------|--------|---------|----------|
| `@v` | Variable / value | `@v1`, `@v2` | Until next pause (step/continue) |
| `@f` | Stack frame | `@f0`, `@f1` | Until next pause |
| `@o` | Expanded object | `@o1`, `@o2` | Until session ends or `dbg gc-refs` |
| `BP#` | Breakpoint | `BP#1`, `BP#2` | Until removed |
| `LP#` | Logpoint | `LP#1`, `LP#2` | Until removed |
| `HS#` | Heap snapshot | `HS#1`, `HS#2` | Until session ends |

### 3.2 Ref usage

Refs can be used anywhere an identifier is expected:

```bash
dbg props @v1                 # expand variable @v1
dbg eval "@v1.retryCount"     # use ref in expressions
dbg set @v2 true              # mutate variable @v2
dbg frame @f1                 # switch to stack frame @f1
dbg restart-frame @f0         # restart frame @f0
dbg break-rm BP#1             # remove breakpoint BP#1
dbg heap diff HS#1 HS#2       # diff two heap snapshots
```

### 3.3 Ref resolution

The daemon maintains a ref table mapping short refs to V8 RemoteObjectIds, CallFrameIds, BreakpointIds, etc. The table is:

- **Regenerated** on each pause event (for `@v` and `@f` refs)
- **Append-only** for `@o` refs (expanded objects persist across pauses)
- **Stable** for `BP#`, `LP#`, `HS#` refs (persist until explicitly removed)

---

## 4. The State Snapshot

The `state` command is the primary "where am I?" command. It returns a structured view of the current debug context, analogous to agent-browser's `snapshot`.

### 4.1 Default output

```
⏸ Paused at src/queue/processor.ts:47 (BP#1, hit #3)  [resumed 1.2s ago]

Source:
   45│   async processJob(job: Job) {
   46│     const lock = await this.acquireLock(job.id);
 → 47│     if (!lock) return;
   48│     const result = await this.execute(job);
   49│     await this.markComplete(job.id);

Locals:
  @v1  job       Job { id: "test-123", type: "email", retries: 2 }
  @v2  lock      false
  @v3  this      QueueProcessor { workerId: "worker-a", redis: [Redis] }

Stack:
  @f0  processJob         src/queue/processor.ts:47
  @f1  poll                src/queue/processor.ts:71
  @f2  setTimeout cb       node:internal/timers:573
  ┊ async
  @f3  QueueProcessor.start  src/queue/processor.ts:12

Breakpoints:
  BP#1  src/queue/processor.ts:47  (cond: job.id === 'test-123')  hits: 3
  BP#2  src/queue/processor.ts:31
```

### 4.2 Filtering flags

| Flag | Output |
|------|--------|
| (none) | Full state: source + locals + stack + breakpoints |
| `-v` / `--vars` | Locals only |
| `-s` / `--stack` | Stack trace only |
| `-b` / `--breakpoints` | Breakpoints/logpoints only |
| `-c` / `--code` | Source context only |
| `--compact` | One-line-per-section summary |
| `--depth N` | Object expansion depth (default: 1) |
| `--lines N` | Source context lines above/below (default: 3) |
| `--frame @fN` | Show state from perspective of frame N |
| `--all-scopes` | Include closure and global scope, not just locals |
| `--json` | Full state as JSON (for programmatic use) |

### 4.3 Auto-state return

**Every execution command returns a state snapshot automatically.** This is a critical design choice that halves the number of tool calls an agent needs.

Commands that return state: `continue`, `step`, `step over`, `step into`, `step out`, `run-to`, `restart-frame`, `pause`.

The auto-returned state uses the same format as `dbg state` and respects a configurable default verbosity (see `dbg config`).

---

## 5. Command Reference

### 5.1 Session Management

```
dbg launch [--brk] [--session NAME] <command...>
```
Start a Node.js process with `--inspect` (or `--inspect-brk` if `--brk` is passed) and attach the debugger daemon. Returns initial state if `--brk`.

- `--brk` — pause on first line of user code (recommended for most debugging)
- `--session NAME` — assign a name for multi-session debugging
- `--port PORT` — use specific inspector port (default: auto)
- `--timeout SECS` — daemon idle timeout (default: 300)

```
dbg attach <pid | ws-url | port>
```
Attach to an already-running Node.js process (started with `--inspect`).

```
dbg stop [--session NAME]
```
Kill the debugged process and shut down the daemon.

```
dbg sessions
```
List active debug sessions with PID, status (paused/running), and session name.

```
dbg sessions --cleanup
```
Kill all orphaned daemon processes.

```
dbg status
```
Current session info: PID, pause state, attached breakpoints, memory usage, uptime.

---

### 5.2 Breakpoints

```
dbg break <file>:<line> [OPTIONS]
```
Set a breakpoint. Returns the breakpoint ID and resolved location (with source map).

Options:
- `--condition <expr>` — only pause when expression is truthy
- `--hit-count <n>` — only pause on the Nth hit
- `--continue` — immediately continue after setting (composite command)
- `--log <template>` — convert to logpoint (shortcut for `dbg logpoint`)

```
dbg break --pattern <urlRegex>:<line>
```
Set breakpoint on all files matching a URL regex pattern. Useful for breaking in `node_modules` or dynamically loaded scripts.

```
dbg break-fn <expr>
```
Set a breakpoint on every call to the function returned by evaluating `<expr>`. Example: `dbg break-fn "require('express').Router"`.

```
dbg break-on-load [--sourcemap]
```
Break whenever a new script is parsed. With `--sourcemap`, only break on scripts with source maps (i.e., your code, not node internals).

```
dbg break-rm <BP#id | LP#id | all>
```
Remove a breakpoint or logpoint by ref. `all` removes everything.

```
dbg break-ls
```
List all breakpoints and logpoints with their locations, conditions, and hit counts.

```
dbg break-toggle [BP#id | all]
```
Enable/disable breakpoint(s) without removing them.

```
dbg breakable <file>:<start>-<end>
```
List valid breakpoint locations in a line range. Useful when the agent picks a non-breakable line.

```
dbg logpoint <file>:<line> <template>
```
Set a logpoint — logs the interpolated template string each time the line is hit, without pausing. Template uses `${expr}` syntax.

- `--max <n>` — auto-pause after N log emissions (default: 100, prevents floods)
- `--condition <expr>` — only log when condition is true

```
dbg catch [all | uncaught | caught | none]
```
Configure pause-on-exception behavior. `all` catches even exceptions inside try/catch. `uncaught` is the most useful default.

---

### 5.3 Execution Control

All execution commands **return a state snapshot** when the process next pauses.

```
dbg continue
```
Resume execution until next breakpoint, exception, or manual pause.

```
dbg step [over | into | out]
```
Step one statement. Default is `over`.

- `step into` — with `--break-on-async` flag, pauses on the first async task scheduled before the next pause
- `step over` / `step into` — accept `--skip <pattern>` to skip over matching files (inline blackboxing)

```
dbg run-to <file>:<line>
```
Continue execution until a specific location. Does not create a persistent breakpoint.

```
dbg restart-frame [@fN]
```
Re-execute the specified frame (or current frame) from the beginning. The process continues immediately and pauses at the beginning of the restarted function.

```
dbg pause
```
Interrupt a running process. Returns state at the interrupt point.

```
dbg kill-execution
```
Terminate the current JavaScript execution without killing the Node.js process. Useful for stopping infinite loops while keeping the debug session alive.

---

### 5.4 Inspection

```
dbg state [FLAGS]
```
Return the current debug state snapshot. See Section 4 for flags.

```
dbg vars [name1, name2, ...]
```
Show local variables in the current frame. Optionally filter to specific names. Output assigns `@v` refs.

```
dbg stack [--async-depth N]
```
Show the call stack. `--async-depth` controls how many async frames to resolve (default: 8, 0 to disable).

```
dbg eval <expression>
```
Evaluate an expression in the context of the current call frame.

- Supports `await` (uses CDP's `awaitPromise`)
- Supports `@ref` interpolation: `dbg eval "@v1.retryCount"`
- `--frame @fN` — evaluate in a specific frame
- `--silent` — suppress exception reporting
- `--timeout MS` — kill evaluation after N milliseconds (default: 5000)
- `--side-effect-free` — throw if expression has side effects (safe inspection)

```
dbg props <@ref> [OPTIONS]
```
Expand the properties of an object ref. Returns `@o` refs for nested values.

- `--own` — only own properties (skip prototype chain)
- `--depth N` — recursive expansion depth (default: 1)
- `--private` — include private fields
- `--internal` — include V8 internal properties (e.g., `[[PromiseState]]`)

```
dbg instances <expression>
```
Find all live instances of a prototype/constructor. Evaluates the expression to get a prototype, then queries all objects sharing it. Example: `dbg instances "EventEmitter.prototype"`.

```
dbg globals
```
List all global `let`, `const`, and `class` declarations in the current execution context.

```
dbg source [OPTIONS]
```
Show source code around the current pause location.

- `--lines N` — lines above and below (default: 5)
- `--file <path>` — show source of a different file
- `--all` — show full file

```
dbg search <query> [OPTIONS]
```
Search across all loaded scripts.

- `--regex` — treat query as regex
- `--case-sensitive` — case-sensitive search (default: insensitive)
- `--file <scriptId>` — search within a specific script

```
dbg scripts [--filter <pattern>]
```
List all loaded scripts (files). Useful to find the right `scriptId` for breakpoints in dynamically loaded code.

```
dbg console [OPTIONS]
```
Show captured console output (log, warn, error, etc.) with timestamps and stack traces.

- `--follow` — stream output in real-time (blocks until Ctrl+C or `--max`)
- `--since <N>` — only show last N entries
- `--level <log|warn|error>` — filter by level
- `--clear` — clear captured console buffer

```
dbg exceptions [OPTIONS]
```
Show captured uncaught exceptions.

- `--follow` — stream in real-time
- `--since <N>` — last N entries

---

### 5.5 Mutation

These commands let an agent **test hypotheses and fixes without restarting**.

```
dbg set <@vRef | varName> <value>
```
Change the value of a local, closure, or catch-scope variable in the current frame.

- Value is parsed as JSON or as a JavaScript primitive
- Only works on `local`, `closure`, and `catch` scope types (V8 limitation)
- Example: `dbg set @v2 true`, `dbg set retryCount 0`

```
dbg set-return <value>
```
Change the return value of the current function. Only available when paused at a return point.

```
dbg hotpatch <file>
```
Live-edit the source of a loaded script. Reads the file from disk and pushes it to V8 via `Debugger.setScriptSource`.

- If the edited function is the top-most stack frame (and only activation), it auto-restarts
- `--dry-run` — check if the edit would succeed without applying
- Returns status: `Ok`, `CompileError`, `BlockedByActiveFunction`, etc.
- **This is dbg's killer feature for agents** — fix code and immediately verify, no restart

---

### 5.6 Blackboxing

Control which code the debugger steps into, preventing agents from getting lost in framework internals.

```
dbg blackbox <pattern...>
```
Skip stepping into scripts matching the given patterns (regex). Stepping into a blackboxed function will step over it instead.

- Example: `dbg blackbox "node_modules" "internal/"`
- Stacks with previous patterns

```
dbg blackbox-ls
```
List current blackbox patterns.

```
dbg blackbox-rm <pattern | all>
```
Remove blackbox patterns.

---

### 5.7 CPU Profiling

```
dbg cpu start [--interval <μs>]
```
Start the V8 CPU profiler. Default sampling interval is 1000μs.

```
dbg cpu stop [--top N]
```
Stop profiling and return results.

- `--top N` — show top N hottest functions (default: 10)
- Output includes: function name, file:line, self time %, total time %, deopt reason (if any)
- Full profile saved to a file for external tools

```
dbg coverage start [--detailed]
```
Start precise code coverage collection. `--detailed` enables block-level granularity (not just function-level).

```
dbg coverage stop [OPTIONS]
```
Stop coverage and report.

- `--file <path>` — filter to a specific file
- `--uncovered` — only show uncovered lines/blocks
- Output: per-function execution counts and uncovered ranges

---

### 5.8 Memory / Heap

```
dbg heap usage
```
Quick heap statistics: used, total, embedder heap, backing store. No snapshot needed.

```
dbg heap snapshot [--tag <name>]
```
Take a full V8 heap snapshot. Assigns an `HS#` ref.

```
dbg heap diff <HS#a> <HS#b> [--top N]
```
Compare two heap snapshots. Output: table of constructors with delta count and delta size, sorted by size impact.

```
dbg heap sample start [--interval <bytes>] [--include-gc]
```
Start sampling heap profiler. Lightweight alternative to full snapshots.

- `--interval` — average sampling interval in bytes (default: 32768)
- `--include-gc` — include objects already garbage-collected (shows temporary allocations)

```
dbg heap sample stop [--top N]
```
Stop sampling and report top allocation sites.

```
dbg heap track start
```
Start allocation tracking over time (timeline mode).

```
dbg heap track stop
```
Stop tracking and report allocation rate by callsite.

```
dbg heap inspect <heapObjectId>
```
Get a remote object reference from a heap snapshot node, bridging heap analysis with runtime inspection. Returns an `@o` ref.

```
dbg gc
```
Force a garbage collection cycle. Useful before taking a snapshot to see what truly leaks.

---

### 5.9 Advanced / Utility

```
dbg inject-hook <name>
```
Create a runtime binding that, when called from application code, sends a notification to the daemon. Use for custom instrumentation.

- Adds a global function `__dbg_<name>()` that the app can call
- When called, the daemon captures the call's arguments and stack
- View with: `dbg hooks [--follow]`

```
dbg contexts
```
List all V8 execution contexts (useful for debugging Jest VM sandboxes, workers, or vm.runInContext scenarios). Each context gets an ID.

```
dbg async-depth <N>
```
Set the async call stack trace depth. Default: 16. Set to 0 to disable async stacks. Higher values cost more memory but show the full async chain.

```
dbg config [key] [value]
```
Get/set daemon configuration:

- `auto-state` — verbosity of auto-returned state snapshots (default: `full`)
- `default-depth` — default object expansion depth (default: 1)
- `default-lines` — default source context lines (default: 3)
- `async-depth` — async stack trace depth (default: 16)
- `blackbox` — default blackbox patterns
- `timeout` — daemon idle timeout in seconds

```
dbg gc-refs
```
Clear accumulated `@o` refs to free memory. `@v` and `@f` refs are cleared automatically on each pause.

```
dbg --help-agent
```
Output a compact LLM-optimized reference card with core workflow, quick reference, and common debugging patterns. Designed to be injected into an agent's context window.

---

## 6. Output Format

### 6.1 Principles

1. **Plain text by default** — no ANSI escape codes, no box drawing (unless `--color`)
2. **Compact** — one entity per line where possible, tree indentation for hierarchy
3. **@refs inline** — every inspectable value is prefixed with its ref
4. **Timing annotations** — execution commands report elapsed time since last pause
5. **No JSON by default** — JSON wastes tokens on syntax. Available with `--json` flag
6. **Truncation with hints** — large outputs are truncated with a `... (dbg props @oN for more)` hint

### 6.2 Variable formatting

Variables are displayed with smart truncation:

```
@v1  job         Job { id: "test-123", type: "email", retries: 2, payload: {...} }
@v2  lock        false
@v3  items       Array(47) [ "a", "b", "c", ... ]
@v4  callback    Function processResult(job)
@v5  promise     Promise { <pending> }
@v6  error       Error: "connection refused" (at src/db.ts:12)
@v7  map         Map(3) { "a" => 1, "b" => 2, "c" => 3 }
@v8  buf         Buffer(1024) <48 65 6c 6c 6f ...>
@v9  undefined   undefined
```

- Objects: constructor name + top-level properties up to ~80 chars, then `{...}`
- Arrays: type + length + first 3 elements, then `...`
- Functions: `Function` + name + parameters
- Promises: state (`<pending>`, `<resolved: value>`, `<rejected: error>`)
- Errors: message + first stack frame
- Buffers: length + first 5 hex bytes

### 6.3 Source code formatting

```
   45│   async processJob(job: Job) {
   46│     const lock = await this.acquireLock(job.id);
 → 47│     if (!lock) return;
   48│     const result = await this.execute(job);
   49│     await this.markComplete(job.id);
```

- Line numbers right-aligned, pipe separator
- Arrow `→` at current execution line
- Source-mapped locations (show `.ts` not `.js`)
- Breakpoint markers: `●` at lines with breakpoints

### 6.4 Stack trace formatting

```
@f0  processJob         src/queue/processor.ts:47
@f1  poll                src/queue/processor.ts:71
@f2  setTimeout cb       node:internal/timers:573
┊ async gap
@f3  QueueProcessor.start  src/queue/processor.ts:12
```

- Frame ref, function name, source-mapped location
- `┊ async gap` markers between async boundaries
- Blackboxed frames shown dimmed or collapsed: `┊ ... 3 framework frames (blackboxed)`

### 6.5 Error output

Errors always suggest the next action:

```
✗ Cannot set breakpoint at src/queue/processor.ts:46 — no breakable location
  Nearest valid lines: 45, 47
  → Try: dbg break src/queue/processor.ts:47

✗ Variable 'foo' not found in current scope
  Available locals: job, lock, this
  → Try: dbg vars

✗ Cannot step — process is running (not paused)
  → Try: dbg pause

✗ Session "default" not found — no active debug session
  → Try: dbg launch --brk "node app.js"
```

---

## 7. Source Map Support

Source maps are a first-class concern, not an afterthought.

### 7.1 Behavior

- All user-facing locations display **source-mapped paths and line numbers** (TypeScript, etc.)
- The `Debugger.scriptParsed` event provides `sourceMapURL`; the daemon fetches and caches it
- `dbg break src/foo.ts:42` resolves to the generated `.js` location automatically
- Stack traces always show source-mapped locations
- `dbg source` shows the original source (TypeScript), not compiled JS
- If no source map exists, the generated JS is shown (no error)

### 7.2 Source map commands

```
dbg sourcemap <file>        # Show source map info for a file
dbg sourcemap --disable     # Disable source map resolution globally
```

---

## 8. Session & Daemon Protocol

### 8.1 Daemon lifecycle

1. `dbg launch` starts a background daemon process
2. Daemon opens a WebSocket to the Node.js inspector (`ws://127.0.0.1:<port>`)
3. Daemon listens on a Unix socket at `$XDG_RUNTIME_DIR/dbg/<session-name>.sock` (or `$TMPDIR` fallback)
4. CLI commands connect to the Unix socket, send a request, receive a response, disconnect
5. Daemon shuts down when: process exits, `dbg stop` is called, or idle timeout is reached

### 8.2 Internal protocol

CLI-to-daemon communication uses newline-delimited JSON over Unix socket. Each request/response is a single JSON object. This is internal — users never see it.

```json
// Request
{"cmd": "continue", "args": {}}

// Response
{"ok": true, "state": { ... }, "refs": { ... }}
```

### 8.3 Multi-session

- Each debug session has a unique name (default: `"default"`)
- Multiple sessions can run simultaneously (e.g., debugging a client and server)
- `--session NAME` on any command targets a specific session
- `dbg sessions` lists all active sessions

### 8.4 Crash recovery

- If the daemon crashes, the CLI detects the dead socket and reports:
  `✗ Session "default" daemon is not running. The debugged process (PID 42871) is still alive.`
  `→ Try: dbg attach 42871`
- Lock files prevent duplicate daemons for the same session

---

## 9. SKILL.md for Agent Integration

dbg ships with a SKILL.md for Claude Code's skill system and compatible agents.

```yaml
---
name: node-debugger
description: >
  Node.js runtime debugger CLI. Use when debugging runtime errors, race
  conditions, memory leaks, circular dependencies, Jest/VM issues, or any
  bug requiring breakpoints, variable inspection, stepping through code, or
  profiling. Triggers: "debug", "breakpoint", "race condition", "memory leak",
  "step through", "inspect at runtime", "profile", "heap snapshot", "why is
  this variable undefined", "infinite loop".
---
```

### 9.1 `--help-agent` output

The `dbg --help-agent` command outputs a compact reference designed for agent context windows:

```
dbg — Node.js debugger CLI for AI agents

CORE LOOP:
  1. dbg launch --brk "node app.js"    → pauses at first line, returns state
  2. dbg break src/file.ts:42          → set breakpoint
  3. dbg continue                      → run to breakpoint, returns state
  4. Inspect: dbg vars, dbg eval, dbg props @v1
  5. Mutate/fix: dbg set @v1 value, dbg hotpatch src/file.ts
  6. Repeat from 3

REFS: Every output assigns @refs. Use them everywhere:
  @v1..@vN  variables    │  dbg props @v1, dbg set @v2 true
  @f0..@fN  stack frames │  dbg frame @f1, dbg restart-frame @f0
  BP#1..N   breakpoints  │  dbg break-rm BP#1
  HS#1..N   heap snaps   │  dbg heap diff HS#1 HS#2

EXECUTION (all return state automatically):
  dbg continue              Resume to next breakpoint
  dbg step [over|into|out]  Step one statement
  dbg run-to file:line      Continue to location
  dbg pause                 Interrupt running process
  dbg restart-frame @f0     Re-run current function

BREAKPOINTS:
  dbg break file:line [--condition expr]
  dbg logpoint file:line "template ${var}"
  dbg catch [all|uncaught|none]
  dbg blackbox "node_modules/**"

INSPECTION:
  dbg state [-v|-s|-b|-c] [--depth N]
  dbg vars [name...]
  dbg eval <expr>                    (await supported)
  dbg props @ref [--depth N]
  dbg instances "Class.prototype"
  dbg search "query" [--regex]

MUTATION:
  dbg set @v1 <value>        Change variable
  dbg set-return <value>     Change return value
  dbg hotpatch <file>        Live-edit code (no restart!)

PROFILING:
  dbg cpu start / stop [--top N]
  dbg coverage start [--detailed] / stop [--uncovered]
  dbg heap usage | snapshot | diff | sample | gc

PATTERNS:
  # Race condition → trace with logpoints
  dbg logpoint src/lock.ts:31 "acquire: ${jobId} by ${workerId}"
  dbg continue

  # Circular dependency → trace require chain
  dbg break-on-load --sourcemap
  dbg logpoint node_modules/jest-runtime/build/index.js:348 "${from} → ${moduleName}"

  # Memory leak → snapshot before/after
  dbg heap snapshot --tag before
  # ... trigger load ...
  dbg heap snapshot --tag after
  dbg heap diff HS#1 HS#2 --top 5

  # Skip framework noise
  dbg blackbox "node_modules" "internal/"
```

---

## 10. Installation & Distribution

### 10.1 Install methods

```bash
# npx (zero install — recommended for first use)
npx dbg launch --brk "node app.js"

# Global install
npm install -g dbg

# Compiled binary (no runtime needed)
# Download from GitHub releases: dbg-linux-x64, dbg-darwin-arm64, etc.
curl -fsSL https://github.com/<org>/dbg/releases/latest/download/dbg-$(uname -s)-$(uname -m) -o /usr/local/bin/dbg
chmod +x /usr/local/bin/dbg
```

### 10.2 Skill installation (for Claude Code and compatible agents)

```bash
# Via vercel skills CLI
npx skills add <org>/dbg

# Manual: copy SKILL.md to Claude Code skills directory
cp node_modules/dbg/skills/node-debugger/SKILL.md ~/.claude/skills/node-debugger/SKILL.md
```

### 10.3 Requirements

- **Debugged process**: Node.js 16+ (for V8 inspector support)
- **dbg binary**: no runtime dependency (standalone compiled binary)
- **dbg via npm/npx**: Bun or Node.js 18+ on the host

---

## 11. Scope & Non-Goals

### 11.1 In scope

- Node.js / JavaScript / TypeScript debugging via V8 Inspector Protocol
- CLI interface optimized for AI agents
- CPU profiling, heap profiling, code coverage
- Source map support
- Live code editing (hotpatch)
- Multi-session debugging

### 11.2 Out of scope (v1)

- **Browser debugging** — dbg targets Node.js processes only (no DOM, no CSS)
- **Other languages** — no Python, Rust, Go, etc. (use dedicated tools)
- **GUI** — no TUI, no web UI (output is text for terminal/agent consumption)
- **MCP server mode** — may be added later as an optional adapter, but CLI is primary
- **Remote debugging** — v1 targets localhost only (SSH tunneling is the recommended approach for remote)
- **Recording/replay** — time-travel debugging (may be a v2 feature)
- **Test framework integration** — dbg debugs any Node.js process; it doesn't know about Jest/Vitest internals (but can debug them)

---

## 12. V8 Inspector Protocol Mapping

Reference for implementors. Maps dbg commands to CDP methods.

| dbg command | CDP domain | CDP method(s) |
|---|---|---|
| `launch --brk` | — | Spawns `node --inspect-brk` + `Runtime.runIfWaitingForDebugger` |
| `break file:line` | Debugger | `setBreakpointByUrl` |
| `break --pattern` | Debugger | `setBreakpointByUrl` (urlRegex) |
| `break-fn` | Debugger | `setBreakpointOnFunctionCall` |
| `break-on-load` | Debugger | `setInstrumentationBreakpoint` |
| `break-rm` | Debugger | `removeBreakpoint` |
| `break-toggle` | Debugger | `setBreakpointsActive` |
| `breakable` | Debugger | `getPossibleBreakpoints` |
| `catch` | Debugger | `setPauseOnExceptions` |
| `continue` | Debugger | `resume` |
| `step over` | Debugger | `stepOver` |
| `step into` | Debugger | `stepInto` (+ `breakOnAsyncCall`) |
| `step out` | Debugger | `stepOut` |
| `run-to` | Debugger | `continueToLocation` |
| `restart-frame` | Debugger | `restartFrame` |
| `pause` | Debugger | `pause` |
| `eval` | Debugger | `evaluateOnCallFrame` (awaitPromise) |
| `vars` | Debugger | scope chain from `paused` event → `getProperties` |
| `stack` | Debugger | `paused` event callFrames + `getStackTrace` |
| `props` | Runtime | `getProperties` |
| `instances` | Runtime | `queryObjects` |
| `globals` | Runtime | `globalLexicalScopeNames` |
| `search` | Debugger | `searchInContent` |
| `scripts` | Debugger | `scriptParsed` events (cached) |
| `set` | Debugger | `setVariableValue` |
| `set-return` | Debugger | `setReturnValue` |
| `hotpatch` | Debugger | `setScriptSource` |
| `blackbox` | Debugger | `setBlackboxPatterns` |
| `source` | Debugger | `getScriptSource` |
| `kill-execution` | Runtime | `terminateExecution` |
| `console` | Runtime | `consoleAPICalled` event |
| `exceptions` | Runtime | `exceptionThrown` event |
| `contexts` | Runtime | `executionContextCreated` event |
| `inject-hook` | Runtime | `addBinding` |
| `heap usage` | Runtime | `getHeapUsage` |
| `cpu start/stop` | Profiler | `start` / `stop` |
| `coverage start/stop` | Profiler | `startPreciseCoverage` / `takePreciseCoverage` |
| `heap snapshot` | HeapProfiler | `takeHeapSnapshot` |
| `heap sample start/stop` | HeapProfiler | `startSampling` / `stopSampling` |
| `heap track start/stop` | HeapProfiler | `startTrackingHeapObjects` / `stopTrackingHeapObjects` |
| `heap inspect` | HeapProfiler | `getObjectByHeapObjectId` |
| `gc` | HeapProfiler | `collectGarbage` |
| `async-depth` | Debugger | `setAsyncCallStackDepth` |

---

## 13. Testing Strategy

### 13.1 Unit tests

- Ref system: creation, resolution, lifecycle, collision handling
- Output formatters: variable formatting, truncation, source display
- Source map resolution: .ts → .js mapping, inline source maps, missing maps
- Command argument parsing

### 13.2 Integration tests

- Launch + attach + breakpoint + step + inspect + stop lifecycle
- Conditional breakpoints with expression evaluation
- Logpoint emission and flood throttling
- Source map resolution end-to-end (TypeScript project)
- Hotpatch: edit, verify, dry-run, blocked scenarios
- Multi-session: two concurrent debug sessions
- Heap snapshot, diff, sampling
- CPU profiling and coverage collection
- Daemon crash recovery and orphan cleanup

### 13.3 Agent simulation tests

- Scripted debugging scenarios (like the race condition / circular dependency / memory leak scenarios from the design phase) run as end-to-end bash scripts
- Measure: total tool calls needed, total tokens in output, success rate
- Compare against equivalent MCP-based debuggers

---

## 14. Future Considerations (v2+)

- **MCP adapter** — optional MCP server mode wrapping the CLI for clients that prefer MCP
- **Watch expressions** — persistent expressions re-evaluated on every pause
- **Conditional logpoint templates** — more complex logpoint logic
- **Time-travel debugging** — record execution and replay forward/backward
- **Remote debugging** — built-in SSH tunnel management
- **Multi-process** — debug parent + child processes (fork/cluster)
- **Worker threads** — attach to worker threads via `Target` domain
- **Flamegraph export** — export CPU profiles as interactive flamegraphs
- **VS Code extension** — thin wrapper that delegates to the CLI
