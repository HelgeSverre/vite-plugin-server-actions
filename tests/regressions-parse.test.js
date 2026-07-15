import { describe, it, expect, vi, afterEach } from "vitest";
import { parse } from "@babel/parser";
import { extractExportedFunctions, isValidFunctionName } from "../src/ast-parser.js";
import { generateTypeDefinitions, generateEnhancedClientProxy } from "../src/type-generator.js";

const defaultOptions = {
	apiPrefix: "/api",
	routeTransform: (path, func) => `${path.replace(/\.server\.(js|ts)$/, "")}/${func}`,
	moduleNameTransform: (path) => path.replace(/\//g, "_").replace(/\.server\.(js|ts)$/, ""),
};

/**
 * Assert that generated client proxy code is syntactically valid JavaScript
 */
function expectParseable(code) {
	expect(() => parse(code, { sourceType: "module" })).not.toThrow();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Parse regressions", () => {
	describe("JSDoc on export const arrow functions", () => {
		it("should extract JSDoc from export const arrow functions", () => {
			const code = `/** Adds a todo */\nexport const addTodo = async (title) => title;`;

			const functions = extractExportedFunctions(code, "todo.server.js");

			expect(functions).toHaveLength(1);
			expect(functions[0].jsdoc).toContain("Adds a todo");
		});
	});

	describe("re-exports emit a loud build-time warning", () => {
		it("should warn about named re-exports, naming the dropped exports", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const code = `export { helper, other as renamed } from "./util.server.js";\nexport async function main() {}`;
			const functions = extractExportedFunctions(code, "todo.server.js");

			// The local exports are still extracted
			expect(functions.map((fn) => fn.name)).toEqual(["main"]);

			// And the dropped re-exports are loudly reported
			const warnings = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
			expect(warnings).toContain("helper");
			expect(warnings).toContain("renamed");
			expect(warnings).toContain("./util.server.js");
			expect(warnings).toContain("todo.server.js");
		});

		it("should warn about export * re-exports", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const code = `export * from "./other.server.js";\nexport async function main() {}`;
			extractExportedFunctions(code, "todo.server.js");

			const warnings = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
			expect(warnings).toContain("./other.server.js");
		});
	});

	describe("reserved-word and string export aliases", () => {
		it("should reject reserved words as function names", () => {
			expect(isValidFunctionName("delete")).toBe(false);
			expect(isValidFunctionName("default")).toBe(false);
			expect(isValidFunctionName("class")).toBe(false);
			expect(isValidFunctionName("await")).toBe(false);
			expect(isValidFunctionName(undefined)).toBe(false);
			// Regular names still pass
			expect(isValidFunctionName("deleteTodo")).toBe(true);
			expect(isValidFunctionName("_private")).toBe(true);
		});

		it("should mark `export { foo as default }` as a default export", () => {
			const code = `async function foo() { return 1; }\nexport { foo as default };`;

			const functions = extractExportedFunctions(code, "test.server.js");

			expect(functions).toHaveLength(1);
			expect(functions[0].name).toBe("default");
			expect(functions[0].isDefault).toBe(true);
		});

		it("should extract string aliases with their actual value instead of undefined", () => {
			const code = `async function bar() { return 1; }\nexport { bar as "bar baz" };`;

			const functions = extractExportedFunctions(code, "test.server.js");

			expect(functions).toHaveLength(1);
			expect(functions[0].name).toBe("bar baz");
			// ...which is then rejected by name validation (skipped with a warning by the plugin)
			expect(isValidFunctionName(functions[0].name)).toBe(false);
		});
	});

	describe("destructured parameters with default values", () => {
		it("should extract a pattern name for `{opts} = {}` instead of undefined", () => {
			const code = `export async function f({opts} = {}, id) { return id; }`;

			const functions = extractExportedFunctions(code, "test.server.js");
			const params = functions[0].params;

			expect(params[0].name).toBe("{opts}");
			expect(params[0].isOptional).toBe(true);
			expect(params[0].defaultValue).toBe("{}");
			expect(params[1].name).toBe("id");
		});

		it("should handle array patterns with defaults", () => {
			const code = `export async function f([a, b] = []) { return a; }`;

			const functions = extractExportedFunctions(code, "test.server.js");

			expect(functions[0].params[0].name).toBe("[a, b]");
			expect(functions[0].params[0].defaultValue).toBe("[]");
		});

		it("should generate a syntactically valid client proxy for `{page} = {}` followed by another param", () => {
			const code = `export async function f({page} = {}, filter) { return filter; }`;
			const functionDetails = extractExportedFunctions(code, "test.server.js");

			const proxy = generateEnhancedClientProxy("test", functionDetails, defaultOptions, "test.server.js");

			expectParseable(proxy);
			expect(proxy).not.toContain("f(, ");
			expect(proxy).toContain("function f({page} = {}, filter)");
		});

		it("should not crash generateEnhancedClientProxy for undocumented destructured-with-default params", () => {
			const code = `export async function updateSettings({theme} = {}) { return theme; }`;
			const functionDetails = extractExportedFunctions(code, "settings.server.js");

			let proxy;
			expect(() => {
				proxy = generateEnhancedClientProxy("settings", functionDetails, defaultOptions, "settings.server.js");
			}).not.toThrow();

			expectParseable(proxy);
		});

		it("should not crash generateTypeDefinitions for destructured-with-default params", () => {
			const code = `export async function updateSettings({theme} = {}) { return theme; }`;
			const functionDetails = extractExportedFunctions(code, "settings.server.js");
			const serverFunctions = new Map([
				[
					"settings",
					{
						functions: functionDetails.map((fn) => fn.name),
						functionDetails,
						filePath: "settings.server.js",
					},
				],
			]);

			expect(() => generateTypeDefinitions(serverFunctions, defaultOptions)).not.toThrow();
		});
	});

	describe("declare module specifiers match client imports", () => {
		it("should emit a wildcard declare module matching relative import specifiers", () => {
			const serverFunctions = new Map([
				[
					"src_actions_todo",
					{
						functions: ["addTodo"],
						functionDetails: [
							{
								name: "addTodo",
								isAsync: true,
								params: [{ name: "text", type: "string", isOptional: false }],
								returnType: "Promise<Todo>",
								jsdoc: null,
							},
						],
						filePath: "src/actions/todo.server.js",
					},
				],
			]);

			const typeDefs = generateTypeDefinitions(serverFunctions, defaultOptions);

			// Root-relative form (for baseUrl/paths setups)
			expect(typeDefs).toContain('declare module "src/actions/todo.server.js"');
			// Wildcard form matching e.g. "./actions/todo.server.js"
			expect(typeDefs).toContain('declare module "*/todo.server.js"');
			// The file must stay a script: an `export {}` would turn it into a module,
			// which silently disables all ambient `declare module` blocks
			expect(typeDefs).not.toContain("export {}");
			expect(typeDefs).not.toContain("declare global");
			expect(typeDefs).toContain("declare namespace ServerActions");
		});

		it("does not emit a shared wildcard for two server files with the same basename", () => {
			const makeModule = (fnName, filePath) => ({
				functions: [fnName],
				functionDetails: [{ name: fnName, isAsync: true, params: [], returnType: "Promise<void>", jsdoc: null }],
				filePath,
			});
			const serverFunctions = new Map([
				["src_admin_todo", makeModule("adminAdd", "src/admin/todo.server.js")],
				["src_user_todo", makeModule("userAdd", "src/user/todo.server.js")],
			]);

			const typeDefs = generateTypeDefinitions(serverFunctions, defaultOptions);

			// Exact-path declarations are still emitted for both files
			expect(typeDefs).toContain('declare module "src/admin/todo.server.js"');
			expect(typeDefs).toContain('declare module "src/user/todo.server.js"');
			// TypeScript MERGES ambient module declarations with identical wildcard
			// patterns, which would union both files' exports (typing wrong imports
			// as valid) - so the ambiguous wildcard must not be emitted at all
			expect(typeDefs).not.toContain('declare module "*/todo.server.js"');
		});

		it("emits extensionless and .js wildcard variants for .server.ts files", () => {
			const serverFunctions = new Map([
				[
					"src_actions_stats",
					{
						functions: ["getStats"],
						functionDetails: [
							{ name: "getStats", isAsync: true, params: [], returnType: "Promise<Stats>", jsdoc: null },
						],
						filePath: "src/actions/stats.server.ts",
					},
				],
			]);

			const typeDefs = generateTypeDefinitions(serverFunctions, defaultOptions);

			// TS clients conventionally import .server.ts files without the extension
			// ("./actions/stats.server") or with .js under NodeNext resolution - the
			// literal "*/stats.server.ts" wildcard alone would never match either form
			expect(typeDefs).toContain('declare module "*/stats.server" {');
			expect(typeDefs).toContain('declare module "*/stats.server.js" {');
			expect(typeDefs).toContain('declare module "*/stats.server.ts" {');
		});
	});

	describe("required param after defaulted param", () => {
		it("should not emit an optional param before a required one (TS1016)", () => {
			const code = `export async function f(a = 1, b) { return b; }`;
			const functionDetails = extractExportedFunctions(code, "test.server.js");
			const serverFunctions = new Map([
				[
					"test",
					{
						functions: ["f"],
						functionDetails,
						filePath: "test.server.js",
					},
				],
			]);

			const typeDefs = generateTypeDefinitions(serverFunctions, defaultOptions);

			expect(typeDefs).toContain("function f(a: any, b: any)");
			expect(typeDefs).not.toContain("a?: any, b: any");
		});

		it("should keep trailing defaulted params optional", () => {
			const code = `export async function f(a, b = 1) { return a; }`;
			const functionDetails = extractExportedFunctions(code, "test.server.js");
			const serverFunctions = new Map([
				[
					"test",
					{
						functions: ["f"],
						functionDetails,
						filePath: "test.server.js",
					},
				],
			]);

			const typeDefs = generateTypeDefinitions(serverFunctions, defaultOptions);

			expect(typeDefs).toContain("function f(a: any, b?: any)");
		});
	});

	describe("module names starting with a digit", () => {
		it("should sanitize namespace names so they are valid TypeScript identifiers", () => {
			const serverFunctions = new Map([
				[
					"2fa",
					{
						functions: ["verify"],
						functionDetails: [
							{
								name: "verify",
								isAsync: true,
								params: [{ name: "code", type: "string", isOptional: false }],
								returnType: "Promise<boolean>",
								jsdoc: null,
							},
						],
						filePath: "2fa.server.js",
					},
				],
			]);

			const typeDefs = generateTypeDefinitions(serverFunctions, defaultOptions);

			expect(typeDefs).not.toContain("namespace 2fa");
			expect(typeDefs).toContain("namespace _2fa");
		});
	});

	describe("dev proxy marker", () => {
		it("should not emit the unreachable security warning and should use the per-module marker", () => {
			const functionDetails = [
				{
					name: "getTodos",
					isAsync: true,
					params: [],
					returnType: null,
					jsdoc: null,
				},
			];

			const proxy = generateEnhancedClientProxy("todo", functionDetails, defaultOptions, "todo.server.js");

			// The proxy marker must not be gated behind an always-true check
			expect(proxy).not.toContain("if (!window.__VITE_SERVER_ACTIONS_PROXY__)");
			expect(proxy).not.toContain("SECURITY WARNING");
			// Should match the fallback proxy's per-module object marker
			expect(proxy).toContain("window.__VITE_SERVER_ACTIONS_PROXY__ = window.__VITE_SERVER_ACTIONS_PROXY__ || {}");
			expect(proxy).toContain("window.__VITE_SERVER_ACTIONS_PROXY__['todo'] = true");
		});
	});

	describe("network-error message interpolates the function name", () => {
		it("should embed the function name instead of leaking `${func.name}` into client code", () => {
			const functionDetails = [
				{
					name: "addTodo",
					isAsync: true,
					params: [{ name: "text", type: "string", isOptional: false }],
					returnType: null,
					jsdoc: null,
				},
			];

			const proxy = generateEnhancedClientProxy("todo", functionDetails, defaultOptions, "todo.server.js");

			// `func` only exists at generation time; it must not leak into the client code
			expect(proxy).not.toContain("${func.name}");
			expect(proxy).toContain("Failed to execute server action 'addTodo':");
		});
	});
});
