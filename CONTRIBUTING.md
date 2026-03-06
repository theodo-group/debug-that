# Contributing to dbg

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) (latest)
- [Node.js](https://nodejs.org) 20+ (for integration tests)
- Git

### Getting Started

```bash
git clone https://github.com/theodo-group/dbg.git
cd dbg
bun install
```

### Commands

```bash
bun run dev          # Run in development
bun test             # Run all tests
bun run lint         # Lint with Biome
bun run format       # Auto-fix lint/format issues
bun run typecheck    # TypeScript type checking
bun run build        # Compile standalone binary
```

## Project Structure

```
src/
  cli/          # CLI argument parsing, command routing
  daemon/       # Background daemon, Unix socket server
  cdp/          # Chrome DevTools Protocol WebSocket client
  dap/          # Debug Adapter Protocol client (LLDB, etc.)
  refs/         # @ref system (mapping short refs to V8 IDs)
  formatter/    # Output formatting (variables, source, stack traces)
  commands/     # Command implementations (break, step, eval, etc.)
  protocol/     # CLI-to-daemon JSON protocol types
  sourcemap/    # Source map resolution
tests/
  unit/         # Unit tests
  integration/  # Integration tests (node/, bun/, lldb/, shared/)
  fixtures/     # Test fixture scripts
```

## Making Changes

1. **Fork** the repository and create a branch from `main`
2. **Read** the existing code before modifying — understand the patterns
3. **Write tests** for new functionality (unit and/or integration)
4. **Run the full test suite** before submitting: `bun test`
5. **Lint** your code: `bun run lint`

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Biome** handles formatting and linting (tabs, double quotes, semicolons)
- **No ANSI colors by default** — output is optimized for AI agent consumption
- **Compact output** — one entity per line where possible
- **Error messages** should suggest the next valid command
- Use **Bun APIs** over Node.js equivalents (WebSocket, Bun.serve, etc.)

## Adding a New Command

1. Create `src/commands/<name>.ts`
2. Register it with `registerCommand("name", handler)`
3. Import it in `src/main.ts`
4. Handle the daemon request in `src/daemon/entry.ts`
5. Add the command to help text in `src/cli/parser.ts`

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Write a clear description of what changed and why
- Ensure CI passes (lint, typecheck, tests)
- Link related issues

## Reporting Issues

- Use GitHub Issues
- Include the output of `dbg --version`
- Include reproduction steps and expected vs actual behavior
- Include relevant debug logs (`dbg logs`)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
