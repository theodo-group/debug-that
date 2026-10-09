# Changelog

## 0.12.0

Everything since 0.6.3, the last published version. Node.js and Bun debugging got most of it: dbg now debugs live targets without pausing them, binds breakpoints on files before they load, pauses at a program's exit, and reads minified code.

### New Features

- **Eval while running** — `dbg eval` no longer needs a pause: without `--frame` it evaluates in the global scope on a running target, so a hook can be installed or adjusted on a live process. `await` in an expression works; `--await` settles a promise the same way on V8 and JSC, and says when it can only settle once the program runs. `--out <file>` writes the whole value.
- **Function breakpoints on JavaScript** — `dbg break-fn <path|@ref>` pauses on calls of `fetch`, `service.ping` or a function object found at a pause; `--name <regex>` (Bun) matches any function by name, minified code included. The engine pauses on the call itself when it can; native functions (`JSON.parse`) are wrapped in place, which `break-ls` notes, and the wrapper is removed with the breakpoint or when dbg disconnects. `--log` makes a function logpoint; `break fn:<path>` and `logpoint fn:<path>` take the form `break-ls` prints.
- **Breakpoints on files not loaded yet** bind before the file's first statement runs, whatever loads it: `import`, `require` or `vm.compileFunction` (Jest). They show as `(pending: file not loaded yet)` until then, and keep a pinned column.
- **`continue --wait N`** blocks until the next pause or the program's end; **`step --wait N`** waits for a step that runs long. While running, `continue --wait` just waits. A wait that runs out says so, `Running (no pause within 30s)`, with the next step.
- **`catch exit`** pauses in the program's exit with its state still alive: `Paused at ./app.js:4:10 (exit code 3)`, and `eval` reaches everything that is still there.
- **Bun** — launch Bun programs and executables built by `bun build --compile` with no flags: the inspector listens on a socket file only dbg knows. Console output is captured. Breakpoints, hit counts and logpoints use JSC's own features. A finished Bun program exits with dbg attached, as it would without it.
- **Minified and bundled code** — `--width N` on `state`, `source` and `search` shows N characters around the column or match; `search` reports the match column and windows each match. `dbg source <file>:<line>[:<col>]` shows a window anywhere, and a search result pastes back in as is. `dbg sourcemap <script> --map <file>` pairs a script with a map file written while the session runs, re-read as it changes; `dbg sourcemap <script> --pretty` shows a script formatted from then on, with positions and breakpoints translating both ways. Pairings survive a restart.
- **Attach shows what it reached** — `attach` and `status` print the target's pid and command line, so a stale process holding a port is visible at once.
- **Every error carries its next step** as a field (`suggestion` in `--json`), printed as `-> Try: dbg ...`. Commands that need a pause, a loaded script or a known ref say what to do without one.
- **Daemon** — stays alive while a target is live, however long the next command takes; `--timeout` is its idle timeout in seconds. `attach` and `launch` reuse a daemon with no live target, so the retry an error suggests works.
- **`dbg install lldb`** finds `lldb-dap` where toolchains put it: PATH, Homebrew's LLVM kegs, Xcode and the Command Line Tools, a Linux distribution's `/usr/lib/llvm-N`.
- **`bun run test:stress`** reruns the test suites on a CPU-starved machine, to catch code that waits on time instead of protocol events.

### Changes

- **One pause vocabulary on both engines**, the one DAP adapters use: `breakpoint`, `debugger`, `step`, `pause`, `entry`, `exception`, `exit code N`, `function breakpoint <name>`. The engines' words no longer leak through (`other`, `Breakpoint`, `DebuggerStatement`, `Break on start`).
- **Positions count from 1 everywhere**, columns included; `launch`, `restart` and `status` printed the pause line one too early for Node and Bun.
- **`eval --timeout` takes seconds**, like every other time flag (was milliseconds).
- **Logpoints never print into the program's own output**: they reach `dbg console` only, on Node and Bun.
- **`launch`**: everything after the program's name goes to the program; a program that exits before its inspector opens fails at once with its stderr.
- **`--help`** keeps descriptions in one column; placeholders read `SECONDS` and `N`.

### Bug Fixes

- A source file bundled into several chunks: a breakpoint on a line only another chunk maps silently never bound.
- `dbg launch node app.js` and `dbg attach ... --runtime bun` rejected `node` and `bun` as explicit runtimes.
- A `dbg launch` or `attach` right after `dbg stop` reached the dying daemon and failed.
- On Bun, attaching to a running process never activated breakpoints; a CommonJS entry file never paused at entry; a finished program showed as running forever.
- A breakpoint on `app.js` could bind in `webapp.js`: suffix matching now respects path boundaries.
- A source-mapped breakpoint keeps its translated column, snapped to the line's first breakable location: minified lines bind on the right statement, and a mapping on a trailing sub-expression no longer binds nowhere.
- Map and Set values rendered as `"" => undefined`.
- A dropped `vm` context (one per Jest test file) marked the session idle while the process lived.
- A launch on a slow machine could report `Running` while the program stood held at line 1; the wait for a held program's first stop has no bound now.
- Races found under CPU starvation: `continue` returning before the engine had resumed, a function breakpoint's first pause arriving before its entry was recorded, a pending breakpoint missing an ES module that ran first, a step landing after an `await` on Bun reported as a breakpoint. Waits are on protocol events now, not timers.
- Bun 1.4.0 on macOS now and then leaves a fresh inspector socket or stderr pipe without any event under heavy launch and exit churn; dbg reopens a silent socket and reads a child's stderr from a file.
- DAP: `restart-frame` created its wait while still marked paused and ran into a moving thread; LLDB tests skip cleanly without `lldb-dap`.

### Internal

- The CDP runtime layer is a `InspectorDialect` per engine, bound to its socket, owning the whole connect handshake and reporting its target's events in one shape; the session reads no raw engine event. A `Launcher` per runtime starts a program held until dbg connects.
- `PendingBreakpoints` owns the waiting-breakpoint lifecycle; `classifyPause` names every pause in one place; `FunctionBreakpoints` binds each target with the first strategy that can.
- `UserError(message, next)` replaces the `"... -> Try: ..."` string convention. Breakpoint metadata is a union on kind; frame refs carry typed metadata; values read from the target are checked, not cast.
- README: what dbg puts in the debugged process, and why Bun keeps an exit listener (it flushes the last output, which Bun otherwise drops).

## 0.6.0

### New Features

- **Java expression evaluation (ECJ compile+inject)** — full Java expression support in `dbg eval`, replacing the limited variable/field-only evaluator
  - Arithmetic, method calls with arguments, ternary, constructors, collections, string operations
  - Automatic reflection fallback for private field access
  - Compiles expressions to bytecode with ECJ 3.40.0, injects via JDI `ClassLoader.defineClass`
- **Java hot code replace (`dbg hotpatch`)** — live-patch Java classes without restarting the JVM
  - `.java` input: compiles with ECJ using debuggee classpath, redefines via `vm.redefineClasses()`
  - `.class` input: reads bytecode directly, auto-detects inner class siblings
  - Obsolete frame detection with restart-frame support
  - Two-step DAP protocol (prepare + redefineClasses) avoids java-debug framework deadlock
  - Works with Spring Boot: attach to running app, hotpatch controller, verify with curl
- **Unified structured logger** — single typed JSONL log file per session
  - Replaces separate CdpLogger + DaemonLogger + DEBUG_DAP with `Logger<N>` typed by source
  - `LogData<N, M>` conditional type: known messages enforce data shapes at compile time
  - Custom formatters per (source, msg) pair: CDP `→/←/⚡`, DAP `→/←/⚡`, default `key=value`
  - `dbg logs --src cdp --level trace` with colored output

### Bug Fixes

- **JVM freeze after hotpatch** — `SUSPEND_ALL` breakpoint policy (matching IntelliJ) prevents VM safepoint deadlock when `redefineClasses` is called with only one thread paused
- **Breakpoint disable/re-enable around redefineClasses** — prevents JDWP agent from firing events during class redefinition safepoint

### Improvements

- **Maven-based Java adapter installer** — dependencies resolved via `mvn dependency:copy-dependencies` instead of manual JAR downloads; `pom.xml` is the single source of truth
- **java-debug 0.53.2** (built from source) — includes `suspendAllThreads` setting for `SUSPEND_ALL` policy
- **`bun run build:java`** — one command to recompile the Java adapter during development
- **`dbg install java`** always recompiles (no "already installed" guard)
- **DAP runtime configs** extracted into `src/dap/runtimes/` with typed `DapRuntimeConfig` interface
- **WaitForStopOptions** — unified continue/step options across CDP and DAP sessions
- **`-cp` classpath support** for Java launch: `dbg launch java -- -cp lib/*:classes Main`
- **Short filename resolution** for Java sources (Maven layout auto-detection)
- **`PathSearchingVirtualMachine.classPath()`** for safe classpath resolution without thread resumption

## 0.5.0

### New Features

- **Java debugging via DAP** — launch and attach to JVM programs using Microsoft's `java-debug.core` adapter
  - `dbg launch --runtime java Hello.java` — launch with breakpoints, stepping, variable inspection, eval
  - `dbg attach localhost:5005 --runtime java` — attach to a running JVM via JDWP
  - `dbg install java` — managed install (~3.5MB from Maven Central, compiled locally)
  - Conditional breakpoints, exception pause, function breakpoints (registration only without JDT)
  - Auto-detect `mvn`, `gradle`, `gradlew`, `mvnw`, `mvnDebug` as Java runtimes

### Internal

- **Adapter installer registry** — `src/dap/adapters/` with `AdapterInstaller` interface; adding a new adapter = one file + one registry entry
- **DapSession runtime strategy pattern** — replaced if/else chain with `DapRuntimeConfig` per runtime for launch args, attach parsing, and adapter resolution
- **Build-time asset bundling** — Java adapter sources tarball generated by `build.ts`, bundled as Bun file asset, lazy-imported at install time
- Extracted lldb installer from monolithic `install.ts` into `adapters/lldb.ts`
- Fixed lldb installer bug: liblldb extraction from already-deleted tarball
- `Bun.$` shell syntax replaces `Bun.spawnSync` in adapter installers
- `Bun.which()` replaces `which` shell command for adapter resolution
- `path.delimiter` for cross-platform classpath separator
- Attach-mode disconnect preserves debuggee (`terminateDebuggee: false`)

## 0.4.0

### New Features

- **`path-map` and `symbols` commands** for DAP debug info management (LLDB, Python)
- **Auto-detect runtime** from command binary name — `dbg launch node app.js` no longer needs `--runtime node`
- **Deferred breakpoint rebinding** with source-map awareness for Jest/Vitest — breakpoints set in `.ts` files resolve correctly when test runners compile to `.js`
- **Pending breakpoint status** — `break-ls` now shows `[pending]` for breakpoints not yet resolved to a script

### Bug Fixes

- **CLI parser: value flags now accept dash-prefixed values** — `--timeout -1` and `--condition -x` work correctly instead of being misinterpreted as flags
- **CLI parser: POSIX combined short flags with values** — `-p9229` and `-vp9229` now correctly parse the value remainder
- **CLI parser: stricter command suggestion threshold** — short typos like `dbg zz` no longer produce false "Did you mean" suggestions
- **Source map translation for logpoints and run-to** — coordinates now resolve correctly through source maps
- **DAP adapter errors surfaced** when `stopOnEntry` fails
- **Socket directory permissions** restricted to owner only (security fix)

### Internal

- Restructured session architecture: extracted `BaseSession`, `Session` interface, and `SessionCapabilities`
- Replaced `registerCommand()` with declarative `defineCommand()` using Zod schemas
- Typed `RefEntry` as discriminated union with deterministic pending rebinds
- Introduced `SourceLocation`/`RuntimeLocation` types for coordinate spaces
- Rewritten CLI parser as tokenizer/parser two-phase architecture
- Reduced command boilerplate with typed `daemonRequest()` helper
- Improved `DaemonServer` type safety and error handling

## 0.3.0

- `--color` flag with syntax highlighting and colored output
- Bun debugger support (WebKit Inspector / JSC)
- `catch` command for exception breakpoints
- `logpoint` command
- `break-toggle` command
- `breakable` command to list breakable locations
- `restart-frame` command
- Source map support (`sourcemap` command)
- `console` and `exceptions` commands
- `blackbox`, `blackbox-ls`, `blackbox-rm` commands
- `set`, `set-return`, `hotpatch` mutation commands
- `search` command for searching source content

## 0.2.1

- Bug fixes

## 0.2.0

- Initial public release
