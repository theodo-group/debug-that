// Like a Jest run: a vm context is made for a test file, then dropped, while the program goes on
import vm from "node:vm";
let ctx = vm.createContext({});
vm.runInContext("1 + 1", ctx);
ctx = null;
setTimeout(() => {
	globalThis.gc?.(); // --expose-gc: V8 reports the context destroyed once it is collected
	setTimeout(() => {
		debugger;
	}, 1500);
}, 100);
