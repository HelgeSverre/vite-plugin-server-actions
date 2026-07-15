/**
 * Runtime validation code that gets bundled with the production server
 * This avoids the need for relative imports from src/
 */

/**
 * Simple schema discovery for production
 */
export class SchemaDiscovery {
	constructor() {
		this.schemas = new Map();
	}

	registerSchema(moduleName, functionName, schema) {
		const key = `${moduleName}.${functionName}`;
		this.schemas.set(key, schema);
	}

	getSchema(moduleName, functionName) {
		const key = `${moduleName}.${functionName}`;
		return this.schemas.get(key) || null;
	}

	getAllSchemas() {
		return new Map(this.schemas);
	}
}

/**
 * Standard error response factory for production
 * Mirrors createErrorResponse in src/security.js so production error
 * responses match development and the OpenAPI-documented error schema
 */
function createErrorResponse(status, message, code = null, details = null) {
	const error = {
		error: true,
		status,
		message,
		timestamp: new Date().toISOString(),
	};

	if (code) {
		error.code = code;
	}

	if (details) {
		error.details = details;
	}

	return error;
}

/**
 * Resolve the value at a given issue path within the validated data
 * (Zod 3 issues don't carry the received input, so we look it up ourselves)
 */
function getValueAtPath(data, path) {
	return path.reduce((value, key) => (value == null ? undefined : value[key]), data);
}

/**
 * Validation middleware for production
 */
export function createValidationMiddleware(options = {}) {
	const schemaDiscovery = options.schemaDiscovery || new SchemaDiscovery();

	return async function validationMiddleware(req, res, next) {
		let moduleName, functionName, schema;

		// Check for context from route setup
		if (req.validationContext) {
			moduleName = req.validationContext.moduleName;
			functionName = req.validationContext.functionName;
			schema = req.validationContext.schema;
		}

		if (!schema) {
			// No schema defined, skip validation
			return next();
		}

		let validationData;

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
			if (schema._def?.typeName === "ZodTuple") {
				// Schema expects multiple arguments (tuple)
				validationData = req.body;
			} else {
				// Schema expects single argument (first element of array)
				validationData = req.body[0];
			}

			// Validate request body using Zod
			if (schema.parse) {
				// It's a Zod schema
				const validatedData = await schema.parseAsync(validationData);

				// Replace request body with validated data
				if (schema._def?.typeName === "ZodTuple") {
					req.body = validatedData;
				} else {
					// Only the first argument is validated - preserve any remaining arguments
					req.body = [validatedData, ...req.body.slice(1)];
				}
			}
			next();
		} catch (error) {
			if (error.errors) {
				// Zod validation error - same shape as development
				const validationErrors = error.errors.map((err) => ({
					path: err.path.join("."),
					message: err.message,
					code: err.code,
					value: err.input !== undefined ? err.input : getValueAtPath(validationData, err.path),
				}));

				return res
					.status(400)
					.json(createErrorResponse(400, "Validation failed", "VALIDATION_ERROR", { validationErrors }));
			}

			// Other (non-Zod) error - same shape and status as development
			console.error("Validation middleware error:", error);
			return res
				.status(500)
				.json(
					createErrorResponse(
						500,
						"Internal validation error",
						"VALIDATION_INTERNAL_ERROR",
						process.env.NODE_ENV === "development" ? { message: error.message, stack: error.stack } : null,
					),
				);
		}
	};
}
