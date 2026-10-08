// Requires a module whose top-level code runs as it loads, as Jest test files do
import { createRequire } from "node:module";

const target = createRequire(import.meta.url)("./cjs-target.cjs");
console.log(target.total);
