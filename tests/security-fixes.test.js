import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import fs from "fs/promises";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import serverActions from "../src/index.js";
import { escapeRoutePath } from "../src/security.js";

// Regression tests for security fixes:
// - files inside node_modules are never treated as server actions
// - route paths derived from file names cannot inject Express route patterns
// - the generated production server never keys error details off NODE_ENV
// - build-time schema discovery writes to a private temp directory
// - generated .d.ts declarations cannot be broken out of via file names

const fixtureRoot = path.join(process.cwd(), "vsa-test-tmp", `vsa-secfix-${process.pid}-${Date.now()}`);
const serverProcesses = [];
const httpServers = [];

// Basename-based transform so endpoints don't embed the temp dir path
// (same convention as the other regression suites)
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

async function startServer(app) {
	const server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	httpServers.push(server);
	return server.address().port;
}

// Raw http.request so URL paths (e.g. containing ":") reach the server verbatim
function request(port, requestPath, { method = "POST", body = [] } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: requestPath,
				method,
				headers: { "Content-Type": "application/json" },
			},
			(res) => {
				let data = "";
				res.setEncoding("utf-8");
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => resolve({ status: res.statusCode, body: data }));
			},
		);
		req.on("error", reject);
		if (method !== "GET" && method !== "HEAD") req.write(JSON.stringify(body));
		req.end();
	});
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
		await plugin.load(id);
	}
	const { emitted, context } = createBundleContext();
	await plugin.generateBundle.call(context, {}, {});
	return emitted;
}

async function getAvailablePort() {
	const probe = net.createServer();
	await new Promise((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", resolve);
	});
	const { port } = probe.address();
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

function waitForServer(proc) {
	return new Promise((resolve, reject) => {
		let stderr = "";
		let settled = false;
		const timeout = global.setTimeout(() => finish(new Error(`Server failed to start: ${stderr}`)), 10_000);
		const finish = (error) => {
			if (settled) return;
			settled = true;
			global.clearTimeout(timeout);
			proc.stdout.off("data", onStdout);
			proc.off("error", onError);
			proc.off("exit", onExit);
			if (error) reject(error);
			else resolve();
		};
		const onStdout = (data) => {
			if (data.toString().includes("Server listening")) finish();
		};
		const onError = (error) => finish(error);
		const onExit = (code, signal) => finish(new Error(`Server exited before starting (${code ?? signal}): ${stderr}`));

		proc.stdout.on("data", onStdout);
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.once("error", onError);
		proc.once("exit", onExit);
	});
}

async function stopServer(proc) {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	await new Promise((resolve) => {
		const finish = () => {
			global.clearTimeout(forceKillTimer);
			proc.off("exit", finish);
			resolve();
		};
		const forceKillTimer = global.setTimeout(() => proc.kill("SIGKILL"), 5_000);
		proc.once("exit", finish);
		proc.kill("SIGTERM");
	});
}

async function bootProductionServer(emitted, appName, env = {}) {
	const appDir = path.join(fixtureRoot, appName);
	const distDir = path.join(appDir, "dist");
	await fs.mkdir(distDir, { recursive: true });
	for (const [fileName, source] of Object.entries(emitted)) {
		const targetPath = path.join(distDir, fileName);
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.writeFile(targetPath, source, "utf-8");
	}
	await fs.writeFile(path.join(distDir, "index.html"), "<html>client</html>", "utf-8");

	const port = await getAvailablePort();
	const proc = spawn(process.execPath, [path.join("dist", "server.js")], {
		cwd: appDir,
		env: { ...process.env, PORT: String(port), ...env },
	});
	try {
		await waitForServer(proc);
	} catch (error) {
		await stopServer(proc);
		throw error;
	}
	serverProcesses.push(proc);
	return port;
}

beforeAll(async () => {
	await fs.mkdir(fixtureRoot, { recursive: true });
});

afterAll(async () => {
	for (const proc of serverProcesses) {
		await stopServer(proc);
	}
	for (const server of httpServers) {
		await new Promise((resolve) => server.close(resolve));
	}
	await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("security fixes", () => {
	describe("escapeRoutePath", () => {
		it("escapes path-to-regexp metacharacters in every segment", () => {
			expect(escapeRoutePath(":id/hijack")).toBe("\\:id/hijack");
			expect(escapeRoutePath("a*b/c(d)?")).toBe("a\\*b/c\\(d\\)\\?");
			expect(escapeRoutePath("x[1]")).toBe("x\\[1\\]");
		});

		it("leaves ordinary route segments untouched (dots are escaped for strict literal matching)", () => {
			expect(escapeRoutePath("actions/todo/addTodo")).toBe("actions/todo/addTodo");
			expect(escapeRoutePath("my-folder/my.file.v2/list_items")).toBe(String.raw`my-folder/my\.file\.v2/list_items`);
		});
	});

	describe("node_modules policy", () => {
		it("never treats dependency .server.js files as server actions", async () => {
			// A path with a real node_modules segment, mirroring an imported
			// dependency file (kept inside the project root for sanitizePath)
			const depFile = await writeFixture(
				"node_modules/evil-pkg/index.server.js",
				`export async function backdoor() { return "pwned"; }\n`,
			);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);

			// load() must decline the file entirely - no proxy, no endpoints
			const result = await plugin.load(depFile);
			expect(result).toBeUndefined();

			const port = await startServer(captured.app);
			const response = await request(port, "/api/node_modules/evil-pkg/index/backdoor");
			expect(response.status).toBe(404);
		});

		it("still processes project files outside node_modules", async () => {
			const projectFile = await writeFixture(
				"project-app/todo.server.js",
				`export async function addTodo(text) { return text; }\n`,
			);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			const result = await plugin.load(projectFile);
			expect(result).toContain("export async function addTodo");

			const port = await startServer(captured.app);
			const response = await request(port, "/api/todo/addTodo", { body: ["hello"] });
			expect(response.status).toBe(200);
			expect(JSON.parse(response.body)).toBe("hello");
		});

		it("can be opted out of via allowNodeModules", async () => {
			const depFile = await writeFixture(
				"node_modules/workspace-pkg/index.server.js",
				`export async function wsAction() { return "ws"; }\n`,
			);

			const plugin = serverActions({ allowNodeModules: true });
			const result = await plugin.load(depFile);
			expect(result).toContain("export async function wsAction");
		});

		it("warns when a node_modules .server.js import is resolved", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const plugin = serverActions({ routeTransform });
				const importer = path.join(fixtureRoot, "project-app", "app.js");

				await plugin.resolveId("../node_modules/evil-pkg/index.server.js", importer);
				await plugin.resolveId("../node_modules/evil-pkg/index.server.js", importer);

				const warnings = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
				expect(warnings).toContain("NOT treated as a server action");
				// Warn only once per importer->source pair
				expect(warnings.split("NOT treated as a server action").length - 1).toBe(1);
			} finally {
				warnSpy.mockRestore();
			}
		});
	});

	describe("route-pattern injection", () => {
		it("registers colon filenames as literal routes in dev, not wildcards", async () => {
			const colonFile = await writeFixture(
				"colontest/:id.server.js",
				`export async function hijack() { return "injected"; }\n`,
			);

			const plugin = serverActions({ routeTransform });
			const { server, captured } = createMockViteServer();
			plugin.configureServer(server);
			const result = await plugin.load(colonFile);
			expect(result).toContain("export async function hijack");

			const port = await startServer(captured.app);

			// The wildcard spelling must NOT match...
			const hijackAttempt = await request(port, "/api/totally-unrelated/hijack");
			expect(hijackAttempt.status).toBe(404);

			// ...while the literal spelling does
			const literal = await request(port, "/api/:id/hijack");
			expect(literal.status).toBe(200);
			expect(JSON.parse(literal.body)).toBe("injected");
		});

		it("escapes route patterns in the generated production server", async () => {
			const colonFile = await writeFixture(
				"prodcolon/:id.server.js",
				`export async function hijack() { return "injected"; }\n`,
			);

			const plugin = serverActions({ routeTransform });
			const emitted = await runBuild(plugin, [colonFile]);

			// The emitted route must contain the escaped segment (embedded as a
			// valid string literal, so the backslash is JSON-escaped)
			const expectedLiteral = JSON.stringify(escapeRoutePath("/api/:id/hijack"));
			expect(emitted["server.js"]).toContain(expectedLiteral);
			// And must not contain an unescaped wildcard route
			expect(emitted["server.js"]).not.toContain('"/api/:id/hijack"');
		});

		it("does not expose dependency modules through the production bundle", async () => {
			const depFile = await writeFixture(
				"node_modules/evil-pkg/prod.server.js",
				`export async function backdoor() { return "pwned"; }\n`,
			);

			const plugin = serverActions({ routeTransform });
			const emitted = await runBuild(plugin, [depFile]);

			expect(emitted[".vsa/actions.js"]).not.toContain("backdoor");
			expect(emitted["server.js"]).not.toContain("/api/node_modules/");
		});

		it("boots a production server whose injected filename route only matches literally", async () => {
			const colonFile = await writeFixture(
				"bootcolon/:id.server.js",
				`export async function hijack() { return "injected"; }\n`,
			);

			const plugin = serverActions({ routeTransform });
			const emitted = await runBuild(plugin, [colonFile]);
			const port = await bootProductionServer(emitted, "boot-colon-app");

			const hijackAttempt = await request(port, "/api/totally-unrelated/hijack");
			expect(hijackAttempt.status).toBe(404);

			const literal = await request(port, "/api/:id/hijack");
			expect(literal.status).toBe(200);
			expect(JSON.parse(literal.body)).toBe("injected");
		});
	});

	describe("generated server error details", () => {
		async function buildCrashyApp() {
			const crashyFile = await writeFixture(
				"crashy/app.server.js",
				`export async function boom() {\n\treturn globalThis.__definitely_not_a_thing__.split("");\n}\n`,
			);
			return runBuild(serverActions({ routeTransform }), [crashyFile]);
		}

		it("never leaks stacks, even when booted with NODE_ENV=development", async () => {
			const emitted = await buildCrashyApp();
			expect(emitted["server.js"]).not.toContain("process.env.NODE_ENV");

			const port = await bootProductionServer(emitted, "crashy-dev-env-app", { NODE_ENV: "development" });
			const response = await request(port, "/api/app/boom");

			expect(response.status).toBe(500);
			expect(response.body).not.toContain("stack");
			expect(response.body).not.toContain("__definitely_not_a_thing__");
		});

		it("includes details only when explicitly configured via serverErrorDetails", async () => {
			const crashyFile = await writeFixture(
				"crashy-optin/app.server.js",
				`export async function boom() {\n\treturn globalThis.__also_not_a_thing__.split("");\n}\n`,
			);
			const emitted = await runBuild(serverActions({ serverErrorDetails: true, routeTransform }), [crashyFile]);
			expect(emitted["server.js"]).toContain("details: { message: error.message, stack: error.stack }");

			const port = await bootProductionServer(emitted, "crashy-optin-app");
			const response = await request(port, "/api/app/boom");
			expect(response.status).toBe(500);
			expect(response.body).toContain('"details"');
			expect(response.body).toContain("stack");
		});
	});

	describe("build-time schema discovery temp file", () => {
		it("does not write to a predictable shared-temp path", async () => {
			// Pre-plant a symlink at the OLD predictable naming scheme pointing at
			// a canary file. The build must never touch either.
			const canaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "vsa-secfix-canary-"));
			const canary = path.join(canaryDir, "canary.txt");
			await fs.writeFile(canary, "untouched", "utf-8");
			const trap = path.join(os.tmpdir(), `vsa-schemas-${process.pid}-${Date.now()}.json`);
			await fs.symlink(canary, trap, "file").catch(() => {});

			try {
				const plainFile = await writeFixture(
					"schemas/app.server.js",
					`export async function ping() { return "pong"; }\n`,
				);
				const plugin = serverActions({ openAPI: { enabled: true } });
				const emitted = await runBuild(plugin, [plainFile]);

				expect(emitted[".vsa/openapi.json"]).toBeDefined();
				expect(await fs.readFile(canary, "utf-8")).toBe("untouched");
				// The predictable path must not have been created as a regular file
				const trapStat = await fs.lstat(trap).catch(() => null);
				expect(trapStat?.isSymbolicLink()).toBe(true);
			} finally {
				await fs.rm(trap, { force: true }).catch(() => {});
				await fs.rm(canaryDir, { recursive: true, force: true }).catch(() => {});
			}
		});
	});

	describe("generated TypeScript definitions", () => {
		it("cannot be broken out of via crafted file names", async () => {
			const { generateTypeDefinitions } = await import("../src/type-generator.js");
			const evilName = 'x";\n}); process.exit(1); //.server.js';
			const modules = new Map([
				[
					"evil",
					{
						functions: ["f"],
						functionDetails: [{ name: "f", isAsync: true, params: [], returnType: null, jsdoc: null }],
						filePath: evilName,
					},
				],
			]);

			const output = generateTypeDefinitions(modules, {});

			// The declaration must embed the name as a proper quoted literal
			expect(output).toContain(`declare module ${JSON.stringify(evilName)} {`);
			// No unescaped breakout sequence may appear
			expect(output).not.toContain('declare module "x";');
		});
	});
});
