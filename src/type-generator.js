/**
 * TypeScript definition generator for server actions
 * Generates accurate .d.ts files with full type information
 */

/**
 * Generate TypeScript definitions for server actions
 * @param {Map} serverFunctions - Map of module names to function info
 * @param {Object} options - Plugin options
 * @returns {string} - TypeScript definition content
 */
export function generateTypeDefinitions(serverFunctions, options = {}) {
	let typeDefinitions = `// Auto-generated TypeScript definitions for Vite Server Actions
// This file is automatically updated when server actions change

`;

	// Add imports for common types
	typeDefinitions += `type ServerActionResult<T> = Promise<T>;
type ServerActionError = {
  error: boolean;
  status: number;
  message: string;
  code?: string;
  details?: any;
  timestamp: string;
};

`;

	// TypeScript MERGES ambient module declarations that share an identical
	// wildcard pattern, so two server files with the same basename would produce
	// one merged declaration containing BOTH files' exports (typing every import
	// of either file with the union of both modules' functions and masking
	// wrong-import errors). Count each candidate wildcard pattern first so only
	// unambiguous ones are emitted.
	const wildcardCounts = new Map();
	for (const moduleInfo of serverFunctions.values()) {
		for (const pattern of wildcardPatternsForFile(moduleInfo.filePath)) {
			wildcardCounts.set(pattern, (wildcardCounts.get(pattern) || 0) + 1);
		}
	}

	// Generate types for each module
	for (const [moduleName, moduleInfo] of serverFunctions) {
		typeDefinitions += generateModuleTypes(moduleName, moduleInfo, wildcardCounts);
	}

	// Generate a global interface that combines all server actions
	typeDefinitions += generateGlobalInterface(serverFunctions);

	return typeDefinitions;
}

/**
 * Wildcard ambient-module patterns matching the import specifiers clients may
 * use for a server file. .server.ts files are conventionally imported without
 * their extension ("./x.server") or with a .js extension under NodeNext
 * resolution, so those variants are included for TypeScript files.
 * @param {string} filePath - Relative file path
 * @returns {string[]}
 */
function wildcardPatternsForFile(filePath) {
	const fileName = filePath.split("/").pop();
	const patterns = [`*/${fileName}`];
	if (fileName.endsWith(".ts")) {
		const withoutExtension = fileName.slice(0, -".ts".length);
		patterns.push(`*/${withoutExtension}`, `*/${withoutExtension}.js`);
	}
	return patterns;
}

/**
 * Generate TypeScript types for a specific module
 * @param {string} moduleName - Module name
 * @param {Object} moduleInfo - Module information with functions
 * @param {Map<string, number>} wildcardCounts - How many server files emit each wildcard pattern
 * @returns {string}
 */
function generateModuleTypes(moduleName, moduleInfo, wildcardCounts = new Map()) {
	const { functions, filePath, functionDetails = [] } = moduleInfo;

	let moduleBody = "";
	functionDetails.forEach((func) => {
		const signature = generateFunctionSignature(func);
		const jsdocComment = func.jsdoc ? formatJSDocForTS(func.jsdoc) : "";

		moduleBody += `${jsdocComment}  export ${signature};\n`;
	});

	let moduleTypes = `// Types for ${filePath}\n`;
	moduleTypes += `declare module "${filePath}" {\n`;
	moduleTypes += moduleBody;
	moduleTypes += `}\n\n`;

	// Ambient module declarations only match the exact import specifier, and
	// clients import server files with relative specifiers (e.g. "./actions/todo.server.js").
	// Relative specifiers cannot be declared ambiently (TS2436), so also emit
	// wildcard declarations that match import paths ending in the file name -
	// but only when the pattern is unambiguous: TypeScript merges ambient
	// modules with identical wildcard patterns, so a pattern shared by two
	// server files would silently union both files' exports.
	for (const pattern of wildcardPatternsForFile(filePath)) {
		if ((wildcardCounts.get(pattern) ?? 1) > 1) {
			moduleTypes += `// Skipped wildcard declaration "${pattern}": multiple server files share this basename,\n`;
			moduleTypes += `// and TypeScript would merge their ambient declarations into one module\n\n`;
			continue;
		}
		moduleTypes += `declare module "${pattern}" {\n`;
		moduleTypes += moduleBody;
		moduleTypes += `}\n\n`;
	}

	return moduleTypes;
}

/**
 * Generate function signature with proper TypeScript syntax
 * @param {Object} func - Function information
 * @returns {string}
 */
function generateFunctionSignature(func) {
	const { name, isAsync, params, returnType } = func;

	// Generate parameter list
	const paramList = params
		.map((param, index) => {
			let paramStr = param.name;

			// Add type annotation
			if (param.type) {
				paramStr += `: ${param.type}`;
			} else {
				paramStr += `: any`; // Fallback for untyped parameters
			}

			// A required parameter cannot follow an optional one (TS1016), so only
			// mark the parameter optional if no later parameter is required
			const hasLaterRequiredParam = params.slice(index + 1).some((p) => !p.isOptional && !p.isRest);

			// Handle optional parameters
			if (param.isOptional && !param.name.includes("...") && !hasLaterRequiredParam) {
				// Insert ? before the type annotation
				paramStr = paramStr.replace(":", "?:");
			}

			return paramStr;
		})
		.join(", ");

	// Determine return type
	let resultType = returnType || "any";
	if (isAsync) {
		// Check if the return type is already a Promise
		if (resultType.startsWith("Promise<")) {
			// Already wrapped in Promise, don't double-wrap
			resultType = resultType;
		} else {
			resultType = `Promise<${resultType}>`;
		}
	}

	return `function ${name}(${paramList}): ${resultType}`;
}

/**
 * Generate JavaScript function signature (without TypeScript types)
 * @param {Object} func - Function information
 * @returns {string}
 */
function generateJavaScriptSignature(func) {
	const { name, params } = func;

	// Generate parameter list without TypeScript types
	const paramList = params
		.map((param) => {
			let paramStr = param.name;

			// For JavaScript, we only need the parameter name
			// Optional and rest parameters are handled naturally

			// Destructured parameters with a default value need a safe default in the
			// generated signature so calling the proxy without that argument doesn't
			// throw while destructuring undefined
			if (param.defaultValue && !param.isRest) {
				if (paramStr.startsWith("{")) {
					paramStr += " = {}";
				} else if (paramStr.startsWith("[")) {
					paramStr += " = []";
				}
			}

			return paramStr;
		})
		.join(", ");

	return `function ${name}(${paramList})`;
}

/**
 * Generate a global interface that combines all server actions
 * @param {Map} serverFunctions - All server functions
 * @returns {string}
 */
function generateGlobalInterface(serverFunctions) {
	// Emitted as a top-level ambient namespace instead of `declare global` + `export {}`:
	// an `export {}` turns the .d.ts into a module, which silently disables all the
	// ambient `declare module` blocks above (they would never match any import)
	let globalInterface = `// Global server actions interface
declare namespace ServerActions {
`;

	for (const [moduleName, moduleInfo] of serverFunctions) {
		const { functionDetails = [] } = moduleInfo;

		globalInterface += `  namespace ${capitalizeFirst(sanitizeNamespaceName(moduleName))} {\n`;

		functionDetails.forEach((func) => {
			const signature = generateFunctionSignature(func);
			const jsdocComment = func.jsdoc ? formatJSDocForTS(func.jsdoc, "    ") : "";

			globalInterface += `${jsdocComment}    ${signature};\n`;
		});

		globalInterface += `  }\n`;
	}

	globalInterface += `}\n`;

	return globalInterface;
}

/**
 * Format JSDoc comments for TypeScript
 * @param {string} jsdoc - Raw JSDoc comment
 * @param {string} indent - Indentation prefix
 * @returns {string}
 */
function formatJSDocForTS(jsdoc, indent = "  ") {
	if (!jsdoc) return "";

	// Clean up the JSDoc comment and add proper indentation
	const lines = jsdoc.split("\n");
	const formattedLines = lines.map((line) => `${indent}${line.trim()}`);

	return formattedLines.join("\n") + "\n";
}

/**
 * Capitalize first letter of a string
 * @param {string} str - Input string
 * @returns {string}
 */
function capitalizeFirst(str) {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Sanitize a module name into a valid TypeScript namespace identifier
 * (e.g. "2fa" -> "_2fa", "my-module" -> "my_module")
 * @param {string} name - Module name
 * @returns {string}
 */
function sanitizeNamespaceName(name) {
	const sanitized = String(name).replace(/[^a-zA-Z0-9_$]/g, "_");
	return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

/**
 * Generate enhanced client proxy with better TypeScript support
 * @param {string} moduleName - Module name
 * @param {Array} functionDetails - Detailed function information
 * @param {Object} options - Plugin options
 * @param {string} filePath - Relative file path
 * @returns {string}
 */
export function generateEnhancedClientProxy(moduleName, functionDetails, options, filePath) {
	const isDev = process.env.NODE_ENV !== "production";

	let clientProxy = `\n// vite-server-actions: ${moduleName}\n`;

	// Set proxy flag at module level to prevent false security warnings
	if (isDev) {
		clientProxy += `
// Development-only marker for client proxy module
if (typeof window !== 'undefined') {
  // Mark that this is a legitimate proxy module
  window.__VITE_SERVER_ACTIONS_PROXY__ = window.__VITE_SERVER_ACTIONS_PROXY__ || {};
  window.__VITE_SERVER_ACTIONS_PROXY__['${moduleName}'] = true;
}
`;
	}

	// Generate functions with enhanced type information
	functionDetails.forEach((func) => {
		const routePath = options.routeTransform(filePath, func.name);
		// Generate JavaScript signature (without TypeScript types)
		const jsSignature = generateJavaScriptSignature(func);

		clientProxy += `
export async ${jsSignature} {
  console.log("[Vite Server Actions] 🚀 - Executing ${func.name}");
  
  ${
		isDev
			? `
  // Validate arguments in development
  if (arguments.length > 0) {
    const args = Array.from(arguments);
    
    // Check for functions
    if (args.some(arg => typeof arg === 'function')) {
      console.warn(
        '[Vite Server Actions] Warning: Functions cannot be serialized and sent to the server. ' +
        'Function arguments will be converted to null.'
      );
    }
    
    // Check argument count
    const requiredParams = ${JSON.stringify(func.params.filter((p) => !p.isOptional && !p.isRest))};
    const maxParams = ${func.params.filter((p) => !p.isRest).length};
    const hasRest = ${func.params.some((p) => p.isRest)};
    
    if (args.length < requiredParams.length) {
      console.warn(\`[Vite Server Actions] Warning: Function '${func.name}' expects at least \${requiredParams.length} arguments, got \${args.length}\`);
    }
    
    if (args.length > maxParams && !hasRest) {
      console.warn(\`[Vite Server Actions] Warning: Function '${func.name}' expects at most \${maxParams} arguments, got \${args.length}\`);
    }
    
    // Check for non-serializable types
    args.forEach((arg, index) => {
      if (arg instanceof Date) {
        console.warn(\`[Vite Server Actions] Warning: Argument \${index + 1} is a Date object. Consider passing as ISO string: \${arg.toISOString()}\`);
      } else if (arg instanceof RegExp) {
        console.warn(\`[Vite Server Actions] Warning: Argument \${index + 1} is a RegExp and cannot be serialized properly\`);
      } else if (arg && typeof arg === 'object' && arg.constructor !== Object && !Array.isArray(arg)) {
        console.warn(\`[Vite Server Actions] Warning: Argument \${index + 1} is a custom object instance that may not serialize properly\`);
      }
    });
  }
  `
			: ""
	}
  
  try {
    const response = await fetch(${JSON.stringify(`${options.apiPrefix}/${routePath}`)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.from(arguments))
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = { 
          error: true,
          status: response.status,
          message: 'Failed to parse error response',
          timestamp: new Date().toISOString()
        };
      }
      
      console.error("[Vite Server Actions] ❗ - Error in ${func.name}:", errorData);
      
      const error = new Error(errorData.message || 'Server request failed');
      Object.assign(error, errorData);
      throw error;
    }

    console.log("[Vite Server Actions] ✅ - ${func.name} executed successfully");
    
    // Handle 204 No Content responses (function returned undefined)
    if (response.status === 204) {
      return undefined;
    }
    
    const result = await response.json();
    
    ${
			isDev
				? `
`
				: ""
		}
    
    return result;
    
  } catch (error) {
    console.error("[Vite Server Actions] ❗ - Network or execution error in ${func.name}:", error.message);
    
    ${
			isDev
				? `
`
				: ""
		}
    
    // Re-throw with more context if it's not already our custom error
    if (!error.status) {
      const networkError = new Error(\`Failed to execute server action '${func.name}': \${error.message}\`);
      networkError.originalError = error;
      throw networkError;
    }
    
    throw error;
  }
}
`;
	});

	return clientProxy;
}
