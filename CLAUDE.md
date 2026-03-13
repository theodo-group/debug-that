# debug-that — Debugger CLI for AI Agents

## Project Overview
CLI debugger built with Bun, optimized for AI agent consumption.
Supports Node.js (CDP), Bun (JSC/WebKit), and native code via LLDB (DAP).

## Tech Stack
- **Runtime**: Bun
- **Language**: TypeScript
- **Linting/Formatting**: Biome
- **Testing**: bun:test
- **Validation**: Zod v4 (mini)
- **Dependencies**: Minimal — leverage Bun built-ins (WebSocket, test runner, file I/O)

## Project Structure
```
src/
  cli/          # CLI argument parsing, command routing, flag utilities
  session/      # Shared session abstractions
    session.ts    # Session interface + SessionCapabilities
    base-session.ts # BaseSession abstract class (shared state, refs, console)
    types.ts      # Shared types (PauseInfo, StateSnapshot, ConsoleMessage, etc.)
    factory.ts    # createSession() + isDapRuntime()
  daemon/       # Background daemon process, Unix socket server
  cdp/          # Chrome DevTools Protocol (Node.js / Bun)
    session.ts    # CdpSession (extends BaseSession)
    session-*.ts  # CDP method modules (breakpoints, execution, inspection, etc.)
    dialect.ts    # CdpDialect interface (V8 vs JSC strategy)
    adapters/     # NodeAdapter, BunAdapter (CdpDialect implementations)
    client.ts     # CdpClient WebSocket wrapper
  dap/          # Debug Adapter Protocol (LLDB, Python, etc.)
    session.ts    # DapSession (extends BaseSession)
    client.ts     # DapClient stdin/stdout wrapper
  refs/         # @ref system (mapping short refs to V8 IDs)
  formatter/    # Output formatting (variables, source, stack traces)
  commands/     # Command implementations (break, step, eval, etc.)
  protocol/     # CLI-to-daemon JSON protocol types
  sourcemap/    # Source map resolution
  util/         # Shared utilities (escapeRegex, etc.)
  constants.ts  # Centralized timeout/limit constants
tests/
  unit/         # Unit tests
  integration/  # Integration tests (node/, bun/, lldb/, shared/)
  fixtures/     # Test fixture scripts
```

## Commands
- `bun run dev` — run in development
- `bun test` — run all tests
- `bun run build` — compile standalone binary
- `bun run lint` — lint with biome
- `bun run format` — format with biome
- `bun run typecheck` — type check source files

## Guidelines
- Use Bun APIs over Node.js equivalents (WebSocket, Bun.serve, Bun.$, etc.)
- No ANSI colors by default (token efficiency for AI agents)
- Every error should suggest the next valid command
- Keep output compact — one entity per line where possible
- Use @refs for all inspectable entities in output
- Use `parseIntFlag()` from `src/cli/parse-flag.ts` for integer CLI flags (NaN-safe)
- Use `parseFileLine()` / `parseFileLineColumn()` from `src/cli/parse-target.ts` for file:line:column parsing
- Use `escapeRegex()` from `src/util/escape-regex.ts` for CDP urlRegex patterns
- Use `formatTimestamp()` from `src/formatter/timestamp.ts` for time display
- Import timeout/limit values from `src/constants.ts` — do not hardcode magic numbers
- Adding a command: create `src/commands/<name>.ts`, register in `src/main.ts`, handle in `src/daemon/entry.ts`, add to help in `src/cli/parser.ts`
