import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { OpenAPIGenerator, parseJSDocParameters } from "../src/openapi.js";
import { ZodAdapter, SchemaDiscovery, createValidationMiddleware } from "../src/validation.js";
import { createValidationMiddleware as createRuntimeValidationMiddleware } from "../src/validation-runtime.js";

function createMockRes() {
	return {
		status: vi.fn().mockReturnThis(),
		json: vi.fn().mockReturnThis(),
	};
}

describe("tuple schemas are not double-wrapped in generated request bodies", () => {
	it("documents the tuple itself as the request body array", () => {
		const generator = new OpenAPIGenerator();
		const tupleSchema = z.tuple([z.object({ text: z.string() }), z.number()]);

		const requestSchema = generator.generateRequestSchema(tupleSchema);

		// The middleware validates req.body directly against the tuple,
		// so the documented body must be the tuple array - not an array of tuples
		expect(requestSchema.type).toBe("array");
		expect(requestSchema.minItems).toBe(2);
		expect(requestSchema.maxItems).toBe(2);
		expect(requestSchema.items.type).not.toBe("array");
	});

	it("documents a spec-conformant body that the middleware actually accepts", async () => {
		const adapter = new ZodAdapter();
		const tupleSchema = z.tuple([z.object({ text: z.string() })]);

		// A body built from the (fixed) spec: single-element array containing the object
		const specConformantBody = [{ text: "buy milk" }];
		const result = await adapter.validate(tupleSchema, specConformantBody);

		expect(result.success).toBe(true);

		const generator = new OpenAPIGenerator();
		const requestSchema = generator.generateRequestSchema(tupleSchema);
		expect(requestSchema.maxItems).toBe(1);
		expect(requestSchema.items.type).toBe("object");
	});
});

describe("JSDoc optional-with-default parameters are parsed correctly", () => {
	it("parses [name=value] as optional with a clean name and description", () => {
		const jsdoc = "/**\n * @param {string} [priority=low] - task priority\n */";
		const params = parseJSDocParameters(jsdoc);

		expect(params).toHaveLength(1);
		expect(params[0].name).toBe("priority");
		expect(params[0].required).toBe(false);
		expect(params[0].description).toBe("task priority");
	});

	it("still parses plain and optional-without-default parameters", () => {
		const jsdoc = `/**
		 * @param {string} name - The name
		 * @param {number} [age] - Optional age
		 */`;
		const params = parseJSDocParameters(jsdoc);

		expect(params).toHaveLength(2);
		expect(params[0]).toEqual({ name: "name", type: "string", description: "The name", required: true });
		expect(params[1]).toEqual({ name: "age", type: "number", description: "Optional age", required: false });
	});
});

describe("production validation errors match dev and the documented error schema", () => {
	it("returns the dev-format error response for Zod validation failures", async () => {
		const middleware = createRuntimeValidationMiddleware();
		const schema = z.object({ name: z.string() });
		const mockReq = {
			body: [{ name: 123 }],
			validationContext: { moduleName: "todo", functionName: "addTodo", schema },
		};
		const mockRes = createMockRes();
		const mockNext = vi.fn();

		await middleware(mockReq, mockRes, mockNext);

		expect(mockNext).not.toHaveBeenCalled();
		expect(mockRes.status).toHaveBeenCalledWith(400);
		expect(mockRes.json).toHaveBeenCalledWith({
			error: true,
			status: 400,
			message: "Validation failed",
			code: "VALIDATION_ERROR",
			timestamp: expect.any(String),
			details: expect.objectContaining({
				validationErrors: expect.arrayContaining([
					expect.objectContaining({
						path: "name",
						message: expect.any(String),
						code: expect.any(String),
					}),
				]),
			}),
		});
	});

	it("returns the dev-format error response for invalid (non-array) bodies", async () => {
		const middleware = createRuntimeValidationMiddleware();
		const mockReq = {
			body: "not an array",
			validationContext: { moduleName: "todo", functionName: "addTodo", schema: z.string() },
		};
		const mockRes = createMockRes();
		const mockNext = vi.fn();

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).toHaveBeenCalledWith(400);
		expect(mockRes.json).toHaveBeenCalledWith({
			error: true,
			status: 400,
			message: "Request body must be an array of function arguments",
			code: "INVALID_REQUEST_BODY",
			timestamp: expect.any(String),
		});
		expect(mockNext).not.toHaveBeenCalled();
	});

	it("returns 500 VALIDATION_INTERNAL_ERROR for non-Zod errors, matching dev", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const middleware = createRuntimeValidationMiddleware();
		const brokenSchema = {
			parse: () => {},
			parseAsync: async () => {
				throw new Error("boom");
			},
		};
		const mockReq = {
			body: ["data"],
			validationContext: { moduleName: "todo", functionName: "addTodo", schema: brokenSchema },
		};
		const mockRes = createMockRes();
		const mockNext = vi.fn();

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).toHaveBeenCalledWith(500);
		expect(mockRes.json).toHaveBeenCalledWith(
			expect.objectContaining({
				error: true,
				status: 500,
				message: "Internal validation error",
				code: "VALIDATION_INTERNAL_ERROR",
				timestamp: expect.any(String),
			}),
		);
		expect(mockNext).not.toHaveBeenCalled();

		consoleErrorSpy.mockRestore();
	});
});

describe("validation error 'value' contains the received value", () => {
	it("populates value from the validated data by issue path (Zod 3 has no err.input)", async () => {
		const adapter = new ZodAdapter();
		const schema = z.object({ name: z.string(), age: z.number() });

		const result = await adapter.validate(schema, { name: "John", age: "thirty" });

		expect(result.success).toBe(false);
		const ageError = result.errors.find((e) => e.path === "age");
		expect(ageError).toBeDefined();
		expect(ageError.value).toBe("thirty");
	});

	it("populates value for nested paths and root-level failures", async () => {
		const adapter = new ZodAdapter();
		const schema = z.object({ user: z.object({ age: z.number() }) });

		const result = await adapter.validate(schema, { user: { age: "old" } });

		expect(result.success).toBe(false);
		expect(result.errors[0].path).toBe("user.age");
		expect(result.errors[0].value).toBe("old");

		const rootResult = await adapter.validate(z.number(), "nope");
		expect(rootResult.success).toBe(false);
		expect(rootResult.errors[0].value).toBe("nope");
	});

	it("includes the received value in production validation error responses", async () => {
		const middleware = createRuntimeValidationMiddleware();
		const schema = z.object({ age: z.number() });
		const mockReq = {
			body: [{ age: "thirty" }],
			validationContext: { moduleName: "users", functionName: "setAge", schema },
		};
		const mockRes = createMockRes();

		await middleware(mockReq, mockRes, vi.fn());

		const payload = mockRes.json.mock.calls[0][0];
		expect(payload.details.validationErrors[0].value).toBe("thirty");
	});
});

describe("nested .openapi('Name') schemas produce resolvable $refs", () => {
	it("populates components.schemas with referenced components", () => {
		const generator = new OpenAPIGenerator();
		const schemaDiscovery = new SchemaDiscovery();

		const User = z.object({ name: z.string() }).openapi("User");
		schemaDiscovery.registerSchema("users", "createUser", z.object({ user: User }));

		const serverFunctions = new Map([["users", { functions: ["createUser"] }]]);
		const spec = generator.generateSpec(serverFunctions, schemaDiscovery, { apiPrefix: "/api" });

		const requestSchema = spec.paths["/api/users/createUser"].post.requestBody.content["application/json"].schema;
		expect(requestSchema.items.properties.user).toEqual({ $ref: "#/components/schemas/User" });

		// The referenced component must exist, otherwise the $ref dangles
		expect(spec.components.schemas.User).toBeDefined();
		expect(spec.components.schemas.User.type).toBe("object");
		expect(spec.components.schemas.User.properties.name).toEqual({ type: "string" });
	});
});

describe("standalone middleware URL fallback handles query strings and trailing slashes", () => {
	function setupMiddleware() {
		const discovery = new SchemaDiscovery();
		discovery.registerSchema("todo", "addTodo", z.string());
		return createValidationMiddleware({ schemaDiscovery: discovery });
	}

	it("still validates when the URL has a query string", async () => {
		const middleware = setupMiddleware();
		const mockReq = { url: "/api/todo/addTodo?trace=1", body: [123] };
		const mockRes = createMockRes();
		const mockNext = vi.fn();

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).toHaveBeenCalledWith(400);
		expect(mockNext).not.toHaveBeenCalled();
	});

	it("still validates when the URL has a trailing slash", async () => {
		const middleware = setupMiddleware();
		const mockReq = { url: "/api/todo/addTodo/", body: [123] };
		const mockRes = createMockRes();
		const mockNext = vi.fn();

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).toHaveBeenCalledWith(400);
		expect(mockNext).not.toHaveBeenCalled();
	});
});

describe("zero-argument calls can pass schemas that accept them", () => {
	it("allows an empty args array when the schema is z.tuple([]) in dev", async () => {
		const discovery = new SchemaDiscovery();
		discovery.registerSchema("todo", "getTodos", z.tuple([]));
		const middleware = createValidationMiddleware({ schemaDiscovery: discovery });

		const mockReq = { url: "/api/todo/getTodos", body: [] };
		const mockRes = createMockRes();
		const mockNext = vi.fn();

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).not.toHaveBeenCalled();
		expect(mockNext).toHaveBeenCalled();
		expect(mockReq.body).toEqual([]);
	});

	it("allows an empty args array when the schema is z.tuple([]) in production", async () => {
		const middleware = createRuntimeValidationMiddleware();
		const mockReq = {
			body: [],
			validationContext: { moduleName: "todo", functionName: "getTodos", schema: z.tuple([]) },
		};
		const mockRes = createMockRes();
		const mockNext = vi.fn();

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).not.toHaveBeenCalled();
		expect(mockNext).toHaveBeenCalled();
		expect(mockReq.body).toEqual([]);
	});
});

describe("non-tuple schema on a multi-argument function preserves trailing arguments", () => {
	it("validates the first argument and passes the rest through in dev", async () => {
		const discovery = new SchemaDiscovery();
		discovery.registerSchema("todo", "updateTodo", z.number());
		const middleware = createValidationMiddleware({ schemaDiscovery: discovery });

		const mockReq = { url: "/api/todo/updateTodo", body: [5, "new text"] };
		const mockRes = createMockRes();
		const mockNext = vi.fn();

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).not.toHaveBeenCalled();
		expect(mockNext).toHaveBeenCalled();
		expect(mockReq.body).toEqual([5, "new text"]);
	});

	it("validates the first argument and passes the rest through in production", async () => {
		const middleware = createRuntimeValidationMiddleware();
		const mockReq = {
			body: [5, "new text"],
			validationContext: { moduleName: "todo", functionName: "updateTodo", schema: z.number() },
		};
		const mockRes = createMockRes();
		const mockNext = vi.fn();

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).not.toHaveBeenCalled();
		expect(mockNext).toHaveBeenCalled();
		expect(mockReq.body).toEqual([5, "new text"]);
	});
});
