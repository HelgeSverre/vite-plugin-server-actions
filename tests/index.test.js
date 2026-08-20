import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import serverActions from "../src/index.js";
import fs from "fs/promises";

// NOTE: minimatch is intentionally NOT mocked so include/exclude tests
// exercise the real glob semantics used in production.

// Mock dependencies
vi.mock("fs/promises");

// Mock process.cwd to return a consistent value
vi.spyOn(process, "cwd").mockReturnValue("/project");

const mockExpressApp = {
	use: vi.fn(),
	post: vi.fn(),
};

vi.mock("express", () => {
	const express = vi.fn(() => mockExpressApp);
	express.json = vi.fn(() => vi.fn());
	return { default: express };
});

vi.mock("rollup", () => ({
	rollup: vi.fn(() => ({
		generate: vi.fn(() => ({
			output: [{ code: "mock bundled code" }],
		})),
	})),
}));

describe("vite-plugin-server-actions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should return a plugin object with correct name", () => {
		const plugin = serverActions();
		expect(plugin.name).toBe("vite-plugin-server-actions");
	});

	it("should have required plugin hooks", () => {
		const plugin = serverActions();
		expect(plugin).toHaveProperty("configureServer");
		expect(plugin).toHaveProperty("resolveId");
		expect(plugin).toHaveProperty("load");
		expect(plugin).toHaveProperty("generateBundle");
	});

	describe("resolveId", () => {
		it("should resolve .server.js files", async () => {
			const plugin = serverActions();
			// Relative specifiers are resolved (with leading ./ segments stripped
			// for include-pattern matching)
			const result = await plugin.resolveId("./todo.server.js", "/src/App.svelte");
			expect(result).toContain("todo.server.js");
		});

		it("should not resolve bare specifiers (package imports)", async () => {
			const plugin = serverActions();
			const result = await plugin.resolveId("some-pkg/todo.server.js", "/src/App.svelte");
			expect(result).toBeNull();
		});

		it("should not resolve bare specifiers (package imports)", async () => {
			const plugin = serverActions();
			const result = await plugin.resolveId("some-pkg/todo.server.js", "/src/App.svelte");
			expect(result).toBeNull();
		});

		it("should not resolve non-server files", async () => {
			const plugin = serverActions();
			const result = await plugin.resolveId("regular.js", "/src/App.svelte");
			expect(result).toBeNull();
		});

		it("should not resolve without importer", async () => {
			const plugin = serverActions();
			const result = await plugin.resolveId("todo.server.js");
			expect(result).toBeNull();
		});
	});

	describe("load", () => {
		it("should process .server.js files and extract functions", async () => {
			const mockCode = `
        export async function getTodos() {
          return [];
        }
        
        export function addTodo(todo) {
          return todo;
        }
      `;

			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions();

			// Mock the configureServer to set up the app
			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			const result = await plugin.load("/src/todo.server.js");

			expect(result).toContain("getTodos");
			expect(result).toContain("addTodo");
			// Default route format is now clean hierarchical: src/todo.server.js -> todo
			expect(result).toContain('fetch("/api/todo/getTodos"');
			expect(result).toContain('fetch("/api/todo/addTodo"');
		});

		it("should not process non-server files", async () => {
			const plugin = serverActions();
			const result = await plugin.load("/src/regular.js");
			expect(result).toBeUndefined();
		});

		it("should handle files with no exported functions", async () => {
			const mockCode = "const helper = () => {};";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions();

			// Mock the configureServer to set up the app
			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			const result = await plugin.load("/src/empty.server.js");

			expect(result).toBeDefined();
			expect(result).not.toContain("fetch");
		});
	});

	describe("generateClientProxy", () => {
		it("should generate correct proxy functions", async () => {
			const mockCode = "export async function testFunction() {}";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions();

			// Mock the configureServer to set up the app
			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			const result = await plugin.load("/src/test.server.js");

			expect(result).toContain("export async function testFunction");
			expect(result).toContain('fetch("/api/test/testFunction"');
			expect(result).toContain("method: 'POST'");
			expect(result).toContain("Content-Type': 'application/json'");
		});
	});

	describe("configureServer", () => {
		it("should set up express middleware", () => {
			const plugin = serverActions();
			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};

			plugin.configureServer(mockServer);

			expect(mockServer.middlewares.use).toHaveBeenCalled();
		});
	});

	describe("error handling", () => {
		it("should handle malformed server files gracefully", async () => {
			const mockCode = "invalid javascript code {{{";
			vi.mocked(fs.readFile).mockRejectedValue(new Error("Syntax error"));

			const plugin = serverActions();

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			const result = await plugin.load("/src/broken.server.js");

			expect(result).toContain("Failed to load server actions");
			expect(result).toContain("Syntax error");
		});

		it("should validate function names", async () => {
			const mockCode = `
				export function validFunction() {}
				export function invalidFunction123() {}
			`;
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions();

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			const result = await plugin.load("/src/test.server.js");

			expect(result).toContain("validFunction");
			expect(result).toContain("invalidFunction123"); // This is syntactically valid, so it should be included
		});

		it("should handle duplicate function names", async () => {
			const mockCode = `
				export function functionA() {}
				export function functionB() {}
				export function functionC() {}
			`;
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions();

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			const result = await plugin.load("/src/test.server.js");

			// Should include all functions (no actual duplicates in this case)
			expect(result).toContain("functionA");
			expect(result).toContain("functionB");
			expect(result).toContain("functionC");
		});

		it("should validate module names", async () => {
			const mockCode = "export function test() {}";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions();

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			// With real glob semantics, a path containing ".." segments never matches
			// the include patterns, so it is not processed at all
			const traversalResult = await plugin.load("/src/../../../etc/passwd.server.js");
			expect(traversalResult).toBeUndefined();

			// A path that matches the glob but resolves outside the project root
			// must be rejected by sanitizePath instead of being processed
			const outsideRootResult = await plugin.load("/etc/passwd.server.js");
			expect(outsideRootResult).toContain("Failed to load server actions");
			expect(outsideRootResult).toContain("Invalid file path detected");
		});

		it("should generate error handling in client proxy", async () => {
			const mockCode = "export function testFunction() {}";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions();

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			const result = await plugin.load("/src/test.server.js");

			expect(result).toContain("try {");
			expect(result).toContain("catch (error)");
			expect(result).toContain("errorData.message");
			expect(result).toContain("response.status");
		});
	});

	describe("configuration options", () => {
		it("should use custom API prefix", async () => {
			const mockCode = "export function testFunction() {}";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions({ apiPrefix: "/custom-api" });

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			const result = await plugin.load("/src/test.server.js");

			expect(result).toContain('fetch("/custom-api/test/testFunction"');
			expect(result).not.toContain('fetch("/api/test/testFunction"');
		});

		it("should respect include patterns", async () => {
			const mockCode = "export function testFunction() {}";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions({
				include: "**/actions/*.server.js",
			});

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			// Should process files matching the pattern
			const result1 = await plugin.load("/src/actions/test.server.js");
			expect(result1).toContain("testFunction");

			// Should not process files not matching the pattern
			const result2 = await plugin.load("/src/other/test.server.js");
			expect(result2).toBeUndefined();
		});

		it("should respect exclude patterns", async () => {
			const mockCode = "export function testFunction() {}";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions({
				exclude: ["**/excluded/**"],
			});

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			// Should not process excluded files
			const result1 = await plugin.load("/src/excluded/test.server.js");
			expect(result1).toBeUndefined();

			// Should process non-excluded files
			const result2 = await plugin.load("/src/included/test.server.js");
			expect(result2).toContain("testFunction");
		});

		it("should match root-relative include patterns against real glob semantics", async () => {
			const mockCode = "export async function actionFn() {}";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			// Root-relative pattern (no leading **/) as users naturally write it
			const plugin = serverActions({
				include: ["src/actions/**/*.server.js"],
			});

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			// Absolute id under the (mocked) project root /project matches via the
			// cwd-relative candidate
			const included = await plugin.load("/project/src/actions/todo.server.js");
			expect(included).toContain("actionFn");

			// Same file outside src/actions must not match
			const notIncluded = await plugin.load("/project/src/other/todo.server.js");
			expect(notIncluded).toBeUndefined();
		});

		it("should match root-relative exclude patterns against real glob semantics", async () => {
			const mockCode = "export async function actionFn() {}";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			const plugin = serverActions({
				exclude: ["src/internal/**"],
			});

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			// Excluded by the root-relative pattern even though the id is absolute
			const excluded = await plugin.load("/project/src/internal/secret.server.js");
			expect(excluded).toBeUndefined();

			// Sibling directory is still processed
			const included = await plugin.load("/project/src/public/open.server.js");
			expect(included).toContain("actionFn");
		});

		it("should match root-relative patterns against Vite's root when it differs from the cwd", async () => {
			const mockCode = "export async function actionFn() {}";
			vi.mocked(fs.readFile).mockResolvedValue(mockCode);

			// e.g. `vite packages/app` run from a monorepo root: the process cwd is
			// /project (mocked) but Vite's resolved root is elsewhere
			const plugin = serverActions({
				exclude: ["src/internal/**"],
			});
			plugin.configResolved({ root: "/monorepo/packages/app", server: { fs: { strict: true, allow: [] } } });

			const mockServer = {
				middlewares: {
					use: vi.fn(),
				},
			};
			plugin.configureServer(mockServer);

			// Root-relative exclude must match root-relative paths, not cwd-relative
			// ones ("packages/app/src/internal/...")
			const excluded = await plugin.load("/monorepo/packages/app/src/internal/secret.server.js");
			expect(excluded).toBeUndefined();

			// Sibling directory under the root is still processed
			const included = await plugin.load("/monorepo/packages/app/src/public/open.server.js");
			expect(included).toContain("actionFn");
		});

		it("should handle array and string patterns", async () => {
			const plugin1 = serverActions({
				include: "**/test.server.js",
			});

			const plugin2 = serverActions({
				include: ["**/test.server.js", "**/actions/*.server.js"],
			});

			// Both should work without errors
			expect(plugin1.name).toBe("vite-plugin-server-actions");
			expect(plugin2.name).toBe("vite-plugin-server-actions");
		});

		describe("module name collision handling", () => {
			it("should create unique module names for files with same basename", async () => {
				const mockCode = "export function testFunction() {}";
				vi.mocked(fs.readFile).mockResolvedValue(mockCode);

				const plugin = serverActions();

				const mockServer = {
					middlewares: {
						use: vi.fn(),
					},
				};
				plugin.configureServer(mockServer);

				// Process two files with same basename but different paths
				const result1 = await plugin.load("/src/admin/auth.server.js");
				const result2 = await plugin.load("/src/user/auth.server.js");

				// Both should have the function but with different module paths
				expect(result1).toContain("vite-server-actions: src_admin_auth");
				expect(result2).toContain("vite-server-actions: src_user_auth");

				// API endpoints should be unique
				expect(result1).toContain('fetch("/api/admin/auth/testFunction"');
				expect(result2).toContain('fetch("/api/user/auth/testFunction"');
			});
		});

		describe("middleware support", () => {
			it("should apply custom middleware", async () => {
				const mockCode = "export function testFunction() {}";
				vi.mocked(fs.readFile).mockResolvedValue(mockCode);

				// Mock middleware that adds a header
				const mockMiddleware = vi.fn((req, res, next) => {
					res.setHeader("X-Custom-Header", "test");
					next();
				});

				const plugin = serverActions({
					middleware: mockMiddleware,
				});

				const mockServer = {
					middlewares: {
						use: vi.fn(),
					},
				};
				plugin.configureServer(mockServer);

				// Load a server file to trigger endpoint creation
				await plugin.load("/src/test.server.js");

				// Verify middleware would be applied (we can't test actual execution in unit tests)
				expect(mockExpressApp.post).toHaveBeenCalled();
			});

			it("should handle array of middleware", async () => {
				const mockCode = "export function testFunction() {}";
				vi.mocked(fs.readFile).mockResolvedValue(mockCode);

				const middleware1 = vi.fn((req, res, next) => next());
				const middleware2 = vi.fn((req, res, next) => next());

				const plugin = serverActions({
					middleware: [middleware1, middleware2],
				});

				const mockServer = {
					middlewares: {
						use: vi.fn(),
					},
				};
				plugin.configureServer(mockServer);

				await plugin.load("/src/test.server.js");

				// Verify endpoint was created with middleware
				expect(mockExpressApp.post).toHaveBeenCalled();
			});

			describe("development safety checks", () => {
				beforeEach(() => {
					// Set NODE_ENV to development for these tests
					process.env.NODE_ENV = "development";
				});

				afterEach(() => {
					// Reset NODE_ENV
					delete process.env.NODE_ENV;
				});

				it("should add safety checks in development mode", async () => {
					const mockCode = "export function testFunction() {}";
					vi.mocked(fs.readFile).mockResolvedValue(mockCode);

					const plugin = serverActions();

					const mockServer = {
						middlewares: {
							use: vi.fn(),
						},
					};
					plugin.configureServer(mockServer);

					// NODE_ENV=development skips the test-fixture path remapping, so the
					// fixture must live under the (mocked) project root
					const result = await plugin.load("/project/src/test.server.js");

					// Should contain browser detection
					expect(result).toContain("if (typeof window !== 'undefined')");
					// Should contain the per-module proxy context marker
					expect(result).toContain("__VITE_SERVER_ACTIONS_PROXY__");
				});

				it("should validate function arguments in development", async () => {
					const mockCode = "export function testFunction() {}";
					vi.mocked(fs.readFile).mockResolvedValue(mockCode);

					const plugin = serverActions();

					const mockServer = {
						middlewares: {
							use: vi.fn(),
						},
					};
					plugin.configureServer(mockServer);

					// NODE_ENV=development skips the test-fixture path remapping, so the
					// fixture must live under the (mocked) project root
					const result = await plugin.load("/project/src/test.server.js");

					// Should contain argument validation
					expect(result).toContain("Functions cannot be serialized");
				});

				it("should not add safety checks in production", async () => {
					process.env.NODE_ENV = "production";

					const mockCode = "export function testFunction() {}";
					vi.mocked(fs.readFile).mockResolvedValue(mockCode);

					const plugin = serverActions();

					const mockServer = {
						middlewares: {
							use: vi.fn(),
						},
					};
					plugin.configureServer(mockServer);

					// Use a path under the (mocked) project root so the module is actually
					// processed and we assert on a real production proxy
					const result = await plugin.load("/project/src/test.server.js");

					// Should be a generated proxy, NOT containing development checks
					expect(result).toContain("vite-server-actions:");
					expect(result).not.toContain("SECURITY WARNING");
					expect(result).not.toContain("__VITE_SERVER_ACTIONS_PROXY__");
				});

				it("should not interfere with imports in transform hook", () => {
					const plugin = serverActions();
					const clientCode = `
						import { someFunction } from './actions/test.server.js';
						import utils from './utils.js';
					`;

					// Transform hook should return null since transformation is handled in load hook
					const result = plugin.transform(clientCode, "/src/App.jsx");
					expect(result).toBeNull();
				});
			});
		});
	});
});
