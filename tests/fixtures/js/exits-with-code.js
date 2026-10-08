globalThis.state = ["started"];
setTimeout(() => {
	globalThis.state.push("ending");
	process.exit(3);
}, 10);
