---
name: dbg
description: >
  Debug applications using the dbg CLI debugger.
  Supports Node.js (V8/CDP), Bun (WebKit/JSC), Python (debugpy/DAP), Java (JDWP/DAP), and native code via LLDB (DAP).
  Use when: (1) investigating runtime bugs by stepping through code, (2) inspecting
  variable values at specific execution points, (3) setting breakpoints and conditional
  breakpoints, (4) evaluating expressions in a paused context, (5) hot-patching code
  without restarting (JS/TS), (6) debugging test failures by attaching to a running process,
  (7) debugging C/C++/Rust/Swift with LLDB, (8) debugging Python via debugpy,
  (9) any task where understanding runtime behavior requires a debugger.
  Triggers: "debug this", "set a breakpoint", "step through", "inspect variables",
  "why is this value wrong", "trace execution", "attach debugger", "runtime error",
  "segfault", "core dump".
---

# dbg Debugger

`dbg` is a CLI debugger that supports **Node.js** (V8/CDP), **Bun** (WebKit/JSC), **Python** (via debugpy/DAP), **Java** (via JDWP/DAP) and **native code** (C/C++/Rust/Swift via LLDB/DAP). It uses short `@refs` for all entities -- use them instead of long IDs.

## Supported Runtimes

| Runtime | Language | Launch example |
|---------|----------|----------------|
| Node.js | JavaScript | `dbg launch --brk node app.js` |
| tsx / ts-node | TypeScript | `dbg launch --brk tsx src/app.ts` |
| Bun | JavaScript / TypeScript | `dbg launch --brk bun app.ts` |
| debugpy | Python | `dbg launch --brk python3 app.py` (or attach -- see Python section) |
| LLDB | C / C++ / Rust / Swift | `dbg launch --brk --runtime lldb ./program` |
| JDWP | Java | `dbg launch --brk --runtime java ./program` |

The runtime is auto-detected from the launch command for JS and Python runtimes. For native code, use `--runtime lldb`. Python can also attach to a running `debugpy` listener over TCP (`--runtime python`).

## Core Debug Loop

```bash
# 1. Launch with breakpoint at first line
dbg launch --brk node app.js
# Or: dbg launch --brk bun app.ts
# Or: dbg launch --brk python3 app.py
# Or: dbg launch --brk --runtime lldb ./my_program
# Or attach to a running process with the --inspect flag
dbg attach 9229

# 2. Set breakpoints at suspicious locations
dbg break src/handler.ts:42
dbg break src/utils.ts:15 --condition "count > 10"

# 3. Run to breakpoint
dbg continue

# 4. Inspect state (shows location, source, locals, stack)
dbg state

# 5. Drill into values
dbg props @v1              # expand object
dbg props @v1 --depth 3   # expand nested 3 levels
dbg eval "x + 1"

# 6. Fix and verify (JS/TS only)
dbg set count 0            # change variable
dbg hotpatch src/utils.js  # live-edit (reads file from disk)
dbg continue               # verify fix
```

## Debugging Strategies

### Bug investigation -- narrow down with breakpoints
```bash
dbg launch --brk node app.js
dbg break src/api.ts:50                    # suspect line
dbg break src/api.ts:60 --condition "!user" # conditional
dbg continue
dbg vars                                    # check locals
dbg eval "JSON.stringify(req.body)"         # inspect deeply
dbg step over                               # advance one line
dbg state                                   # see new state
```

### Native code debugging (C/C++/Rust)
```bash
dbg launch --brk --runtime lldb ./my_program
dbg break main.c:42
dbg break-fn main                          # function breakpoint (DAP only)
dbg continue
dbg vars                                    # inspect locals
dbg eval "array[i]"                         # evaluate expression
dbg step into                               # step into function
```

### Python debugging (debugpy)
Python uses the `debugpy` DAP adapter. Two ways in:

**Launch** (auto-detected from a `python`/`python3` command):
```bash
dbg launch --brk python3 app.py        # pauses at first line
dbg break app.py:42
dbg continue
dbg state                              # location + locals + stack
dbg eval "some_expr"                   # evaluate in the paused frame
dbg step over
```

**Attach** -- the debuggee runs its own `debugpy` listener and `dbg` connects
over TCP (no adapter spawned in between). Useful when the process must be
launched a specific way (a test runner, a virtualenv, a secrets wrapper):
```bash
# 1. Start the program listening on a port. --wait-for-client blocks before
#    the first line runs, so you have time to attach and set breakpoints.
python3 -m debugpy --listen 5679 --wait-for-client app.py &

# 2. Attach. --runtime python (alias: debugpy) is REQUIRED for a bare port.
dbg attach 5679 --runtime python

# 3. Set breakpoints (use absolute paths), then drive execution.
dbg break /abs/path/app.py:42
dbg continue
dbg state
```
Notes:
- `--wait-for-client` treats the FIRST TCP connection as the client -- don't
  probe the port to check readiness; just attach once debugpy prints its
  startup banner to stderr.
- A short script can run to completion before you set a breakpoint. Set it
  immediately after attaching, or attach to a long-running entry point.
- `dbg set` / `dbg hotpatch` are JS/TS only; inspection (`break`, `continue`,
  `state`, `vars`, `eval`, `step`, `break-fn`) all work for Python.

### Attach to running/test process (Node/Bun)
```bash
# Start with inspector enabled
node --inspect app.js
# Or: bun --inspect app.ts
# Then attach
dbg attach 9229
dbg state
```

### Trace execution flow with logpoints (no pause)
```bash
dbg logpoint src/auth.ts:20 "login attempt: ${username}"
dbg logpoint src/auth.ts:45 "auth result: ${result}"
dbg continue
dbg console    # see logged output
```

### Exception debugging
```bash
dbg catch uncaught          # pause on uncaught exceptions
dbg continue                # runs until exception
dbg state                   # see where it threw
dbg eval "err.message"      # inspect the error
dbg stack                   # full call stack
```

### TypeScript source map support
dbg automatically resolves `.ts` paths via source maps. Set breakpoints using `.ts` paths, see `.ts` source in output. Use `--generated` to see compiled `.js` if needed.

## Ref System

Every output assigns short refs. Use them everywhere:
- `@v1..@vN` -- variables: `dbg props @v1`, `dbg set @v2 true`
- `@f0..@fN` -- stack frames: `dbg eval --frame @f1 "this"`
- `BP#1..N` -- breakpoints: `dbg break-rm BP#1`, `dbg break-toggle BP#1`
- `LP#1..N` -- logpoints: `dbg break-rm LP#1`

Refs `@v`/`@f` reset on each pause. `BP#`/`LP#` persist until removed.

## Key Flags

- `--json` -- machine-readable JSON output on any command
- `--session NAME` -- target a specific session (default: "default")
- `--runtime NAME` -- select debug adapter (e.g. `lldb` for native code)
- `--generated` -- bypass source maps, show compiled JS (on state/source/stack)

## Command Reference

See [references/commands.md](references/commands.md) for full command details and options.

## Tips

- `dbg state` after stepping always shows location + source + locals -- usually enough context
- `dbg state -c` for source only, `-v` for vars only, `-s` for stack only -- save tokens
- `dbg eval` supports `await` -- useful for async inspection (JS/TS)
- `dbg blackbox "node_modules/**"` -- skip stepping into dependencies
- `dbg hotpatch file` reads the file from disk -- edit the file first, then hotpatch (JS/TS only)
- `dbg break-fn funcName` -- function breakpoints work with DAP runtimes (LLDB, Python, Java)
- Python: `dbg launch --brk python3 app.py`, or attach to a `debugpy --listen <port>` server with `dbg attach <port> --runtime python`
- Execution commands (`continue`, `step`, `pause`, `run-to`) auto-return status
- `dbg stop` kills the debugged process and daemon
