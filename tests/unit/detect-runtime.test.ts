import { describe, expect, test } from "bun:test";
import { detectRuntime } from "../../src/util/detect-runtime.ts";

describe("detectRuntime", () => {
	describe("ExplicitDetector — --runtime flag always wins", () => {
		test("returns explicit runtime with explicit confidence", () => {
			const result = detectRuntime({ command: ["python3", "app.py"], explicitRuntime: "debugpy" });
			expect(result?.runtime).toBe("debugpy");
			expect(result?.confidence).toBe("explicit");
		});

		test("explicit runtime overrides binary name detection", () => {
			const result = detectRuntime({ command: ["node", "app.js"], explicitRuntime: "bun" });
			expect(result?.runtime).toBe("bun");
			expect(result?.confidence).toBe("explicit");
		});

		test("explicit runtime does not strip interpreter", () => {
			const result = detectRuntime({ command: ["python3", "app.py"], explicitRuntime: "debugpy" });
			expect(result?.stripInterpreter).toBe(false);
		});

		test("explicit runtime works with empty command", () => {
			const result = detectRuntime({ command: [], explicitRuntime: "lldb" });
			expect(result?.runtime).toBe("lldb");
			expect(result?.confidence).toBe("explicit");
		});

		test("explicit runtime preserves arbitrary string", () => {
			const result = detectRuntime({ command: ["./foo"], explicitRuntime: "my-custom-adapter" });
			expect(result?.runtime).toBe("my-custom-adapter");
		});
	});

	describe("BinaryNameDetector — CDP runtimes", () => {
		test("node → node", () => {
			const result = detectRuntime({ command: ["node", "app.js"] });
			expect(result?.runtime).toBe("node");
			expect(result?.confidence).toBe("high");
			expect(result?.stripInterpreter).toBe(false);
		});

		test("node with version suffix: node22", () => {
			const result = detectRuntime({ command: ["node22", "app.js"] });
			expect(result?.runtime).toBe("node");
		});

		test("node with absolute path", () => {
			const result = detectRuntime({ command: ["/usr/local/bin/node", "app.js"] });
			expect(result?.runtime).toBe("node");
		});

		test("node via nvm path", () => {
			const result = detectRuntime({
				command: ["/Users/user/.nvm/versions/node/v20.11.0/bin/node", "app.js"],
			});
			expect(result?.runtime).toBe("node");
		});

		test("tsx → node", () => {
			const result = detectRuntime({ command: ["tsx", "app.ts"] });
			expect(result?.runtime).toBe("node");
		});

		test("ts-node → node", () => {
			const result = detectRuntime({ command: ["ts-node", "app.ts"] });
			expect(result?.runtime).toBe("node");
		});

		test("esr → node", () => {
			const result = detectRuntime({ command: ["esr", "app.ts"] });
			expect(result?.runtime).toBe("node");
		});

		test("bun → bun", () => {
			const result = detectRuntime({ command: ["bun", "app.ts"] });
			expect(result?.runtime).toBe("bun");
			expect(result?.stripInterpreter).toBe(false);
		});

		test("deno → deno", () => {
			const result = detectRuntime({ command: ["deno", "run", "app.ts"] });
			expect(result?.runtime).toBe("deno");
		});

		test("electron → electron", () => {
			const result = detectRuntime({ command: ["electron", "."] });
			expect(result?.runtime).toBe("electron");
		});

		test("CDP runtimes never strip interpreter", () => {
			for (const cmd of ["node", "bun", "deno", "tsx", "ts-node", "esr", "electron"]) {
				const result = detectRuntime({ command: [cmd, "app.js"] });
				expect(result?.stripInterpreter).toBe(false);
			}
		});
	});

	describe("BinaryNameDetector — DAP runtimes", () => {
		test("python3 → debugpy, strips interpreter", () => {
			const result = detectRuntime({ command: ["python3", "app.py"] });
			expect(result?.runtime).toBe("debugpy");
			expect(result?.confidence).toBe("high");
			expect(result?.stripInterpreter).toBe(true);
		});

		test("python → debugpy", () => {
			const result = detectRuntime({ command: ["python", "app.py"] });
			expect(result?.runtime).toBe("debugpy");
			expect(result?.stripInterpreter).toBe(true);
		});

		test("python3.14 → debugpy", () => {
			const result = detectRuntime({ command: ["python3.14", "app.py"] });
			expect(result?.runtime).toBe("debugpy");
		});

		test("python3.8 → debugpy", () => {
			const result = detectRuntime({ command: ["python3.8", "app.py"] });
			expect(result?.runtime).toBe("debugpy");
		});

		test("python with absolute path", () => {
			const result = detectRuntime({ command: ["/usr/bin/python3", "app.py"] });
			expect(result?.runtime).toBe("debugpy");
			expect(result?.stripInterpreter).toBe(true);
		});

		test("python via pyenv shim path", () => {
			const result = detectRuntime({
				command: ["/Users/user/.pyenv/shims/python3", "app.py"],
			});
			expect(result?.runtime).toBe("debugpy");
		});

		test("lldb-dap → lldb-dap, no strip", () => {
			const result = detectRuntime({ command: ["lldb-dap"] });
			expect(result?.runtime).toBe("lldb-dap");
			expect(result?.stripInterpreter).toBe(false);
		});

		test("lldb → lldb, no strip", () => {
			const result = detectRuntime({ command: ["lldb", "./a.out"] });
			expect(result?.runtime).toBe("lldb");
			expect(result?.stripInterpreter).toBe(false);
		});

		test("lldb-dap with absolute path", () => {
			const result = detectRuntime({ command: ["/opt/homebrew/opt/llvm/bin/lldb-dap"] });
			expect(result?.runtime).toBe("lldb-dap");
		});

		test("java → java, strips interpreter", () => {
			const result = detectRuntime({ command: ["java", "-jar", "app.jar"] });
			expect(result?.runtime).toBe("java");
			expect(result?.stripInterpreter).toBe(true);
		});

		test("java21 → java", () => {
			const result = detectRuntime({ command: ["java21", "-jar", "app.jar"] });
			expect(result?.runtime).toBe("java");
		});

		test("ruby → ruby, strips interpreter", () => {
			const result = detectRuntime({ command: ["ruby", "app.rb"] });
			expect(result?.runtime).toBe("ruby");
			expect(result?.stripInterpreter).toBe(true);
		});

		test("ruby3.2 → ruby", () => {
			const result = detectRuntime({ command: ["ruby3.2", "app.rb"] });
			expect(result?.runtime).toBe("ruby");
		});

		test("dotnet → dotnet, strips interpreter", () => {
			const result = detectRuntime({ command: ["dotnet", "run"] });
			expect(result?.runtime).toBe("dotnet");
			expect(result?.stripInterpreter).toBe(true);
		});

		test("php → php, strips interpreter", () => {
			const result = detectRuntime({ command: ["php", "app.php"] });
			expect(result?.runtime).toBe("php");
			expect(result?.stripInterpreter).toBe(true);
		});

		test("php8.3 → php", () => {
			const result = detectRuntime({ command: ["php8.3", "app.php"] });
			expect(result?.runtime).toBe("php");
		});

		test("dlv → dlv, no strip (it IS the debugger)", () => {
			const result = detectRuntime({ command: ["dlv", "debug", "."] });
			expect(result?.runtime).toBe("dlv");
			expect(result?.stripInterpreter).toBe(false);
		});
	});

	describe("BinaryNameDetector — secondary tools", () => {
		test("uvicorn → debugpy", () => {
			const result = detectRuntime({ command: ["uvicorn", "main:app"] });
			expect(result?.runtime).toBe("debugpy");
			expect(result?.stripInterpreter).toBe(false);
		});

		test("gunicorn → debugpy", () => {
			const result = detectRuntime({ command: ["gunicorn", "main:app"] });
			expect(result?.runtime).toBe("debugpy");
		});

		test("flask → debugpy", () => {
			const result = detectRuntime({ command: ["flask", "run"] });
			expect(result?.runtime).toBe("debugpy");
		});

		test("django-admin → debugpy", () => {
			const result = detectRuntime({ command: ["django-admin", "runserver"] });
			expect(result?.runtime).toBe("debugpy");
		});

		test("pytest → debugpy", () => {
			const result = detectRuntime({ command: ["pytest", "tests/"] });
			expect(result?.runtime).toBe("debugpy");
		});

		test("mypy → debugpy", () => {
			const result = detectRuntime({ command: ["mypy", "src/"] });
			expect(result?.runtime).toBe("debugpy");
		});

		test("rails → ruby", () => {
			const result = detectRuntime({ command: ["rails", "server"] });
			expect(result?.runtime).toBe("ruby");
		});

		test("rake → ruby", () => {
			const result = detectRuntime({ command: ["rake", "db:migrate"] });
			expect(result?.runtime).toBe("ruby");
		});

		test("rspec → ruby", () => {
			const result = detectRuntime({ command: ["rspec", "spec/"] });
			expect(result?.runtime).toBe("ruby");
		});

		test("irb → ruby", () => {
			const result = detectRuntime({ command: ["irb"] });
			expect(result?.runtime).toBe("ruby");
		});

		test("iex → elixir", () => {
			const result = detectRuntime({ command: ["iex", "-S", "mix"] });
			expect(result?.runtime).toBe("elixir");
		});

		test("mix → elixir", () => {
			const result = detectRuntime({ command: ["mix", "phx.server"] });
			expect(result?.runtime).toBe("elixir");
		});

		test("secondary tools do not strip interpreter", () => {
			for (const cmd of ["uvicorn", "flask", "pytest", "rails", "rake", "iex", "mix"]) {
				const result = detectRuntime({ command: [cmd, "arg"] });
				expect(result?.stripInterpreter).toBe(false);
			}
		});
	});

	describe("edge cases — path handling", () => {
		test("relative path with directory", () => {
			const result = detectRuntime({ command: ["./bin/node", "app.js"] });
			expect(result?.runtime).toBe("node");
		});

		test("deeply nested path", () => {
			const result = detectRuntime({ command: ["/a/b/c/d/python3.12", "app.py"] });
			expect(result?.runtime).toBe("debugpy");
		});

		test("path with spaces (quoted)", () => {
			const result = detectRuntime({ command: ["/path with spaces/node", "app.js"] });
			expect(result?.runtime).toBe("node");
		});

		test("Windows-style path separators do not break basename", () => {
			// basename uses "/" split, so backslash paths keep the full string
			// This is expected — we run on macOS/Linux
			const result = detectRuntime({ command: ["C:\\Program Files\\node.exe", "app.js"] });
			expect(result).toBeNull(); // backslash not split → no match
		});
	});

	describe("edge cases — regex boundary correctness", () => {
		test("'node' matches but 'nodejs' does not", () => {
			expect(detectRuntime({ command: ["node", "a.js"] })?.runtime).toBe("node");
			expect(detectRuntime({ command: ["nodejs", "a.js"] })).toBeNull();
		});

		test("'python3' matches but 'python3x' does not", () => {
			expect(detectRuntime({ command: ["python3", "a.py"] })?.runtime).toBe("debugpy");
			expect(detectRuntime({ command: ["python3x", "a.py"] })).toBeNull();
		});

		test("'python' matches but 'pythonic' does not", () => {
			expect(detectRuntime({ command: ["python", "a.py"] })?.runtime).toBe("debugpy");
			expect(detectRuntime({ command: ["pythonic", "a.py"] })).toBeNull();
		});

		test("'flask' matches but 'flask-admin' does not", () => {
			expect(detectRuntime({ command: ["flask", "run"] })?.runtime).toBe("debugpy");
			expect(detectRuntime({ command: ["flask-admin", "run"] })).toBeNull();
		});

		test("'ruby' matches but 'rubyfmt' does not", () => {
			expect(detectRuntime({ command: ["ruby", "a.rb"] })?.runtime).toBe("ruby");
			expect(detectRuntime({ command: ["rubyfmt", "a.rb"] })).toBeNull();
		});

		test("'bun' matches but 'bunx' does not (future wrapper)", () => {
			expect(detectRuntime({ command: ["bun", "a.ts"] })?.runtime).toBe("bun");
			expect(detectRuntime({ command: ["bunx", "a.ts"] })).toBeNull();
		});

		test("'java' matches but 'javac' does not", () => {
			expect(detectRuntime({ command: ["java", "-jar", "a.jar"] })?.runtime).toBe("java");
			expect(detectRuntime({ command: ["javac", "A.java"] })).toBeNull();
		});

		test("'lldb' matches but 'lldb-server' does not", () => {
			expect(detectRuntime({ command: ["lldb", "./a.out"] })?.runtime).toBe("lldb");
			expect(detectRuntime({ command: ["lldb-server", "g", ":1234"] })).toBeNull();
		});

		test("'php' matches but 'phpunit' does not", () => {
			expect(detectRuntime({ command: ["php", "a.php"] })?.runtime).toBe("php");
			expect(detectRuntime({ command: ["phpunit", "tests/"] })).toBeNull();
		});
	});

	describe("edge cases — version suffix patterns", () => {
		test("node version: node18, node20, node22", () => {
			for (const v of ["node18", "node20", "node22"]) {
				expect(detectRuntime({ command: [v, "a.js"] })?.runtime).toBe("node");
			}
		});

		test("python versions: python2, python3, python3.8, python3.14", () => {
			for (const v of ["python2", "python3", "python3.8", "python3.14"]) {
				expect(detectRuntime({ command: [v, "a.py"] })?.runtime).toBe("debugpy");
			}
		});

		test("bare 'python' (no version) → debugpy", () => {
			expect(detectRuntime({ command: ["python", "a.py"] })?.runtime).toBe("debugpy");
		});

		test("ruby versions: ruby3.2, ruby3.3", () => {
			for (const v of ["ruby3.2", "ruby3.3"]) {
				expect(detectRuntime({ command: [v, "a.rb"] })?.runtime).toBe("ruby");
			}
		});

		test("java versions: java17, java21", () => {
			for (const v of ["java17", "java21"]) {
				expect(detectRuntime({ command: [v, "-jar", "a.jar"] })?.runtime).toBe("java");
			}
		});

		test("php versions: php8.1, php8.3", () => {
			for (const v of ["php8.1", "php8.3"]) {
				expect(detectRuntime({ command: [v, "a.php"] })?.runtime).toBe("php");
			}
		});
	});

	describe("fallback — no match returns null", () => {
		test("empty command", () => {
			expect(detectRuntime({ command: [] })).toBeNull();
		});

		test("unknown binary", () => {
			expect(detectRuntime({ command: ["./my_binary"] })).toBeNull();
		});

		test("unknown command name", () => {
			expect(detectRuntime({ command: ["foobar", "arg1"] })).toBeNull();
		});

		test("wrappers (not yet implemented) return null", () => {
			expect(detectRuntime({ command: ["npx", "ts-node", "app.ts"] })).toBeNull();
			expect(detectRuntime({ command: ["nvm", "exec", "20", "node", "app.js"] })).toBeNull();
			expect(detectRuntime({ command: ["poetry", "run", "python", "app.py"] })).toBeNull();
			expect(detectRuntime({ command: ["uv", "run", "app.py"] })).toBeNull();
		});

		test("build tools return null", () => {
			expect(detectRuntime({ command: ["cargo", "run"] })).toBeNull();
			expect(detectRuntime({ command: ["go", "run", "main.go"] })).toBeNull();
			expect(detectRuntime({ command: ["mvn", "exec:java"] })).toBeNull();
			expect(detectRuntime({ command: ["gradle", "run"] })).toBeNull();
		});

		test("compilers return null", () => {
			expect(detectRuntime({ command: ["gcc", "main.c"] })).toBeNull();
			expect(detectRuntime({ command: ["rustc", "main.rs"] })).toBeNull();
			expect(detectRuntime({ command: ["javac", "Main.java"] })).toBeNull();
		});

		test("single command with no args", () => {
			expect(detectRuntime({ command: ["./a.out"] })).toBeNull();
		});
	});

	describe("integration with launch.ts — stripInterpreter behavior", () => {
		test("stripping python3 leaves just the script", () => {
			const command = ["python3", "app.py", "--verbose"];
			const result = detectRuntime({ command });
			expect(result?.stripInterpreter).toBe(true);
			const launchCommand = result?.stripInterpreter ? command.slice(1) : command;
			expect(launchCommand).toEqual(["app.py", "--verbose"]);
		});

		test("stripping python3 with flags leaves script and flags", () => {
			const command = ["python3", "-u", "app.py"];
			const result = detectRuntime({ command });
			expect(result?.stripInterpreter).toBe(true);
			// Note: stripping cmd[0] also strips python flags like -u
			// This is correct — DAP adapter handles the interpreter
			const launchCommand = result?.stripInterpreter ? command.slice(1) : command;
			expect(launchCommand).toEqual(["-u", "app.py"]);
		});

		test("node is not stripped (CDP uses full command)", () => {
			const command = ["node", "--inspect", "app.js"];
			const result = detectRuntime({ command });
			expect(result?.stripInterpreter).toBe(false);
			const launchCommand = result?.stripInterpreter ? command.slice(1) : command;
			expect(launchCommand).toEqual(["node", "--inspect", "app.js"]);
		});

		test("secondary tools are not stripped", () => {
			const command = ["flask", "run", "--port", "5000"];
			const result = detectRuntime({ command });
			expect(result?.stripInterpreter).toBe(false);
			const launchCommand = result?.stripInterpreter ? command.slice(1) : command;
			expect(launchCommand).toEqual(["flask", "run", "--port", "5000"]);
		});

		test("explicit runtime never strips", () => {
			const command = ["python3", "app.py"];
			const result = detectRuntime({ command, explicitRuntime: "debugpy" });
			expect(result?.stripInterpreter).toBe(false);
			// With explicit runtime, caller manages the command themselves
			const launchCommand = result?.stripInterpreter ? command.slice(1) : command;
			expect(launchCommand).toEqual(["python3", "app.py"]);
		});
	});
});
