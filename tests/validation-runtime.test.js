import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createValidationMiddleware, SchemaDiscovery } from "../src/validation-runtime.js";

function createMockRes() {
	return {
		status: vi.fn().mockReturnThis(),
		json: vi.fn(),
	};
}

// A schema whose async validation throws a NON-Zod error, exercising the
// VALIDATION_INTERNAL_ERROR 500 path
const brokenSchema = {
	parse: () => {},
	parseAsync: async () => {
		throw new Error("boom at /srv/app/secret.js:1:1");
	},
};

function requestWithBrokenSchema() {
	return {
		body: ["data"],
		validationContext: { moduleName: "todo", functionName: "addTodo", schema: brokenSchema },
	};
}

describe("validation-runtime (production validation middleware)", () => {
	const originalNodeEnv = process.env.NODE_ENV;
	let consoleErrorSpy;

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

	describe("internal error detail gating", () => {
		it("does NOT leak error details/stack when NODE_ENV is unset", async () => {
			delete process.env.NODE_ENV;

			const middleware = createValidationMiddleware({ schemaDiscovery: new SchemaDiscovery() });
			const mockRes = createMockRes();
			const mockNext = vi.fn();

			await middleware(requestWithBrokenSchema(), mockRes, mockNext);

			expect(mockRes.status).toHaveBeenCalledWith(500);
			const payload = mockRes.json.mock.calls[0][0];
			expect(payload.code).toBe("VALIDATION_INTERNAL_ERROR");
			expect(payload.details).toBeUndefined();
			expect(JSON.stringify(payload)).not.toContain("/srv/app/secret.js");
			expect(mockNext).not.toHaveBeenCalled();
		});

		it("does NOT leak error details/stack in production", async () => {
			process.env.NODE_ENV = "production";

			const middleware = createValidationMiddleware({ schemaDiscovery: new SchemaDiscovery() });
			const mockRes = createMockRes();

			await middleware(requestWithBrokenSchema(), mockRes, vi.fn());

			expect(mockRes.status).toHaveBeenCalledWith(500);
			const payload = mockRes.json.mock.calls[0][0];
			expect(payload.details).toBeUndefined();
			expect(JSON.stringify(payload)).not.toContain("boom");
		});

		it("includes error details only when explicitly in development", async () => {
			process.env.NODE_ENV = "development";

			const middleware = createValidationMiddleware({ schemaDiscovery: new SchemaDiscovery() });
			const mockRes = createMockRes();

			await middleware(requestWithBrokenSchema(), mockRes, vi.fn());

			expect(mockRes.status).toHaveBeenCalledWith(500);
			const payload = mockRes.json.mock.calls[0][0];
			expect(payload.details).toBeDefined();
			expect(payload.details.message).toContain("boom");
			expect(payload.details.stack).toEqual(expect.any(String));
		});
	});
});
