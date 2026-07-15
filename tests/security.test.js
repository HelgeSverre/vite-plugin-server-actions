import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { sanitizePath, isValidModuleName, createSecureModuleName, createErrorResponse } from "../src/security.js";

const BASE = path.resolve("/project");

describe("security.js", () => {
	let consoleErrorSpy;
	const originalNodeEnv = process.env.NODE_ENV;

	beforeEach(() => {
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
		if (originalNodeEnv === undefined) {
			delete process.env.NODE_ENV;
		} else {
			process.env.NODE_ENV = originalNodeEnv;
		}
	});

	describe("sanitizePath", () => {
		it("resolves relative paths within the base directory", () => {
			expect(sanitizePath("src/actions/todo.server.js", BASE)).toBe(path.resolve(BASE, "src/actions/todo.server.js"));
		});

		it("accepts absolute paths contained in the base directory", () => {
			const inside = path.join(BASE, "src", "todo.server.js");
			expect(sanitizePath(inside, BASE)).toBe(inside);
		});

		it("accepts the base directory itself", () => {
			expect(sanitizePath(BASE, BASE)).toBe(BASE);
		});

		it("rejects non-string and empty inputs", () => {
			expect(sanitizePath(null, BASE)).toBeNull();
			expect(sanitizePath(undefined, BASE)).toBeNull();
			expect(sanitizePath("", BASE)).toBeNull();
			expect(sanitizePath(42, BASE)).toBeNull();
			expect(sanitizePath({}, BASE)).toBeNull();
		});

		// Containment must hold in EVERY environment, not just production
		const environments = ["test", "development", "production", undefined];
		for (const env of environments) {
			const label = env === undefined ? "unset" : env;

			it(`rejects relative traversal outside the base directory (NODE_ENV=${label})`, () => {
				if (env === undefined) {
					delete process.env.NODE_ENV;
				} else {
					process.env.NODE_ENV = env;
				}
				expect(sanitizePath("../../../etc/passwd", BASE)).toBeNull();
				expect(sanitizePath("src/../../escape.server.js", BASE)).toBeNull();
			});

			it(`rejects absolute paths outside the base directory (NODE_ENV=${label})`, () => {
				if (env === undefined) {
					delete process.env.NODE_ENV;
				} else {
					process.env.NODE_ENV = env;
				}
				expect(sanitizePath("/etc/passwd", BASE)).toBeNull();
				expect(sanitizePath("/projectsibling/file.server.js", BASE)).toBeNull();
			});
		}

		it("rejects sibling directories sharing the base directory prefix", () => {
			// "/project-evil" starts with "/project" but is NOT contained in it
			expect(sanitizePath(`${BASE}-evil/file.server.js`, BASE)).toBeNull();
		});

		it("rejects paths containing null bytes", () => {
			expect(sanitizePath("src/evil\0.server.js", BASE)).toBeNull();
		});

		it("rejects Windows reserved device names", () => {
			expect(sanitizePath("src/con", BASE)).toBeNull();
			expect(sanitizePath("src/NUL.server.js", BASE)).toBeNull();
			expect(sanitizePath("src/com1.txt", BASE)).toBeNull();
		});

		describe("test-fixture synthetic path remapping", () => {
			it("remaps /src/, /project/ and /test/ prefixes under NODE_ENV=test only", () => {
				process.env.NODE_ENV = "test";
				expect(sanitizePath("/src/todo.server.js", BASE)).toBe(path.resolve(BASE, "src/todo.server.js"));
				expect(sanitizePath("/project/src/todo.server.js", BASE)).toBe(path.resolve(BASE, "src/todo.server.js"));
				expect(sanitizePath("/test/fixtures/a.server.js", BASE)).toBe(path.resolve(BASE, "test/fixtures/a.server.js"));
			});

			it("still rejects traversal in remapped synthetic paths", () => {
				process.env.NODE_ENV = "test";
				expect(sanitizePath("/src/../../../etc/passwd.server.js", BASE)).toBeNull();
			});

			it("does not remap synthetic prefixes outside NODE_ENV=test", () => {
				process.env.NODE_ENV = "development";
				expect(sanitizePath("/src/todo.server.js", BASE)).toBeNull();

				process.env.NODE_ENV = "production";
				expect(sanitizePath("/src/todo.server.js", BASE)).toBeNull();
			});
		});
	});

	describe("isValidModuleName", () => {
		it("accepts valid JavaScript identifiers", () => {
			expect(isValidModuleName("todo")).toBe(true);
			expect(isValidModuleName("src_actions_todo")).toBe(true);
			expect(isValidModuleName("_private")).toBe(true);
			expect(isValidModuleName("$dollar")).toBe(true);
			expect(isValidModuleName("module2")).toBe(true);
			expect(isValidModuleName("_404")).toBe(true);
		});

		it("rejects empty and non-string values", () => {
			expect(isValidModuleName("")).toBe(false);
			expect(isValidModuleName(null)).toBe(false);
			expect(isValidModuleName(undefined)).toBe(false);
			expect(isValidModuleName(123)).toBe(false);
		});

		it("rejects names that are not valid bare identifiers", () => {
			expect(isValidModuleName("my-module")).toBe(false); // dash
			expect(isValidModuleName("with.dot")).toBe(false); // dot (traversal vector)
			expect(isValidModuleName("../evil")).toBe(false);
			expect(isValidModuleName("2fa")).toBe(false); // leading digit
			expect(isValidModuleName("has space")).toBe(false);
			expect(isValidModuleName("path/segment")).toBe(false);
		});

		it("rejects reserved words that would break generated code", () => {
			for (const reserved of ["class", "delete", "default", "await", "import", "export", "eval", "arguments"]) {
				expect(isValidModuleName(reserved)).toBe(false);
			}
		});
	});

	describe("createSecureModuleName", () => {
		it("converts path-like names to underscore identifiers", () => {
			expect(createSecureModuleName("src/actions/todo")).toBe("src_actions_todo");
		});

		it("replaces dashes and unsafe characters with underscores", () => {
			expect(createSecureModuleName("my-file")).toBe("my_file");
			expect(createSecureModuleName("a@b!c")).toBe("a_b_c");
		});

		it("collapses repeated underscores and trims them from the ends", () => {
			expect(createSecureModuleName("__a//b--c__")).toBe("a_b_c");
		});

		it("prefixes digit-leading names so they stay valid identifiers", () => {
			expect(createSecureModuleName("404")).toBe("_404");
			expect(createSecureModuleName("2fa")).toBe("_2fa");
		});

		it("prefixes reserved words so they stay valid identifiers", () => {
			expect(createSecureModuleName("class")).toBe("_class");
			expect(createSecureModuleName("delete")).toBe("_delete");
		});

		it("always produces names accepted by isValidModuleName", () => {
			const inputs = ["src/actions/todo", "my-file", "404", "class", "2fa-auth/manage", "a@b!c", "await"];
			for (const input of inputs) {
				expect(isValidModuleName(createSecureModuleName(input)), `input: ${input}`).toBe(true);
			}
		});
	});

	describe("createErrorResponse", () => {
		it("creates the standard error envelope", () => {
			const error = createErrorResponse(404, "Function not found");
			expect(error).toEqual({
				error: true,
				status: 404,
				message: "Function not found",
				timestamp: expect.any(String),
			});
			// Timestamp must be a valid ISO date
			expect(new Date(error.timestamp).toISOString()).toBe(error.timestamp);
		});

		it("includes code and details when provided", () => {
			const error = createErrorResponse(400, "Bad request", "INVALID_REQUEST_BODY", { suggestion: "Send an array" });
			expect(error.code).toBe("INVALID_REQUEST_BODY");
			expect(error.details).toEqual({ suggestion: "Send an array" });
		});

		it("omits code and details keys when not provided", () => {
			const error = createErrorResponse(500, "Internal server error");
			expect(error).not.toHaveProperty("code");
			expect(error).not.toHaveProperty("details");
		});

		it("strips stack traces from details in production", () => {
			process.env.NODE_ENV = "production";
			const error = createErrorResponse(500, "Internal server error", "INTERNAL_ERROR", {
				stack: "Error: secret\n  at /srv/app/server.js:1:1",
				suggestion: "Contact support",
			});
			expect(error.details.stack).toBeUndefined();
			expect(error.details.suggestion).toBe("Contact support");
			expect(JSON.stringify(error)).not.toContain("/srv/app");
		});

		it("keeps stack traces outside production", () => {
			process.env.NODE_ENV = "development";
			const error = createErrorResponse(500, "Internal server error", "INTERNAL_ERROR", {
				stack: "Error: boom\n  at test.js:1:1",
			});
			expect(error.details.stack).toContain("boom");
		});
	});
});
