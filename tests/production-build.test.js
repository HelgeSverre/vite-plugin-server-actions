import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import os from "os";
import path from "path";
import fs from "fs/promises";
import net from "net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const todoAppDir = path.join(__dirname, "../examples/svelte-todo-app");

// Helper function to find an available port
async function getAvailablePort(startPort = 3000) {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(startPort, (err) => {
			if (err) {
				// Port is in use, try next one
				server.close();
				getAvailablePort(startPort + 1)
					.then(resolve)
					.catch(reject);
			} else {
				const port = server.address().port;
				server.close(() => resolve(port));
			}
		});
		server.on("error", () => {
			// Port is in use, try next one
			getAvailablePort(startPort + 1)
				.then(resolve)
				.catch(reject);
		});
	});
}

describe("Production Build", () => {
	let serverProcess;
	let PORT; // Will be assigned dynamically

	beforeAll(async () => {
		// Find an available port
		PORT = await getAvailablePort(3009);
		console.log(`Using port ${PORT} for production build test`);

		console.log("Building todo app...");
		// Build the app
		await new Promise((resolve, reject) => {
			const buildProcess = spawn("npm", ["run", "build"], {
				cwd: todoAppDir,
				stdio: "inherit",
			});

			buildProcess.on("close", (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`Build failed with code ${code}`));
				}
			});
		});

		// Check what files were generated
		const distFiles = await fs.readdir(path.join(todoAppDir, "dist"));
		console.log("Generated files:", distFiles);

		// Start the production server FROM A DIFFERENT CWD (like `pm2 start
		// dist/server.js` from anywhere): static assets and openapi.json must be
		// resolved relative to server.js itself, not the process cwd
		console.log("Starting production server...");
		const foreignCwd = await fs.mkdtemp(path.join(os.tmpdir(), "vsa-prod-cwd-"));
		serverProcess = spawn("node", [path.join(todoAppDir, "dist", "server.js")], {
			cwd: foreignCwd,
			env: { ...process.env, PORT: PORT.toString() },
		});

		// Wait for server to be ready
		await new Promise((resolve, reject) => {
			let output = "";

			serverProcess.stdout.on("data", (data) => {
				output += data.toString();
				console.log("Server output:", data.toString());
				if (output.includes("Server listening")) {
					resolve();
				}
			});

			serverProcess.stderr.on("data", (data) => {
				console.error("Server error:", data.toString());
			});

			serverProcess.on("error", (err) => {
				reject(err);
			});

			// Timeout after 10 seconds
			global.setTimeout(() => reject(new Error("Server failed to start")), 10000);
		});

		// Give it a bit more time to fully initialize
		await new Promise((resolve) => global.setTimeout(resolve, 1000));
	}, 30000);

	afterAll(async () => {
		if (serverProcess) {
			serverProcess.kill("SIGTERM");
			// Wait a bit for the process to fully terminate
			await new Promise((resolve) => global.setTimeout(resolve, 1000));
		}
	});

	describe("Server functionality", () => {
		it("should serve the static files", async () => {
			const response = await fetch(`http://localhost:${PORT}/`);
			expect(response.ok).toBeTruthy();
			const html = await response.text();
			expect(html.toLowerCase()).toContain("<!doctype html>");
		});

		it("should handle getTodos endpoint", async () => {
			const response = await fetch(`http://localhost:${PORT}/api/actions/todo/getTodos`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify([]),
			});

			expect(response.ok).toBeTruthy();
			const todos = await response.json();
			expect(Array.isArray(todos)).toBeTruthy();
		});

		it("should handle addTodo with validation", async () => {
			// Test with valid data
			const validResponse = await fetch(`http://localhost:${PORT}/api/actions/todo/addTodo`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify([{ text: "Test todo", priority: "high" }]),
			});

			expect(validResponse.ok).toBeTruthy();
			const newTodo = await validResponse.json();
			expect(newTodo).toHaveProperty("id");
			expect(newTodo.text).toBe("Test todo");
			expect(newTodo.priority).toBe("high");

			// Test with invalid data (if validation is working)
			const invalidResponse = await fetch(`http://localhost:${PORT}/api/actions/todo/addTodo`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify([{ text: "", priority: "invalid" }]),
			});

			// Validation must reject invalid data with a 400
			expect(invalidResponse.status).toBe(400);
			const error = await invalidResponse.json();
			expect(error.error).toBe(true);
			expect(error.code).toBe("VALIDATION_ERROR");
			expect(error.message).toContain("Validation");
		});

		it("should return 400 INVALID_REQUEST_BODY for non-array request bodies", async () => {
			// getTodos has no schema, so this exercises the route handler's own
			// Array.isArray guard (same behavior as development)
			const response = await fetch(`http://localhost:${PORT}/api/actions/todo/getTodos`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ not: "an array" }),
			});

			expect(response.status).toBe(400);
			const error = await response.json();
			expect(error.error).toBe(true);
			expect(error.code).toBe("INVALID_REQUEST_BODY");
			expect(error.message).toContain("array");
		});

		it("should not leak stack traces in error responses by default", async () => {
			// updateTodo throws "Todo not found" for a nonexistent id; the server runs
			// without NODE_ENV=development, so no internal details may be exposed
			const response = await fetch(`http://localhost:${PORT}/api/actions/todo/updateTodo`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify([999999999, { text: "does not exist" }]),
			});

			expect(response.status).toBe(500);
			const error = await response.json();
			expect(error.error).toBe(true);
			expect(error.message).toBe("Internal server error");
			expect(error.details).toBeUndefined();
			expect(JSON.stringify(error)).not.toContain("at "); // no stack frames
		});
	});

	describe("OpenAPI functionality", () => {
		it("should serve OpenAPI spec in production", async () => {
			const response = await fetch(`http://localhost:${PORT}/api/openapi.json`);

			// The example enables OpenAPI, so the endpoint MUST be available
			expect(response.status).toBe(200);

			const spec = await response.json();
			expect(spec.openapi).toBe("3.0.3");
			expect(spec.info.title).toBe("Svelte Todo App API");
			expect(spec.paths).toBeDefined();

			// Should have todo endpoints in the clean hierarchical format
			const paths = Object.keys(spec.paths);
			expect(paths).toContain("/api/actions/todo/getTodos");
			expect(paths).toContain("/api/actions/todo/addTodo");
		});

		it("should serve Swagger UI in production", async () => {
			const response = await fetch(`http://localhost:${PORT}/api/docs`);

			// The example enables swaggerUI, so the docs page MUST be available
			expect(response.status).toBe(200);

			const html = await response.text();
			expect(html.toLowerCase()).toContain("swagger");
		});
	});

	describe("Build artifacts", () => {
		it("should generate correct server.js", async () => {
			const serverCode = await fs.readFile(path.join(todoAppDir, "dist/server.js"), "utf-8");

			// Validation runtime must be inlined and used in the routes
			expect(serverCode).toContain("createValidationMiddleware");
			expect(serverCode).toContain("createContextualValidationMiddleware(");

			// Routes are registered with JSON.stringify'd (double-quoted) paths and
			// wired through the contextual validation middleware
			expect(serverCode).toContain('app.post("/api/actions/todo/addTodo"');
			expect(serverCode).toContain("createContextualValidationMiddleware('src_actions_todo', 'addTodo')");

			// Every route handler guards against non-array request bodies
			expect(serverCode).toContain("Array.isArray(req.body)");
			expect(serverCode).toContain("INVALID_REQUEST_BODY");

			// Error details are only exposed when explicitly running in development,
			// never via the leaky "not production" check (covers the route handlers
			// AND the inlined validation runtime)
			expect(serverCode).toContain("process.env.NODE_ENV === 'development'");
			expect(serverCode).not.toMatch(/NODE_ENV\s*!==\s*['"]production['"]/);

			// OpenAPI spec must be read and served
			expect(serverCode).toContain("openapi.json");
			expect(serverCode).toContain("app.get('/api/openapi.json'");

			// Static assets are resolved relative to server.js itself, not the cwd
			expect(serverCode).toContain("express.static(__dirname)");
			expect(serverCode).not.toContain("express.static('dist')");

			// Module naming: default moduleNameTransform produces src_actions_todo
			expect(serverCode).toContain("serverActions.src_actions_todo");
		});

		it("should embed the self-contained built-in logging middleware", async () => {
			const serverCode = await fs.readFile(path.join(todoAppDir, "dist/server.js"), "utf-8");

			// The built-in uses only runtime globals, so fail-closed middleware
			// generation can preserve it without a dangling module import.
			expect(serverCode).toContain("Server Action Triggered");
			expect(serverCode).toContain("console.dir");
			expect(serverCode).not.toContain("util.inspect");
		});

		it("should generate actions.js with schemas", async () => {
			const actionsCode = await fs.readFile(path.join(todoAppDir, "dist/.vsa/actions.js"), "utf-8");

			// Zod schemas attached to functions must survive bundling so the
			// production server can validate requests
			expect(actionsCode).toMatch(/\.schema\s*=|schema:/);

			// The todo module's functions must be exported
			expect(actionsCode).toContain("addTodo");
			expect(actionsCode).toContain("getTodos");
		});

		it("should generate openapi.json with real request schemas", async () => {
			const openAPISpec = await fs.readFile(path.join(todoAppDir, "dist/.vsa/openapi.json"), "utf-8");
			const spec = JSON.parse(openAPISpec);

			expect(spec.openapi).toBe("3.0.3");
			expect(spec.paths).toBeDefined();

			// Schemas must be discovered during the build (Vite sets NODE_ENV=production
			// before load() runs, which used to leave schemaDiscovery empty), so the
			// documented request body reflects addTodo's Zod schema instead of the
			// generic fallback
			const addTodoSchema =
				spec.paths["/api/actions/todo/addTodo"]?.post?.requestBody?.content?.["application/json"]?.schema;
			expect(addTodoSchema).toBeDefined();
			expect(JSON.stringify(addTodoSchema)).toContain('"text"');
			// Not the generic fallback body
			expect(addTodoSchema.description).not.toBe("Function arguments array");
		});
	});
});
