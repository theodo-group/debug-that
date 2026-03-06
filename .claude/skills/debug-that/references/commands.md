# dbg Command Reference

## Table of Contents
- [Session](#session)
- [Execution](#execution)
- [Inspection](#inspection)
- [Breakpoints](#breakpoints)
- [Mutation](#mutation)
- [Blackboxing](#blackboxing)
- [Source Maps](#source-maps)
- [Global Flags](#global-flags)

## Session

```bash
dbg launch [--brk] <command...>     # Start + attach debugger (--brk pauses at first line)
dbg launch --brk --runtime lldb ./program  # Native debugging via LLDB (DAP)
dbg attach <pid|ws-url|port>        # Attach to running process
dbg stop                            # Kill process + daemon
dbg sessions [--cleanup]            # List active sessions
dbg status                          # Session info (pid, state, pause location)
```

## Execution

All execution commands automatically return session status (state + pause info).

```bash
dbg continue                        # Resume to next breakpoint or completion
dbg step [over|into|out]            # Step one statement (default: over)
dbg run-to <file>:<line>            # Continue to specific location
dbg pause                           # Interrupt running process
dbg restart-frame [@fN]             # Re-execute frame from beginning
```

## Inspection

### state -- composite snapshot
```bash
dbg state                           # Full snapshot: location, source, locals, stack, breakpoints
dbg state -v                        # Locals only
dbg state -s                        # Stack only
dbg state -c                        # Source code only
dbg state -b                        # Breakpoints only
dbg state --depth 3                 # Expand object values to depth 3
dbg state --lines 10                # Show 10 lines of source context
dbg state --frame @f1               # Inspect a different stack frame
dbg state --all-scopes              # Include closure scope variables
dbg state --compact                 # Compact output
dbg state --generated               # Show compiled JS paths instead of TS
```

### vars -- local variables
```bash
dbg vars                            # All locals in current frame
dbg vars name1 name2                # Filter specific variables
dbg vars --frame @f1                # Variables from a different frame
dbg vars --all-scopes               # Include closure scope
```

### stack -- call stack
```bash
dbg stack                           # Full call stack
dbg stack --async-depth 5           # Include async frames
dbg stack --generated               # Show compiled JS paths
```

### eval -- evaluate expression
```bash
dbg eval <expression>               # Evaluate in current frame
dbg eval "await fetchUser(id)"      # Await supported
dbg eval --frame @f1 "this"         # Evaluate in different frame
dbg eval --silent "setup()"         # No output (side effects only)
dbg eval --side-effect-free "x + 1" # Abort if side effects detected
dbg eval --timeout 5000 "slowFn()"  # Custom timeout in ms
```

### props -- expand object
```bash
dbg props @v1                       # Expand object properties
dbg props @v1 --depth 3             # Nested expansion
dbg props @v1 --own                 # Own properties only
dbg props @v1 --private             # Include private fields
dbg props @v1 --internal            # Include internal slots
```

### source -- view source code
```bash
dbg source                          # Source around current line
dbg source --lines 20               # 20 lines of context
dbg source --file src/app.ts        # Source of a specific file
dbg source --all                    # Entire file
dbg source --generated              # Show compiled JS
```

### Other inspection
```bash
dbg search "query"                  # Search loaded scripts
dbg search "pattern" --regex        # Regex search
dbg search "text" --case-sensitive  # Case-sensitive search
dbg search "text" --file <id>       # Search in specific script
dbg scripts                         # List loaded scripts
dbg scripts --filter "src/"         # Filter by pattern
dbg console                         # Show console output
dbg console --since 5               # Last 5 messages
dbg console --level error           # Filter by level
dbg console --clear                 # Clear console buffer
dbg exceptions                      # Show captured exceptions
dbg exceptions --since 3            # Last 3 exceptions
```

## Breakpoints

```bash
dbg break <file>:<line>                       # Set breakpoint
dbg break <file>:<line>:<column>              # Set breakpoint
dbg break src/app.ts:42 --condition "x > 10"  # Conditional
dbg break src/app.ts:42 --hit-count 5         # Break on Nth hit
dbg break src/app.ts:42 --continue            # Log but don't pause
dbg break --pattern "handler":15              # Regex URL match
dbg break-rm BP#1                   # Remove specific breakpoint
dbg break-rm all                    # Remove all breakpoints
dbg break-ls                        # List all breakpoints
dbg break-toggle BP#1               # Disable/enable one breakpoint
dbg break-toggle all                # Disable/enable all
dbg breakable src/app.ts:10-50      # List valid breakpoint locations
dbg logpoint src/app.ts:20 "x=${x}" # Log without pausing
dbg logpoint src/app.ts:20 "x=${x}" --condition "x > 0"
dbg break-fn <name>                  # Function breakpoint (DAP runtimes only)
dbg break-fn main --condition "argc > 1"
dbg catch all                       # Pause on all exceptions
dbg catch uncaught                  # Pause on uncaught only
dbg catch none                      # Don't pause on exceptions
```

## Mutation

```bash
dbg set <@ref|name> <value>         # Change variable value
dbg set count 0                     # By name
dbg set @v2 true                    # By ref
dbg set-return "newValue"           # Change return value (at return point)
dbg hotpatch <file>                 # Live-edit script from disk
dbg hotpatch <file> --dry-run       # Preview without applying
```

## Blackboxing

Skip stepping into matching scripts (useful for node_modules).

```bash
dbg blackbox "node_modules/**"      # Add pattern
dbg blackbox "lib/**" "vendor/**"   # Multiple patterns
dbg blackbox-ls                     # List patterns
dbg blackbox-rm "node_modules/**"   # Remove specific pattern
dbg blackbox-rm all                 # Remove all patterns
```

## Source Maps

dbg auto-detects source maps from `Debugger.scriptParsed` events. TypeScript `.ts` paths work transparently for breakpoints and display.

```bash
dbg sourcemap                       # List all loaded source maps
dbg sourcemap src/app.ts            # Info for specific file
dbg sourcemap --disable             # Disable resolution globally
```

## Global Flags

```bash
--session NAME                       # Target session (default: "default")
--runtime NAME                       # Debug adapter: lldb, codelldb, etc. (for native debugging)
--json                               # JSON output
--color                              # Enable ANSI colors
--help-agent                         # LLM-optimized reference card
--help                               # Human help
```
