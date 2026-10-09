function greet(person) {
	const message = `Hello, ${person.name}! Age: ${person.age}`;
	return message;
}
function add(a, b) {
	const result = a + b;
	return result;
}
const alice = { name: "Alice", age: 30 };
const greeting = greet(alice);
const sum = add(2, 3);
console.log(greeting);
console.log("Sum:", sum);
