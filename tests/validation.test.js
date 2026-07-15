import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
	ValidationAdapter,
	ZodAdapter,
	SchemaDiscovery,
	createValidationMiddleware,
	defaultAdapter,
	defaultSchemaDiscovery,
	adapters,
} from "../src/validation.js";

describe("ValidationAdapter", () => {
	it("should throw error for unimplemented validate method", async () => {
		const adapter = new ValidationAdapter();
		await expect(adapter.validate(null, {})).rejects.toThrow("ValidationAdapter.validate must be implemented");
	});

	it("should throw error for unimplemented toOpenAPISchema method", () => {
		const adapter = new ValidationAdapter();
		expect(() => adapter.toOpenAPISchema(null)).toThrow("ValidationAdapter.toOpenAPISchema must be implemented");
	});

	it("should throw error for unimplemented getParameters method", () => {
		const adapter = new ValidationAdapter();
		expect(() => adapter.getParameters(null)).toThrow("ValidationAdapter.getParameters must be implemented");
	});
});

describe("ZodAdapter", () => {
	let adapter;

	beforeEach(() => {
		adapter = new ZodAdapter();
	});

	describe("validate", () => {
		it("should validate valid data against schema", async () => {
			const schema = z.object({
				name: z.string(),
				age: z.number(),
			});
			const data = { name: "John", age: 30 };

			const result = await adapter.validate(schema, data);

			expect(result.success).toBe(true);
			expect(result.data).toEqual(data);
			expect(result.errors).toBeUndefined();
		});

		it("should return validation errors for invalid data", async () => {
			const schema = z.object({
				name: z.string(),
				age: z.number(),
			});
			const data = { name: "John", age: "thirty" }; // Invalid age

			const result = await adapter.validate(schema, data);

			expect(result.success).toBe(false);
			expect(result.data).toBeUndefined();
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toBe("age");
			expect(result.errors[0].message).toContain("Expected number");
		});

		it("should handle validation errors with multiple issues", async () => {
			const schema = z.object({
				name: z.string().min(3),
				age: z.number().min(18),
				email: z.string().email(),
			});
			const data = { name: "Jo", age: 15, email: "invalid-email" };

			const result = await adapter.validate(schema, data);

			expect(result.success).toBe(false);
			expect(result.errors).toHaveLength(3);
			expect(result.errors.map((e) => e.path)).toContain("name");
			expect(result.errors.map((e) => e.path)).toContain("age");
			expect(result.errors.map((e) => e.path)).toContain("email");
		});

		it("should handle non-Zod errors", async () => {
			const schema = {
				parseAsync: vi.fn().mockRejectedValue(new Error("Generic error")),
			};

			const result = await adapter.validate(schema, {});

			expect(result.success).toBe(false);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toBe("root");
			expect(result.errors[0].message).toBe("Generic error");
			expect(result.errors[0].code).toBe("unknown");
		});
	});

	describe("toOpenAPISchema", () => {
		it("should convert string schema to OpenAPI", () => {
			const schema = z.string();
			const result = adapter.toOpenAPISchema(schema);

			expect(result).toEqual({
				type: "string",
				description: undefined,
			});
		});

		it("should convert number schema to OpenAPI", () => {
			const schema = z.number().min(0).max(100);
			const result = adapter.toOpenAPISchema(schema);

			expect(result.type).toBe("number");
			expect(result.minimum).toBe(0);
			expect(result.maximum).toBe(100);
		});

		it("should convert boolean schema to OpenAPI", () => {
			const schema = z.boolean();
			const result = adapter.toOpenAPISchema(schema);

			expect(result).toEqual({
				type: "boolean",
				description: undefined,
			});
		});

		it("should convert array schema to OpenAPI", () => {
			const schema = z.array(z.string());
			const result = adapter.toOpenAPISchema(schema);

			expect(result.type).toBe("array");
			expect(result.items).toEqual({
				type: "string",
				description: undefined,
			});
		});

		it("should convert object schema to OpenAPI", () => {
			const schema = z.object({
				name: z.string(),
				age: z.number().optional(),
				active: z.boolean(),
			});
			const result = adapter.toOpenAPISchema(schema);

			expect(result.type).toBe("object");
			expect(result.properties).toBeDefined();
			expect(result.properties.name).toEqual({ type: "string", description: undefined });
			expect(result.properties.age).toEqual({ type: "number", description: undefined });
			expect(result.properties.active).toEqual({ type: "boolean", description: undefined });
			expect(result.required).toEqual(["name", "active"]);
		});

		it("should convert enum schema to OpenAPI", () => {
			const schema = z.enum(["low", "medium", "high"]);
			const result = adapter.toOpenAPISchema(schema);

			expect(result).toEqual({
				type: "string",
				enum: ["low", "medium", "high"],
				description: undefined,
			});
		});

		it("should convert optional schema to OpenAPI", () => {
			const schema = z.string().optional();
			const result = adapter.toOpenAPISchema(schema);

			expect(result).toEqual({
				type: "string",
				description: undefined,
			});
		});

		it("should convert nullable schema to OpenAPI", () => {
			const schema = z.string().nullable();
			const result = adapter.toOpenAPISchema(schema);

			expect(result.type).toBe("string");
			expect(result.nullable).toBe(true);
		});

		it("should convert union schema to OpenAPI", () => {
			const schema = z.union([z.string(), z.number()]);
			const result = adapter.toOpenAPISchema(schema);

			// The zod-to-openapi library handles unions differently
			expect(result).toBeDefined();
			expect(result.type || result.oneOf || result.anyOf).toBeDefined();
		});

		it("should handle string constraints", () => {
			const schema = z.string().min(3).max(50).email();
			const result = adapter.toOpenAPISchema(schema);

			expect(result.type).toBe("string");
			expect(result.minLength).toBe(3);
			expect(result.maxLength).toBe(50);
			expect(result.format).toBe("email");
		});

		it("should handle unsupported schemas gracefully", () => {
			const invalidSchema = { _def: { typeName: "UnsupportedType" } };

			const result = adapter.toOpenAPISchema(invalidSchema);

			// The adapter uses basic fallback for schemas without .openapi() extension
			expect(result).toBeDefined();
			expect(result.type).toBe("object");
			// Unsupported types get a descriptive fallback
			expect(result.description).toBe("Zod type: UnsupportedType");
		});
	});

	describe("getParameters", () => {
		it("should return empty array for undefined schema", () => {
			const result = adapter.getParameters(undefined);
			expect(result).toEqual([]);
		});

		it("should handle single parameter schema", () => {
			const schema = z.string();
			const result = adapter.getParameters(schema);

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe("data");
			expect(result[0].in).toBe("body");
			expect(result[0].required).toBe(true);
		});

		it("should handle object schema parameters", () => {
			const schema = z.object({
				name: z.string(),
				age: z.number().optional(),
			});
			const result = adapter.getParameters(schema);

			expect(result).toHaveLength(2);
			expect(result.find((p) => p.name === "name").required).toBe(true);
			expect(result.find((p) => p.name === "age").required).toBe(false);
		});
	});
});

describe("SchemaDiscovery", () => {
	let discovery;

	beforeEach(() => {
		discovery = new SchemaDiscovery();
	});

	it("should register and retrieve schemas", () => {
		const schema = z.string();
		discovery.registerSchema("testModule", "testFunction", schema);

		const retrieved = discovery.getSchema("testModule", "testFunction");
		expect(retrieved).toBe(schema);
	});

	it("should return null for non-existent schema", () => {
		const result = discovery.getSchema("nonExistent", "function");
		expect(result).toBeNull();
	});

	it("should discover schemas from module", () => {
		const mockFunction = vi.fn();
		mockFunction.schema = z.string();

		const module = {
			testFunction: mockFunction,
			regularFunction: vi.fn(), // No schema
			nonFunction: "not a function",
		};

		discovery.discoverFromModule(module, "testModule");

		const schema = discovery.getSchema("testModule", "testFunction");
		expect(schema).toBe(mockFunction.schema);

		const noSchema = discovery.getSchema("testModule", "regularFunction");
		expect(noSchema).toBeNull();
	});

	it("should get all schemas", () => {
		const schema1 = z.string();
		const schema2 = z.number();

		discovery.registerSchema("module1", "func1", schema1);
		discovery.registerSchema("module2", "func2", schema2);

		const allSchemas = discovery.getAllSchemas();
		expect(allSchemas.size).toBe(2);
		expect(allSchemas.get("module1.func1")).toBe(schema1);
		expect(allSchemas.get("module2.func2")).toBe(schema2);
	});

	it("should clear all schemas", () => {
		discovery.registerSchema("module", "func", z.string());
		expect(discovery.getAllSchemas().size).toBe(1);

		discovery.clear();
		expect(discovery.getAllSchemas().size).toBe(0);
	});
});

describe("createValidationMiddleware", () => {
	let mockReq, mockRes, mockNext;
	let middleware;

	beforeEach(() => {
		mockReq = {
			url: "/api/testModule/testFunction",
			body: ["test data"],
		};

		mockRes = {
			status: vi.fn().mockReturnThis(),
			json: vi.fn().mockReturnThis(),
		};

		mockNext = vi.fn();

		const discovery = new SchemaDiscovery();
		middleware = createValidationMiddleware({ schemaDiscovery: discovery });
	});

	it("should call next() when no schema is registered", async () => {
		await middleware(mockReq, mockRes, mockNext);

		expect(mockNext).toHaveBeenCalled();
		expect(mockRes.status).not.toHaveBeenCalled();
		expect(mockRes.json).not.toHaveBeenCalled();
	});

	it("should validate request body when schema exists", async () => {
		const discovery = new SchemaDiscovery();
		discovery.registerSchema("testModule", "testFunction", z.string());
		middleware = createValidationMiddleware({ schemaDiscovery: discovery });

		await middleware(mockReq, mockRes, mockNext);

		expect(mockNext).toHaveBeenCalled();
		expect(mockReq.body).toEqual(["test data"]);
	});

	it("should return 400 for invalid request body format", async () => {
		const discovery = new SchemaDiscovery();
		discovery.registerSchema("testModule", "testFunction", z.string());
		middleware = createValidationMiddleware({ schemaDiscovery: discovery });

		mockReq.body = "not an array";

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

	it("should return 400 for validation errors", async () => {
		const discovery = new SchemaDiscovery();
		discovery.registerSchema("testModule", "testFunction", z.string());
		middleware = createValidationMiddleware({ schemaDiscovery: discovery });

		mockReq.body = [123]; // Invalid string

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).toHaveBeenCalledWith(400);
		expect(mockRes.json).toHaveBeenCalledWith({
			error: true,
			status: 400,
			message: "Validation failed",
			code: "VALIDATION_ERROR",
			details: expect.objectContaining({
				validationErrors: expect.any(Array),
			}),
			timestamp: expect.any(String),
		});
		expect(mockNext).not.toHaveBeenCalled();
	});

	it("should handle tuple schemas correctly", async () => {
		const discovery = new SchemaDiscovery();
		const tupleSchema = z.tuple([z.string(), z.number()]);
		discovery.registerSchema("testModule", "testFunction", tupleSchema);
		middleware = createValidationMiddleware({ schemaDiscovery: discovery });

		mockReq.body = ["hello", 42];

		await middleware(mockReq, mockRes, mockNext);

		expect(mockNext).toHaveBeenCalled();
		expect(mockReq.body).toEqual(["hello", 42]);
	});

	it("should handle middleware errors gracefully", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const discovery = new SchemaDiscovery();
		// Create a broken adapter that throws
		const brokenAdapter = {
			validate: vi.fn().mockRejectedValue(new Error("Adapter error")),
		};

		discovery.registerSchema("testModule", "testFunction", z.string());
		middleware = createValidationMiddleware({
			schemaDiscovery: discovery,
			adapter: brokenAdapter,
		});

		await middleware(mockReq, mockRes, mockNext);

		expect(mockRes.status).toHaveBeenCalledWith(500);
		expect(mockRes.json).toHaveBeenCalledWith({
			error: true,
			status: 500,
			message: "Internal validation error",
			code: "VALIDATION_INTERNAL_ERROR",
			details: expect.objectContaining({
				message: "Adapter error",
			}),
			timestamp: expect.any(String),
		});
		expect(consoleErrorSpy).toHaveBeenCalled();

		consoleErrorSpy.mockRestore();
	});
});

describe("Default exports", () => {
	it("should export default adapter", () => {
		expect(defaultAdapter).toBeInstanceOf(ZodAdapter);
	});

	it("should export default schema discovery", () => {
		expect(defaultSchemaDiscovery).toBeInstanceOf(SchemaDiscovery);
		expect(defaultSchemaDiscovery.adapter).toBeInstanceOf(ZodAdapter);
	});

	it("should export adapters object", () => {
		expect(adapters).toBeDefined();
		expect(adapters.zod).toBe(ZodAdapter);
	});
});
