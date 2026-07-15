import { z } from "zod";
import { createErrorResponse } from "./security.js";
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";

// Extend Zod with OpenAPI support
extendZodWithOpenApi(z);

/**
 * Resolve the value at a given issue path within the validated data
 * (Zod 3 issues don't carry the received input, so we look it up ourselves)
 * @param {any} data - The data that was validated
 * @param {Array<string|number>} path - The issue path
 * @returns {any} The value at the path, or undefined
 */
function getValueAtPath(data, path) {
	return path.reduce((value, key) => (value == null ? undefined : value[key]), data);
}

/**
 * Base validation adapter interface
 */
export class ValidationAdapter {
	/**
	 * Validate data against a schema
	 * @param {any} schema - The validation schema
	 * @param {any} data - The data to validate
	 * @returns {Promise<{success: boolean, data?: any, errors?: any[]}>}
	 */
	async validate(schema, data) {
		throw new Error("ValidationAdapter.validate must be implemented");
	}

	/**
	 * Convert schema to OpenAPI schema format
	 * @param {any} schema - The validation schema
	 * @returns {object} OpenAPI schema object
	 */
	toOpenAPISchema(schema) {
		throw new Error("ValidationAdapter.toOpenAPISchema must be implemented");
	}

	/**
	 * Get parameter definitions for OpenAPI
	 * @param {any} schema - The validation schema
	 * @returns {Array} Array of OpenAPI parameter objects
	 */
	getParameters(schema) {
		throw new Error("ValidationAdapter.getParameters must be implemented");
	}
}

/**
 * Zod validation adapter
 */
export class ZodAdapter extends ValidationAdapter {
	async validate(schema, data) {
		try {
			const validatedData = await schema.parseAsync(data);
			return {
				success: true,
				data: validatedData,
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				return {
					success: false,
					errors: error.errors.map((err) => ({
						path: err.path.join("."),
						message: err.message,
						code: err.code,
						value: err.input !== undefined ? err.input : getValueAtPath(data, err.path),
					})),
				};
			}
			return {
				success: false,
				errors: [
					{
						path: "root",
						message: error.message,
						code: "unknown",
					},
				],
			};
		}
	}

	toOpenAPISchema(schema) {
		try {
			// Use @asteasolutions/zod-to-openapi for conversion
			const registry = new OpenAPIRegistry();
			const schemaName = "_TempSchema";

			// The library requires schemas to have .openapi() metadata
			// If the schema doesn't have it, add it dynamically
			let schemaToRegister = schema;
			if (typeof schema.openapi === "function") {
				// Add openapi metadata with the temp schema name
				schemaToRegister = schema.openapi(schemaName);
			} else {
				// Schema wasn't created with extendZodWithOpenApi - use basic fallback
				return this._basicZodToOpenAPI(schema);
			}

			registry.register(schemaName, schemaToRegister);

			// Generate the OpenAPI components
			const generator = new OpenApiGeneratorV3(registry.definitions);
			const components = generator.generateComponents();

			// Collect named components generated for nested .openapi('Name') schemas
			// so spec generators can register them under components.schemas
			// (otherwise emitted $ref pointers would dangle)
			const generatedSchemas = components.components?.schemas || {};
			for (const [name, componentSchema] of Object.entries(generatedSchemas)) {
				if (name !== schemaName) {
					this.discoveredComponents = this.discoveredComponents || {};
					this.discoveredComponents[name] = componentSchema;
				}
			}

			// Extract the schema from components
			const openAPISchema = generatedSchemas[schemaName];

			if (!openAPISchema) {
				// Fallback for schemas that couldn't be converted
				return this._basicZodToOpenAPI(schema);
			}

			return openAPISchema;
		} catch (error) {
			// Only log warning for unexpected errors
			if (process.env.NODE_ENV === "development") {
				console.warn(`Failed to convert Zod schema to OpenAPI: ${error.message}`);
			}
			return this._basicZodToOpenAPI(schema);
		}
	}

	/**
	 * Basic Zod to OpenAPI conversion for schemas without .openapi() extension
	 * @param {any} schema - Zod schema
	 * @returns {object} OpenAPI schema
	 */
	_basicZodToOpenAPI(schema) {
		if (!schema || !schema._def) {
			return { type: "object", description: "Unknown schema" };
		}

		const typeName = schema._def.typeName;

		switch (typeName) {
			case "ZodString":
				return { type: "string" };
			case "ZodNumber":
				return { type: "number" };
			case "ZodBoolean":
				return { type: "boolean" };
			case "ZodArray":
				return {
					type: "array",
					items: this._basicZodToOpenAPI(schema._def.type),
				};
			case "ZodObject": {
				const shape = schema._def.shape ? schema._def.shape() : {};
				const properties = {};
				const required = [];
				for (const [key, value] of Object.entries(shape)) {
					properties[key] = this._basicZodToOpenAPI(value);
					if (!value.isOptional?.()) {
						required.push(key);
					}
				}
				return {
					type: "object",
					properties,
					...(required.length > 0 ? { required } : {}),
				};
			}
			case "ZodOptional":
				return this._basicZodToOpenAPI(schema._def.innerType);
			case "ZodDefault":
				return this._basicZodToOpenAPI(schema._def.innerType);
			case "ZodEnum":
				return {
					type: "string",
					enum: schema._def.values,
				};
			case "ZodTuple": {
				const items = schema._def.items.map((item) => this._basicZodToOpenAPI(item));
				return {
					type: "array",
					items: items.length === 1 ? items[0] : { oneOf: items },
					minItems: items.length,
					maxItems: items.length,
				};
			}
			default:
				return { type: "object", description: `Zod type: ${typeName}` };
		}
	}

	getParameters(schema) {
		if (!schema || typeof schema._def === "undefined") {
			return [];
		}

		// For function parameters, we expect an array schema or object schema
		if (schema._def.typeName === "ZodArray") {
			// Array of parameters - convert each item to a parameter
			const itemSchema = schema._def.type;
			return this._schemaToParameters(itemSchema, "body");
		} else if (schema._def.typeName === "ZodObject") {
			// Object parameters - convert each property to a parameter
			return this._objectToParameters(schema);
		}

		return [
			{
				name: "data",
				in: "body",
				required: true,
				schema: this.toOpenAPISchema(schema),
			},
		];
	}

	_objectToParameters(zodObject) {
		const shape = zodObject._def.shape();
		const parameters = [];

		for (const [key, value] of Object.entries(shape)) {
			parameters.push({
				name: key,
				in: "body",
				required: !value.isOptional(),
				schema: this.toOpenAPISchema(value),
				description: value.description || `Parameter: ${key}`,
			});
		}

		return parameters;
	}

	_schemaToParameters(schema, location = "body") {
		return [
			{
				name: "data",
				in: location,
				required: true,
				schema: this.toOpenAPISchema(schema),
			},
		];
	}
}

/**
 * Schema discovery utilities
 */
export class SchemaDiscovery {
	constructor(adapter = new ZodAdapter()) {
		this.adapter = adapter;
		this.schemas = new Map();
	}

	/**
	 * Register a schema for a function
	 * @param {string} moduleName - Module name
	 * @param {string} functionName - Function name
	 * @param {any} schema - Validation schema
	 */
	registerSchema(moduleName, functionName, schema) {
		const key = `${moduleName}.${functionName}`;
		this.schemas.set(key, schema);
	}

	/**
	 * Get schema for a function
	 * @param {string} moduleName - Module name
	 * @param {string} functionName - Function name
	 * @returns {any|null} Schema or null if not found
	 */
	getSchema(moduleName, functionName) {
		const key = `${moduleName}.${functionName}`;
		return this.schemas.get(key) || null;
	}

	/**
	 * Check if schema exists for a function
	 * @param {string} moduleName - Module name
	 * @param {string} functionName - Function name
	 * @returns {boolean} True if schema exists
	 */
	hasSchema(moduleName, functionName) {
		const key = `${moduleName}.${functionName}`;
		return this.schemas.has(key);
	}

	/**
	 * Get all schemas
	 * @returns {Map} All registered schemas
	 */
	getAllSchemas() {
		return new Map(this.schemas);
	}

	/**
	 * Discover schemas from module exports
	 * @param {object} module - Module with exported functions
	 * @param {string} moduleName - Module name
	 */
	discoverFromModule(module, moduleName) {
		for (const [functionName, fn] of Object.entries(module)) {
			if (typeof fn === "function") {
				// Check if function has attached schema
				if (fn.schema) {
					this.registerSchema(moduleName, functionName, fn.schema);
				}

				// Check for JSDoc schema annotations (future enhancement)
				// This would require parsing JSDoc comments from the function
			}
		}
	}

	/**
	 * Clear all schemas
	 */
	clear() {
		this.schemas.clear();
	}
}

/**
 * Validation middleware factory
 */
export function createValidationMiddleware(options = {}) {
	// Handle adapter as string key (e.g., "zod") or instance
	let adapter;
	if (typeof options.adapter === "string") {
		const AdapterClass = adapters[options.adapter];
		if (!AdapterClass) {
			throw new Error(`Unknown validation adapter: ${options.adapter}. Available: ${Object.keys(adapters).join(", ")}`);
		}
		adapter = new AdapterClass();
	} else {
		adapter = options.adapter || new ZodAdapter();
	}
	const schemaDiscovery = options.schemaDiscovery || new SchemaDiscovery(adapter);

	return async function validationMiddleware(req, res, next) {
		let moduleName, functionName, schema;

		// Check for context from route setup
		if (req.validationContext) {
			moduleName = req.validationContext.moduleName;
			functionName = req.validationContext.functionName;
			schema = req.validationContext.schema;
		} else {
			// Fallback to URL parsing and schema discovery
			// Strip query string/fragment and trailing slashes so lookups
			// like /api/todo/addTodo?trace=1 or /api/todo/addTodo/ still match
			const pathname = req.url.split("?")[0].split("#")[0].replace(/\/+$/, "");
			const urlParts = pathname.split("/");
			functionName = urlParts[urlParts.length - 1];
			moduleName = urlParts[urlParts.length - 2];
			schema = schemaDiscovery.getSchema(moduleName, functionName);
		}

		if (!schema) {
			// No schema defined, skip validation
			return next();
		}

		try {
			// Request body should be an array of arguments for server functions
			// (an empty array is valid - e.g. zero-argument functions with z.tuple([]))
			if (!Array.isArray(req.body)) {
				return res
					.status(400)
					.json(
						createErrorResponse(400, "Request body must be an array of function arguments", "INVALID_REQUEST_BODY"),
					);
			}

			// Validate based on schema type
			let validationData;
			if (schema._def?.typeName === "ZodTuple") {
				// Schema expects multiple arguments (tuple)
				validationData = req.body;
			} else {
				// Schema expects single argument (first element of array)
				validationData = req.body[0];
			}

			const result = await adapter.validate(schema, validationData);

			if (!result.success) {
				return res
					.status(400)
					.json(createErrorResponse(400, "Validation failed", "VALIDATION_ERROR", { validationErrors: result.errors }));
			}

			// Replace request body with validated data
			if (schema._def?.typeName === "ZodTuple") {
				req.body = result.data;
			} else {
				// Only the first argument is validated - preserve any remaining arguments
				req.body = [result.data, ...req.body.slice(1)];
			}

			next();
		} catch (error) {
			console.error("Validation middleware error:", error);
			res
				.status(500)
				.json(
					createErrorResponse(
						500,
						"Internal validation error",
						"VALIDATION_INTERNAL_ERROR",
						process.env.NODE_ENV !== "production" ? { message: error.message, stack: error.stack } : null,
					),
				);
		}
	};
}

// Export default adapters and utilities
export const adapters = {
	zod: ZodAdapter,
};

export const defaultAdapter = new ZodAdapter();
export const defaultSchemaDiscovery = new SchemaDiscovery(defaultAdapter);
