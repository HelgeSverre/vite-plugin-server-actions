import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

// Identifiers that resolve at runtime in a plain Node process. A serialized
// middleware function loses its defining scope, so only references to these
// (plus its own params/locals) survive fn.toString() -> embed intact.
const RUNTIME_GLOBALS = new Set([
	// Language values
	"globalThis",
	"undefined",
	"NaN",
	"Infinity",
	"arguments",
	// Global functions
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"escape",
	"unescape",
	"eval",
	"structuredClone",
	"queueMicrotask",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"setImmediate",
	"clearImmediate",
	"atob",
	"btoa",
	// Built-in objects and constructors
	"Object",
	"Function",
	"Boolean",
	"Symbol",
	"Error",
	"AggregateError",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
	"Number",
	"BigInt",
	"Math",
	"Date",
	"String",
	"RegExp",
	"Array",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"BigInt64Array",
	"BigUint64Array",
	"Float32Array",
	"Float64Array",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"FinalizationRegistry",
	"ArrayBuffer",
	"SharedArrayBuffer",
	"Atomics",
	"DataView",
	"JSON",
	"Promise",
	"Reflect",
	"Proxy",
	"Intl",
	"Iterator",
	"WebAssembly",
	// Node globals
	"process",
	"console",
	"Buffer",
	"URL",
	"URLSearchParams",
	"TextEncoder",
	"TextDecoder",
	"TextEncoderStream",
	"TextDecoderStream",
	"navigator",
	"AbortController",
	"AbortSignal",
	"Event",
	"EventTarget",
	"MessageChannel",
	"MessageEvent",
	"MessagePort",
	"BroadcastChannel",
	"DOMException",
	"performance",
	"crypto",
	"fetch",
	"Headers",
	"Request",
	"Response",
	"FormData",
	"Blob",
	"File",
	"WebSocket",
	"ReadableStream",
	"WritableStream",
	"TransformStream",
	"CompressionStream",
	"DecompressionStream",
]);

/**
 * Statically analyze a middleware function's source (fn.toString()) and report
 * whether it can be embedded verbatim into the generated production server.
 * A function is embeddable only when every referenced identifier is one of its
 * own params/locals or a JS/Node runtime global - anything else (imports,
 * closure variables, module-level constants) would be a dangling reference
 * once the function is serialized away from its defining module.
 * Runtime-global references are reported separately: fn.toString() cannot
 * reveal whether e.g. "File" was actually an import shadowing the global in
 * the defining module, so callers must surface that assumption to the user.
 * @param {string} source - Function source, as produced by Function.prototype.toString
 * @returns {{ serializable: boolean, freeVariables: string[], globalReferences: string[], error: string|null }}
 */
export function analyzeMiddlewareSource(source) {
	let ast;
	try {
		// Wrap in parens so function declarations parse as expressions. Sources
		// that are not valid expressions (e.g. object method shorthand, native
		// code) cannot be embedded either way.
		ast = parse(`(${source})`, {
			sourceType: "module",
			plugins: ["typescript"],
		});
	} catch (error) {
		return {
			serializable: false,
			freeVariables: [],
			globalReferences: [],
			error: `its source could not be parsed as a standalone function (${error.message})`,
		};
	}

	const freeVariables = new Set();
	const globalReferences = new Set();
	const traverseFn = traverse.default || traverse;
	traverseFn(ast, {
		Identifier(path) {
			if (!path.isReferencedIdentifier()) {
				return;
			}
			const name = path.node.name;
			if (path.scope.hasBinding(name, /* noGlobals */ true)) {
				return;
			}
			if (RUNTIME_GLOBALS.has(name)) {
				globalReferences.add(name);
				return;
			}
			freeVariables.add(name);
		},
	});

	return {
		serializable: freeVariables.size === 0,
		freeVariables: Array.from(freeVariables),
		globalReferences: Array.from(globalReferences),
		error: null,
	};
}
