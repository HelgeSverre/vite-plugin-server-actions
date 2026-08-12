import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
	OpenAPIGenerator,
	createSwaggerMiddleware,
	setupOpenAPIEndpoints,
	parseJSDocParameters,
	EnhancedOpenAPIGenerator,
} from "../src/openapi.js";
import { SchemaDiscovery, ZodAdapter } from "../src/validation.js";

// Mock swagger-ui-express
vi.mock("swagger-ui-express", () => ({
	default: {
		serve: vi.fn(),
		setup: vi.fn(() => vi.fn()),
	},
}));

describe("OpenAPIGenerator", () => {
	let generator;
	let schemaDiscovery;

	beforeEach(() => {
		generator = new OpenAPIGenerator();
		schemaDiscovery = new SchemaDiscovery();
	});

	it("should initialize with default options", () => {
		expect(generator.info.title).toBe("Server Actions API");
		expect(generator.info.version).toBe("1.0.0");
		// Servers are now determined dynamically, not set during initialization
		expect(generator.servers).toHaveLength(0);
	});

	it("should initialize with custom options", () => {
		const customGenerator = new OpenAPIGenerator({
			info: {
				title: "Custom API",
				version: "2.0.0",
				description: "Custom description",
			},
			servers: [
				{
					url: "https://api.example.com",
					description: "Production server",
				},
			],
		});

		expect(customGenerator.info.title).toBe("Custom API");
		expect(customGenerator.info.version).toBe("2.0.0");
		expect(customGenerator.info.description).toBe("Custom description");
		expect(customGenerator.servers[0].url).toBe("https://api.example.com");
	});

	describe("generateSpec", () => {
		it("should generate basic OpenAPI spec", () => {
			const serverFunctions = new Map([["testModule", { functions: ["testFunction", "anotherFunction"] }]]);

			const spec = generator.generateSpec(serverFunctions, schemaDiscovery, {
				apiPrefix: "/api",
			});

			expect(spec.openapi).toBe("3.0.3");
			expect(spec.info).toBeDefined();
			expect(spec.servers).toBeDefined();
			expect(spec.paths).toBeDefined();
			expect(spec.components.schemas).toBeDefined();

			// Check paths are generated
			expect(spec.paths["/api/testModule/testFunction"]).toBeDefined();
			expect(spec.paths["/api/testModule/anotherFunction"]).toBeDefined();
		});

		it("should generate paths for multiple modules", () => {
			const serverFunctions = new Map([
				["module1", { functions: ["func1", "func2"] }],
				["module2", { functions: ["func3"] }],
			]);

			const spec = generator.generateSpec(serverFunctions, schemaDiscovery);

			expect(Object.keys(spec.paths)).toHaveLength(3);
			expect(spec.paths["/api/module1/func1"]).toBeDefined();
			expect(spec.paths["/api/module1/func2"]).toBeDefined();
			expect(spec.paths["/api/module2/func3"]).toBeDefined();
		});

		it("should include schema information when available", () => {
			const serverFunctions = new Map([["testModule", { functions: ["testFunction"] }]]);

			const schema = z.object({ name: z.string(), age: z.number() });
			schemaDiscovery.registerSchema("testModule", "testFunction", schema);

			const spec = generator.generateSpec(serverFunctions, schemaDiscovery);

			const pathItem = spec.paths["/api/testModule/testFunction"];
			expect(pathItem.post.requestBody.content["application/json"].schema).toBeDefined();
		});

		it("should use dynamic port when provided", () => {
			const serverFunctions = new Map([["testModule", { functions: ["testFunction"] }]]);

			const spec = generator.generateSpec(serverFunctions, schemaDiscovery, {
				apiPrefix: "/api",
				port: 8081,
			});

			expect(spec.servers).toHaveLength(1);
			expect(spec.servers[0].url).toBe("http://localhost:8081");
		});

		it("should preserve configured server URLs", () => {
			const servers = [{ url: "https://api.example.com", description: "Production" }];
			const customGenerator = new OpenAPIGenerator({ servers });
			const spec = customGenerator.generateSpec(new Map(), schemaDiscovery);

			expect(spec.servers).toEqual(servers);
		});
	});

	describe("generatePathItem", () => {
		it("should generate correct path item structure", () => {
			const pathItem = generator.generatePathItem("testModule", "testFunction", null);

			expect(pathItem.post).toBeDefined();
			expect(pathItem.post.operationId).toBe("testModule_testFunction");
			expect(pathItem.post.tags).toEqual(["testModule"]);
			expect(pathItem.post.summary).toBe("Execute testFunction");
			expect(pathItem.post.description).toContain("testFunction");
			expect(pathItem.post.description).toContain("testModule");
		});

		it("should include request body schema", () => {
			const pathItem = generator.generatePathItem("testModule", "testFunction", null);

			expect(pathItem.post.requestBody.required).toBe(true);
			expect(pathItem.post.requestBody.content["application/json"]).toBeDefined();
		});

		it("should include standard response codes", () => {
			const pathItem = generator.generatePathItem("testModule", "testFunction", null);

			expect(pathItem.post.responses[200]).toBeDefined();
			expect(pathItem.post.responses[400]).toBeDefined();
			expect(pathItem.post.responses[404]).toBeDefined();
			expect(pathItem.post.responses[500]).toBeDefined();
		});

		it("should include proper response schemas", () => {
			const pathItem = generator.generatePathItem("testModule", "testFunction", null);

			// Success response
			expect(pathItem.post.responses[200].content["application/json"].schema).toBeDefined();

			// Error responses
			expect(pathItem.post.responses[400].content["application/json"].schema).toBeDefined();
			expect(pathItem.post.responses[404].content["application/json"].schema).toBeDefined();
			expect(pathItem.post.responses[500].content["application/json"].schema).toBeDefined();
		});
	});

	describe("generateRequestSchema", () => {
		it("should generate default schema when no validation schema provided", () => {
			const schema = generator.generateRequestSchema(null);

			expect(schema.type).toBe("array");
			expect(schema.description).toContain("Function arguments");
			expect(schema.items.type).toBe("object");
		});

		it("should generate schema with validation when provided", () => {
			const validationSchema = z.string();
			const schema = generator.generateRequestSchema(validationSchema);

			expect(schema.type).toBe("array");
			expect(schema.items.type).toBe("string");
		});

		it("should handle complex validation schemas", () => {
			const validationSchema = z.object({
				name: z.string(),
				age: z.number(),
				active: z.boolean(),
			});
			const schema = generator.generateRequestSchema(validationSchema);

			expect(schema.type).toBe("array");
			expect(schema.items.type).toBe("object");
			expect(schema.items.properties).toBeDefined();
			expect(schema.items.properties.name).toBeDefined();
			expect(schema.items.properties.age).toBeDefined();
			expect(schema.items.properties.active).toBeDefined();
		});
	});

	describe("getErrorSchema", () => {
		it("should return standard error schema", () => {
			const errorSchema = generator.getErrorSchema();

			expect(errorSchema.type).toBe("object");
			expect(errorSchema.properties.error).toBeDefined();
			expect(errorSchema.properties.error.type).toBe("boolean");
			expect(errorSchema.properties.status).toBeDefined();
			expect(errorSchema.properties.message).toBeDefined();
			expect(errorSchema.properties.timestamp).toBeDefined();
			expect(errorSchema.properties.details).toBeDefined();
			expect(errorSchema.required).toContain("error");
			expect(errorSchema.required).toContain("status");
			expect(errorSchema.required).toContain("message");
			expect(errorSchema.required).toContain("timestamp");
		});

		it("should include validation error structure", () => {
			const errorSchema = generator.getErrorSchema();

			const validationErrors = errorSchema.properties.details.properties.validationErrors;
			expect(validationErrors.type).toBe("array");
			expect(validationErrors.items.properties.path).toBeDefined();
			expect(validationErrors.items.properties.message).toBeDefined();
			expect(validationErrors.items.properties.code).toBeDefined();
		});
	});
});

describe("createSwaggerMiddleware", () => {
	it("should create middleware array", () => {
		const spec = { openapi: "3.0.3", info: { title: "Test" } };
		const middleware = createSwaggerMiddleware(spec);

		expect(Array.isArray(middleware)).toBe(true);
		expect(middleware).toHaveLength(2);
	});

	it("should pass custom options to swagger setup", () => {
		const spec = { openapi: "3.0.3", info: { title: "Test" } };
		const customOptions = {
			swaggerOptions: {
				customSiteTitle: "Custom Title",
				customCss: "body { background: red; }",
			},
		};

		const middleware = createSwaggerMiddleware(spec, customOptions);
		expect(middleware).toHaveLength(2);
	});
});

describe("setupOpenAPIEndpoints", () => {
	let mockApp;
	let consoleLogSpy;

	beforeEach(() => {
		mockApp = {
			get: vi.fn(),
			use: vi.fn(),
		};
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	it("should setup OpenAPI JSON endpoint", () => {
		const spec = { openapi: "3.0.3", info: { title: "Test" } };

		setupOpenAPIEndpoints(mockApp, spec);

		expect(mockApp.get).toHaveBeenCalledWith("/api/openapi.json", expect.any(Function));
	});

	it("should setup Swagger UI by default", () => {
		const spec = { openapi: "3.0.3", info: { title: "Test" } };

		setupOpenAPIEndpoints(mockApp, spec);

		expect(mockApp.use).toHaveBeenCalledWith("/api/docs", expect.any(Function), expect.any(Function));
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("API Documentation"));
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("OpenAPI Spec"));
	});

	it("should skip Swagger UI when disabled", () => {
		const spec = { openapi: "3.0.3", info: { title: "Test" } };

		setupOpenAPIEndpoints(mockApp, spec, { enableSwaggerUI: false });

		expect(mockApp.get).toHaveBeenCalledWith("/api/openapi.json", expect.any(Function));
		expect(mockApp.use).not.toHaveBeenCalled();
		expect(consoleLogSpy).not.toHaveBeenCalled();
	});

	it("should use custom paths", () => {
		const spec = { openapi: "3.0.3", info: { title: "Test" } };
		const options = {
			docsPath: "/custom/docs",
			specPath: "/custom/spec.json",
		};

		setupOpenAPIEndpoints(mockApp, spec, options);

		expect(mockApp.get).toHaveBeenCalledWith("/custom/spec.json", expect.any(Function));
		expect(mockApp.use).toHaveBeenCalledWith("/custom/docs", expect.any(Function), expect.any(Function));
	});

	it("should serve OpenAPI spec correctly", () => {
		const spec = { openapi: "3.0.3", info: { title: "Test" } };

		setupOpenAPIEndpoints(mockApp, spec);

		// Get the handler function and test it
		const getCall = mockApp.get.mock.calls.find((call) => call[0] === "/api/openapi.json");
		expect(getCall).toBeDefined();

		const handler = getCall[1];
		const mockReq = {};
		const mockRes = { json: vi.fn() };

		handler(mockReq, mockRes);

		expect(mockRes.json).toHaveBeenCalledWith(spec);
	});
});

describe("parseJSDocParameters", () => {
	it("should return empty array for no JSDoc", () => {
		expect(parseJSDocParameters("")).toEqual([]);
		expect(parseJSDocParameters(null)).toEqual([]);
		expect(parseJSDocParameters(undefined)).toEqual([]);
	});

	it("should parse simple parameter", () => {
		const jsdoc = "/**\n * @param {string} name - The user's name\n */";
		const params = parseJSDocParameters(jsdoc);

		expect(params).toHaveLength(1);
		expect(params[0]).toEqual({
			name: "name",
			type: "string",
			description: "The user's name",
			required: true,
		});
	});

	it("should parse multiple parameters", () => {
		const jsdoc = `/**
		 * @param {string} name - The user's name
		 * @param {number} age - The user's age
		 * @param {boolean} active - Whether user is active
		 */`;
		const params = parseJSDocParameters(jsdoc);

		expect(params).toHaveLength(3);
		expect(params[0].name).toBe("name");
		expect(params[1].name).toBe("age");
		expect(params[2].name).toBe("active");
	});

	it("should handle optional parameters", () => {
		const jsdoc = "/**\n * @param {string} [name] - Optional name\n */";
		const params = parseJSDocParameters(jsdoc);

		expect(params).toHaveLength(1);
		expect(params[0].name).toBe("name");
		expect(params[0].required).toBe(false);
	});

	it("should handle complex types", () => {
		const jsdoc = `/**
		 * @param {Array<string>} items - List of items
		 * @param {Object} config - Configuration object
		 */`;
		const params = parseJSDocParameters(jsdoc);

		expect(params).toHaveLength(2);
		expect(params[0].type).toBe("array<string>");
		expect(params[1].type).toBe("object");
	});
});

describe("EnhancedOpenAPIGenerator", () => {
	let generator;

	beforeEach(() => {
		generator = new EnhancedOpenAPIGenerator();
	});

	describe("generatePathItemWithJSDoc", () => {
		it("should enhance path item with JSDoc description", () => {
			const jsdoc = `/**
			 * Creates a new user in the system
			 * @param {string} name - The user's name
			 */`;

			const pathItem = generator.generatePathItemWithJSDoc("userModule", "createUser", null, jsdoc);

			expect(pathItem.post.description).toBe("Creates a new user in the system");
		});

		it("should generate request schema from JSDoc when no validation schema", () => {
			const jsdoc = `/**
			 * @param {string} name - The user's name
			 * @param {number} age - The user's age
			 */`;

			const pathItem = generator.generatePathItemWithJSDoc("userModule", "createUser", null, jsdoc);

			expect(pathItem.post.requestBody.content["application/json"].schema.type).toBe("array");
			expect(pathItem.post.requestBody.content["application/json"].schema.items.type).toBe("object");
		});

		it("should not override validation schema when present", () => {
			const validationSchema = z.string();
			const jsdoc = `/**
			 * @param {number} age - The user's age
			 */`;

			const pathItem = generator.generatePathItemWithJSDoc("userModule", "createUser", validationSchema, jsdoc);

			// Should use validation schema, not JSDoc
			expect(pathItem.post.requestBody.content["application/json"].schema.items.type).toBe("string");
		});
	});

	describe("generateSchemaFromJSDoc", () => {
		it("should generate single parameter schema", () => {
			const params = [{ name: "name", type: "string", description: "User name", required: true }];

			const schema = generator.generateSchemaFromJSDoc(params);

			expect(schema.type).toBe("string");
			expect(schema.description).toBe("User name");
		});

		it("should generate object schema for multiple parameters", () => {
			const params = [
				{ name: "name", type: "string", description: "User name", required: true },
				{ name: "age", type: "number", description: "User age", required: false },
			];

			const schema = generator.generateSchemaFromJSDoc(params);

			expect(schema.type).toBe("object");
			expect(schema.properties.name).toBeDefined();
			expect(schema.properties.age).toBeDefined();
			expect(schema.required).toEqual(["name"]);
		});
	});

	describe("jsDocTypeToOpenAPISchema", () => {
		it("should convert basic types", () => {
			expect(generator.jsDocTypeToOpenAPISchema({ type: "string", description: "test" })).toEqual({
				type: "string",
				description: "test",
			});

			expect(generator.jsDocTypeToOpenAPISchema({ type: "number", description: "test" })).toEqual({
				type: "number",
				description: "test",
			});

			expect(generator.jsDocTypeToOpenAPISchema({ type: "boolean", description: "test" })).toEqual({
				type: "boolean",
				description: "test",
			});
		});

		it("should handle union types", () => {
			const result = generator.jsDocTypeToOpenAPISchema({
				type: "'low'|'medium'|'high'",
				description: "Priority level",
			});

			expect(result.type).toBe("string");
			expect(result.enum).toEqual(["low", "medium", "high"]);
			expect(result.description).toBe("Priority level");
		});

		it("should handle arrays", () => {
			const result = generator.jsDocTypeToOpenAPISchema({
				type: "array",
				description: "List of items",
			});

			expect(result.type).toBe("array");
			expect(result.items.type).toBe("object");
			expect(result.description).toBe("List of items");
		});

		it("should default to object for unknown types", () => {
			const result = generator.jsDocTypeToOpenAPISchema({
				type: "CustomType",
				description: "Custom type",
			});

			expect(result.type).toBe("object");
			expect(result.description).toBe("Custom type");
		});
	});
});
