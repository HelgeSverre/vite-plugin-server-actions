import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import http from "http";
import path from "path";
import serverActions from "../src/index.js";

// Temp dir must live inside the project root so sanitizePath containment passes.
const tempDir = path.join(process.cwd(), "node_modules", `vsa-hmr-${process.pid}-${Date.now()}`);

// Simple route transform so endpoints don't include the temp dir path
const routeTransform = (filePath, functionName) => {
	const base = path.basename(filePath).replace(/\.server\.(js|ts)$/, "");
	return `${base}/${functionName}`;
};

/**
 * Create a mock Vite dev server that captures the Express app and the
 * watcher "change" callback so tests can simulate HMR file changes.
 */
function createMockViteServer() {
	const captured = { app: null, changeCallback: null };
	const server = {
		watcher: {
			on: (event, callback) => {
				if (event === "change") {
					captured.changeCallback = callback;
				}
			},
		},
		middlewares: {
			use: (handler) => {
				captured.app = handler;
			},
		},
		httpServer: null,
	};
	return { server, captured };
}

const httpServers = [];

/** Start a real HTTP server around the captured Express app */
async function startServer(app) {
	const server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	httpServers.push(server);
	return server.address().port;
}

async function postJSON(port, urlPath, body) {
	const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	let data = null;
	try {
		data = await response.json();
	} catch {
		// 204 or non-JSON response
	}
	return { status: response.status, data };
}

beforeAll(async () => {
	await fs.mkdir(tempDir, { recursive: true });
});

afterAll(async () => {
	for (const server of httpServers) {
		await new Promise((resolve) => server.close(resolve));
	}
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("Hot Module Replacement (HMR)", () => {
	describe("Watcher setup", () => {
		it("should register watcher for file changes when watcher exists", () => {
			const { server, captured } = createMockViteServer();

			const plugin = serverActions();
			plugin.configureServer(server);

			expect(captured.changeCallback).toBeInstanceOf(Function);
		});

		it("should handle null watcher gracefully", () => {
			const plugin = serverActions();
			const serverWithNullWatcher = {
				watcher: null,
				middlewares: { use: vi.fn() },
			};

			expect(() => {
				plugin.configureServer(serverWithNullWatcher);
			}).not.toThrow();
		});

		it("should handle undefined watcher gracefully", () => {
			const plugin = serverActions();
			const serverWithUndefinedWatcher = {
				middlewares: { use: vi.fn() },
			};

			expect(() => {
				plugin.configureServer(serverWithUndefinedWatcher);
			}).not.toThrow();
		});
	});

	describe("Stale module cache invalidation", () => {
		it("serves fresh code after a .server.js file is edited (no dev-server restart)", async () => {
			const filePath = path.join(tempDir, "counter.server.js");
			await fs.writeFile(filePath, `export async function getValue() { return "v1"; }\n`);

			const { server, captured } = createMockViteServer();
			const plugin = serverActions({ routeTransform });
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);

			// First request serves the original implementation
			const before = await postJSON(port, "/api/counter/getValue", []);
			expect(before.status).toBe(200);
			expect(before.data).toBe("v1");

			// Edit the file, then simulate Vite's HMR flow: watcher fires "change",
			// and the invalidated module is re-loaded by the plugin
			await fs.writeFile(filePath, `export async function getValue() { return "v2"; }\n`);
			captured.changeCallback(filePath);
			await plugin.load(filePath);

			// The endpoint must serve the NEW code, not a stale cached module
			const after = await postJSON(port, "/api/counter/getValue", []);
			expect(after.status).toBe(200);
			expect(after.data).toBe("v2");
		});

		it("serves fresh code on the next request even before the module is re-loaded", async () => {
			const filePath = path.join(tempDir, "lazy.server.js");
			await fs.writeFile(filePath, `export async function read() { return "old"; }\n`);

			const { server, captured } = createMockViteServer();
			const plugin = serverActions({ routeTransform });
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);
			expect((await postJSON(port, "/api/lazy/read", [])).data).toBe("old");

			// Only the watcher fires - the route handler imports at request time and
			// must pick up the bumped module version by itself
			await fs.writeFile(filePath, `export async function read() { return "new"; }\n`);
			captured.changeCallback(filePath);

			expect((await postJSON(port, "/api/lazy/read", [])).data).toBe("new");
		});

		it("does not register duplicate route handlers when load() re-runs after HMR", async () => {
			const filePath = path.join(tempDir, "dedupe.server.js");
			await fs.writeFile(filePath, `export async function ping() { return "pong"; }\n`);

			const { server, captured } = createMockViteServer();
			const plugin = serverActions({ routeTransform });
			plugin.configureServer(server);
			await plugin.load(filePath);

			const postSpy = vi.spyOn(captured.app, "post");

			// Simulate two HMR cycles
			captured.changeCallback(filePath);
			await plugin.load(filePath);
			captured.changeCallback(filePath);
			await plugin.load(filePath);

			// The endpoint was registered during the first load; re-loads must not
			// stack additional handlers onto the Express router
			expect(postSpy).not.toHaveBeenCalled();

			const port = await startServer(captured.app);
			expect((await postJSON(port, "/api/dedupe/ping", [])).data).toBe("pong");
		});
	});

	describe("Schema cache invalidation", () => {
		it("keeps other modules' schemas validating after an HMR edit", async () => {
			const fileA = path.join(tempDir, "alpha.server.js");
			const fileB = path.join(tempDir, "beta.server.js");

			await fs.writeFile(
				fileA,
				`import { z } from "zod";
export async function makeAlpha(data) { return { ok: true, ...data }; }
makeAlpha.schema = z.object({ name: z.string().min(2) });
`,
			);
			await fs.writeFile(
				fileB,
				`import { z } from "zod";
export async function makeBeta(data) { return { ok: true, ...data }; }
makeBeta.schema = z.object({ count: z.number() });
`,
			);

			const { server, captured } = createMockViteServer();
			const plugin = serverActions({ routeTransform, validation: { enabled: true } });
			plugin.configureServer(server);
			await plugin.load(fileA);
			await plugin.load(fileB);

			const port = await startServer(captured.app);

			// Both schemas validate initially
			const invalidAlpha = await postJSON(port, "/api/alpha/makeAlpha", [{ name: "x" }]);
			expect(invalidAlpha.status).toBe(400);
			expect(invalidAlpha.data.code).toBe("VALIDATION_ERROR");

			// Edit beta and run the HMR flow for it
			await fs.writeFile(
				fileB,
				`import { z } from "zod";
export async function makeBeta(data) { return { ok: true, edited: true, ...data }; }
makeBeta.schema = z.object({ count: z.number() });
`,
			);
			captured.changeCallback(fileB);
			await plugin.load(fileB);

			// Alpha's schema must have survived beta's HMR edit
			const invalidAlphaAfter = await postJSON(port, "/api/alpha/makeAlpha", [{ name: "x" }]);
			expect(invalidAlphaAfter.status).toBe(400);
			expect(invalidAlphaAfter.data.code).toBe("VALIDATION_ERROR");

			// And beta's re-discovered schema still validates too
			const invalidBeta = await postJSON(port, "/api/beta/makeBeta", [{ count: "not-a-number" }]);
			expect(invalidBeta.status).toBe(400);
			expect(invalidBeta.data.code).toBe("VALIDATION_ERROR");

			// Valid beta requests execute the edited implementation
			const validBeta = await postJSON(port, "/api/beta/makeBeta", [{ count: 3 }]);
			expect(validBeta.status).toBe(200);
			expect(validBeta.data).toEqual({ ok: true, edited: true, count: 3 });
		});
	});

	describe("File change handling", () => {
		it("ignores non-server file changes without touching registered modules", async () => {
			const filePath = path.join(tempDir, "stable.server.js");
			await fs.writeFile(filePath, `export async function stable() { return "steady"; }\n`);

			const { server, captured } = createMockViteServer();
			const plugin = serverActions({ routeTransform });
			plugin.configureServer(server);
			await plugin.load(filePath);

			const ignoredFiles = [
				"/project/src/components/TodoList.svelte",
				"/project/src/App.vue",
				"/project/src/main.js",
				"/project/src/styles.css",
			];

			for (const file of ignoredFiles) {
				expect(() => captured.changeCallback(file)).not.toThrow();
			}

			// The server module is still registered and serving
			const port = await startServer(captured.app);
			expect((await postJSON(port, "/api/stable/stable", [])).data).toBe("steady");
		});

		it("respects exclude patterns for watched file changes", async () => {
			const excludedDir = path.join(tempDir, "tmp");
			await fs.mkdir(excludedDir, { recursive: true });
			const excludedFile = path.join(excludedDir, "scratch.server.js");
			await fs.writeFile(excludedFile, `export async function scratch() { return 1; }\n`);

			const { server, captured } = createMockViteServer();
			const plugin = serverActions({ routeTransform, exclude: ["**/tmp/**"] });
			plugin.configureServer(server);

			// Excluded files are not processed by load...
			const result = await plugin.load(excludedFile);
			expect(result).toBeUndefined();

			// ...and their change events are ignored without errors
			expect(() => captured.changeCallback(excludedFile)).not.toThrow();
		});
	});
});
