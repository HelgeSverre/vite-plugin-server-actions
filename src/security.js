import path from "path";

/**
 * Sanitize and validate file paths to prevent directory traversal attacks
 * @param {string} filePath - The file path to sanitize
 * @param {string} basePath - The base directory to restrict access to
 * @param {string[]} [allowedPaths] - Additional directories access is allowed from
 *   (e.g. Vite's server.fs.allow, so monorepo/workspace files outside the project
 *   root that Vite itself legitimately serves are not rejected)
 * @returns {string|null} - Sanitized path or null if invalid
 */
export function sanitizePath(filePath, basePath, allowedPaths = []) {
	if (!filePath || typeof filePath !== "string") {
		return null;
	}

	let inputPath = filePath;

	// Test-fixture affordance: synthetic absolute paths like /src/... or /project/...
	// are treated as relative to basePath. The containment and suspicious-pattern
	// checks below still apply to the resolved result, in every NODE_ENV.
	if (
		process.env.NODE_ENV === "test" &&
		(inputPath.startsWith("/src/") || inputPath.startsWith("/project/") || inputPath.startsWith("/test/"))
	) {
		inputPath = inputPath.startsWith("/project/") ? inputPath.slice("/project/".length) : inputPath.slice(1);
	}

	// Normalize the paths
	const normalizedPath = path.resolve(basePath, inputPath);

	// Check if the resolved path is within the base directory or any
	// explicitly allowed directory
	const allowedBases = [basePath, ...allowedPaths].map((base) => path.resolve(base));
	const isContained = allowedBases.some(
		(base) => normalizedPath === base || normalizedPath.startsWith(base + path.sep),
	);
	if (!isContained) {
		console.error(`Path traversal attempt detected: ${filePath}`);
		return null;
	}

	// Additional checks for suspicious patterns
	const suspiciousPatterns = [
		/\0/, // Null bytes
		/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, // Windows reserved names
	];

	const pathSegments = filePath.split(/[/\\]/);
	for (const segment of pathSegments) {
		if (suspiciousPatterns.some((pattern) => pattern.test(segment))) {
			console.error(`Suspicious path segment detected: ${segment}`);
			return null;
		}
	}

	return normalizedPath;
}

// Words that cannot be used as bare binding identifiers in generated ES module
// code (import * as <name>, export { <name> }), including strict-mode reserved
// words - module code is always strict
const RESERVED_IDENTIFIERS = new Set([
	"arguments",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"eval",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
]);

/**
 * Validate module name to prevent injection attacks
 * @param {string} moduleName - The module name to validate
 * @returns {boolean}
 */
export function isValidModuleName(moduleName) {
	if (!moduleName || typeof moduleName !== "string") {
		return false;
	}

	// Module names are embedded as bare identifiers in generated code
	// (import * as <name>, serverActions.<name>), so they must be valid,
	// non-reserved JavaScript identifiers. No dots to prevent directory
	// traversal via module names
	const validPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
	return validPattern.test(moduleName) && !RESERVED_IDENTIFIERS.has(moduleName);
}

/**
 * Create a secure module name from a file path
 * @param {string} filePath - The file path
 * @returns {string}
 */
export function createSecureModuleName(filePath) {
	// Remove any potentially dangerous characters
	const name = filePath
		.replace(/[^a-zA-Z0-9_/-]/g, "_") // Replace non-alphanumeric (except slash and dash)
		.replace(/\/+/g, "_") // Replace slashes with underscores
		.replace(/-+/g, "_") // Replace dashes with underscores
		.replace(/_+/g, "_") // Collapse multiple underscores
		.replace(/^_|_$/g, ""); // Trim underscores from start/end

	// The name is used as a bare identifier in generated code (import * as <name>),
	// so prefix digit-leading names and reserved words to keep them valid JS.
	// The user-facing URL route is derived from routeTransform, not from this name.
	if (/^[0-9]/.test(name) || RESERVED_IDENTIFIERS.has(name)) {
		return `_${name}`;
	}

	return name;
}

/**
 * Validate that a configured output filename is a plain filename - emitted
 * build artifacts must land directly in the output directory, so path
 * separators, traversal segments, and null bytes are rejected
 * @param {string} fileName - The filename to validate
 * @returns {boolean}
 */
export function isPlainFileName(fileName) {
	if (!fileName || typeof fileName !== "string") {
		return false;
	}

	if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")) {
		return false;
	}

	return fileName !== "." && fileName !== "..";
}

/**
 * Escape a route path so every segment matches literally when handed to
 * Express's router. Route paths are derived from file and directory names via
 * routeTransform, and unescaped path-to-regexp metacharacters (`:`, `*`, `?`,
 * `(`, `)`, `[`, `]`, ...) would be interpreted as route patterns - e.g. a
 * file named ":id.server.js" would register "/api/:id/..." as a wildcard that
 * matches ANY single URL segment, hijacking or shadowing other routes.
 * @param {string} routePath - Route path produced by routeTransform
 * @returns {string} Route path whose segments match literally
 */
export function escapeRoutePath(routePath) {
	return String(routePath)
		.split("/")
		.map((segment) => segment.replace(/[^A-Za-z0-9_-]/g, "\\$&"))
		.join("/");
}

/**
 * Standard error response factory
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @param {string} [code] - Error code for client handling
 * @param {object} [details] - Additional error details
 * @returns {object}
 */
export function createErrorResponse(status, message, code = null, details = null) {
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

	// In production, don't expose internal error details
	if (process.env.NODE_ENV === "production" && details?.stack) {
		delete details.stack;
	}

	return error;
}
