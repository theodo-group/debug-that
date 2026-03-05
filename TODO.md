# TODO — Improvements from React Native Crash Debugging

## Context

While debugging a React Native iOS crash (SIGABRT in Yoga C++ caused by `width: 'fit-content'` in a StyleSheet), we used agent-dbg with `--runtime lldb` (DAP mode) to attach to the running app, catch the exception, and walk the stack to identify the problematic component.

The full workflow was:
1. `agent-dbg attach --runtime lldb <pid>` to connect to the RN app
2. `agent-dbg catch all` to break on exceptions
3. Trigger the crash in the app (toggle theme)
4. `agent-dbg stack` to get 50 frames from `__pthread_kill` through Yoga to unistyles
5. `agent-dbg vars --frame @fN` + `agent-dbg props @vN` repeated many times to drill into `ShadowNodeFamily` objects and find which component had the bad style

This revealed several friction points, ordered by impact for AI agent usage.

---

## High Impact

### 1. Deep object inspection (`props --depth N`)

**Issue:** Inspecting a nested object graph requires one `props` call per level. To identify which of 6 React Native nodes had the bad style, we needed ~20 sequential commands: `props @v386` → find entry → `props @v40` → find ShadowNodeFamily → `props @v41` → find `componentName_`. Multiply by 6 nodes. Each call is a full daemon round-trip, burning tokens and time for an AI agent.

**Example:**
```bash
# Current: 4 round-trips to reach componentName_
agent-dbg props @v386          # tagToProps map → 6 entries
agent-dbg props @v40           # entry 0 → {first: 4, second: @v41}
agent-dbg props @v41           # second → ShadowNodeFamily object
agent-dbg props @v42           # ShadowNodeFamily → {tag_: 4, componentName_: "View", ...}

# Desired: 1 round-trip
agent-dbg props @v386 --depth 3
# Returns the full tree expanded 3 levels deep
```

**Suggested fix:** Add `--depth N` (default 1) to `props` and `vars` commands. In `getProps()`, after fetching immediate children, recursively call `getProps()` on any child that has a `variablesReference > 0` (DAP) or is an object type (CDP), up to the depth limit. Cap at depth 5 to avoid runaway expansion. Return a nested JSON structure instead of a flat list.

---

### 2. Watchpoints / data breakpoints

**Issue:** DAP supports `dataBreakpoints` — break when a specific memory address is written to. This would directly answer "when does this variable get set to the bad value?" instead of the multi-breakpoint stepping approach we tried (set BP at clone loop, step through each clone, check props each time). LLDB natively supports watchpoints (`watchpoint set variable foo`).

**Example:**
```bash
# After finding the suspicious variable:
agent-dbg vars --frame @f288
# @v50  tagToProps  size=6

# Desired: break when a specific tag's props are modified
agent-dbg watch @v50 --write
# → WP#1 set on tagToProps (0x7ff8a0012340), break on write

# Continue execution → breaks exactly when the bad style is applied
agent-dbg continue
# Paused: watchpoint WP#1 hit — tagToProps modified at ShadowTreeManager.cpp:34
```

**Suggested fix:** Add a `watch` command that sends DAP `dataBreakpointInfo` (to check if a variable supports data breakpoints) followed by `setDataBreakpoints`. Track watchpoints in a `watchpoints` array similar to `functionBreakpoints`. For CDP mode, this isn't natively supported — return an error with suggestion.

---

### 3. Loaded modules / libraries

**Issue:** We spent ~30 minutes trying to eval C++ expressions at React framework frames (`this->tag_`, `this->getComponentName()`) before realizing the framework binary had no debug symbols (built on CI, `.o` files missing). There was no way to know upfront which frames had usable debug info and which didn't.

**Example:**
```bash
# Current: blind trial-and-error
agent-dbg eval 'this->tag_' --frame @f300
# Error: invalid use of 'this' outside of a non-static member function
# (Why? No debug symbols — but the error message doesn't say that)

# Desired: check what has symbols first
agent-dbg modules
# MODULE                              SYMBOLS   PATH
# MyApp                               full      /path/to/MyApp.app/MyApp
# React.framework                     stripped  /path/to/React.framework/React
# hermes.framework                    full      /path/to/hermes.framework/hermes
# react-native-unistyles.framework    full      /path/to/unistyles.framework/...
```

**Suggested fix:** Add a `modules` command that sends DAP `modules` request. Display module name, symbol status (full/stripped/none), version, and path. Optionally filter: `agent-dbg modules --filter yoga`. For CDP, return the loaded scripts list (already available via `getScripts`).

---

### 4. Attach by process name

**Issue:** Every debugging session required manually finding the PID (`xcrun simctl spawn booted launchctl list | grep MyApp`, or `pgrep -f MyApp`). DAP's attach request accepts a process `name` field, but we only exposed `target` (which expects a PID or WebSocket URL).

**Example:**
```bash
# Current: manual PID lookup
pgrep -f "debug-rn-wrong-dimensions"   # → 12345
agent-dbg attach --runtime lldb 12345

# Desired: attach by name
agent-dbg attach --runtime lldb --name "debug-rn-wrong-dimensions"
# Attached to PID 12345 (debug-rn-wrong-dimensions)
```

**Suggested fix:** In `DapSession.attach()`, detect if `target` is numeric (PID) or a string (process name). If string, pass `{ name: target }` instead of `{ pid: parseInt(target) }` in the DAP attach request. LLDB-DAP supports both. For CDP, keep existing behavior (target is always a WebSocket URL or port).

---

### 5. `run-to` for DAP

**Issue:** `run-to` is not implemented for DAP sessions. We had to manually set a breakpoint, continue, then remove it — 3 commands instead of 1. This pattern was used repeatedly in the investigation scripts.

**Example:**
```bash
# Current: 3 commands
agent-dbg break ShadowTreeManager.cpp:22
# BP#5 set
agent-dbg continue
# Paused at ShadowTreeManager.cpp:22
agent-dbg break-rm BP#5

# Desired: 1 command
agent-dbg run-to ShadowTreeManager.cpp:22
# Paused at ShadowTreeManager.cpp:22 (temporary breakpoint auto-removed)
```

**Suggested fix:** Implement `DapSession.runTo(file, line)` by: (1) setting a temporary breakpoint via `setBreakpoints` (add to existing file breakpoints), (2) calling `continue`, (3) on stop, removing the temporary breakpoint. Alternatively, some DAP adapters support `goto` targets — check adapter capabilities first.

---

## Medium Impact

### 6. Disassembly view

**Issue:** When source code isn't available (framework built on CI without debug symbols), the `source` command returns nothing useful. Disassembly is the only way to understand what's executing. DAP has a `disassemble` request that returns instruction-level code, but we never exposed it.

**Example:**
```bash
# Current: no source available
agent-dbg source --frame @f300
# Error: no source available for this frame

# Desired: fall back to disassembly
agent-dbg disassemble --frame @f300
# 0x1a2b3c40  stp x29, x30, [sp, #-16]!
# 0x1a2b3c44  mov x29, sp
# 0x1a2b3c48  bl  0x1a2b4000        ; yoga::Style::operator==
# → 0x1a2b3c4c  cbz w0, 0x1a2b3c60  ; <-- current instruction
# 0x1a2b3c50  ldr x8, [x19, #24]
```

**Suggested fix:** Add a `disassemble` command that sends DAP `disassemble` request with the current frame's `instructionPointerReference`. Format output with addresses, mnemonics, and an arrow marking the current instruction. For CDP, this isn't applicable — return an error.

---

### 7. Memory read

**Issue:** We couldn't inspect `folly::dynamic` internals because LLDB's expression evaluator didn't understand F14 hash maps. But with raw memory access + known struct layouts, we could have manually decoded the data. DAP has `readMemory` request.

**Example:**
```bash
# Current: opaque object
agent-dbg eval '*(folly::dynamic::ObjectImpl*)(0x7ff8a0012340)'
# Error: no member named 'ObjectImpl' in namespace 'folly::dynamic'

# Desired: read raw memory
agent-dbg memory 0x7ff8a0012340 --count 128
# 0x7ff8a001_2340: 06 00 00 00 00 00 00 00  03 00 00 00 00 00 00 00  ................
# 0x7ff8a001_2350: 40 56 01 a0 f8 7f 00 00  00 00 00 00 00 00 00 00  @V..............
```

**Suggested fix:** Add a `memory` command that sends DAP `readMemory` request. Accept address (hex) and byte count. Format as hex dump with ASCII sidebar. For CDP, not applicable.

---

### 8. Exception breakpoint filters

**Issue:** Our `catch` command only supports `all/none/uncaught`. When debugging the RN crash, `catch all` caught every signal (including harmless SIGTRAPs from thread creation), requiring manual `continue` past irrelevant stops. DAP supports filter-based exception breakpoints — LLDB can catch only `SIGABRT`.

**Example:**
```bash
# Current: catch everything
agent-dbg catch all
# Stops on SIGTRAP (thread created) — irrelevant, continue
# Stops on SIGTRAP (breakpoint) — irrelevant, continue
# Stops on SIGABRT — the actual crash

# Desired: catch specific signals
agent-dbg catch --filter SIGABRT
# Only stops on SIGABRT
```

**Suggested fix:** Query the adapter's `exceptionBreakpointFilters` capability (returned in `initialize` response) and expose them. Add `--filter <name>` flag to `catch` command. Send `setExceptionBreakpoints` with selected filter IDs instead of blanket all/none.

---

### 9. Restart for DAP

**Issue:** After each investigation attempt, we had to `stop` the session and re-launch/re-attach manually. `restart` isn't implemented for DAP.

**Example:**
```bash
# Current: 2 commands + re-specify args
agent-dbg stop
agent-dbg attach --runtime lldb 12345

# Desired: 1 command
agent-dbg restart
# Re-attached to PID 12345
```

**Suggested fix:** Store the original launch/attach arguments in `DapSession`. On `restart()`, call `stop()` then replay the original `launch()` or `attach()` call. Some DAP adapters also support the `restart` request natively — check capabilities first.

---

### 10. Stack filtering

**Issue:** The crash produced 50 stack frames, but only ~5 were relevant (yoga layout, unistyles shadow tree update). An AI agent has to parse all 50 to find the interesting ones, wasting tokens.

**Example:**
```bash
# Current: 50 frames, most are system/framework noise
agent-dbg stack
# @f0  __pthread_kill (libsystem_kernel.dylib)
# @f1  pthread_kill (libsystem_pthread.dylib)
# ... 45 more framework frames ...
# @f47 -[UIApplication sendAction:to:from:forEvent:]
# @f48 UIApplicationMain

# Desired: filter by keyword
agent-dbg stack --filter yoga
# @f5  yoga::StyleValuePool::getLength (yoga.cpp:1234)
# @f6  yoga::Node::setStyle (Node.cpp:567)
# @f8  facebook::react::updateYogaProps (Props.cpp:89)

# Or show only user code (non-system frames)
agent-dbg stack --user
# @f10 margelo::nitro::unistyles::HybridStyleSheet::onPlatformDependenciesChange
# @f12 margelo::nitro::unistyles::ShadowTreeManager::updateShadowTree
```

**Suggested fix:** Add `--filter <keyword>` flag to `stack` command that filters frames by function name substring match. Add `--user` flag that excludes frames from system libraries (heuristic: exclude paths containing `/usr/lib/`, `libsystem_`, `UIKit`, `CoreFoundation`, etc.). Both are client-side filters on the existing stack data — no protocol changes needed.

---

## Low Impact

### 11. Toggle breakpoint for DAP

**Issue:** `break-toggle` throws "not yet supported" for DAP. DAP tracks enabled/disabled state per breakpoint — when re-sending `setBreakpoints`, each breakpoint can have an `enabled` field set to `false`.

**Example:**
```bash
agent-dbg break-toggle BP#3
# BP#3 disabled (was enabled)
```

**Suggested fix:** Add an `enabled` field to `DapBreakpointEntry`. On toggle, flip the flag and re-sync breakpoints for that file via `setBreakpoints`, including `enabled: false` for the toggled one.

---

### 12. Loaded sources for DAP

**Issue:** `scripts` returns an empty array for DAP sessions. DAP has a `loadedSources` request that returns all source files known to the debugger.

**Example:**
```bash
agent-dbg scripts --filter unistyles
# (empty — no scripts tracked in DAP mode)

# Desired:
# ShadowTreeManager.cpp  /path/to/unistyles/ShadowTreeManager.cpp
# HybridStyleSheet.cpp   /path/to/unistyles/HybridStyleSheet.cpp
```

**Suggested fix:** Implement `DapSession.getScripts(filter?)` by sending DAP `loadedSources` request. Cache the result (it doesn't change often). Apply the filter client-side on the returned source names/paths.

---

### 13. Better eval error suggestions

**Issue:** When `eval` fails, the error message comes raw from the debugger with no actionable suggestions. For example, `this->tag_` fails with "invalid use of 'this' outside of a non-static member function" — but doesn't tell you *why* (no debug symbols) or *what to try instead*.

**Example:**
```bash
# Current:
agent-dbg eval 'this->tag_' --frame @f300
# Error: invalid use of 'this' outside of a non-static member function

# Desired:
agent-dbg eval 'this->tag_' --frame @f300
# Error: invalid use of 'this' outside of a non-static member function
#   -> This frame may lack debug symbols. Try 'agent-dbg modules' to check.
#   -> Try accessing the variable directly: 'tag_'
#   -> Try a different frame: 'agent-dbg eval 'this->tag_' --frame @f301'
```

**Suggested fix:** In the eval error handler, pattern-match common LLDB error messages and append contextual suggestions. Examples:
- "invalid use of this" → suggest checking modules for symbols, try variable directly
- "no member named" → suggest `props` to list available members
- "use of undeclared identifier" → suggest `vars` to see what's in scope

---

## Infrastructure

### Managed adapter binaries (`agent-dbg install lldb`)

**Issue:** LLDB debugging requires `lldb-dap` which is a system dependency (Homebrew LLVM on macOS, apt on Linux). Relying on users to install it separately is fragile for an open source tool. Integration tests skip when it's missing.

**Goal:** Follow the Playwright/Puppeteer model — the tool manages its own adapter binaries.

**Design:**
```bash
agent-dbg install lldb    # downloads lldb-dap for current platform
agent-dbg install --list  # shows installed adapters
```

Storage: `~/.agent-dbg/adapters/lldb-dap`

**Implementation steps:**
1. Add `install` CLI command that detects platform+arch (darwin-arm64, linux-x64, etc.)
2. Download pre-built `lldb-dap` + `liblldb` from LLVM GitHub releases
3. Store in `~/.agent-dbg/adapters/`
4. Update `resolveAdapterCommand()` in `src/dap/session.ts` to check managed path first, then system PATH
5. Integration tests check managed path OR system PATH (current skip-if-not-found behavior)

**References:** Playwright stores browsers in `~/.cache/ms-playwright/`, esbuild/swc download platform-specific binaries via optionalDependencies
