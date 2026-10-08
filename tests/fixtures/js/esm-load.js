// Imports a module whose top-level code calls a function declared above it
const target = await import("./esm-target.js");
console.log(target.total);
