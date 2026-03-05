// Fixture: hotpatch while function is on the call stack
function compute(x) {
	debugger;
	return x * 2;
}
const result = compute(21);
console.log("result:", result);
