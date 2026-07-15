import { describe, it, expect, afterEach } from "vitest";
import {
	validateFunctionSignature,
	validateFileStructure,
	validateRuntimeArguments,
	generateTypeInfo,
	createDevelopmentFeedback,
	validateSchemaAttachment,
} from "../src/dev-validator.js";

const FILE = "src/actions/todo.server.ts";
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
	if (originalNodeEnv === undefined) {
		delete process.env.NODE_ENV;
	} else {
		process.env.NODE_ENV = originalNodeEnv;
	}
});

describe("dev-validator", () => {
	describe("validateFunctionSignature", () => {
		it("returns no warnings for a fully annotated, documented function", () => {
			const func = {
				name: "addTodo",
				isAsync: true,
				returnType: "Promise<Todo>",
				jsdoc: "/** Adds a todo */",
				params: [{ name: "text", type: "string" }],
			};

			expect(validateFunctionSignature(func, FILE)).toEqual([]);
		});

		it("warns about untyped parameters and names them", () => {
			const func = {
				name: "addTodo",
				isAsync: true,
				returnType: "Promise<Todo>",
				jsdoc: "/** doc */",
				params: [{ name: "text", type: "string" }, { name: "priority" }, { name: "done" }],
			};

			const warnings = validateFunctionSignature(func, FILE);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("Missing Type Annotations");
			expect(warnings[0]).toContain("priority, done");
			expect(warnings[0]).toContain("addTodo");
			expect(warnings[0]).toContain(FILE);
		});

		it("warns when an async function has no return type annotation", () => {
			const func = {
				name: "getTodos",
				isAsync: true,
				jsdoc: "/** doc */",
				params: [],
			};

			const warnings = validateFunctionSignature(func, FILE);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("Missing Return Type");
			expect(warnings[0]).toContain("getTodos");
		});

		it("does not warn about missing return type on non-async functions", () => {
			const func = {
				name: "helper",
				isAsync: false,
				jsdoc: "/** doc */",
				params: [],
			};

			const warnings = validateFunctionSignature(func, FILE);
			expect(warnings.some((w) => w.includes("Missing Return Type"))).toBe(false);
		});

		it("warns when JSDoc documentation is missing", () => {
			const func = {
				name: "getTodos",
				isAsync: true,
				returnType: "Promise<Todo[]>",
				params: [],
			};

			const warnings = validateFunctionSignature(func, FILE);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("Missing Documentation");
		});

		it("warns about complex destructured parameters", () => {
			const func = {
				name: "updateSettings",
				isAsync: true,
				returnType: "Promise<void>",
				jsdoc: "/** doc */",
				params: [{ name: "{opts}", type: "Options" }],
			};

			const warnings = validateFunctionSignature(func, FILE);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("Complex Parameter Destructuring");
		});
	});

	describe("validateFileStructure", () => {
		it("warns when the file exports no functions", () => {
			const warnings = validateFileStructure([], FILE);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("No Functions Found");
		});

		it("warns when a file contains more than 10 functions", () => {
			const functions = Array.from({ length: 11 }, (_, i) => ({ name: `getThing${i}` }));
			const warnings = validateFileStructure(functions, FILE);
			expect(warnings.some((w) => w.includes("Large File") && w.includes("11 functions"))).toBe(true);
		});

		it("does not warn for a small file with consistent naming", () => {
			const functions = [{ name: "getTodos" }, { name: "addTodo" }, { name: "deleteTodo" }];
			expect(validateFileStructure(functions, FILE)).toEqual([]);
		});

		it("warns about inconsistent naming styles", () => {
			const functions = [
				{ name: "getUser" },
				{ name: "get_user_by_id" },
				{ name: "fetchPosts" },
				{ name: "list_items" },
			];
			const warnings = validateFileStructure(functions, FILE);
			expect(warnings.some((w) => w.includes("Inconsistent Naming"))).toBe(true);
		});
	});

	describe("validateRuntimeArguments", () => {
		const functionInfo = {
			params: [
				{ name: "text", isOptional: false },
				{ name: "priority", isOptional: true },
			],
		};

		it("returns no warnings outside development", () => {
			process.env.NODE_ENV = "test";
			expect(validateRuntimeArguments("addTodo", [], functionInfo)).toEqual([]);

			process.env.NODE_ENV = "production";
			expect(validateRuntimeArguments("addTodo", [], functionInfo)).toEqual([]);
		});

		it("warns about too few arguments in development", () => {
			process.env.NODE_ENV = "development";
			const warnings = validateRuntimeArguments("addTodo", [], functionInfo);
			expect(warnings).toContain("Function 'addTodo' expects at least 1 arguments, got 0");
		});

		it("warns about too many arguments in development", () => {
			process.env.NODE_ENV = "development";
			const warnings = validateRuntimeArguments("addTodo", ["a", "b", "c"], functionInfo);
			expect(warnings).toContain("Function 'addTodo' expects at most 2 arguments, got 3");
		});

		it("does not warn about extra arguments when the function has a rest parameter", () => {
			process.env.NODE_ENV = "development";
			const restInfo = {
				params: [
					{ name: "first", isOptional: false },
					{ name: "rest", isRest: true },
				],
			};
			expect(validateRuntimeArguments("collect", ["a", "b", "c", "d"], restInfo)).toEqual([]);
		});

		it("warns about non-serializable argument types in development", () => {
			process.env.NODE_ENV = "development";
			class Custom {}
			const warnings = validateRuntimeArguments("addTodo", [() => {}, new Date()], {
				params: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
			});

			expect(warnings.some((w) => w.includes("Argument 1 is a function"))).toBe(true);
			expect(warnings.some((w) => w.includes("Argument 2 is a Date object"))).toBe(true);

			const moreWarnings = validateRuntimeArguments("addTodo", [/regex/, new Custom()], {
				params: [{ name: "a" }, { name: "b" }],
			});
			expect(moreWarnings.some((w) => w.includes("Argument 1 is a RegExp"))).toBe(true);
			expect(moreWarnings.some((w) => w.includes("Argument 2 is a custom object instance"))).toBe(true);
		});

		it("accepts plain objects and arrays without warnings", () => {
			process.env.NODE_ENV = "development";
			const warnings = validateRuntimeArguments("addTodo", [{ text: "hi" }, [1, 2]], {
				params: [{ name: "a" }, { name: "b" }],
			});
			expect(warnings).toEqual([]);
		});
	});

	describe("generateTypeInfo", () => {
		it("renders a full signature with types, defaults and Promise return type", () => {
			const info = {
				name: "addTodo",
				isAsync: true,
				returnType: "Todo",
				params: [
					{ name: "text", type: "string" },
					{ name: "priority", type: "string", defaultValue: '"low"' },
				],
			};

			expect(generateTypeInfo(info)).toBe('function addTodo(text: string, priority: string = "low"): Promise<Todo>');
		});

		it("falls back to any for unannotated non-async functions", () => {
			const info = { name: "helper", isAsync: false, params: [{ name: "x" }] };
			expect(generateTypeInfo(info)).toBe("function helper(x): any");
		});
	});

	describe("createDevelopmentFeedback", () => {
		it("summarizes modules and their functions", () => {
			const serverFunctions = new Map([
				["todo", { functions: ["addTodo", "getTodos"], filePath: "src/todo.server.js" }],
				["user", { functions: ["getUser"], filePath: "src/user.server.js" }],
			]);

			const feedback = createDevelopmentFeedback(serverFunctions);
			expect(feedback).toContain("Found 3 server actions across 2 modules");
			expect(feedback).toContain("src/todo.server.js: addTodo, getTodos");
			expect(feedback).toContain("src/user.server.js: getUser");
		});
	});

	describe("validateSchemaAttachment", () => {
		it("suggests adding a schema for functions without one", () => {
			const moduleExports = { addTodo: async () => {} };
			const suggestions = validateSchemaAttachment(moduleExports, ["addTodo"], FILE);

			expect(suggestions).toHaveLength(1);
			expect(suggestions[0]).toContain("Missing Validation Schema");
			expect(suggestions[0]).toContain("addTodo.schema = z.object");
		});

		it("returns no suggestions when schemas are attached", () => {
			const addTodo = async () => {};
			addTodo.schema = { parse: () => {} };
			const suggestions = validateSchemaAttachment({ addTodo }, ["addTodo"], FILE);
			expect(suggestions).toEqual([]);
		});

		it("ignores names that are not functions on the module", () => {
			const suggestions = validateSchemaAttachment({ notAFunction: 42 }, ["notAFunction", "missing"], FILE);
			expect(suggestions).toEqual([]);
		});
	});
});
