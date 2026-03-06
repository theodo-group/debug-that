// Test fixture with errors for debug-that integration tests
// Launch with: node --inspect-brk tests/fixtures/error-app.js

function riskyOperation(input) {
	if (!input) {
		throw new Error("Input is required");
	}
	return input.toUpperCase();
}

function handleError() {
	try {
		riskyOperation(null);
	} catch (err) {
		console.error("Caught:", err.message);
		return { error: err.message };
	}
}

// Uncaught error path
const mode = process.argv[2] || "caught";

if (mode === "caught") {
	const result = handleError();
	console.log("Result:", result);
} else if (mode === "uncaught") {
	riskyOperation(null); // This will throw uncaught
}
