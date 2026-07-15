import { createRequire } from "module";
import { pathToFileURL } from "url";
import fs from "fs/promises";
import path from "path";
import { analyzeMiddlewareSource } from "./middleware-analysis.js";

/**
 * Extract schemas from server modules during build time
 */
export async function extractSchemas(serverFunctions) {
	const schemas = {};

	for (const [moduleName, { id, functions }] of serverFunctions) {
		schemas[moduleName] = {};

		try {
			// Import the module to get schemas
			const moduleUrl = pathToFileURL(id).href;
			const module = await import(moduleUrl);

			// Extract schemas from exported functions
			for (const functionName of functions) {
				if (module[functionName] && module[functionName].schema) {
					// We need to serialize the Zod schema
					// For now, we'll store a reference that can be imported
					schemas[moduleName][functionName] = {
						hasSchema: true,
						// We'll need to generate import statements for these
					};
				}
			}
		} catch (error) {
			console.warn(`Failed to extract schemas from ${id}: ${error.message}`);
		}
	}

	return schemas;
}

/**
 * Prepare user middleware for the generated production server.
 *
 * String entries are module paths (relative to the Vite root) whose default
 * export is the middleware; they are bundled alongside the server actions and
 * mounted via app.use. Function entries are embedded verbatim via
 * fn.toString() - but only when static analysis proves they reference nothing
 * outside their own scope and runtime globals, because a serialized function
 * loses its defining module scope. Non-embeddable functions are excluded with
 * a prominent build warning.
 *
 * @param {object} options - Plugin options (middleware, apiPrefix)
 * @param {string} rootDir - Vite project root, used to resolve string entries
 * @param {object} [warnings] - Warning sinks: `warn` for advisories, `warnDropped`
 *   for middleware that is EXCLUDED from the build (routed through Rollup's
 *   warning path so it survives the plugin's `silent` option)
 * @returns {{ imports: Array<{exportName: string, id: string}>, mountCode: string }}
 */
export function generateMiddlewareCode(
	options,
	rootDir = process.cwd(),
	{ warn = console.warn, warnDropped = warn } = {},
) {
	const entries = Array.isArray(options.middleware)
		? options.middleware
		: options.middleware
			? [options.middleware]
			: [];
	const imports = [];
	const mounts = [];

	entries.forEach((entry, index) => {
		if (typeof entry === "string") {
			const exportName = `__vsa_middleware_${index}`;
			imports.push({ exportName, id: path.resolve(rootDir, entry) });
			// Rollup only warns on a missing default export, so guard at boot with
			// a clear error instead of letting Express fail on app.use(undefined)
			const guardMessage = JSON.stringify(
				`[Vite Server Actions] middleware[${index}] module "${entry}" must default-export a function.`,
			);
			mounts.push(
				`if (typeof serverActions.${exportName} !== "function") { throw new Error(${guardMessage}); }`,
				`app.use(${JSON.stringify(options.apiPrefix)}, serverActions.${exportName});`,
			);
			return;
		}

		if (typeof entry !== "function") {
			warnDropped(
				`[Vite Server Actions] WARNING: middleware[${index}] is neither a function nor a module path string ` +
					`and was EXCLUDED from the generated production server.`,
			);
			return;
		}

		const source = entry.toString();
		const label = entry.name ? `middleware[${index}] ("${entry.name}")` : `middleware[${index}]`;
		const analysis = analyzeMiddlewareSource(source);
		if (!analysis.serializable) {
			const reason = analysis.error || `captures non-global identifier(s): ${analysis.freeVariables.join(", ")}`;
			warnDropped(
				`[Vite Server Actions] WARNING: ${label} ${reason}. ` +
					`Serialized functions lose their surrounding scope, so it was EXCLUDED from the generated production server. ` +
					`Pass a module path string (relative to the Vite root) whose default export is the middleware instead.`,
			);
			return;
		}

		if (analysis.globalReferences.length > 0) {
			// fn.toString() cannot show whether these names were imports or
			// module-scope bindings shadowing the globals in the defining module
			warn(
				`[Vite Server Actions] NOTE: ${label} references runtime global(s) ${analysis.globalReferences.join(", ")}. ` +
					`In the generated production server these resolve to Node's built-in globals - if any of them is ` +
					`actually an import or module-scope binding with the same name, the embedded copy will misbehave; ` +
					`pass a module path string (relative to the Vite root) whose default export is the middleware instead.`,
			);
		}

		mounts.push(`app.use(${JSON.stringify(options.apiPrefix)}, (${source}));`);
	});

	return { imports, mountCode: mounts.join("\n        ") };
}

/**
 * Generate validation setup code for production
 */
export async function generateValidationCode(options, serverFunctions) {
	if (!options.validation?.enabled) {
		return {
			imports: "",
			setup: "",
			middlewareFactory: "",
			validationRuntime: "",
		};
	}

	// Read the validation runtime code that will be embedded
	const validationRuntimePath = new URL("./validation-runtime.js", import.meta.url);
	const validationRuntime = `
// Embedded validation runtime
${await fs.readFile(validationRuntimePath, "utf-8")}
`;

	// Generate setup code
	const setup = `
// Setup validation
const schemaDiscovery = new SchemaDiscovery();
const validationMiddleware = createValidationMiddleware({ schemaDiscovery });

// Register schemas from server actions
${Array.from(serverFunctions.entries())
	.map(([moduleName, { functions }]) => {
		return functions
			.map(
				(fn) => `
if (serverActions.${moduleName}.${fn}.schema) {
  schemaDiscovery.registerSchema('${moduleName}', '${fn}', serverActions.${moduleName}.${fn}.schema);
}`,
			)
			.join("\n");
	})
	.join("\n")}
`;

	// Generate middleware factory
	const middlewareFactory = `
function createContextualValidationMiddleware(moduleName, functionName) {
  return (req, res, next) => {
    req.validationContext = {
      moduleName,
      functionName,
      schema: serverActions[moduleName]?.[functionName]?.schema
    };
    return validationMiddleware(req, res, next);
  };
}
`;

	return {
		imports: "",
		setup,
		middlewareFactory,
		validationRuntime,
	};
}
