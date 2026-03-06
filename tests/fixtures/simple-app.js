// Simple test fixture for debug-that integration tests
// Launch with: node --inspect-brk tests/fixtures/simple-app.js

function greet(name) {
	const message = `Hello, ${name}!`;
	console.log(message);
	return message;
}

function add(a, b) {
	const result = a + b;
	return result;
}

async function fetchData(id) {
	const data = { id, name: "test", items: [1, 2, 3] };
	await new Promise((resolve) => setTimeout(resolve, 10));
	return data;
}

class Counter {
	constructor(initial = 0) {
		this.count = initial;
	}

	increment() {
		this.count++;
		return this.count;
	}

	decrement() {
		this.count--;
		return this.count;
	}
}

// Main execution
const counter = new Counter(10);
const greeting = greet("World");
const sum = add(2, 3);

counter.increment();
counter.increment();
counter.decrement();

fetchData("test-123").then((data) => {
	console.log("Data:", JSON.stringify(data));
	console.log("Counter:", counter.count);
	console.log("Sum:", sum);
});
