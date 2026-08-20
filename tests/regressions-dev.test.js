import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import serverActions from "../src/index.js";
import { sanitizePath } from "../src/security.js";
import { loggingMiddleware } from "../src/middleware.js";
import { defaultSchemaDiscovery } from "../src/validation.js";

// Temp dir must live inside the project root so sanitizePath containment passes,
// but NOT inside node_modules: files there are never treated as server actions.
const tempDir = path.join(process.cwd(), "vsa-test-tmp", `vsa-regress-${process.pid}-${Date.now()}`);

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

describe("dev-mode regressions", () => {
	describe("stale ESM cache for .server.js files (HMR)", () => {
		it("serves fresh code after a .server.js file is edited, without a dev-server restart", async () => {
			const filePath = path.join(tempDir, "stale.server.js");
			await fs.writeFile(filePath, `export async function getValue() { return "v1"; }\n`);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);

			const first = await postJSON(port, "/api/stale/getValue", []);
			expect(first.status).toBe(200);
			expect(first.data).toBe("v1");

			// Edit the file and simulate the HMR watcher firing
			await fs.writeFile(filePath, `export async function getValue() { return "v2"; }\n`);
			captured.changeCallback(filePath);
			// Vite re-runs load() for the invalidated module
			await plugin.load(filePath);

			const second = await postJSON(port, "/api/stale/getValue", []);
			expect(second.status).toBe(200);
			expect(second.data).toBe("v2");
		});
	});

	describe("duplicate Express route registration across HMR re-runs of load()", () => {
		it("registers each endpoint only once even when load() re-runs", async () => {
			const filePath = path.join(tempDir, "dedupe.server.js");
			await fs.writeFile(filePath, `export async function doThing() { return "ok"; }\n`);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);

			const postSpy = vi.spyOn(captured.app, "post");

			await plugin.load(filePath);
			captured.changeCallback(filePath);
			await plugin.load(filePath);
			await plugin.load(filePath);

			const registrations = postSpy.mock.calls.filter((call) => call[0] === "/api/dedupe/doThing");
			expect(registrations).toHaveLength(1);
			postSpy.mockRestore();
		});
	});

	describe("HMR schema clearing wipes all modules' schemas", () => {
		it("keeps validating unrelated modules after another server file changes", async () => {
			const fileA = path.join(tempDir, "alpha.server.js");
			const fileB = path.join(tempDir, "beta.server.js");
			await fs.writeFile(
				fileA,
				`import { z } from "zod";
export async function getAlpha(input) { return "alpha"; }
getAlpha.schema = z.object({ name: z.string() });
`,
			);
			await fs.writeFile(
				fileB,
				`import { z } from "zod";
export async function createBeta(input) { return "beta executed"; }
createBeta.schema = z.object({ title: z.string() });
`,
			);

			const plugin = serverActions({ routeTransform, validation: { enabled: true } });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(fileA);
			await plugin.load(fileB);

			const port = await startServer(captured.app);

			// Sanity: invalid payload to beta is rejected before any change
			const before = await postJSON(port, "/api/beta/createBeta", [{ title: 123 }]);
			expect(before.status).toBe(400);
			expect(before.data.code).toBe("VALIDATION_ERROR");

			// Edit alpha.server.js and simulate the watcher change event
			await fs.writeFile(
				fileA,
				`import { z } from "zod";
export async function getAlpha(input) { return "alpha v2"; }
getAlpha.schema = z.object({ name: z.string() });
`,
			);
			captured.changeCallback(fileA);

			// Beta's schema must survive: invalid payload must still be rejected
			const after = await postJSON(port, "/api/beta/createBeta", [{ title: 123 }]);
			expect(after.status).toBe(400);
			expect(after.data.code).toBe("VALIDATION_ERROR");
		});

		it("uses a per-instance SchemaDiscovery instead of the shared module-level singleton", async () => {
			const filePath = path.join(tempDir, "isolated.server.js");
			await fs.writeFile(
				filePath,
				`import { z } from "zod";
export async function isolatedFn(input) { return "ok"; }
isolatedFn.schema = z.object({ id: z.number() });
`,
			);

			const sizeBefore = defaultSchemaDiscovery.getAllSchemas().size;

			const plugin = serverActions({ routeTransform, validation: { enabled: true } });
			const { server } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			// The plugin instance must not register its schemas on the shared singleton
			expect(defaultSchemaDiscovery.getAllSchemas().size).toBe(sizeBefore);
		});
	});

	describe("first-request validation bypass for .server.ts modules", () => {
		it("validates the very first request to a TypeScript server action", async () => {
			const filePath = path.join(tempDir, "guard.server.ts");
			await fs.writeFile(
				filePath,
				`import { z } from "zod";
export async function createUser(input: { role: string }): Promise<string> {
  return "created";
}
createUser.schema = z.object({ role: z.literal("user") });
`,
			);

			const writeSpy = vi.spyOn(fs, "writeFile");
			const plugin = serverActions({ routeTransform, validation: { enabled: true } });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);

			// FIRST request with invalid arguments must already be rejected
			const first = await postJSON(port, "/api/guard/createUser", [{ role: "admin" }]);
			expect(first.status).toBe(400);
			expect(first.data.code).toBe("VALIDATION_ERROR");

			// And a valid first-class request still goes through
			const valid = await postJSON(port, "/api/guard/createUser", [{ role: "user" }]);
			expect(valid.status).toBe(200);
			expect(valid.data).toBe("created");

			const generatedModulePaths = writeSpy.mock.calls
				.map(([target]) => String(target))
				.filter((target) => target.endsWith(".mjs"));
			expect(generatedModulePaths.some((target) => target.startsWith(os.tmpdir()))).toBe(true);
			expect(generatedModulePaths.some((target) => path.dirname(target) === tempDir)).toBe(false);
		});

		it("loads CommonJS packages from the private fallback module", async () => {
			const filePath = path.join(tempDir, "commonjs.server.ts");
			await fs.writeFile(
				filePath,
				`import express from "express";
export async function getDependencyType(): Promise<string> {
  return typeof express;
}
`,
			);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);
			const response = await postJSON(port, "/api/commonjs/getDependencyType", []);

			expect(response.status).toBe(200);
			expect(response.data).toBe("function");
			expect(await fs.stat(path.join(tempDir, ".commonjs.server.tmp.mjs")).catch(() => null)).toBeNull();
		});
	});

	describe("include/exclude patterns vs absolute file paths", () => {
		it("applies project-root-relative exclude patterns to absolute ids", async () => {
			const filePath = path.join(tempDir, "excluded.server.js");
			await fs.writeFile(filePath, `export async function hidden() { return "secret"; }\n`);

			const relativeDir = path.relative(process.cwd(), tempDir).replace(/\\/g, "/");
			const plugin = serverActions({ routeTransform, exclude: [`${relativeDir}/**`] });
			const { server } = createMockViteServer();
			plugin.configureServer(server);

			const result = await plugin.load(filePath);
			expect(result).toBeUndefined();
		});

		it("applies project-root-relative include patterns to absolute ids", async () => {
			const filePath = path.join(tempDir, "included.server.js");
			await fs.writeFile(filePath, `export async function visible() { return "hello"; }\n`);

			const relativeDir = path.relative(process.cwd(), tempDir).replace(/\\/g, "/");
			const plugin = serverActions({ routeTransform, include: [`${relativeDir}/*.server.js`] });
			const { server } = createMockViteServer();
			plugin.configureServer(server);

			const result = await plugin.load(filePath);
			expect(result).toContain("visible");
		});
	});

	describe("dev error handler classification", () => {
		it("returns 500 (not 404) for user errors whose message contains 'not found'", async () => {
			const filePath = path.join(tempDir, "errors.server.js");
			await fs.writeFile(filePath, `export async function findTodo() { throw new Error("Todo not found"); }\n`);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);

			const response = await postJSON(port, "/api/errors/findTodo", []);
			expect(response.status).toBe(500);
			expect(response.data.code).toBe("INTERNAL_ERROR");
			expect(response.data.details.message).toBe("Todo not found");
		});

		it("returns 500 (not 404) for user errors whose message contains 'not a function'", async () => {
			const filePath = path.join(tempDir, "typeerrors.server.js");
			await fs.writeFile(filePath, `export async function callBroken() { const db = {}; return db.fetch(); }\n`);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);

			const response = await postJSON(port, "/api/typeerrors/callBroken", []);
			expect(response.status).toBe(500);
			expect(response.data.code).toBe("INTERNAL_ERROR");
		});

		it("returns a clean availableFunctions list in 404 responses (no suggestion/emoji junk)", async () => {
			const filePath = path.join(tempDir, "ghost.server.js");
			await fs.writeFile(
				filePath,
				`export async function realFn() { return 1; }
export async function getGhost() { return 2; }
`,
			);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);

			// Remove getGhost so the registered route hits the FUNCTION_NOT_FOUND path
			await fs.writeFile(filePath, `export async function realFn() { return 1; }\n`);
			captured.changeCallback(filePath);
			await plugin.load(filePath);

			const response = await postJSON(port, "/api/ghost/getGhost", []);
			expect(response.status).toBe(404);
			expect(response.data.code).toBe("FUNCTION_NOT_FOUND");
			expect(response.data.details.availableFunctions).toEqual(["realFn"]);
			expect(response.data.details.suggestion).toBe("Try one of: realFn");
		});
	});

	describe("user-thrown error status codes (dev/prod parity)", () => {
		it("honors a numeric error.status thrown by the action", async () => {
			const filePath = path.join(tempDir, "authstatus.server.js");
			await fs.writeFile(
				filePath,
				`export async function denied() {
	const err = new Error("Unauthorized");
	err.status = 401;
	throw err;
}
`,
			);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);

			const response = await postJSON(port, "/api/authstatus/denied", []);
			expect(response.status).toBe(401);
			expect(response.data.error).toBe(true);
			expect(response.data.status).toBe(401);
			expect(response.data.message).toBe("Unauthorized");
			expect(response.data.code).toBe("SERVER_ACTION_ERROR");
		});

		it("honors the error.statusCode Express alias and a custom error.code", async () => {
			const filePath = path.join(tempDir, "aliasstatus.server.js");
			await fs.writeFile(
				filePath,
				`export async function payUp() {
	const err = new Error("Payment required");
	err.statusCode = 402;
	err.code = "PAYMENT_REQUIRED";
	throw err;
}
`,
			);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);

			const response = await postJSON(port, "/api/aliasstatus/payUp", []);
			expect(response.status).toBe(402);
			expect(response.data.status).toBe(402);
			expect(response.data.message).toBe("Payment required");
			expect(response.data.code).toBe("PAYMENT_REQUIRED");
		});

		it("falls back to 500 INTERNAL_ERROR for non-numeric or out-of-range statuses", async () => {
			const filePath = path.join(tempDir, "badstatus.server.js");
			await fs.writeFile(
				filePath,
				`export async function teapot() {
	const err = new Error("boom");
	err.status = "teapot";
	throw err;
}
export async function redirecty() {
	const err = new Error("boom");
	err.status = 302;
	throw err;
}
`,
			);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);

			const nonNumeric = await postJSON(port, "/api/badstatus/teapot", []);
			expect(nonNumeric.status).toBe(500);
			expect(nonNumeric.data.code).toBe("INTERNAL_ERROR");

			const outOfRange = await postJSON(port, "/api/badstatus/redirecty", []);
			expect(outOfRange.status).toBe(500);
			expect(outOfRange.data.code).toBe("INTERNAL_ERROR");
		});
	});

	describe("sanitizePath enforcement in development/test NODE_ENV", () => {
		const originalNodeEnv = process.env.NODE_ENV;

		afterEach(() => {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
		});

		it("rejects absolute paths outside the base directory when NODE_ENV=development", () => {
			process.env.NODE_ENV = "development";
			expect(sanitizePath("/etc/passwd", process.cwd())).toBeNull();
		});

		it("rejects absolute paths outside the base directory when NODE_ENV=test", () => {
			process.env.NODE_ENV = "test";
			expect(sanitizePath("/etc/passwd", process.cwd())).toBeNull();
		});

		it("still accepts real files inside the base directory", () => {
			process.env.NODE_ENV = "development";
			const inside = path.join(process.cwd(), "src", "index.js");
			expect(sanitizePath(inside, process.cwd())).toBe(inside);
		});

		it("rejects traversal even for test-fixture style /src/ paths", () => {
			process.env.NODE_ENV = "test";
			expect(sanitizePath("/src/../../../etc/passwd.server.js", "/project")).toBeNull();
		});
	});

	describe("server files outside the Vite root (server.fs.allow)", () => {
		it("loads server files outside the root when the directory is in server.fs.allow", async () => {
			const workspaceDir = path.join(tempDir, "workspace");
			const appDir = path.join(workspaceDir, "app");
			const sharedFile = path.join(workspaceDir, "shared", "api.server.js");
			await fs.mkdir(appDir, { recursive: true });
			await fs.mkdir(path.dirname(sharedFile), { recursive: true });
			await fs.writeFile(sharedFile, `export async function ping() { return "pong"; }\n`);

			const plugin = serverActions({ routeTransform });
			plugin.configResolved({ root: appDir, server: { fs: { strict: true, allow: [workspaceDir] } } });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);

			const result = await plugin.load(sharedFile);
			expect(result).toContain("ping");
			expect(result).not.toContain("Failed to load server actions");

			// And the registered endpoint actually serves the out-of-root module
			const port = await startServer(captured.app);
			const response = await postJSON(port, "/api/api/ping", []);
			expect(response.status).toBe(200);
			expect(response.data).toBe("pong");
		});

		it("still rejects out-of-root server files that are not covered by server.fs.allow", async () => {
			const workspaceDir = path.join(tempDir, "workspace-denied");
			const appDir = path.join(workspaceDir, "app");
			const outsideFile = path.join(workspaceDir, "elsewhere", "sneaky.server.js");
			await fs.mkdir(appDir, { recursive: true });
			await fs.mkdir(path.dirname(outsideFile), { recursive: true });
			await fs.writeFile(outsideFile, `export async function sneak() { return 1; }\n`);

			const plugin = serverActions({ routeTransform });
			plugin.configResolved({ root: appDir, server: { fs: { strict: true, allow: [appDir] } } });
			const { server } = createMockViteServer();
			plugin.configureServer(server);

			const result = await plugin.load(outsideFile);
			expect(result).toContain("Failed to load server actions");
			expect(result).toContain("Invalid file path detected");
		});
	});

	describe("module name collision ownership across HMR reload order", () => {
		it("keeps module name ownership stable when colliding files reload in swapped order", async () => {
			// my-file.server.js and my_file.server.js normalize to the same module
			// name but keep distinct routes (routeTransform preserves the dash)
			const fileA = path.join(tempDir, "my-file.server.js");
			const fileB = path.join(tempDir, "my_file.server.js");
			await fs.writeFile(
				fileA,
				`import { z } from "zod";
export async function doIt(input) { return "from A"; }
doIt.schema = z.object({ value: z.string() });
`,
			);
			await fs.writeFile(
				fileB,
				`import { z } from "zod";
export async function doIt(input) { return "from B"; }
doIt.schema = z.object({ value: z.number() });
`,
			);

			const plugin = serverActions({ routeTransform, validation: { enabled: true } });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			await plugin.load(fileA);
			await plugin.load(fileB);

			const port = await startServer(captured.app);

			// Sanity: each endpoint validates with its own schema
			expect((await postJSON(port, "/api/my-file/doIt", [{ value: "text" }])).status).toBe(200);
			expect((await postJSON(port, "/api/my-file/doIt", [{ value: 5 }])).status).toBe(400);
			expect((await postJSON(port, "/api/my_file/doIt", [{ value: 5 }])).status).toBe(200);
			expect((await postJSON(port, "/api/my_file/doIt", [{ value: "text" }])).status).toBe(400);

			// Both files are touched (e.g. branch switch): the watcher clears both
			// entries, then the files reload in the OPPOSITE order. Name ownership
			// must not swap, or endpoints validate with the wrong (or no) schema.
			captured.changeCallback(fileA);
			captured.changeCallback(fileB);
			await plugin.load(fileB);
			await plugin.load(fileA);

			expect((await postJSON(port, "/api/my-file/doIt", [{ value: "text" }])).status).toBe(200);
			expect((await postJSON(port, "/api/my-file/doIt", [{ value: 5 }])).status).toBe(400);
			expect((await postJSON(port, "/api/my_file/doIt", [{ value: 5 }])).status).toBe(200);
			expect((await postJSON(port, "/api/my_file/doIt", [{ value: "text" }])).status).toBe(400);
		});
	});

	describe("JS server modules load through Vite's SSR loader when available", () => {
		it("uses ssrLoadModule for .server.js files so edited dependencies are picked up too", async () => {
			const filePath = path.join(tempDir, "ssrpath.server.js");
			await fs.writeFile(filePath, `export async function whoAmI() { return "native"; }\n`);

			const { server, captured } = createMockViteServer();
			// Vite's module graph invalidates a changed file AND its importers, which
			// native import() cannot do - so the SSR loader must be preferred
			server.ssrLoadModule = vi.fn(async () => ({ whoAmI: async () => "ssr" }));

			const plugin = serverActions({ routeTransform });
			plugin.configureServer(server);
			await plugin.load(filePath);

			const port = await startServer(captured.app);
			const response = await postJSON(port, "/api/ssrpath/whoAmI", []);
			expect(response.status).toBe(200);
			expect(response.data).toBe("ssr");
			expect(server.ssrLoadModule).toHaveBeenCalledWith(filePath);
		});
	});

	describe("logging middleware module labels", () => {
		it("labels hierarchical routes with the full module path", () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const req = { method: "POST", url: "/api/actions/todo/addTodo", body: [] };
			const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
			const next = vi.fn();

			loggingMiddleware(req, res, next);

			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Module: actions/todo"));
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Function: addTodo"));
			expect(next).toHaveBeenCalled();
			logSpy.mockRestore();
		});
	});
});
