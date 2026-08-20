import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs/promises";
import http from "http";
import net from "net";
import path from "path";
import serverActions from "../src/index.js";

// Tests for the user middleware contract:
// - PROD: self-contained middleware functions are embedded into dist/server.js
//   and run for every API request (including OPTIONS preflights)
// - PROD: closure-capturing middleware functions trigger a build warning and
//   are excluded instead of being embedded with dangling references
// - PROD/DEV: string entries are module paths whose default export is the
//   middleware; they are bundled (prod) or imported (dev)
// - DEV: middleware mounts on the apiPrefix so OPTIONS preflights pass through

// Fixtures live inside the project so sanitizePath containment passes
const fixtureRoot = path.join(process.cwd(), "vsa-test-tmp", `vsa-mw-${process.pid}-${Date.now()}`);

// Basename-based routes so endpoints don't include the temp dir path
const routeTransform = (filePath, functionName) => {
	const base = path.basename(filePath).replace(/\.server\.(js|ts)$/, "");
	return `${base}/${functionName}`;
};

async function writeFixture(relativePath, content) {
	const filePath = path.join(fixtureRoot, relativePath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf-8");
	return filePath;
}

function createBundleContext() {
	const emitted = {};
	return {
		emitted,
		context: {
			emitFile(file) {
				emitted[file.fileName] = file.source;
			},
		},
	};
}

async function runBuild(plugin, ids) {
	for (const id of ids) {
		const result = await plugin.load(id);
		expect(result).not.toContain("Failed to load server actions");
	}
	const { emitted, context } = createBundleContext();
	await plugin.generateBundle.call(context, {}, {});
	return emitted;
}

async function getAvailablePort(startPort = 4100) {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(startPort, (err) => {
			if (err) {
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
			getAvailablePort(startPort + 1)
				.then(resolve)
				.catch(reject);
		});
	});
}

const serverProcesses = [];

/** Write the emitted build artifacts to <dirName>/dist and boot node dist/server.js */
async function bootProductionServer(emitted, dirName) {
	const appDir = path.join(fixtureRoot, dirName);
	const distDir = path.join(appDir, "dist");
	await fs.mkdir(distDir, { recursive: true });
	for (const [fileName, source] of Object.entries(emitted)) {
		const targetPath = path.join(distDir, fileName);
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.writeFile(targetPath, source, "utf-8");
	}

	const port = await getAvailablePort();
	const proc = spawn(process.execPath, ["dist/server.js"], {
		cwd: appDir,
		env: { ...process.env, PORT: String(port) },
	});
	serverProcesses.push(proc);

	await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
			if (stdout.includes("Server listening")) {
				resolve();
			}
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("exit", (code) => reject(new Error(`Server exited with code ${code}: ${stderr}`)));
		global.setTimeout(() => reject(new Error(`Server failed to start: ${stderr}`)), 10000);
	});

	return port;
}

// --- Dev-server harness (same shape as tests/hmr.test.js) ---

function createMockViteServer() {
	const captured = { app: null };
	const server = {
		watcher: { on: () => {} },
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

async function startDevServer(app) {
	const server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	httpServers.push(server);
	return server.address().port;
}

beforeAll(async () => {
	await fs.mkdir(fixtureRoot, { recursive: true });
});

afterAll(async () => {
	for (const proc of serverProcesses) {
		proc.kill("SIGTERM");
	}
	for (const server of httpServers) {
		await new Promise((resolve) => server.close(resolve));
	}
	await new Promise((resolve) => global.setTimeout(resolve, 500));
	await fs.rm(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("production user middleware", () => {
	it("embeds a self-contained auth middleware into dist/server.js and enforces it at runtime", async () => {
		const actionFile = await writeFixture(
			"auth-app/profile.server.js",
			'export async function whoami() {\n\treturn { user: "helge" };\n}\n',
		);

		// Self-contained: only params, locals, and globals - must serialize
		const authMiddleware = function authGuard(req, res, next) {
			if (!req.headers["x-api-key"]) {
				res.status(401).json({ error: "unauthorized" });
				return;
			}
			next();
		};

		const plugin = serverActions({ routeTransform, middleware: [authMiddleware] });
		const emitted = await runBuild(plugin, [actionFile]);

		// The middleware source is embedded and mounted on the apiPrefix before routes
		expect(emitted["server.js"]).toContain('app.use("/api", (function authGuard');
		expect(emitted["server.js"]).toContain("x-api-key");
		expect(emitted["server.js"].indexOf('app.use("/api"')).toBeLessThan(emitted["server.js"].indexOf("app.post("));

		const port = await bootProductionServer(emitted, "auth-app");

		// Without the header the middleware rejects
		const denied = await fetch(`http://localhost:${port}/api/profile/whoami`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([]),
		});
		expect(denied.status).toBe(401);
		expect(await denied.json()).toEqual({ error: "unauthorized" });

		// OPTIONS preflights pass through the middleware too (app.use before routes)
		const preflight = await fetch(`http://localhost:${port}/api/profile/whoami`, { method: "OPTIONS" });
		expect(preflight.status).toBe(401);

		// With the header the action executes normally
		const allowed = await fetch(`http://localhost:${port}/api/profile/whoami`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": "sekrit" },
			body: JSON.stringify([]),
		});
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toEqual({ user: "helge" });
	}, 30000);

	it("fails the build when middleware captures non-global scope", async () => {
		const actionFile = await writeFixture(
			"closure-app/data.server.js",
			"export async function getData() {\n\treturn [];\n}\n",
		);

		const secret = "s3cret-value";
		const closureMiddleware = (req, res, next) => {
			req.auth = secret;
			next();
		};

		const plugin = serverActions({ routeTransform, middleware: [closureMiddleware] });
		await expect(runBuild(plugin, [actionFile])).rejects.toThrow(
			/middleware\[0\].*secret.*build was stopped.*module path/s,
		);
	});

	it("bundles string-path middleware and mounts it in the generated server", async () => {
		const actionFile = await writeFixture(
			"cors-app/items.server.js",
			"export async function listItems() {\n\treturn [1, 2, 3];\n}\n",
		);
		const middlewarePath = await writeFixture(
			"cors-app/cors-middleware.js",
			[
				"export default function corsHeaders(req, res, next) {",
				'\tres.setHeader("Access-Control-Allow-Origin", "*");',
				"\tnext();",
				"}",
				"",
			].join("\n"),
		);

		// String entries are resolved relative to the Vite root (cwd in this harness)
		const plugin = serverActions({
			routeTransform,
			middleware: [path.relative(process.cwd(), middlewarePath)],
		});
		const emitted = await runBuild(plugin, [actionFile]);

		// The middleware module is bundled into actions.js and mounted via a real import
		expect(emitted[".vsa/actions.js"]).toContain("Access-Control-Allow-Origin");
		expect(emitted[".vsa/actions.js"]).toContain("__vsa_middleware_0");
		expect(emitted["server.js"]).toContain('app.use("/api", serverActions.__vsa_middleware_0);');

		const port = await bootProductionServer(emitted, "cors-app");

		const response = await fetch(`http://localhost:${port}/api/items/listItems`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([]),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(await response.json()).toEqual([1, 2, 3]);

		// OPTIONS preflights get the CORS headers too
		const preflight = await fetch(`http://localhost:${port}/api/items/listItems`, { method: "OPTIONS" });
		expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
	}, 30000);
});

describe("development user middleware", () => {
	it("imports string-path middleware and applies it to action requests", async () => {
		const actionFile = await writeFixture(
			"dev-string/things.server.js",
			'export async function getThing() {\n\treturn "thing";\n}\n',
		);
		const middlewarePath = await writeFixture(
			"dev-string/cors-middleware.js",
			[
				"export default function corsHeaders(req, res, next) {",
				'\tres.setHeader("Access-Control-Allow-Origin", "*");',
				"\tnext();",
				"}",
				"",
			].join("\n"),
		);

		const { server, captured } = createMockViteServer();
		const plugin = serverActions({
			routeTransform,
			middleware: [path.relative(process.cwd(), middlewarePath)],
		});
		plugin.configureServer(server);
		await plugin.load(actionFile);

		const port = await startDevServer(captured.app);

		const response = await fetch(`http://127.0.0.1:${port}/api/things/getThing`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([]),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(await response.json()).toBe("thing");
	});

	it("passes OPTIONS preflights to action routes through user middleware", async () => {
		const actionFile = await writeFixture(
			"dev-options/ping.server.js",
			'export async function ping() {\n\treturn "pong";\n}\n',
		);

		const corsMiddleware = (req, res, next) => {
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Headers", "content-type");
			next();
		};

		const { server, captured } = createMockViteServer();
		const plugin = serverActions({ routeTransform, middleware: [corsMiddleware] });
		plugin.configureServer(server);
		await plugin.load(actionFile);

		const port = await startDevServer(captured.app);

		// The preflight never hits a POST route, but must still pass through the
		// middleware because it mounts on the apiPrefix itself
		const preflight = await fetch(`http://127.0.0.1:${port}/api/ping/ping`, { method: "OPTIONS" });
		expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
		expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type");

		// The actual request passes through the same middleware
		const response = await fetch(`http://127.0.0.1:${port}/api/ping/ping`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([]),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(await response.json()).toBe("pong");
	});
});
