# Changelog

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
