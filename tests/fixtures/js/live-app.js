// Long-running fixture: functions of every shape function breakpoints must handle.
globalThis.service = {
	calls: 0,
	ping(label) {
		this.calls++;
		return `pong:${label}:${this.calls}`;
	},
};
globalThis.double = (n) => n * 2;
globalThis.boundPing = globalThis.service.ping.bind(globalThis.service);
setTimeout(() => {
	globalThis.later = {
		fn(x) {
			return x;
		},
	};
}, 1500);
setInterval(() => {
	globalThis.service.ping("tick");
	globalThis.double(21);
	globalThis.boundPing("bound");
	JSON.parse('{"a":1}');
	globalThis.later?.fn("late");
}, 25);
