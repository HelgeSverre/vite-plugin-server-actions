import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import serverActions from "../src/index.js";
import { isPlainFileName } from "../src/security.js";

// Tests for the serverFileName, openAPI.outputFile, and silent plugin options,
// plus graceful shutdown in the generated production server and the README's
// rate limiting middleware example.

// Fixtures live inside the project so sanitizePath containment passes and
// booted servers can resolve express from the project's node_modules
const fixtureRoot = path.join(process.cwd(), "node_modules", `vsa-config-options-${process.pid}-${Date.now()}`);

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

async function getAvailablePort(startPort = 4700) {
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

/**
 * Write the emitted build artifacts to <dirName>/dist and boot the generated
 * server (whatever filename it was emitted under) from a foreign cwd
 */
async function bootProductionServer(emitted, dirName, serverFileName = "server.js") {
	const distDir = path.join(fixtureRoot, dirName, "dist");
	await fs.mkdir(distDir, { recursive: true });
	for (const [fileName, source] of Object.entries(emitted)) {
		await fs.writeFile(path.join(distDir, fileName), source, "utf-8");
	}

	const foreignCwd = await fs.mkdtemp(path.join(os.tmpdir(), "vsa-config-cwd-"));
	const port = await getAvailablePort();
	const proc = spawn(process.execPath, [path.join(distDir, serverFileName)], {
		cwd: foreignCwd,
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

	return { port, proc };
}

// Basename-based routes so endpoints don't include the temp dir path
const routeTransform = (filePath, functionName) => {
	const base = path.basename(filePath).replace(/\.server\.(js|ts)$/, "");
	return `${base}/${functionName}`;
};

beforeAll(async () => {
	await fs.mkdir(fixtureRoot, { recursive: true });
});

afterAll(async () => {
	for (const proc of serverProcesses) {
		proc.kill("SIGTERM");
	}
	if (serverProcesses.length > 0) {
		await new Promise((resolve) => global.setTimeout(resolve, 500));
	}
	await fs.rm(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isPlainFileName", () => {
	it("accepts plain filenames and rejects paths, traversal, and empty values", () => {
		expect(isPlainFileName("server.js")).toBe(true);
		expect(isPlainFileName("my-server.mjs")).toBe(true);
		expect(isPlainFileName("openapi.json")).toBe(true);
		expect(isPlainFileName("dist/server.js")).toBe(false);
		expect(isPlainFileName("..\\server.js")).toBe(false);
		expect(isPlainFileName("../server.js")).toBe(false);
		expect(isPlainFileName("..")).toBe(false);
		expect(isPlainFileName(".")).toBe(false);
		expect(isPlainFileName("")).toBe(false);
		expect(isPlainFileName(null)).toBe(false);
		expect(isPlainFileName(42)).toBe(false);
		expect(isPlainFileName("bad\0name.js")).toBe(false);
	});
});

describe("serverFileName option", () => {
	it("rejects filenames with path separators at config time", () => {
		expect(() => serverActions({ serverFileName: "dist/server.js" })).toThrow(/serverFileName.*plain filename/s);
		expect(() => serverActions({ serverFileName: "..\\server.js" })).toThrow(/serverFileName/);
		expect(() => serverActions({ serverFileName: "" })).toThrow(/serverFileName/);
	});

	it("emits the production server under the configured filename", async () => {
		const actionFile = await writeFixture(
			"server-name/basic.server.js",
			"export async function ping() {\n\treturn 'pong';\n}\n",
		);

		const plugin = serverActions({ routeTransform, serverFileName: "my-server.mjs" });
		const emitted = await runBuild(plugin, [actionFile]);

		expect(emitted["my-server.mjs"]).toBeDefined();
		expect(emitted["server.js"]).toBeUndefined();
		expect(emitted["my-server.mjs"]).toContain('app.post("/api/basic/ping"');
	});

	it("defaults to server.js", async () => {
		const actionFile = await writeFixture(
			"server-name-default/basic.server.js",
			"export async function ping() {\n\treturn 'pong';\n}\n",
		);

		const plugin = serverActions({ routeTransform });
		const emitted = await runBuild(plugin, [actionFile]);

		expect(emitted["server.js"]).toBeDefined();
	});
});

describe("openAPI.outputFile option", () => {
	it("rejects filenames with path separators at config time", () => {
		expect(() => serverActions({ openAPI: { enabled: true, outputFile: "specs/openapi.json" } })).toThrow(
			/openAPI\.outputFile.*plain filename/s,
		);
		expect(() => serverActions({ openAPI: { outputFile: "..\\openapi.json" } })).toThrow(/openAPI\.outputFile/);
	});

	it("emits the spec under the configured filename and makes the server read it", async () => {
		const actionFile = await writeFixture(
			"spec-name/items.server.js",
			"export async function listItems() {\n\treturn [];\n}\n",
		);

		const plugin = serverActions({
			routeTransform,
			openAPI: { enabled: true, swaggerUI: false, outputFile: "api-spec.json" },
		});
		const emitted = await runBuild(plugin, [actionFile]);

		expect(emitted["api-spec.json"]).toBeDefined();
		expect(emitted["openapi.json"]).toBeUndefined();
		expect(JSON.parse(emitted["api-spec.json"]).openapi).toBe("3.0.3");

		// CRITICAL: the generated server must read the configured filename,
		// while the serving path (specPath) stays independent
		expect(emitted["server.js"]).toContain(`join(__dirname, "api-spec.json")`);
		expect(emitted["server.js"]).toContain("app.get('/api/openapi.json'");
	});

	it("serves the spec from a booted server using custom serverFileName and outputFile", async () => {
		const actionFile = await writeFixture(
			"custom-names-app/hello.server.js",
			"export async function hello() {\n\treturn 'hi';\n}\n",
		);

		const plugin = serverActions({
			routeTransform,
			serverFileName: "app-server.mjs",
			openAPI: { enabled: true, swaggerUI: false, outputFile: "api-spec.json" },
		});
		const emitted = await runBuild(plugin, [actionFile]);

		const { port } = await bootProductionServer(emitted, "custom-names-app", "app-server.mjs");

		const specResponse = await fetch(`http://localhost:${port}/api/openapi.json`);
		expect(specResponse.status).toBe(200);
		const spec = await specResponse.json();
		expect(spec.openapi).toBe("3.0.3");

		const actionResponse = await fetch(`http://localhost:${port}/api/hello/hello`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([]),
		});
		expect(actionResponse.status).toBe(200);
		expect(await actionResponse.json()).toBe("hi");
	}, 30000);
});

describe("silent option", () => {
	function createMockDevServer() {
		const watcherHandlers = {};
		return {
			server: {
				middlewares: { use: vi.fn() },
				watcher: {
					on: vi.fn((event, handler) => {
						watcherHandlers[event] = handler;
					}),
				},
				httpServer: null,
			},
			watcherHandlers,
		};
	}

	it("suppresses advisory warnings like module name collisions", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const dashFile = await writeFixture(
			"silent-collide/my-file.server.js",
			"export async function fromDash() {\n\treturn 'dash';\n}\n",
		);
		const underscoreFile = await writeFixture(
			"silent-collide/my_file.server.js",
			"export async function fromUnderscore() {\n\treturn 'underscore';\n}\n",
		);

		const plugin = serverActions({ silent: true });
		await plugin.load(dashFile);
		await plugin.load(underscoreFile);

		expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("Module name collision"))).toBe(false);
	});

	it("emits advisory warnings by default", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const dashFile = await writeFixture(
			"loud-collide/my-file.server.js",
			"export async function fromDash() {\n\treturn 'dash';\n}\n",
		);
		const underscoreFile = await writeFixture(
			"loud-collide/my_file.server.js",
			"export async function fromUnderscore() {\n\treturn 'underscore';\n}\n",
		);

		const plugin = serverActions();
		await plugin.load(dashFile);
		await plugin.load(underscoreFile);

		expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("Module name collision"))).toBe(true);
	});

	it("suppresses the HMR cleanup log", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const actionFile = await writeFixture(
			"silent-hmr/todo.server.js",
			"export async function addTodo() {\n\treturn 'ok';\n}\n",
		);

		const plugin = serverActions({ silent: true });
		const { server, watcherHandlers } = createMockDevServer();
		plugin.configureServer(server);
		await plugin.load(actionFile);

		watcherHandlers.change(actionFile);

		expect(logSpy.mock.calls.some((call) => String(call[0]).includes("[HMR] Cleaned up server module"))).toBe(false);
	});

	it("emits the HMR cleanup log by default", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const actionFile = await writeFixture(
			"loud-hmr/todo.server.js",
			"export async function addTodo() {\n\treturn 'ok';\n}\n",
		);

		const plugin = serverActions();
		const { server, watcherHandlers } = createMockDevServer();
		plugin.configureServer(server);
		await plugin.load(actionFile);

		watcherHandlers.change(actionFile);

		expect(logSpy.mock.calls.some((call) => String(call[0]).includes("[HMR] Cleaned up server module"))).toBe(true);
	});

	it("still emits console.error when silent", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		// A nonexistent file exercises the load() error path (fs.readFile throws)
		const missingFile = path.join(fixtureRoot, "silent-error/missing.server.js");

		const plugin = serverActions({ silent: true });
		const result = await plugin.load(missingFile);

		expect(result).toContain("Failed to load server actions");
		expect(errorSpy).toHaveBeenCalled();
	});
});

describe("graceful shutdown in the generated production server", () => {
	it("emits SIGTERM/SIGINT handlers with connection draining and a 10s force-exit", async () => {
		const actionFile = await writeFixture(
			"shutdown-code/basic.server.js",
			"export async function ping() {\n\treturn 'pong';\n}\n",
		);

		const plugin = serverActions({ routeTransform });
		const emitted = await runBuild(plugin, [actionFile]);
		const serverCode = emitted["server.js"];

		expect(serverCode).toContain("process.once('SIGTERM'");
		expect(serverCode).toContain("process.once('SIGINT'");
		expect(serverCode).toContain("server.close(() => process.exit(0))");
		expect(serverCode).toContain("setTimeout(() => process.exit(1), 10000)");
		// Double signals must not re-run the shutdown sequence
		expect(serverCode).toContain("if (shuttingDown) return;");
	});

	it("finishes in-flight requests on SIGTERM, exits 0, and releases the port", async () => {
		const actionFile = await writeFixture(
			"shutdown-app/slow.server.js",
			[
				"export async function slowAction() {",
				"\tawait new Promise((resolve) => setTimeout(resolve, 800));",
				"\treturn 'finished';",
				"}",
				"",
			].join("\n"),
		);

		const plugin = serverActions({ routeTransform });
		const emitted = await runBuild(plugin, [actionFile]);
		const { port, proc } = await bootProductionServer(emitted, "shutdown-app");

		const exitPromise = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));

		// Fire an in-flight request, then signal while it is still processing
		const inFlight = fetch(`http://localhost:${port}/api/slow/slowAction`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([]),
		});
		await new Promise((resolve) => global.setTimeout(resolve, 150));
		proc.kill("SIGTERM");

		// The in-flight request completes instead of being dropped
		const response = await inFlight;
		expect(response.status).toBe(200);
		expect(await response.json()).toBe("finished");

		// The process drains and exits cleanly
		expect(await exitPromise).toBe(0);

		// The port is released: a new listener can bind to it
		await new Promise((resolve, reject) => {
			const probe = net.createServer();
			probe.once("error", reject);
			probe.listen(port, () => probe.close(resolve));
		});
	}, 30000);
});

describe("rate limiting middleware example (README)", () => {
	// Keep this file's contents in sync with the README's rate limiting example
	const rateLimitSource = [
		"// src/middleware/rate-limit.js",
		"const WINDOW_MS = 60_000; // 1 minute",
		"const MAX_REQUESTS = 100; // per IP per window",
		"",
		"// Module-level state: this Map lives in the module's scope and persists",
		"// across requests. That is exactly why this middleware must be passed as",
		"// a file path - toString() serialization would strip the module scope",
		"// and lose the Map.",
		"const hits = new Map();",
		"",
		"export default function rateLimit(req, res, next) {",
		'\tconst ip = req.ip || req.socket?.remoteAddress || "unknown";',
		"\tconst now = Date.now();",
		"\tconst entry = hits.get(ip);",
		"",
		"\tif (!entry || now - entry.windowStart >= WINDOW_MS) {",
		"\t\thits.set(ip, { count: 1, windowStart: now });",
		"\t\treturn next();",
		"\t}",
		"",
		"\tentry.count += 1;",
		"\tif (entry.count > MAX_REQUESTS) {",
		'\t\tres.set("Retry-After", String(Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000)));',
		'\t\treturn res.status(429).json({ error: true, status: 429, message: "Too many requests" });',
		"\t}",
		"",
		"\tnext();",
		"}",
		"",
	].join("\n");

	function createMockResponse() {
		return {
			set: vi.fn(),
			status: vi.fn().mockReturnThis(),
			json: vi.fn(),
		};
	}

	it("allows requests under the limit, rejects with 429 over it, and resets per window and per IP", async () => {
		const middlewarePath = await writeFixture("rate-limit/rate-limit.js", rateLimitSource);
		const { default: rateLimit } = await import(pathToFileURL(middlewarePath).href);

		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const next = vi.fn();
		const res = createMockResponse();

		// The first 100 requests from one IP pass through
		for (let i = 0; i < 100; i++) {
			rateLimit({ ip: "10.0.0.1" }, res, next);
		}
		expect(next).toHaveBeenCalledTimes(100);
		expect(res.status).not.toHaveBeenCalled();

		// Request 101 in the same window is rejected with 429 and Retry-After
		rateLimit({ ip: "10.0.0.1" }, res, next);
		expect(next).toHaveBeenCalledTimes(100);
		expect(res.status).toHaveBeenCalledWith(429);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }));
		expect(res.set).toHaveBeenCalledWith("Retry-After", "60");

		// The limiter is keyed by IP: another client is unaffected
		rateLimit({ ip: "10.0.0.2" }, res, next);
		expect(next).toHaveBeenCalledTimes(101);

		// After the window elapses, the original IP is allowed again
		now += 60_001;
		rateLimit({ ip: "10.0.0.1" }, res, next);
		expect(next).toHaveBeenCalledTimes(102);
	});

	it("falls back to the socket address when req.ip is absent", async () => {
		const middlewarePath = await writeFixture("rate-limit-socket/rate-limit.js", rateLimitSource);
		const { default: rateLimit } = await import(pathToFileURL(middlewarePath).href);

		const next = vi.fn();
		rateLimit({ socket: { remoteAddress: "192.168.1.7" } }, createMockResponse(), next);
		expect(next).toHaveBeenCalledTimes(1);
	});
});
