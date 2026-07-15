import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import esbuild from "esbuild";
import serverActions from "../src/index.js";
import { createSecureModuleName, isValidModuleName } from "../src/security.js";

// Tests for production build behavior:
// - module names used as bare JS identifiers in generated code must be valid
//   identifiers even for digit-leading / reserved-word module names
// - file paths interpolated into generated code must be properly escaped
// - distinct files that collapse to the same module name must both survive
//   in the production bundle, with a warning
// - production openapi.json must include real request schemas
// - extensionless relative imports in .server.ts must resolve during prod bundling
// - generated prod server request-body/stack-trace handling

// Fixtures live inside the project so sanitizePath containment passes
const fixtureRoot = path.join(process.cwd(), "node_modules", `vsa-regress-build-${process.pid}-${Date.now()}`);
const fixtureRelative = path.relative(process.cwd(), fixtureRoot).replace(/\\/g, "/");

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

async function getAvailablePort(startPort = 4200) {
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
 * Write the emitted build artifacts to <dirName>/dist and boot dist/server.js
 * from a DIFFERENT cwd (a temp dir outside the app) - the generated server
 * must resolve its sibling files relative to itself, not the process cwd
 */
async function bootProductionServerFromForeignCwd(emitted, dirName) {
	const appDir = path.join(fixtureRoot, dirName);
	const distDir = path.join(appDir, "dist");
	await fs.mkdir(distDir, { recursive: true });
	for (const [fileName, source] of Object.entries(emitted)) {
		await fs.writeFile(path.join(distDir, fileName), source, "utf-8");
	}

	const foreignCwd = await fs.mkdtemp(path.join(os.tmpdir(), "vsa-foreign-cwd-"));
	const port = await getAvailablePort();
	const proc = spawn(process.execPath, [path.join(distDir, "server.js")], {
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

	return port;
}

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

describe("module names as JS identifiers", () => {
	it("createSecureModuleName produces valid identifiers for digit-leading and reserved-word names", () => {
		expect(createSecureModuleName("404")).toBe("_404");
		expect(createSecureModuleName("class")).toBe("_class");
		expect(createSecureModuleName("1todo")).toBe("_1todo");
		expect(createSecureModuleName("import")).toBe("_import");
		// Regular names are unchanged
		expect(createSecureModuleName("src/actions/todo.server.js")).toBe("src_actions_todo_server_js");
	});

	it("isValidModuleName rejects names that are not valid JS identifiers", () => {
		expect(isValidModuleName("404")).toBe(false);
		expect(isValidModuleName("class")).toBe(false);
		expect(isValidModuleName("1todo")).toBe(false);
		expect(isValidModuleName("my-module")).toBe(false); // dashes are not identifier chars
		expect(isValidModuleName("_404")).toBe(true);
		expect(isValidModuleName("_class")).toBe(true);
		expect(isValidModuleName("src_actions_todo")).toBe(true);
	});

	it("builds production bundle for digit-leading and reserved-word module names", async () => {
		const notFoundFile = await writeFixture(
			"identifiers/404.server.js",
			"export async function notFound() {\n\treturn 404;\n}\n",
		);
		const classFile = await writeFixture(
			"identifiers/class.server.js",
			"export async function run() {\n\treturn 'ok';\n}\n",
		);

		const plugin = serverActions({
			// Simulate root-level files: module name derived from the basename only
			moduleNameTransform: (filePath) =>
				filePath
					.split("/")
					.pop()
					.replace(/\.server\.(js|ts)$/, ""),
		});

		const emitted = await runBuild(plugin, [notFoundFile, classFile]);

		expect(emitted["actions.js"]).toContain("notFound");
		expect(emitted["actions.js"]).toContain("run");
		expect(emitted["server.js"]).toContain("serverActions._404.notFound");
		expect(emitted["server.js"]).toContain("serverActions._class.run");
	});
});

describe("path escaping in generated code", () => {
	it("builds when the file path contains a single quote and emits syntactically valid server.js", async () => {
		const quotedFile = await writeFixture(
			"o'brien/todo.server.js",
			"export async function addTodo(todo) {\n\treturn todo;\n}\n",
		);

		const plugin = serverActions();
		const emitted = await runBuild(plugin, [quotedFile]);

		expect(emitted["actions.js"]).toContain("addTodo");

		// The route (which contains the quote) must be embedded as an escaped string
		const expectedRoute = `/api/${fixtureRelative}/o'brien/todo/addTodo`;
		expect(emitted["server.js"]).toContain(JSON.stringify(expectedRoute));

		// The emitted server must parse as valid JavaScript
		await expect(esbuild.transform(emitted["server.js"], { loader: "js" })).resolves.toBeDefined();
	});

	it("generates prod server routes with an array body guard and dev-only error details", async () => {
		const plainFile = await writeFixture(
			"plain/basic.server.js",
			"export async function ping() {\n\treturn 'pong';\n}\n",
		);

		const plugin = serverActions();
		const emitted = await runBuild(plugin, [plainFile]);
		const serverCode = emitted["server.js"];

		// Non-array bodies must get the same 400 as development
		expect(serverCode).toContain("Array.isArray(req.body)");
		expect(serverCode).toContain("INVALID_REQUEST_BODY");

		// Stack traces/error details must be opt-in via NODE_ENV=development,
		// not leak whenever NODE_ENV merely isn't 'production'
		expect(serverCode).toContain("process.env.NODE_ENV === 'development'");
		expect(serverCode).not.toContain("process.env.NODE_ENV !== 'production'");
	});
});

describe("module name collisions", () => {
	it("keeps both modules in the production bundle and warns when names collide", async () => {
		const warnSpy = vi.spyOn(console, "warn");

		const dashFile = await writeFixture(
			"collide/my-file.server.js",
			"export async function fromDash() {\n\treturn 'dash';\n}\n",
		);
		const underscoreFile = await writeFixture(
			"collide/my_file.server.js",
			"export async function fromUnderscore() {\n\treturn 'underscore';\n}\n",
		);

		const plugin = serverActions();
		const emitted = await runBuild(plugin, [dashFile, underscoreFile]);

		// A deterministic disambiguation warning is emitted
		expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("Module name collision"))).toBe(true);

		// Both modules survive into the bundled actions and server routes
		expect(emitted["actions.js"]).toContain("fromDash");
		expect(emitted["actions.js"]).toContain("fromUnderscore");
		expect(emitted["server.js"]).toContain(JSON.stringify(`/api/${fixtureRelative}/collide/my-file/fromDash`));
		expect(emitted["server.js"]).toContain(JSON.stringify(`/api/${fixtureRelative}/collide/my_file/fromUnderscore`));
	});
});

describe("production OpenAPI schema discovery", () => {
	it("emits openapi.json with real request schemas when NODE_ENV=production during build", async () => {
		const schemaFile = await writeFixture(
			"openapi/todo.server.js",
			[
				'import { z } from "zod";',
				"",
				"export async function addTodo(todo) {",
				"\treturn todo;",
				"}",
				"",
				"addTodo.schema = z.tuple([z.object({ text: z.string() })]);",
				"",
			].join("\n"),
		);

		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production"; // vite build sets this before load() runs
		try {
			const plugin = serverActions({
				validation: { enabled: true, adapter: "zod" },
				openAPI: { enabled: true, swaggerUI: false },
			});

			const emitted = await runBuild(plugin, [schemaFile]);

			const spec = JSON.parse(emitted["openapi.json"]);
			const pathKey = Object.keys(spec.paths).find((key) => key.endsWith("/todo/addTodo"));
			expect(pathKey).toBeDefined();

			const requestSchema = spec.paths[pathKey].post.requestBody.content["application/json"].schema;
			// Without build-time discovery this is the generic fallback body with no
			// mention of the Zod schema's properties
			expect(JSON.stringify(requestSchema)).toContain('"text"');
		} finally {
			process.env.NODE_ENV = previousNodeEnv;
		}
	});
});

describe("build-time schema discovery side-effect isolation", () => {
	it("discovers schemas without executing user module side effects in the build process", async () => {
		const sideEffectFile = await writeFixture(
			"side-effects/pool.server.js",
			[
				'import { z } from "zod";',
				"",
				"// Simulates a DB pool / keepalive timer started at module top level",
				"globalThis.__VSA_BUILD_SIDE_EFFECT__ = (globalThis.__VSA_BUILD_SIDE_EFFECT__ || 0) + 1;",
				"",
				"export async function createItem(item) {",
				"\treturn item;",
				"}",
				"",
				"createItem.schema = z.tuple([z.object({ name: z.string() })]);",
				"",
			].join("\n"),
		);

		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";
		try {
			const plugin = serverActions({
				validation: { enabled: true, adapter: "zod" },
				openAPI: { enabled: true, swaggerUI: false },
			});

			const emitted = await runBuild(plugin, [sideEffectFile]);

			// Schemas were still discovered (in a disposable child process)...
			const spec = JSON.parse(emitted["openapi.json"]);
			const pathKey = Object.keys(spec.paths).find((key) => key.endsWith("/pool/createItem"));
			expect(pathKey).toBeDefined();
			const requestSchema = spec.paths[pathKey].post.requestBody.content["application/json"].schema;
			expect(JSON.stringify(requestSchema)).toContain('"name"');

			// ...but the module's top-level code never ran inside THIS process, so
			// pools/timers/listeners started by user modules cannot hang `vite build`
			expect(globalThis.__VSA_BUILD_SIDE_EFFECT__).toBeUndefined();
		} finally {
			process.env.NODE_ENV = previousNodeEnv;
			delete globalThis.__VSA_BUILD_SIDE_EFFECT__;
		}
	});
});

describe("TypeScript extensionless imports in production bundling", () => {
	it("resolves extensionless relative imports from .server.ts files", async () => {
		await writeFixture("ts-app/database.ts", 'export const db = { name: "mock-db" };\n');
		const tsServerFile = await writeFixture(
			"ts-app/svc.server.ts",
			[
				'import { db } from "./database";',
				"",
				"export async function getDb(): Promise<string> {",
				"\treturn db.name;",
				"}",
				"",
			].join("\n"),
		);

		const plugin = serverActions();
		const emitted = await runBuild(plugin, [tsServerFile]);

		expect(emitted["actions.js"]).toContain("getDb");
		expect(emitted["actions.js"]).toContain("mock-db");
	});
});

describe("generated server runtime: cwd-independence and user error statuses", () => {
	// Basename-based routes so endpoints don't include the temp dir path
	const routeTransform = (filePath, functionName) => {
		const base = path.basename(filePath).replace(/\.server\.(js|ts)$/, "");
		return `${base}/${functionName}`;
	};

	it("resolves static assets relative to server.js instead of the process cwd", async () => {
		const plainFile = await writeFixture(
			"static-paths/basic.server.js",
			"export async function ping() {\n\treturn 'pong';\n}\n",
		);

		const plugin = serverActions({ routeTransform });
		const emitted = await runBuild(plugin, [plainFile]);

		expect(emitted["server.js"]).toContain("express.static(__dirname)");
		expect(emitted["server.js"]).not.toContain("express.static('dist')");
	});

	it("serves static files, actions, and user-thrown statuses when booted from a different cwd", async () => {
		const actionFile = await writeFixture(
			"errstatus/pay.server.js",
			[
				"export async function payUp() {",
				'\tconst err = new Error("Payment required");',
				"\terr.status = 402;",
				"\tthrow err;",
				"}",
				"",
				"export async function forbidden() {",
				'\tconst err = new Error("No entry");',
				"\terr.statusCode = 403;",
				'\terr.code = "NO_ENTRY";',
				"\tthrow err;",
				"}",
				"",
				"export async function plainBoom() {",
				'\tthrow new Error("secret internals");',
				"}",
				"",
				"export async function hello() {",
				'\treturn "hello";',
				"}",
				"",
			].join("\n"),
		);

		const plugin = serverActions({ routeTransform });
		const emitted = await runBuild(plugin, [actionFile]);
		// A client asset emitted alongside server.js - it must be served even
		// when the server process is started from an unrelated directory
		emitted["index.html"] = "<!doctype html><html><body>vsa-static-ok</body></html>";

		const port = await bootProductionServerFromForeignCwd(emitted, "errstatus-app");

		const staticResponse = await fetch(`http://localhost:${port}/index.html`);
		expect(staticResponse.status).toBe(200);
		expect(await staticResponse.text()).toContain("vsa-static-ok");

		const callAction = async (name) => {
			const response = await fetch(`http://localhost:${port}/api/pay/${name}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify([]),
			});
			let data = null;
			try {
				data = await response.json();
			} catch {
				// non-JSON response
			}
			return { status: response.status, data };
		};

		const ok = await callAction("hello");
		expect(ok.status).toBe(200);
		expect(ok.data).toBe("hello");

		// error.status round-trips to the client (same as development)
		const payment = await callAction("payUp");
		expect(payment.status).toBe(402);
		expect(payment.data.error).toBe(true);
		expect(payment.data.status).toBe(402);
		expect(payment.data.message).toBe("Payment required");
		expect(payment.data.code).toBe("SERVER_ACTION_ERROR");

		// error.statusCode alias and custom error.code round-trip too
		const denied = await callAction("forbidden");
		expect(denied.status).toBe(403);
		expect(denied.data.status).toBe(403);
		expect(denied.data.message).toBe("No entry");
		expect(denied.data.code).toBe("NO_ENTRY");

		// Errors without a status stay opaque 500s
		const boom = await callAction("plainBoom");
		expect(boom.status).toBe(500);
		expect(boom.data.message).toBe("Internal server error");
		expect(JSON.stringify(boom.data)).not.toContain("secret internals");
	}, 30000);
});
