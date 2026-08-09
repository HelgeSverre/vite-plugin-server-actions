import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "child_process";
import fs from "fs/promises";
import http from "http";
import net from "net";
import path from "path";
import serverActions from "../src/index.js";

// The production server serves client assets from the same directory as its
// generated implementation. These tests exercise the running server, because
// checking snippets in generated source cannot establish that Express will not
// serve an artifact first.
const fixtureRoot = path.join(process.cwd(), "node_modules", `vsa-static-${process.pid}-${Date.now()}`);
const serverProcesses = [];

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

async function getAvailablePort() {
	const probe = net.createServer();
	await new Promise((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", resolve);
	});
	const { port } = probe.address();
	await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
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
		let forceKillTimer;
		let finalTimeout;
		const finish = () => {
			global.clearTimeout(forceKillTimer);
			global.clearTimeout(finalTimeout);
			proc.off("exit", finish);
			resolve();
		};
		forceKillTimer = global.setTimeout(() => {
			proc.kill("SIGKILL");
			// A child that cannot be reaped must not leave this test run hanging.
			finalTimeout = global.setTimeout(finish, 1_000);
		}, 5_000);
		proc.once("exit", finish);
		proc.kill("SIGTERM");
	});
}

async function bootProductionServer(emitted, appName, serverFileName = "server.js") {
	const appDir = path.join(fixtureRoot, appName);
	const distDir = path.join(appDir, "dist");
	await fs.mkdir(distDir, { recursive: true });
	for (const [fileName, source] of Object.entries(emitted)) {
		const targetPath = path.join(distDir, fileName);
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.writeFile(targetPath, source, "utf-8");
	}
	await fs.writeFile(path.join(distDir, "index.html"), "<html>client</html>", "utf-8");
	await fs.mkdir(path.join(distDir, "assets"), { recursive: true });
	await fs.writeFile(path.join(distDir, "assets", "demo.js"), "console.log('client')", "utf-8");

	const port = await getAvailablePort();
	const proc = spawn(process.execPath, [path.join("dist", serverFileName)], {
		cwd: appDir,
		env: { ...process.env, PORT: String(port) },
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

// Use http.request rather than fetch: URL normalization by fetch would turn
// /nested/../actions.js into /actions.js before the production server sees it.
function request(port, requestPath, method) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, path: requestPath, method, headers: { Accept: "*/*" } },
			(res) => {
				let body = "";
				res.setEncoding("utf-8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode, body }));
			},
		);
		req.once("error", reject);
		req.end();
	});
}

async function expectHidden(port, secret, requestPath, method) {
	const response = await request(port, requestPath, method);
	expect(response.status, `${method} ${requestPath} must not serve a private build artifact`).toBe(404);
	expect(response.body, `${method} ${requestPath} must not disclose action source`).not.toContain(secret);
}

afterAll(async () => {
	await Promise.all(serverProcesses.map(stopServer));
	await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("Static source disclosure (private production artifacts)", () => {
	it("keeps private artifacts and URL spelling aliases private", async () => {
		const secret = "vsa_static_source_secret_7caa439e";
		const actionFile = await writeFixture(
			"disclosure-app/src/todo.server.js",
			`export const secret = ${JSON.stringify(secret)};\nexport async function listTodos() { return secret; }\n`,
		);
		const emitted = await runBuild(
			serverActions({
				routeTransform,
				openAPI: { enabled: true, info: { title: "Test API", version: "1.0.0", description: "test" } },
			}),
			[actionFile],
		);
		expect(emitted[".vsa/actions.js"]).toContain(secret);

		const port = await bootProductionServer(emitted, "disclosure-app");
		const exactPrivateFiles = ["server.js", "actions.js", "actions.d.ts", "openapi.json"];
		const actionSourceSpellings = [
			"/actions.js?cache=bypass",
			"/%61ctions.js", // percent-encoded character
			"/actions%2ejs", // percent-encoded dot
			"/.%2factions.js", // encoded separator after a dot segment
			"/assets%2f..%2factions.js", // encoded separators and traversal
			"/nested/../actions.js", // literal traversal (preserved by http.request)
			"/nested/%2e%2e/actions.js", // encoded dot segment
			"/ACTIONS.JS", // case variant on case-insensitive filesystems
			"//actions.js", // repeated leading separators
			"/assets//..//actions.js", // repeated internal separators
			// .vsa directory traversal — must not serve anything inside the private dir
			"/.vsa/actions.js",
			"/.vsa/actions.d.ts",
			"/.vsa/openapi.json",
			"/assets/../.vsa/actions.js", // literal traversal into .vsa
			"/.%2f.vsa/actions.js", // encoded leading separator
			"/assets%2f..%2f.vsa%2factions.js", // fully encoded traversal into .vsa
		];
		const serverSourceSpellings = [
			"/server.js?cache=bypass",
			"/%73erver.js", // percent-encoded character
			"/server%2ejs", // percent-encoded dot
			"/.%2fserver.js", // encoded separator after a dot segment
			"/..%2fdist%2fserver.js", // encoded traversal back into the static root
			"/assets%2f..%2fserver.js", // encoded separators and traversal
			"/nested/../server.js", // literal traversal
			"/nested/%2e%2e/server.js", // encoded dot segment
			"//server.js", // repeated leading separators
			"/assets//..//server.js", // repeated internal separators
		];

		for (const method of ["GET", "HEAD"]) {
			for (const fileName of exactPrivateFiles) {
				await expectHidden(port, secret, `/${fileName}`, method);
			}
			for (const requestPath of actionSourceSpellings) {
				await expectHidden(port, secret, requestPath, method);
			}
			for (const requestPath of serverSourceSpellings) {
				await expectHidden(port, secret, requestPath, method);
			}
		}

		const clientPage = await request(port, "/index.html", "GET");
		expect(clientPage.status).toBe(200);
		expect(clientPage.body).toContain("client");
		const clientAsset = await request(port, "/assets/demo.js", "GET");
		expect(clientAsset.status).toBe(200);
		expect(clientAsset.body).toContain("console.log");

		const spec = await request(port, "/api/openapi.json", "GET");
		expect(spec.status).toBe(200);
		expect(spec.body).toContain('"openapi"');
		expect(spec.body).not.toContain(secret);
		const docs = await request(port, "/api/docs/", "GET");
		expect(docs.status).toBe(200);
	});

	it("keeps a customized server filename private", async () => {
		const secret = "vsa_custom_server_secret_c6bdf16a";
		const serverFileName = "app-server.mjs";
		const actionFile = await writeFixture(
			"custom-server-app/src/todo.server.js",
			`export const secret = ${JSON.stringify(secret)};\nexport async function listTodos() { return secret; }\n`,
		);
		const emitted = await runBuild(serverActions({ routeTransform, serverFileName }), [actionFile]);
		expect(emitted[serverFileName]).toBeDefined();
		const port = await bootProductionServer(emitted, "custom-server-app", serverFileName);

		for (const method of ["GET", "HEAD"]) {
			await expectHidden(port, secret, `/${serverFileName}?download=1`, method);
			await expectHidden(port, secret, `/APP-SERVER.MJS`, method);
		}
	});
});
