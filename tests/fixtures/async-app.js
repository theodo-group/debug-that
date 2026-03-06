// Test fixture with async patterns for debug-that integration tests
// Launch with: node --inspect-brk tests/fixtures/async-app.js

async function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processItem(item) {
	await delay(10);
	const result = { ...item, processed: true, timestamp: Date.now() };
	return result;
}

async function processQueue(items) {
	const results = [];
	for (const item of items) {
		const result = await processItem(item);
		results.push(result);
	}
	return results;
}

const queue = [
	{ id: 1, name: "alpha" },
	{ id: 2, name: "beta" },
	{ id: 3, name: "gamma" },
];

processQueue(queue).then((results) => {
	console.log(`Processed ${results.length} items`);
	for (const r of results) {
		console.log(`  ${r.id}: ${r.name} (processed: ${r.processed})`);
	}
});
