import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import express from "express";
import { rollup } from "rollup";
import { minimatch } from "minimatch";
import esbuild from "esbuild";
import { createRequire } from "module";
import { createHash } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import os from "os";
import { middleware } from "./middleware.js";
import { SchemaDiscovery, createValidationMiddleware } from "./validation.js";
import { OpenAPIGenerator, setupOpenAPIEndpoints } from "./openapi.js";
import { generateValidationCode, generateMiddlewareCode } from "./build-utils.js";
import { extractExportedFunctions, isValidFunctionName } from "./ast-parser.js";
import { generateTypeDefinitions, generateEnhancedClientProxy } from "./type-generator.js";
import {
	sanitizePath,
	isValidModuleName,
	createSecureModuleName,
	createErrorResponse,
	isPlainFileName,
} from "./security.js";
import { createLogger } from "./logger.js";
import {
	enhanceFunctionNotFoundError,
	enhanceParsingError,
	enhanceValidationError,
	enhanceModuleLoadError,
	createDevelopmentWarning,
} from "./error-enhancer.js";
import {
	validateFunctionSignature,
	validateFileStructure,
	createDevelopmentFeedback,
	validateSchemaAttachment,
} from "./dev-validator.js";

// Module cache moved to plugin instance to avoid cross-instance pollution

/**
 * Convert a module id to something import() accepts. Absolute paths must be
 * imported as file:// URLs - on Windows a raw drive-letter path like
 * C:\...\x.js is parsed as a URL scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
 * @param {string} id - Module path or bare specifier
 * @returns {string}
 */
function toImportSpecifier(id) {
	// Windows absolute paths (C:\...) must be file:// URLs for ESM import().
	// POSIX paths are importable as-is - and staying plain keeps them
	// resolvable by module runners that interpose on dynamic import (Vite SSR,
	// Vitest module mocks), which cannot resolve file:// URLs.
	return path.isAbsolute(id) && process.platform === "win32" ? pathToFileURL(id).href : id;
}

const execFileAsync = promisify(execFile);
const SCHEMA_WORKER_PATH = fileURLToPath(new URL("./schema-discovery-worker.js", import.meta.url));

/**
 * Discover Zod schemas from server modules at build time without importing
 * them into the build process. A disposable child process imports each module,
 * converts every attached schema to its OpenAPI form, writes the result to a
 * temp file, and hard-exits - so top-level side effects in user modules
 * (DB connection pools, setInterval, listeners) cannot hang `vite build`.
 * @param {Map} serverFunctions - Map of module names to function info
 * @param {object} logger - Plugin logger (respects the `silent` option)
 * @returns {Promise<Record<string, object>>} - schemaDiscovery entries keyed by "module.function"
 */
async function discoverSchemasAtBuildTime(serverFunctions, logger) {
	const modules = Array.from(serverFunctions.entries()).map(([moduleName, { id }]) => ({ moduleName, id }));
	if (modules.length === 0) {
		return {};
	}

	const outputFile = path.join(os.tmpdir(), `vsa-schemas-${process.pid}-${Date.now()}.json`);
	try {
		await execFileAsync(process.execPath, [SCHEMA_WORKER_PATH, JSON.stringify({ modules }), outputFile], {
			timeout: 30_000,
		});
		const result = JSON.parse(await fs.readFile(outputFile, "utf-8"));
		for (const warning of result.warnings || []) {
			logger.warn(`[Vite Server Actions] ${warning}`);
		}
		return result.schemas || {};
	} catch (error) {
		logger.warn(
			`[Vite Server Actions] Build-time schema discovery failed, openapi.json will use generic request bodies: ${error.message}`,
		);
		return {};
	} finally {
		await fs.unlink(outputFile).catch(() => {});
	}
}

/**
 * Import a module, handling TypeScript files in development
 * @param {string} id - Module path
 * @param {any} viteServer - Vite dev server instance
 * @param {Map} cache - Module cache for this plugin instance
 * @param {Map} [versions] - File change counters used to bust Node's ESM cache
 * @returns {Promise<any>} - Imported module
 */
async function importModule(id, viteServer = null, cache = new Map(), versions = null) {
	const isTypeScript = id.endsWith(".ts");

	// In production, use regular import. TypeScript files cannot be imported
	// natively, so they fall through to the esbuild fallback below.
	if (process.env.NODE_ENV === "production" && !isTypeScript) {
		return import(toImportSpecifier(id));
	}

	// Use Vite's SSR module loader if available (preferred method for BOTH .js
	// and .ts files): Vite's module graph invalidates an edited file AND its
	// importers, so helper modules imported by a server file also serve fresh
	// code after an edit, and repeated edits don't pile stale copies into
	// Node's evict-less ESM cache.
	if (viteServer && viteServer.ssrLoadModule) {
		try {
			// Clear from cache if it exists to ensure fresh load
			if (cache.has(id)) {
				cache.delete(id);
			}

			const module = await viteServer.ssrLoadModule(id);
			cache.set(id, module);
			return module;
		} catch (error) {
			console.error(`Failed to load module ${id} via Vite SSR:`, error);
			// Fall through to the fallbacks below
		}
	}

	// Fallback for JS files without a usable dev server: Node's native import()
	// caches modules by URL with no invalidation API. The HMR watcher bumps the
	// file's version counter, and we import with a version query so edited files
	// serve fresh code without a dev-server restart. Repeated imports of the
	// same version hit Node's cache. Note: this busts only the file's own
	// top-level code, not its imported dependencies - Vite's SSR loader above
	// handles full dependency-graph invalidation.
	if (!isTypeScript) {
		const version = versions?.get(id) || 0;
		if (version === 0) {
			return import(toImportSpecifier(id));
		}
		return import(`${pathToFileURL(id).href}?v=${version}`);
	}

	// Check cache first
	if (cache.has(id)) {
		return cache.get(id);
	}

	// Fallback: Manual TypeScript compilation (when Vite server is not available)
	// Retry logic for TypeScript compilation failures
	let retryCount = 0;
	const maxRetries = 3;

	while (retryCount < maxRetries) {
		try {
			// Read and transform TypeScript file
			const tsCode = await fs.readFile(id, "utf-8");

			// Transform imports to be relative to the original file location
			const result = await esbuild.transform(tsCode, {
				loader: "ts",
				target: "node16",
				format: "esm",
				sourcefile: id,
				sourcemap: "inline",
			});

			// Create a temporary file in the same directory as the original
			// This ensures relative imports work correctly
			const dir = path.dirname(id);
			const basename = path.basename(id, ".ts");
			const tmpFile = path.join(dir, `.${basename}.tmp.mjs`);

			// Write compiled JavaScript
			await fs.writeFile(tmpFile, result.code, "utf-8");

			try {
				// Add a small delay to ensure file is written
				await new Promise((resolve) => setTimeout(resolve, 50));

				// Import the compiled module with cache busting (as a file:// URL so
				// Windows drive-letter paths don't parse as URL schemes)
				const module = await import(`${pathToFileURL(tmpFile).href}?t=${Date.now()}`);

				// Cache the module
				cache.set(id, module);

				// Clean up temp file immediately
				await fs.unlink(tmpFile).catch(() => {});

				return module;
			} catch (importError) {
				// Clean up on error
				await fs.unlink(tmpFile).catch(() => {});
				throw importError;
			}
		} catch (error) {
			retryCount++;
			if (retryCount >= maxRetries) {
				console.error(`Failed to import TypeScript module ${id} after ${maxRetries} attempts:`, error);
				throw error;
			}
			// Wait before retry
			await new Promise((resolve) => setTimeout(resolve, 100 * retryCount));
		}
	}
}

// Utility functions for path transformation
export const pathUtils = {
	/**
	 * Default path normalizer - creates underscore-separated module names (preserves original behavior)
	 * @param {string} filePath - Relative file path (e.g., "src/actions/todo.server.js")
	 * @returns {string} - Normalized module name (e.g., "src_actions_todo")
	 */
	createModuleName: (filePath) => {
		return filePath
			.replace(/\//g, "_") // Replace slashes with underscores
			.replace(/\./g, "_") // Replace dots with underscores
			.replace(/_server_(js|ts)$/, ""); // Remove .server.js or .server.ts extension
	},

	/**
	 * Clean route transformer - creates hierarchical paths: /api/actions/todo/create
	 * @param {string} filePath - Relative file path (e.g., "src/actions/todo.server.js")
	 * @param {string} functionName - Function name (e.g., "create")
	 * @returns {string} - Clean route (e.g., "actions/todo/create")
	 */
	createCleanRoute: (filePath, functionName) => {
		const cleanPath = filePath
			.replace(/^src\//, "") // Remove src/ prefix
			.replace(/\.server\.(js|ts)$/, ""); // Remove .server.js or .server.ts suffix
		return `${cleanPath}/${functionName}`;
	},

	/**
	 * Legacy route transformer - creates underscore-separated paths: /api/src_actions_todo/create
	 * @param {string} filePath - Relative file path (e.g., "src/actions/todo.server.js")
	 * @param {string} functionName - Function name (e.g., "create")
	 * @returns {string} - Legacy route (e.g., "src_actions_todo/create")
	 */
	createLegacyRoute: (filePath, functionName) => {
		const legacyPath = filePath
			.replace(/\//g, "_") // Replace slashes with underscores
			.replace(/\.server\.(js|ts)$/, ""); // Remove .server.js or .server.ts extension
		return `${legacyPath}/${functionName}`;
	},

	/**
	 * Minimal route transformer - keeps original structure: /api/actions/todo.server/create
	 * @param {string} filePath - Relative file path (e.g., "actions/todo.server.js")
	 * @param {string} functionName - Function name (e.g., "create")
	 * @returns {string} - Minimal route (e.g., "actions/todo.server/create")
	 */
	createMinimalRoute: (filePath, functionName) => {
		const minimalPath = filePath.replace(/\.(js|ts)$/, ""); // Just remove .js or .ts
		return `${minimalPath}/${functionName}`;
	},
};

const DEFAULT_OPTIONS = {
	apiPrefix: "/api",
	include: ["**/*.server.js", "**/*.server.ts"],
	exclude: [],
	middleware: [],
	serverFileName: "server.js",
	silent: false,
	moduleNameTransform: pathUtils.createModuleName,
	routeTransform: (filePath, functionName) => {
		// Default to clean hierarchical paths: /api/actions/todo/create
		const cleanPath = filePath
			.replace(/^src\//, "") // Remove src/ prefix
			.replace(/\.server\.(js|ts)$/, ""); // Remove .server.js or .server.ts suffix
		return `${cleanPath}/${functionName}`;
	},
	validation: {
		enabled: false,
		adapter: "zod",
	},
};

function shouldProcessFile(filePath, options, rootDir = process.cwd()) {
	// Normalize the options to arrays
	const includePatterns = Array.isArray(options.include) ? options.include : [options.include];
	const excludePatterns = Array.isArray(options.exclude) ? options.exclude : [options.exclude];

	// Vite supplies absolute file paths, but users naturally write project-root-relative
	// patterns like "src/internal/**". Vite's project root can also differ from the
	// process cwd (e.g. `vite packages/app` run from a monorepo root), so match
	// patterns against the raw path and against paths relative to both the Vite
	// root and the cwd.
	const candidates = [filePath];
	if (path.isAbsolute(filePath)) {
		for (const base of new Set([rootDir, process.cwd()])) {
			const relativePath = path.relative(base, filePath).replace(/\\/g, "/");
			if (relativePath && relativePath !== filePath && !candidates.includes(relativePath)) {
				candidates.push(relativePath);
			}
		}
	}
	const matchesPattern = (pattern) => candidates.some((candidate) => minimatch(candidate, pattern));

	// Check if file matches any include pattern
	const isIncluded = includePatterns.some(matchesPattern);

	// Check if file matches any exclude pattern
	const isExcluded = excludePatterns.length > 0 && excludePatterns.some(matchesPattern);

	return isIncluded && !isExcluded;
}

export default function serverActions(userOptions = {}) {
	const options = {
		...DEFAULT_OPTIONS,
		...userOptions,
		validation: { ...DEFAULT_OPTIONS.validation, ...userOptions.validation },
		openAPI: {
			enabled: false,
			info: {
				title: "Server Actions API",
				version: "1.0.0",
				description: "Auto-generated API documentation for Vite Server Actions",
			},
			docsPath: "/api/docs",
			specPath: "/api/openapi.json",
			outputFile: "openapi.json",
			swaggerUI: true,
			...userOptions.openAPI,
		},
	};

	// Reject bad output filenames at config time - emitted artifacts must be
	// plain filenames landing directly in the output directory
	for (const [optionName, value] of [
		["serverFileName", options.serverFileName],
		["openAPI.outputFile", options.openAPI.outputFile],
	]) {
		if (!isPlainFileName(value)) {
			throw new Error(
				`[Vite Server Actions] Invalid ${optionName}: ${JSON.stringify(value)}. ` +
					`Expected a plain filename without path separators (e.g. "server.js").`,
			);
		}
	}

	const logger = createLogger(options.silent);
	const serverFunctions = new Map();
	const schemaDiscovery = new SchemaDiscovery(); // Per-instance to avoid cross-instance pollution
	const tsModuleCache = new Map(); // Per-instance cache for TypeScript modules
	const moduleVersions = new Map(); // Per-file change counters for busting Node's ESM cache
	const moduleNameOwners = new Map(); // Module name -> file id; the first claimant owns the name for the whole session
	let registeredEndpoints = new Set(); // Endpoints already registered on the dev Express app
	let app;
	let openAPIGenerator;
	let validationMiddleware = null;
	let viteConfig = null;
	let viteDevServer = null;

	// Initialize OpenAPI generator if enabled
	if (options.openAPI.enabled) {
		openAPIGenerator = new OpenAPIGenerator({
			info: options.openAPI.info,
		});
	}

	// Initialize validation middleware if enabled
	if (options.validation.enabled) {
		validationMiddleware = createValidationMiddleware({
			schemaDiscovery,
		});
	}

	return {
		name: "vite-plugin-server-actions",

		configResolved(config) {
			// Store Vite config for later use
			viteConfig = config;
		},

		configureServer(server) {
			viteDevServer = server;
			app = express();
			app.use(express.json());
			registeredEndpoints = new Set();

			// User middleware mounts on the API prefix itself (not per action route) so
			// EVERY method - including CORS OPTIONS preflights - passes through it
			// before the action routes.
			const userMiddleware = Array.isArray(options.middleware)
				? options.middleware
				: options.middleware
					? [options.middleware]
					: [];
			for (const entry of userMiddleware) {
				if (typeof entry === "string") {
					const resolvedId = path.resolve(viteConfig?.root || process.cwd(), entry);
					// Resolved per request through importModule (Vite's SSR loader when
					// available) so edits to the middleware module hot-reload like server
					// action modules do
					app.use(options.apiPrefix, (req, res, next) => {
						importModule(resolvedId, viteDevServer, tsModuleCache, moduleVersions)
							.then((module) => {
								if (typeof module.default !== "function") {
									throw new Error(`Middleware module "${entry}" must default-export a middleware function`);
								}
								return module.default(req, res, next);
							})
							.catch(next);
					});
				} else if (typeof entry === "function") {
					app.use(options.apiPrefix, entry);
				} else if (entry != null) {
					logger.warn(`[Vite Server Actions] Ignoring middleware entry that is neither a function nor a module path`);
				}
			}

			// Clean up on HMR
			if (server.watcher) {
				server.watcher.on("change", (file) => {
					// If a server file changed, remove it from the map
					if (shouldProcessFile(file, options, viteConfig?.root)) {
						// Bump the version counter so the next import loads fresh code
						moduleVersions.set(file, (moduleVersions.get(file) || 0) + 1);

						// Clear cached module for this file
						tsModuleCache.delete(file);

						for (const [moduleName, moduleInfo] of serverFunctions.entries()) {
							if (moduleInfo.id === file) {
								serverFunctions.delete(moduleName);
								// Clear only this module's schemas so other modules keep validating
								for (const key of Array.from(schemaDiscovery.schemas.keys())) {
									if (key.startsWith(`${moduleName}.`)) {
										schemaDiscovery.schemas.delete(key);
									}
								}
								logger.log(`[HMR] Cleaned up server module: ${moduleName}`);
							}
						}
					}
				});
			}

			// Setup dynamic OpenAPI endpoints in development
			if (process.env.NODE_ENV !== "production" && options.openAPI.enabled && openAPIGenerator) {
				// OpenAPI spec endpoint - generates spec dynamically from current serverFunctions
				app.get(options.openAPI.specPath, (req, res) => {
					// Get the actual port from the request
					const port = req.get("host")?.split(":")[1] || viteConfig.server?.port || 5173;
					const openAPISpec = openAPIGenerator.generateSpec(serverFunctions, schemaDiscovery, {
						apiPrefix: options.apiPrefix,
						routeTransform: options.routeTransform,
						port,
					});

					// Add a note if no functions are found
					if (serverFunctions.size === 0) {
						openAPISpec.info.description =
							(openAPISpec.info.description || "") +
							"\n\nNote: No server functions found yet. Try refreshing after accessing your app to trigger module loading.";
					}

					res.json(openAPISpec);
				});

				// Swagger UI setup
				if (options.openAPI.swaggerUI) {
					try {
						// Dynamic import swagger-ui-express
						import("swagger-ui-express")
							.then(({ default: swaggerUi }) => {
								const docsPath = options.openAPI.docsPath;

								app.use(
									docsPath,
									swaggerUi.serve,
									swaggerUi.setup(null, {
										swaggerOptions: {
											url: options.openAPI.specPath,
										},
									}),
								);

								// Wait for server to start and get the actual port, then log URLs
								server.httpServer?.on("listening", () => {
									const address = server.httpServer.address();
									const port = address?.port || viteConfig.server?.port || 5173;
									// Always use localhost for consistent display
									const host = "localhost";

									// Delay to appear after Vite's startup messages
									global.setTimeout(() => {
										if (viteConfig?.logger) {
											logger.log(`  \x1b[2;32m➜\x1b[0m  API Docs: http://${host}:${port}${docsPath}`);
											logger.log(`  \x1b[2;32m➜\x1b[0m  OpenAPI:  http://${host}:${port}${options.openAPI.specPath}`);
										} else {
											logger.log(`📖 API Documentation: http://${host}:${port}${docsPath}`);
											logger.log(`📄 OpenAPI Spec: http://${host}:${port}${options.openAPI.specPath}`);
										}
									}, 50); // Small delay to appear after Vite's ready message
								});
							})
							.catch((error) => {
								logger.warn("Swagger UI setup failed:", error.message);
							});
					} catch (error) {
						logger.warn("Swagger UI setup failed:", error.message);
					}
				}
			}

			server.middlewares.use(app);

			// Show development feedback after server is ready
			if (process.env.NODE_ENV === "development") {
				server.httpServer?.on("listening", () => {
					// Delay to appear after Vite's startup messages
					global.setTimeout(() => {
						if (serverFunctions.size > 0) {
							logger.log(createDevelopmentFeedback(serverFunctions));
						}
					}, 100);
				});
			}
		},

		async resolveId(source, importer, resolveOptions) {
			// Skip SSR resolution
			if (resolveOptions?.ssr) {
				return null;
			}

			// Handle server file imports from client code
			if (importer && shouldProcessFile(source, options, viteConfig?.root)) {
				const resolvedPath = path.resolve(path.dirname(importer), source);
				return resolvedPath;
			}

			// Handle TypeScript imports from server files
			if (importer && shouldProcessFile(importer, options, viteConfig?.root)) {
				// Check if this is a relative import
				if (source.startsWith(".") || source.startsWith("/")) {
					// Try to resolve TypeScript file
					const basePath = path.resolve(path.dirname(importer), source);
					const possiblePaths = [
						basePath,
						`${basePath}.ts`,
						`${basePath}.tsx`,
						path.join(basePath, "index.ts"),
						path.join(basePath, "index.tsx"),
					];

					for (const possiblePath of possiblePaths) {
						try {
							const stats = await fs.stat(possiblePath);
							// Only return if it's a file, not a directory
							if (stats.isFile()) {
								return possiblePath;
							}
						} catch {
							// File doesn't exist, try next
						}
					}
				}
			}

			return null;
		},

		async load(id, loadOptions) {
			if (shouldProcessFile(id, options, viteConfig?.root)) {
				// Check if this is an SSR request - if so, let Vite handle the actual module
				if (loadOptions?.ssr) {
					return null; // Let Vite handle SSR loading of the actual module
				}
				try {
					const code = await fs.readFile(id, "utf-8");

					// Sanitize the file path for security: contain to the Vite project root,
					// plus any directories the user explicitly lets Vite serve from
					// (server.fs.allow covers monorepo/workspace files outside the root)
					const rootDir = viteConfig?.root || process.cwd();
					const allowedDirs = (viteConfig?.server?.fs?.allow || []).filter((dir) => typeof dir === "string");
					if (viteConfig?.server?.fs?.strict === false) {
						// fs.strict=false disables Vite's own serving restrictions - mirror that
						// by allowing the whole filesystem root (suspicious-segment checks still apply)
						allowedDirs.push(path.parse(path.resolve(id)).root);
					}
					const sanitizedPath = sanitizePath(id, rootDir, allowedDirs);
					if (!sanitizedPath) {
						throw new Error(`Invalid file path detected: ${id}`);
					}

					// Relativize against the project root; files outside the root (permitted
					// via server.fs.allow) relativize against the innermost allowed directory
					// containing them, so module names and routes never contain ".." segments
					let relativePath = path.relative(rootDir, sanitizedPath);
					if (relativePath.startsWith("..")) {
						const containingDir = allowedDirs
							.map((dir) => path.resolve(dir))
							.filter((dir) => sanitizedPath === dir || sanitizedPath.startsWith(dir + path.sep))
							.sort((a, b) => b.length - a.length)[0];
						if (containingDir) {
							relativePath = path.relative(containingDir, sanitizedPath);
						}
					}

					// Normalize path separators
					relativePath = relativePath.replace(/\\/g, "/").replace(/^\//, "");

					// Generate module name for internal use (must be valid identifier)
					let moduleName = createSecureModuleName(options.moduleNameTransform(relativePath));

					// Distinct files can normalize to the same module name (e.g. my-file.server.js
					// and my_file.server.js both become my_file). The FIRST file to claim a name
					// owns it for the lifetime of the plugin instance: dev endpoints capture their
					// module name permanently at registration, so ownership must not depend on
					// which entries currently sit in serverFunctions (the HMR watcher deletes and
					// re-adds them in arbitrary order). Every other file gets a deterministic hash
					// suffix derived from its relative path so it doesn't silently overwrite the
					// owner in serverFunctions (and the production bundle).
					const ownerId = moduleNameOwners.get(moduleName);
					if (ownerId === undefined) {
						moduleNameOwners.set(moduleName, id);
					} else if (ownerId !== id) {
						const suffix = createHash("sha256").update(relativePath).digest("hex").slice(0, 6);
						const disambiguatedName = `${moduleName}_${suffix}`;
						logger.warn(
							`[Vite Server Actions] Module name collision: "${relativePath}" and "${ownerId}" ` +
								`both normalize to "${moduleName}". Using "${disambiguatedName}" for "${relativePath}". ` +
								`Consider renaming the files or providing a custom moduleNameTransform.`,
						);
						moduleName = disambiguatedName;
						moduleNameOwners.set(moduleName, id);
					}

					// Validate module name
					if (!isValidModuleName(moduleName)) {
						throw new Error(`Invalid server module name: ${moduleName}`);
					}

					// Use AST parser to extract exported functions with detailed information
					const exportedFunctions = extractExportedFunctions(code, id);
					const functions = [];
					const functionDetails = [];

					for (const fn of exportedFunctions) {
						// Skip default exports for now (could be supported in future)
						if (fn.isDefault) {
							logger.warn(
								createDevelopmentWarning("Default Export Skipped", `Default exports are not currently supported`, {
									filePath: relativePath,
									suggestion: "Use named exports instead: export async function myFunction() {}",
								}),
							);
							continue;
						}

						// Validate function name
						if (!isValidFunctionName(fn.name)) {
							logger.warn(
								createDevelopmentWarning(
									"Invalid Function Name",
									`Function name '${fn.name}' is not a valid JavaScript identifier`,
									{
										filePath: relativePath,
										suggestion:
											"Function names must start with a letter, $, or _ and contain only letters, numbers, $, and _",
									},
								),
							);
							continue;
						}

						// Warn about non-async functions
						if (!fn.isAsync) {
							logger.warn(
								createDevelopmentWarning(
									"Non-Async Function",
									`Function '${fn.name}' is not async. Server actions should typically be async`,
									{
										filePath: relativePath,
										suggestion: "Consider changing to: export async function " + fn.name + "() {}",
									},
								),
							);
						}

						functions.push(fn.name);
						functionDetails.push(fn);
					}

					// Check for duplicate function names within the same module
					const uniqueFunctions = [...new Set(functions)];
					if (uniqueFunctions.length !== functions.length) {
						logger.warn(`Duplicate function names detected in ${id}`);
					}

					// Store both simple function names and detailed information
					serverFunctions.set(moduleName, {
						functions: uniqueFunctions,
						functionDetails,
						id,
						filePath: relativePath,
					});

					// Development-time validation and feedback
					if (process.env.NODE_ENV === "development") {
						// Validate file structure
						const fileWarnings = validateFileStructure(functionDetails, relativePath);
						fileWarnings.forEach((warning) => logger.warn(warning));

						// Validate individual function signatures
						functionDetails.forEach((func) => {
							const funcWarnings = validateFunctionSignature(func, relativePath);
							funcWarnings.forEach((warning) => logger.warn(warning));
						});
					}

					// Discover schemas from module if validation is enabled (development only)
					// Skip TypeScript files to avoid SSR loading issues
					if (options.validation.enabled && process.env.NODE_ENV !== "production" && !id.endsWith(".ts")) {
						try {
							const module = await importModule(id, viteDevServer, tsModuleCache, moduleVersions);
							schemaDiscovery.discoverFromModule(module, moduleName);

							// Validate schema attachment in development
							if (process.env.NODE_ENV === "development") {
								const schemaWarnings = validateSchemaAttachment(module, uniqueFunctions, relativePath);
								schemaWarnings.forEach((warning) => logger.warn(warning));
							}
						} catch (error) {
							const enhancedError = enhanceModuleLoadError(id, error);
							logger.warn(enhancedError.message);

							if (process.env.NODE_ENV === "development" && enhancedError.suggestions) {
								enhancedError.suggestions.forEach((suggestion) => {
									logger.info(`  💡 ${suggestion}`);
								});
							}
						}
					} else if (options.validation.enabled && id.endsWith(".ts")) {
						// For TypeScript files, defer schema discovery to request time
						logger.log(`[Vite Server Actions] Deferring schema discovery for TypeScript file: ${relativePath}`);
					}

					// Setup routes in development mode only
					if (process.env.NODE_ENV !== "production" && app) {
						// User middleware is mounted on the apiPrefix in configureServer (so it
						// also sees OPTIONS preflights); only validation runs per-route here
						const middlewares = [];
						if (validationMiddleware) {
							middlewares.push(validationMiddleware);
						}

						uniqueFunctions.forEach((functionName) => {
							const routePath = options.routeTransform(relativePath, functionName);
							const endpoint = `${options.apiPrefix}/${routePath}`;

							// load() re-runs on every HMR invalidation, but Express routes cannot be
							// removed. Skip endpoints that are already registered so the router stack
							// doesn't grow with duplicate handlers on every edit.
							if (registeredEndpoints.has(endpoint)) {
								return;
							}
							registeredEndpoints.add(endpoint);

							// Create a context-aware validation middleware if validation is enabled
							const contextMiddlewares = [...middlewares];
							if (validationMiddleware && options.validation.enabled) {
								// Replace the generic validation middleware with a context-aware one
								const lastIdx = contextMiddlewares.length - 1;
								if (contextMiddlewares[lastIdx] === validationMiddleware) {
									contextMiddlewares[lastIdx] = async (req, res, next) => {
										// Schema discovery for TypeScript files is deferred from load()
										// to request time; run it BEFORE validation so the first request
										// is validated too (not just subsequent ones)
										if (id.endsWith(".ts") && !schemaDiscovery.hasSchema(moduleName, functionName)) {
											try {
												const module = await importModule(id, viteDevServer, tsModuleCache, moduleVersions);
												schemaDiscovery.discoverFromModule(module, moduleName);
											} catch (err) {
												logger.warn(`Failed to discover schemas for ${moduleName}:`, err.message);
											}
										}

										// Add context to request for validation
										// Get the schema directly from schemaDiscovery
										const schema = schemaDiscovery.getSchema(moduleName, functionName);
										req.validationContext = {
											moduleName, // For error messages
											functionName, // For error messages
											schema, // Direct schema access
										};
										return validationMiddleware(req, res, next);
									};
								}
							}

							// Apply middleware before the handler
							app.post(endpoint, ...contextMiddlewares, async (req, res) => {
								try {
									const module = await importModule(id, viteDevServer, tsModuleCache, moduleVersions);

									// Lazy schema discovery for TypeScript files
									if (
										options.validation.enabled &&
										id.endsWith(".ts") &&
										!schemaDiscovery.hasSchema(moduleName, functionName)
									) {
										try {
											schemaDiscovery.discoverFromModule(module, moduleName);
										} catch (err) {
											logger.warn(`Failed to discover schemas for ${moduleName}:`, err.message);
										}
									}

									// Check if function exists in module
									if (typeof module[functionName] !== "function") {
										// Get available functions for better error message
										const availableFunctions = Object.keys(module).filter((key) => typeof module[key] === "function");

										const enhancedError = enhanceFunctionNotFoundError(functionName, moduleName, availableFunctions);

										// Mark the error so the catch block can classify it reliably
										// (user-thrown errors that merely contain "not found" must NOT become 404s)
										const notFoundError = new Error(enhancedError.message);
										notFoundError.code = "FUNCTION_NOT_FOUND";
										notFoundError.availableFunctions = availableFunctions;
										throw notFoundError;
									}

									// Validate request body is array for function arguments
									if (!Array.isArray(req.body)) {
										const bodyError = new Error("Request body must be an array of function arguments");
										bodyError.code = "INVALID_REQUEST_BODY";
										throw bodyError;
									}

									const result = await module[functionName](...req.body);
									if (result === undefined) {
										res.status(204).end();
									} else {
										res.json(result);
									}
								} catch (error) {
									console.error(`Error in ${functionName}: ${error.message}`);

									if (error.code === "FUNCTION_NOT_FOUND") {
										const availableFunctions = error.availableFunctions || [];

										res.status(404).json(
											createErrorResponse(404, "Function not found", "FUNCTION_NOT_FOUND", {
												functionName,
												moduleName,
												availableFunctions: availableFunctions.length > 0 ? availableFunctions : undefined,
												suggestion: `Try one of: ${availableFunctions.join(", ") || "none available"}`,
											}),
										);
									} else if (error.code === "INVALID_REQUEST_BODY") {
										res.status(400).json(
											createErrorResponse(400, error.message, "INVALID_REQUEST_BODY", {
												suggestion: "Send an array of arguments: [arg1, arg2, ...]",
											}),
										);
									} else {
										// Same contract as the generated production server: user-thrown
										// errors carry their HTTP status via err.status or err.statusCode
										const userStatus = [error.status, error.statusCode].find(
											(value) => Number.isInteger(value) && value >= 400 && value <= 599,
										);
										if (userStatus && userStatus !== 500) {
											res
												.status(userStatus)
												.json(
													createErrorResponse(
														userStatus,
														error.message,
														error.code || "SERVER_ACTION_ERROR",
														process.env.NODE_ENV !== "production" ? { stack: error.stack } : null,
													),
												);
										} else {
											res.status(500).json(
												createErrorResponse(
													500,
													"Internal server error",
													"INTERNAL_ERROR",
													process.env.NODE_ENV !== "production"
														? {
																message: error.message,
																stack: error.stack,
																suggestion: "Check server logs for more details",
															}
														: { suggestion: "Contact support if this persists" },
												),
											);
										}
									}
								}
							});
						});
					}
					// OpenAPI endpoints will be set up during configureServer after all modules are loaded

					// Use enhanced client proxy generator if we have detailed function information
					if (functionDetails.length > 0) {
						return generateEnhancedClientProxy(moduleName, functionDetails, options, relativePath);
					} else {
						// Fallback to basic proxy for backwards compatibility
						return generateClientProxy(moduleName, uniqueFunctions, options, relativePath);
					}
				} catch (error) {
					const enhancedError = enhanceParsingError(id, error);
					console.error(enhancedError.message);

					// Provide helpful suggestions in development
					if (process.env.NODE_ENV === "development" && enhancedError.suggestions.length > 0) {
						logger.info("[Vite Server Actions] 💡 Suggestions:");
						enhancedError.suggestions.forEach((suggestion) => {
							logger.info(`  • ${suggestion}`);
						});
					}

					// Return error comment with context instead of failing the build
					return `// Failed to load server actions from ${id}
// Error: ${error.message}
// ${enhancedError.suggestions.length > 0 ? "Suggestions: " + enhancedError.suggestions.join(", ") : ""}`;
				}
			}
		},

		transform(code, id) {
			// This hook is not needed since we handle the transformation in the load hook
			// The warning was incorrectly flagging legitimate imports that are being transformed
			return null;
		},

		async generateBundle(outputOptions, bundle) {
			// Prepare user middleware for the production server: string entries are
			// bundled into actions.js (default exports), embeddable functions are
			// serialized, closure-capturing functions warn and are excluded
			const middlewareCodegen = generateMiddlewareCode(options, viteConfig?.root || process.cwd(), {
				warn: logger.warn,
				// Dropping middleware from the build must stay visible even with
				// `silent: true`, so it routes through Rollup's warning path
				warnDropped: typeof this.warn === "function" ? (message) => this.warn(message) : logger.warn,
			});

			// Create a virtual entry point for all server functions
			const virtualEntryId = "virtual:server-actions-entry";
			let virtualModuleContent = "";
			for (const [moduleName, { id }] of serverFunctions) {
				// JSON.stringify the specifier so quotes/backslashes in file paths
				// (e.g. /Users/O'Brien/... or Windows paths) don't break the generated code
				virtualModuleContent += `import * as ${moduleName} from ${JSON.stringify(id)};\n`;
			}
			for (const { exportName, id } of middlewareCodegen.imports) {
				virtualModuleContent += `import ${exportName} from ${JSON.stringify(id)};\n`;
			}
			const virtualExports = [...serverFunctions.keys(), ...middlewareCodegen.imports.map((m) => m.exportName)];
			virtualModuleContent += `export { ${virtualExports.join(", ")} };`;

			// Use Rollup to bundle the virtual module
			const build = await rollup({
				input: virtualEntryId,
				plugins: [
					{
						name: "virtual",
						resolveId(id) {
							if (id === virtualEntryId) {
								return id;
							}
						},
						load(id) {
							if (id === virtualEntryId) {
								return virtualModuleContent;
							}
						},
					},
					{
						name: "typescript-transform",
						async resolveId(source, importer) {
							// TypeScript convention allows extensionless relative imports
							// (import { db } from "./database"), which work in dev via
							// Vite's ssrLoadModule. Mirror the outer resolveId's extension
							// resolution so the production bundle resolves them too.
							if (!importer || !source.startsWith(".")) {
								return null;
							}

							const basePath = path.resolve(path.dirname(importer), source);
							const possiblePaths = [
								basePath,
								`${basePath}.ts`,
								`${basePath}.tsx`,
								path.join(basePath, "index.ts"),
								path.join(basePath, "index.tsx"),
							];

							for (const possiblePath of possiblePaths) {
								try {
									const stats = await fs.stat(possiblePath);
									// Only return if it's a file, not a directory
									if (stats.isFile()) {
										return possiblePath;
									}
								} catch {
									// File doesn't exist, try next
								}
							}

							return null;
						},
						async load(id) {
							// Handle TypeScript files
							if (id.endsWith(".ts")) {
								const code = await fs.readFile(id, "utf-8");
								const result = await esbuild.transform(code, {
									loader: "ts",
									target: "node16",
									format: "esm",
								});
								return result.code;
							}
							return null;
						},
					},
					{
						name: "external-modules",
						resolveId(source) {
							if (
								!shouldProcessFile(source, options, viteConfig?.root) &&
								!source.startsWith(".") &&
								!path.isAbsolute(source)
							) {
								return { id: source, external: true };
							}
						},
					},
				],
			});

			const { output } = await build.generate({ format: "es" });

			if (output.length === 0) {
				throw new Error("Failed to bundle server functions");
			}

			const bundledCode = output[0].code;

			// Emit the bundled server functions into a private subdirectory
			// so they never share the static-serve root with client assets.
			this.emitFile({
				type: "asset",
				fileName: ".vsa/actions.js",
				source: bundledCode,
			});

			// Generate and emit TypeScript definitions
			const typeDefinitions = generateTypeDefinitions(serverFunctions, options);
			this.emitFile({
				type: "asset",
				fileName: ".vsa/actions.d.ts",
				source: typeDefinitions,
			});

			// Generate OpenAPI spec if enabled
			let openAPISpec = null;
			if (options.openAPI.enabled) {
				// Vite sets NODE_ENV=production before load() runs during `vite build`,
				// which skips the dev-time schema discovery. Discover schemas here so the
				// emitted openapi.json documents the real request shapes instead of the
				// generic fallback body. The discovery runs in a disposable child process:
				// importing user modules in-process would execute their top-level side
				// effects (DB pools, timers, listeners) inside the build process and could
				// keep `vite build` from ever exiting.
				const discovered = await discoverSchemasAtBuildTime(serverFunctions, logger);
				for (const [key, schema] of Object.entries(discovered)) {
					schemaDiscovery.schemas.set(key, schema);
				}

				// Use PORT env var for production builds, defaulting to 3000
				const port = process.env.PORT || 3000;
				openAPISpec = openAPIGenerator.generateSpec(serverFunctions, schemaDiscovery, {
					apiPrefix: options.apiPrefix,
					routeTransform: options.routeTransform,
					port,
				});

				// Emit OpenAPI spec inside the private subdirectory
				this.emitFile({
					type: "asset",
					fileName: `.vsa/${options.openAPI.outputFile}`,
					source: JSON.stringify(openAPISpec, null, 2),
				});
			}

			// Generate validation code if enabled
			const validationCode = await generateValidationCode(options, serverFunctions);

			// Generate server.js
			const serverCode = `
        import express from 'express';
        import * as serverActions from './.vsa/actions.js';
        ${options.openAPI.enabled && options.openAPI.swaggerUI ? "import swaggerUi from 'swagger-ui-express';" : ""}
        import { fileURLToPath } from 'url';
        import * as pathModule from 'path';
        ${options.openAPI.enabled ? "import { readFileSync } from 'fs';" : ""}

        // Resolve sibling files relative to this script, not the process cwd,
        // so the server works when started from any directory (pm2, systemd, ...)
        const __dirname = pathModule.dirname(fileURLToPath(import.meta.url));
        ${options.openAPI.enabled ? `const openAPISpec = JSON.parse(readFileSync(pathModule.join(__dirname, '.vsa', ${JSON.stringify(options.openAPI.outputFile)}), 'utf-8'));` : ""}
        ${validationCode.imports}
        ${validationCode.validationRuntime}

        const app = express();
        ${validationCode.setup}
        ${validationCode.middlewareFactory}

        // Middleware
        // --------------------------------------------------
        app.use(express.json());
        ${middlewareCodegen.mountCode}

				// Server artifacts live in a private .vsa/ subdirectory that is never
				// exposed by express.static. A single middleware decodes the URL, resolves
				// it against the static root (collapsing dot-segments exactly as
				// express.static would), and 404s any path that reaches the private
				// directory or matches the server entry-point filename. No denylist,
				// no per-file path canonicalization — the architecture separates client
				// and server code at the filesystem level.
				// ------------------------------------------------------------------
				const serverEntryBasename = ${JSON.stringify(options.serverFileName)};
				const vsaDir = pathModule.join(__dirname, '.vsa');
				app.use((req, res, next) => {
					if (req.method !== 'GET' && req.method !== 'HEAD') {
						return next();
					}
					let decoded;
					try {
						decoded = decodeURIComponent(req.path);
					} catch {
						return next();
					}
					const target = pathModule.resolve(__dirname, '.' + decoded);
					if (
						target.startsWith(vsaDir + pathModule.sep) ||
						target === vsaDir
					) {
						return res.status(404).end();
					}
					if (
						pathModule.basename(target).toLowerCase() ===
						serverEntryBasename.toLowerCase()
					) {
						return res.status(404).end();
					}
					next();
				});
        app.use(express.static(__dirname));

				// Server functions
				// --------------------------------------------------
        ${Array.from(serverFunctions.entries())
					.flatMap(([moduleName, { functions, filePath }]) =>
						functions
							.map((functionName) => {
								const routePath = options.routeTransform(filePath, functionName);
								const middlewareCall = options.validation?.enabled
									? `createContextualValidationMiddleware('${moduleName}', '${functionName}'), `
									: "";
								return `
            app.post(${JSON.stringify(`${options.apiPrefix}/${routePath}`)}, ${middlewareCall}async (req, res) => {
              try {
                if (!Array.isArray(req.body)) {
                  return res.status(400).json({
                    error: true,
                    status: 400,
                    message: 'Request body must be an array of function arguments',
                    code: 'INVALID_REQUEST_BODY',
                    timestamp: new Date().toISOString(),
                    details: { suggestion: 'Send an array of arguments: [arg1, arg2, ...]' }
                  });
                }
                const result = await serverActions.${moduleName}.${functionName}(...req.body);
                if (result === undefined) {
                  res.status(204).end();
                } else {
                  res.json(result);
                }
              } catch (error) {
                console.error(\`Error in ${functionName}: \${error.message}\`);
                const status = [error.status, error.statusCode].find(
                  (value) => Number.isInteger(value) && value >= 400 && value <= 599
                ) || 500;
                res.status(status).json({
                  error: true,
                  status,
                  message: status === 500 ? 'Internal server error' : error.message,
                  code: error.code || 'SERVER_ACTION_ERROR',
                  timestamp: new Date().toISOString(),
                  ...(process.env.NODE_ENV === 'development' ? { details: { message: error.message, stack: error.stack } } : {})
                });
              }
            });
          `;
							})
							.join("\n")
							.trim(),
					)
					.join("\n")
					.trim()}

				${
					options.openAPI.enabled
						? `
				// OpenAPI endpoints
				// --------------------------------------------------
				app.get('${options.openAPI.specPath}', (req, res) => {
					res.json(openAPISpec);
				});
				
				${
					options.openAPI.swaggerUI
						? `
				// Swagger UI
				app.use('${options.openAPI.docsPath}', swaggerUi.serve, swaggerUi.setup(openAPISpec));
				`
						: ""
				}
				`
						: ""
				}

				// Start server
				// --------------------------------------------------
        const port = process.env.PORT || 3000;
        const server = app.listen(port, () => {
					console.log(\`🚀 Server listening: http://localhost:\${port}\`);
					${
						options.openAPI.enabled
							? `
					console.log(\`📖 API Documentation: http://localhost:\${port}${options.openAPI.docsPath}\`);
					console.log(\`📄 OpenAPI Spec: http://localhost:\${port}${options.openAPI.specPath}\`);
					`
							: ""
					}
				});

        // Graceful shutdown: stop accepting new connections, let in-flight
        // requests finish, then exit 0; force-exit 1 if draining takes >10s
				// --------------------------------------------------
        let shuttingDown = false;
        function shutdown(signal) {
          if (shuttingDown) return;
          shuttingDown = true;
          console.log(\`\${signal} received, shutting down gracefully...\`);
          setTimeout(() => process.exit(1), 10000).unref();
          server.close(() => process.exit(0));
          // Keep-alive sockets with no in-flight request would otherwise
          // stall close(); busy sockets are closed after their response
          server.closeIdleConnections?.();
        }
        process.once('SIGTERM', () => shutdown('SIGTERM'));
        process.once('SIGINT', () => shutdown('SIGINT'));

        // List all server functions
				// --------------------------------------------------
      `;

			this.emitFile({
				type: "asset",
				fileName: options.serverFileName,
				source: serverCode,
			});
		},
	};
}

function generateClientProxy(moduleName, functions, options, filePath) {
	// Add development-only safety checks
	const isDev = process.env.NODE_ENV !== "production";

	let clientProxy = `\n// vite-server-actions: ${moduleName}\n`;

	// Mark this as a legitimate client proxy module
	if (isDev) {
		clientProxy += `
// Development-only marker for client proxy module
if (typeof window !== 'undefined') {
  window.__VITE_SERVER_ACTIONS_PROXY__ = window.__VITE_SERVER_ACTIONS_PROXY__ || {};
  window.__VITE_SERVER_ACTIONS_PROXY__['${moduleName}'] = true;
}
`;
	}

	functions.forEach((functionName) => {
		const routePath = options.routeTransform(filePath, functionName);

		clientProxy += `
      export async function ${functionName}(...args) {
      	console.log("[Vite Server Actions] 🚀 - Executing ${functionName}");
        
        ${
					isDev
						? `
        // Validate arguments in development
        if (args.some(arg => typeof arg === 'function')) {
          console.warn(
            '[Vite Server Actions] Warning: Functions cannot be serialized and sent to the server. ' +
            'Function arguments will be converted to null.'
          );
        }
        `
						: ""
				}
        
        try {
          const response = await fetch(${JSON.stringify(`${options.apiPrefix}/${routePath}`)}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args)
          });

          if (!response.ok) {
            let errorData;
            try {
              errorData = await response.json();
            } catch {
              errorData = { error: 'Unknown error', details: 'Failed to parse error response' };
            }
            
            console.error("[Vite Server Actions] ❗ - Error in ${functionName}:", errorData);
            
            const error = new Error(errorData.message || errorData.error || 'Server request failed');
            error.details = errorData.details;
            error.status = response.status;
            throw error;
          }

          console.log("[Vite Server Actions] ✅ - ${functionName} executed successfully");
          
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
          console.error("[Vite Server Actions] ❗ - Network or execution error in ${functionName}:", error.message);
          
          ${
						isDev
							? `
`
							: ""
					}
          
          // Re-throw with more context if it's not already our custom error
          if (!error.status) {
            const networkError = new Error(\`Failed to execute server action '${functionName}': \${error.message}\`);
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

// Export built-in middleware and validation utilities
export { middleware };
export { generateClientProxy };
export { createValidationMiddleware, ValidationAdapter, ZodAdapter, SchemaDiscovery, adapters } from "./validation.js";
export { OpenAPIGenerator, setupOpenAPIEndpoints, createSwaggerMiddleware } from "./openapi.js";
