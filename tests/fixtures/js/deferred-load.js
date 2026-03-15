// This script dynamically imports another file after initialization,
// simulating how Jest/Vitest load test files after setup.

async function main() {
	const target = await import("./deferred-target.js");
	target.run();
}

main();
