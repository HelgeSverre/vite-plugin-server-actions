import { describe, it, expect } from "vitest";
import { generateTypeDefinitions, generateEnhancedClientProxy } from "../src/type-generator.js";

describe("Type Generator - TypeScript Support", () => {
	describe("Type Definition Generation", () => {
		it("should generate proper TypeScript definitions for basic functions", () => {
			const serverFunctions = new Map([
				[
					"todo_actions",
					{
						functions: ["getTodos", "addTodo"],
						functionDetails: [
							{
								name: "getTodos",
								isAsync: true,
								params: [],
								returnType: "Promise<Todo[]>",
								jsdoc: "/**\n * Get all todos\n * @returns {Promise<Todo[]>} List of todos\n */",
							},
							{
								name: "addTodo",
								isAsync: true,
								params: [
									{ name: "text", type: "string", isOptional: false },
									{ name: "priority", type: '"low" | "medium" | "high"', isOptional: true },
								],
								returnType: "Promise<Todo>",
								jsdoc:
									"/**\n * Add a new todo\n * @param {string} text - Todo text\n * @param {string} priority - Priority level\n * @returns {Promise<Todo>} Created todo\n */",
							},
						],
						filePath: "src/actions/todo.server.ts",
					},
				],
			]);

			const options = { moduleNameTransform: (path) => path.replace(/\//g, "_").replace(/\.server\.(js|ts)$/, "") };
			const typeDefs = generateTypeDefinitions(serverFunctions, options);

			expect(typeDefs).toContain('declare module "src/actions/todo.server.ts"');
			expect(typeDefs).toContain("function getTodos(): Promise<Todo[]>");
			expect(typeDefs).toContain('function addTodo(text: string, priority?: "low" | "medium" | "high"): Promise<Todo>');
			expect(typeDefs).toContain("Get all todos");
			expect(typeDefs).toContain("Add a new todo");
		});

		it("should avoid double-wrapping Promise types", () => {
			const serverFunctions = new Map([
				[
					"test_module",
					{
						functions: ["asyncFunc", "syncFunc"],
						functionDetails: [
							{
								name: "asyncFunc",
								isAsync: true,
								params: [],
								returnType: "Promise<string>", // Already wrapped
								jsdoc: null,
							},
							{
								name: "syncFunc",
								isAsync: false,
								params: [],
								returnType: "number",
								jsdoc: null,
							},
						],
						filePath: "test.server.ts",
					},
				],
			]);

			const options = { moduleNameTransform: (path) => path.replace(/\.server\.(js|ts)$/, "") };
			const typeDefs = generateTypeDefinitions(serverFunctions, options);

			// Should not double-wrap Promise
			expect(typeDefs).toContain("function asyncFunc(): Promise<string>");
			// Should not wrap non-async function
			expect(typeDefs).toContain("function syncFunc(): number");
		});

		it("should handle complex parameter types", () => {
			const serverFunctions = new Map([
				[
					"complex_module",
					{
						functions: ["complexFunc"],
						functionDetails: [
							{
								name: "complexFunc",
								isAsync: true,
								params: [
									{ name: "user", type: "User", isOptional: false },
									{ name: "options", type: "{ includeDeleted?: boolean; limit?: number }", isOptional: true },
									{ name: "...tags", type: "string[]", isRest: true },
								],
								returnType: "Promise<Result<User[]>>",
								jsdoc: null,
							},
						],
						filePath: "complex.server.ts",
					},
				],
			]);

			const options = { moduleNameTransform: (path) => path.replace(/\.server\.(js|ts)$/, "") };
			const typeDefs = generateTypeDefinitions(serverFunctions, options);

			expect(typeDefs).toContain(
				"function complexFunc(user: User, options?: { includeDeleted?: boolean; limit?: number }, ...tags: string[]): Promise<Result<User[]>>",
			);
		});

		it("should generate global namespace declarations", () => {
			const serverFunctions = new Map([
				[
					"auth_module",
					{
						functions: ["login", "logout"],
						functionDetails: [
							{
								name: "login",
								isAsync: true,
								params: [
									{ name: "email", type: "string" },
									{ name: "password", type: "string" },
								],
								returnType: "Promise<AuthResult>",
							},
							{
								name: "logout",
								isAsync: true,
								params: [],
								returnType: "Promise<void>",
							},
						],
						filePath: "auth.server.ts",
					},
				],
			]);

			const options = { moduleNameTransform: (path) => path.replace(/\.server\.(js|ts)$/, "") };
			const typeDefs = generateTypeDefinitions(serverFunctions, options);

			// Must be a script-style ambient namespace: `declare global` requires an
			// `export {}` which would turn the file into a module and disable the
			// ambient `declare module` blocks
			expect(typeDefs).toContain("declare namespace ServerActions");
			expect(typeDefs).not.toContain("export {}");
			expect(typeDefs).toContain("namespace Auth_module");
			expect(typeDefs).toContain("function login(email: string, password: string): Promise<AuthResult>");
			expect(typeDefs).toContain("function logout(): Promise<void>");
		});

		it("should preserve JSDoc comments in type definitions", () => {
			const serverFunctions = new Map([
				[
					"documented_module",
					{
						functions: ["documented"],
						functionDetails: [
							{
								name: "documented",
								isAsync: true,
								params: [{ name: "id", type: "number" }],
								returnType: "Promise<Item>",
								jsdoc: `/**
 * Get an item by ID
 * @param {number} id - The item ID
 * @returns {Promise<Item>} The item
 * @throws {Error} If item not found
 * @example
 * const item = await getItem(123);
 */`,
							},
						],
						filePath: "documented.server.ts",
					},
				],
			]);

			const options = { moduleNameTransform: (path) => path.replace(/\.server\.(js|ts)$/, "") };
			const typeDefs = generateTypeDefinitions(serverFunctions, options);

			expect(typeDefs).toContain("Get an item by ID");
			expect(typeDefs).toContain("@param {number} id - The item ID");
			expect(typeDefs).toContain("@returns {Promise<Item>} The item");
			expect(typeDefs).toContain("@throws {Error} If item not found");
			expect(typeDefs).toContain("@example");
		});

		it("should handle functions with no return type", () => {
			const serverFunctions = new Map([
				[
					"void_module",
					{
						functions: ["voidFunc"],
						functionDetails: [
							{
								name: "voidFunc",
								isAsync: true,
								params: [],
								returnType: null, // No return type specified
								jsdoc: null,
							},
						],
						filePath: "void.server.ts",
					},
				],
			]);

			const options = { moduleNameTransform: (path) => path.replace(/\.server\.(js|ts)$/, "") };
			const typeDefs = generateTypeDefinitions(serverFunctions, options);

			// Should default to Promise<any> for async functions without return type
			expect(typeDefs).toContain("function voidFunc(): Promise<any>");
		});

		it("should handle destructured parameters", () => {
			const serverFunctions = new Map([
				[
					"destructure_module",
					{
						functions: ["processData"],
						functionDetails: [
							{
								name: "processData",
								isAsync: true,
								params: [
									{ name: "{id, name}", type: "{ id: number; name: string }" },
									{ name: "[first, second]", type: "[string, number]" },
								],
								returnType: "Promise<void>",
								jsdoc: null,
							},
						],
						filePath: "destructure.server.ts",
					},
				],
			]);

			const options = { moduleNameTransform: (path) => path.replace(/\.server\.(js|ts)$/, "") };
			const typeDefs = generateTypeDefinitions(serverFunctions, options);

			expect(typeDefs).toContain(
				"function processData({id, name}: { id: number; name: string }, [first, second]: [string, number]): Promise<void>",
			);
		});
	});

	describe("Enhanced Client Proxy Generation", () => {
		it("should strip server JSDoc from the client proxy", () => {
			const moduleName = "todo_module";
			const functionDetails = [
				{
					name: "addTodo",
					isAsync: true,
					params: [
						{ name: "text", type: "string" },
						{ name: "priority", type: '"low" | "medium" | "high"', isOptional: true },
					],
					returnType: "Promise<Todo>",
					jsdoc: "/**\n * Add a new todo\n */",
				},
			];
			const options = {
				apiPrefix: "/api",
				routeTransform: (path, func) => `${path}/${func}`,
			};
			const filePath = "todo.server.ts";

			const proxy = generateEnhancedClientProxy(moduleName, functionDetails, options, filePath);

			expect(proxy).not.toContain("Add a new todo");
			expect(proxy).not.toContain("@param");
			expect(proxy).not.toContain("@returns");
			expect(proxy).toContain("export async function addTodo");
		});

		it("should include development-time type validation hints", () => {
			const moduleName = "test_module";
			const functionDetails = [
				{
					name: "testFunc",
					isAsync: true,
					params: [],
					returnType: "Promise<void>",
				},
			];
			const options = {
				apiPrefix: "/api",
				routeTransform: (path, func) => func,
			};

			const proxy = generateEnhancedClientProxy(moduleName, functionDetails, options, "test.server.ts");

			// In development mode, should include safety checks
			if (process.env.NODE_ENV !== "production") {
				expect(proxy).toContain("window.__VITE_SERVER_ACTIONS_PROXY__");
				expect(proxy).toContain("Functions cannot be serialized");
			}
		});
	});

	describe("Type Annotation Edge Cases", () => {
		it("should handle circular type references gracefully", () => {
			const serverFunctions = new Map([
				[
					"circular_module",
					{
						functions: ["processNode"],
						functionDetails: [
							{
								name: "processNode",
								isAsync: true,
								params: [{ name: "node", type: "TreeNode" }],
								returnType: "Promise<TreeNode>",
								jsdoc: null,
							},
						],
						filePath: "circular.server.ts",
					},
				],
			]);

			const options = { moduleNameTransform: (path) => path.replace(/\.server\.(js|ts)$/, "") };
			const typeDefs = generateTypeDefinitions(serverFunctions, options);

			// Should handle without infinite loops
			expect(typeDefs).toContain("function processNode(node: TreeNode): Promise<TreeNode>");
		});

		it("should handle conditional types", () => {
			const serverFunctions = new Map([
				[
					"conditional_module",
					{
						functions: ["conditional"],
						functionDetails: [
							{
								name: "conditional",
								isAsync: false,
								params: [{ name: "value", type: "T extends string ? string[] : number[]" }],
								returnType: "T",
								jsdoc: null,
							},
						],
						filePath: "conditional.server.ts",
					},
				],
			]);

			const options = { moduleNameTransform: (path) => path.replace(/\.server\.(js|ts)$/, "") };
			const typeDefs = generateTypeDefinitions(serverFunctions, options);

			// Complex conditional types should be preserved
			expect(typeDefs).toContain("T extends string ? string[] : number[]");
		});
	});
});
