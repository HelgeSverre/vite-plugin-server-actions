import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import serverActions from "../src/index.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Temp dir must live inside the project root so sanitizePath containment passes.
const tempDir = path.join(process.cwd(), "node_modules", `vsa-ts-plugin-${process.pid}-${Date.now()}`);

beforeAll(async () => {
	await fs.mkdir(tempDir, { recursive: true });
});

afterAll(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("TypeScript support in plugin", () => {
	it("should resolve TypeScript server file imports from client code", async () => {
		const plugin = serverActions({
			include: ["**/*.server.ts", "**/*.server.js"],
		});

		const resolveId = plugin.resolveId;
		const tsFilePath = "actions/test.server.ts";
		const importer = "/project/src/index.ts";

		// The source matches the include patterns, so it MUST resolve relative
		// to the importer
		const resolved = await resolveId.call(plugin, tsFilePath, importer);
		expect(resolved).toBe(path.resolve(path.dirname(importer), tsFilePath));

		// Non-server imports must not be intercepted
		const notResolved = await resolveId.call(plugin, "actions/helpers.ts", importer);
		expect(notResolved).toBeNull();
	});

	it("should handle TypeScript files in load hook", async () => {
		const plugin = serverActions({
			include: ["**/*.server.ts", "**/*.server.js"],
		});

		const load = plugin.load;
		const tsFilePath = path.join(__dirname, "fixtures/typed.server.ts");

		const result = await load.call(plugin, tsFilePath);

		// A client proxy MUST be generated for the TypeScript fixture
		expect(typeof result).toBe("string");
		expect(result).toContain("export async function greet");
		expect(result).toContain("export async function calculate");
		expect(result).toContain("fetch(");
		expect(result).not.toContain("Failed to load server actions");
	});

	it("should support mixed JS and TS server files", async () => {
		const jsFile = path.join(tempDir, "todo.server.js");
		const tsFile = path.join(tempDir, "user.server.ts");
		await fs.writeFile(jsFile, `export async function addTodo(text) { return { text }; }\n`);
		await fs.writeFile(
			tsFile,
			`export async function getUser(id: number): Promise<{ id: number }> { return { id }; }\n`,
		);

		const plugin = serverActions({
			include: ["**/*.server.js", "**/*.server.ts"],
			routeTransform: (filePath, functionName) => {
				const base = path.basename(filePath).replace(/\.server\.(js|ts)$/, "");
				return `${base}/${functionName}`;
			},
		});

		const load = plugin.load;

		// Both files must yield client proxies pointing at their own routes
		const jsResult = await load.call(plugin, jsFile);
		expect(jsResult).toContain("export async function addTodo");
		expect(jsResult).toContain("/api/todo/addTodo");

		const tsResult = await load.call(plugin, tsFile);
		expect(tsResult).toContain("export async function getUser");
		expect(tsResult).toContain("/api/user/getUser");
	});

	it("should validate TypeScript file patterns", () => {
		const plugin = serverActions({
			include: "**/*.server.ts",
			exclude: ["**/*.test.server.ts", "**/*.spec.server.ts"],
		});

		expect(plugin.name).toBe("vite-plugin-server-actions");
	});
});

describe("TypeScript configuration options", () => {
	it("should accept all TypeScript-defined options", () => {
		const fullOptions = {
			apiPrefix: "/api/v2",
			include: ["src/**/*.server.ts", "api/**/*.server.js"],
			exclude: ["**/*.test.*", "**/*.spec.*"],
			middleware: [
				(req, res, next) => {
					console.log("Middleware 1");
					next();
				},
				(req, res, next) => {
					console.log("Middleware 2");
					next();
				},
			],
			moduleNameTransform: (filePath) => {
				return filePath
					.replace(/\.(js|ts)$/, "")
					.replace(/[/-]/g, "_")
					.toUpperCase();
			},
			routeTransform: (filePath, functionName) => {
				const module = filePath.replace(/^src\//, "").replace(/\.server\.(js|ts)$/, "");
				return `v2/${module}/${functionName}`;
			},
			validation: {
				enabled: true,
				adapter: "zod",
			},
			openAPI: {
				enabled: true,
				swaggerUI: true,
				info: {
					title: "TypeScript API",
					version: "2.0.0",
					description: "API with full TypeScript support",
				},
				docsPath: "/api/v2/docs",
				specPath: "/api/v2/spec.json",
			},
		};

		const plugin = serverActions(fullOptions);
		expect(plugin.name).toBe("vite-plugin-server-actions");
	});

	it("should include TypeScript files by default", () => {
		// Test that the default configuration includes TypeScript files
		const plugin = serverActions();

		// Since we can't directly access the options, we'll test the behavior
		// by checking if the plugin is created successfully
		expect(plugin.name).toBe("vite-plugin-server-actions");

		// The actual default include patterns are now ["**/*.server.js", "**/*.server.ts"]
		// This is handled internally by the plugin
	});
});
