import type Protocol from "devtools-protocol/types/protocol.js";
import type { RemoteObject } from "../formatter/values.ts";
import { formatValue } from "../formatter/values.ts";
import type { CdpSession } from "./session.ts";

export async function setVariable(
	session: CdpSession,
	varName: string,
	value: string,
	options: { frame?: string } = {},
): Promise<{ name: string; oldValue?: string; newValue: string; type: string }> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}
	if (!session.isPaused()) {
		throw new Error("Cannot set variable: process is not paused");
	}

	// Determine which frame to evaluate in
	let callFrameId: string;
	if (options.frame) {
		const entry = session.refs.resolve(options.frame);
		if (entry?.remoteId) {
			callFrameId = entry.remoteId;
		} else {
			throw new Error(`Unknown frame ref: ${options.frame}`);
		}
	} else {
		const topFrame = session.pausedCallFrames[0];
		if (!topFrame) {
			throw new Error("No call frame available");
		}
		callFrameId = topFrame.callFrameId;
	}

	// Try to get old value first (best-effort)
	let oldValue: string | undefined;
	try {
		const oldResult = await session.cdp.send("Debugger.evaluateOnCallFrame", {
			callFrameId,
			expression: varName,
			returnByValue: false,
			generatePreview: true,
		});
		const oldRemote = oldResult.result as RemoteObject | undefined;
		if (oldRemote) {
			oldValue = formatValue(oldRemote);
		}
	} catch {
		// Old value not available
	}

	// Set the new value
	const expression = `${varName} = ${value}`;
	const setResult = await session.cdp.send("Debugger.evaluateOnCallFrame", {
		callFrameId,
		expression,
		returnByValue: false,
		generatePreview: true,
	});

	const evalResult = setResult.result as RemoteObject | undefined;
	const exceptionDetails = setResult.exceptionDetails;

	if (exceptionDetails) {
		const exception = exceptionDetails.exception as RemoteObject | undefined;
		const errorText = exception
			? formatValue(exception)
			: (exceptionDetails.text ?? "Assignment error");
		throw new Error(errorText);
	}

	if (!evalResult) {
		throw new Error("No result from assignment");
	}

	const result: { name: string; oldValue?: string; newValue: string; type: string } = {
		name: varName,
		newValue: formatValue(evalResult),
		type: evalResult.type,
	};
	if (oldValue !== undefined) {
		result.oldValue = oldValue;
	}

	return result;
}

export async function setReturnValue(
	session: CdpSession,
	value: string,
): Promise<{ value: string; type: string }> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}
	if (!session.isPaused()) {
		throw new Error("Cannot set return value: process is not paused");
	}

	const topFrame = session.pausedCallFrames[0];
	if (!topFrame) {
		throw new Error("No call frame available");
	}

	const callFrameId = topFrame.callFrameId;

	// Evaluate the value expression to get a RemoteObject
	const evalResult = await session.cdp.send("Debugger.evaluateOnCallFrame", {
		callFrameId,
		expression: value,
		returnByValue: false,
		generatePreview: true,
	});

	const evalRemote = evalResult.result as RemoteObject | undefined;
	const exceptionDetails = evalResult.exceptionDetails;

	if (exceptionDetails) {
		const exception = exceptionDetails.exception as RemoteObject | undefined;
		const errorText = exception
			? formatValue(exception)
			: (exceptionDetails.text ?? "Evaluation error");
		throw new Error(errorText);
	}

	if (!evalRemote) {
		throw new Error("No result from evaluation");
	}

	// Set the return value using the evaluated RemoteObject
	// Cast to CallArgument — RemoteObject has the objectId/value/unserializableValue fields that CallArgument needs
	const newValue: Protocol.Runtime.CallArgument = {};
	if (evalRemote.objectId) {
		newValue.objectId = evalRemote.objectId;
	} else if (evalRemote.unserializableValue) {
		newValue.unserializableValue = evalRemote.unserializableValue;
	} else {
		newValue.value = evalRemote.value;
	}
	await session.cdp.send("Debugger.setReturnValue", { newValue });

	return {
		value: formatValue(evalRemote),
		type: evalRemote.type,
	};
}

export async function hotpatch(
	session: CdpSession,
	file: string,
	newSource: string,
	options: { dryRun?: boolean } = {},
): Promise<Protocol.Debugger.SetScriptSourceResponse> {
	if (!session.cdp) {
		throw new Error("No active debug session");
	}

	// Find the script URL and then look up the scriptId
	const scriptUrl = session.findScriptUrl(file);
	if (!scriptUrl) {
		throw new Error(`No loaded script matches "${file}"`);
	}

	let scriptId: string | undefined;
	for (const [sid, info] of session.scripts) {
		if (info.url === scriptUrl) {
			scriptId = sid;
			break;
		}
	}

	if (!scriptId) {
		throw new Error(`Could not find script ID for "${file}"`);
	}

	const setSourceParams: Protocol.Debugger.SetScriptSourceRequest = {
		scriptId,
		scriptSource: newSource,
		allowTopFrameEditing: true,
		dryRun: options.dryRun,
	};

	return await session.cdp.send("Debugger.setScriptSource", setSourceParams);
}
