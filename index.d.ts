import type { Plugin } from "vite";
import type { RequestHandler } from "express";
import type { z } from "zod";

export interface ValidationOptions {
	/**
	 * Enable validation for server actions
	 * @default false
	 */
	enabled?: boolean;

	/**
	 * Validation adapter to use
	 * @default "zod"
	 */
	adapter?: "zod";
}

export interface OpenAPIOptions {
	/**
	 * Enable OpenAPI documentation generation
	 * @default false
	 */
	enabled?: boolean;

	/**
	 * OpenAPI specification info
	 */
	info?: {
		title?: string;
		version?: string;
		description?: string;
	};

	/**
	 * Path to serve the Swagger UI documentation
	 * @default "/api/docs"
	 */
	docsPath?: string;

	/**
	 * Path to serve the OpenAPI JSON specification
	 * @default "/api/openapi.json"
	 */
	specPath?: string;

	/**
	 * Enable Swagger UI
	 * @default true when OpenAPI is enabled
	 */
	swaggerUI?: boolean;

	/**
	 * Filename of the OpenAPI spec emitted into the build output directory.
	 * Must be a plain filename without path separators. The generated
	 * production server reads the spec from this file; the serving paths
	 * (`specPath`/`docsPath`) are independent of it.
	 * @default "openapi.json"
	 */
	outputFile?: string;
}

export interface ServerActionOptions {
	/**
	 * Custom API prefix for server action endpoints
	 * @default "/api"
	 */
	apiPrefix?: string;

	/**
	 * Include patterns for server action files
	 * @default ["**\/*.server.js", "**\/*.server.ts"]
	 */
	include?: string | string[];

	/**
	 * Exclude patterns for server action files
	 * @default []
	 */
	exclude?: string | string[];

	/**
	 * Middleware mounted on the API prefix, run before validation and the
	 * action handlers. Each entry is an Express middleware function or a
	 * string path (resolved relative to the Vite root) to a module whose
	 * default export is a middleware function. Accepts a single entry or an
	 * array; entries run in array order.
	 */
	middleware?: RequestHandler | string | Array<RequestHandler | string>;

	/**
	 * Transform function for module names (internal use)
	 * @param filePath - The file path relative to project root
	 * @returns The module name to use internally
	 */
	moduleNameTransform?: (filePath: string) => string;

	/**
	 * Transform function for API routes
	 * @param filePath - The file path relative to project root
	 * @param functionName - The exported function name
	 * @returns The API route path (without prefix)
	 * @default Clean hierarchical paths (removes src/ and .server.js or .server.ts)
	 */
	routeTransform?: (filePath: string, functionName: string) => string;

	/**
	 * Filename of the generated production server emitted into the build
	 * output directory. Must be a plain filename without path separators.
	 * @default "server.js"
	 */
	serverFileName?: string;

	/**
	 * Suppress the plugin's own informational console output (dev startup
	 * feedback, HMR cleanup logs, advisory warnings). Errors always print,
	 * and build warnings about middleware excluded from the production
	 * server are routed through Rollup's warning path so they stay visible.
	 * @default false
	 */
	silent?: boolean;

	/**
	 * Validation configuration
	 */
	validation?: ValidationOptions;

	/**
	 * OpenAPI documentation configuration
	 */
	openAPI?: OpenAPIOptions;
}

export interface ServerActionsPlugin extends Plugin {
	name: "vite-plugin-server-actions";
}

/**
 * Creates a Vite plugin that enables server actions
 * @param options - Configuration options for the plugin
 * @returns Vite plugin instance
 */
declare function serverActions(options?: ServerActionOptions): ServerActionsPlugin;

/**
 * Built-in middleware for server actions
 */
export declare const middleware: {
	/**
	 * Logging middleware that displays server action calls with formatted JSON output
	 */
	logging: RequestHandler;
};

/**
 * Path transformation utilities
 */
export declare const pathUtils: {
	/**
	 * Creates clean hierarchical routes: "actions/todo/create"
	 * @param filePath - The file path relative to project root
	 * @param functionName - The exported function name
	 * @returns Clean route path
	 */
	createCleanRoute: (filePath: string, functionName: string) => string;

	/**
	 * Creates legacy underscore-separated routes: "src_actions_todo/create"
	 * @param filePath - The file path relative to project root
	 * @param functionName - The exported function name
	 * @returns Legacy route path
	 */
	createLegacyRoute: (filePath: string, functionName: string) => string;

	/**
	 * Creates minimal routes: "actions/todo.server/create"
	 * @param filePath - The file path relative to project root
	 * @param functionName - The exported function name
	 * @returns Minimal route path
	 */
	createMinimalRoute: (filePath: string, functionName: string) => string;

	/**
	 * Creates module names for internal use
	 * @param filePath - The file path relative to project root
	 * @returns Module name
	 */
	createModuleName: (filePath: string) => string;
};

// Validation exports
export interface ValidationAdapter {
	validate(
		schema: any,
		data: any,
	): Promise<{
		success: boolean;
		data?: any;
		errors?: Array<{ path: string; message: string; code: string; value?: any }>;
	}>;
	toOpenAPISchema(schema: any): any;
	getParameters(schema: any): any[];
}

export declare class ZodAdapter implements ValidationAdapter {
	validate(
		schema: z.ZodSchema<any>,
		data: any,
	): Promise<{
		success: boolean;
		data?: any;
		errors?: Array<{ path: string; message: string; code: string; value?: any }>;
	}>;
	toOpenAPISchema(schema: z.ZodSchema<any>): any;
	getParameters(schema: z.ZodSchema<any>): any[];
}

export declare class SchemaDiscovery {
	constructor(adapter?: ValidationAdapter);
	registerSchema(moduleName: string, functionName: string, schema: any): void;
	getSchema(moduleName: string, functionName: string): any;
	hasSchema(moduleName: string, functionName: string): boolean;
	getAllSchemas(): Map<string, any>;
	discoverFromModule(module: any, moduleName: string): void;
	clear(): void;
}

export declare const adapters: {
	zod: typeof ZodAdapter;
};

export declare const defaultAdapter: ZodAdapter;
export declare const defaultSchemaDiscovery: SchemaDiscovery;

export declare function createValidationMiddleware(options?: {
	adapter?: ValidationAdapter | "zod";
	schemaDiscovery?: SchemaDiscovery;
}): RequestHandler;

// OpenAPI exports
export declare class OpenAPIGenerator {
	constructor(options?: {
		info?: { title?: string; version?: string; description?: string };
		adapter?: ValidationAdapter;
		servers?: Array<{ url: string; description?: string }>;
	});
	generateSpec(
		serverFunctions: Map<string, any>,
		schemaDiscovery: SchemaDiscovery,
		options?: {
			apiPrefix?: string;
			routeTransform?: (filePath: string, functionName: string) => string;
			port?: number | string;
		},
	): any;
}

export declare function setupOpenAPIEndpoints(
	app: any,
	openAPISpec: any,
	options?: {
		docsPath?: string;
		specPath?: string;
		enableSwaggerUI?: boolean;
		port?: number;
		swaggerOptions?: any;
	},
): void;

export declare function createSwaggerMiddleware(spec: any, options?: { swaggerOptions?: any }): RequestHandler[];

export default serverActions;
