const { add, multiply } = require("./math");

describe("math", () => {
	it("adds two numbers", () => {
		const result = add(2, 3);
		expect(result).toBe(5);
	});

	it("multiplies two numbers", () => {
		const result = multiply(4, 5);
		expect(result).toBe(20);
	});
});
