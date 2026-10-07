// Long-running fixture: a global service whose method is called on a timer.
globalThis.service = {
	calls: 0,
	ping(label) {
		this.calls++;
		return `pong:${label}:${this.calls}`;
	},
};
setInterval(() => {
	globalThis.service.ping("tick");
}, 25);
