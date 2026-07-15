import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loggingMiddleware } from "../src/middleware.js";
import { analyzeMiddlewareSource } from "../src/middleware-analysis.js";
import { generateMiddlewareCode } from "../src/build-utils.js";

describe("loggingMiddleware", () => {
	let mockReq, mockRes, mockNext;
	let consoleLogSpy;

	beforeEach(() => {
		mockReq = {
			method: "POST",
			url: "/api/test_module/testFunction",
			body: { arg1: "value1", arg2: 123 },
		};

		mockRes = {
			json: vi.fn(function (data) {
				return this;
			}),
			status: vi.fn(function () {
				return this;
			}),
		};

		mockNext = vi.fn();
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	it("should log action trigger details", () => {
		loggingMiddleware(mockReq, mockRes, mockNext);

		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Server Action Triggered"));
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Module: test_module"));
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Function: testFunction"));
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Method: POST"));
		expect(mockNext).toHaveBeenCalled();
	});

	it("should log request body", () => {
		loggingMiddleware(mockReq, mockRes, mockNext);

		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Request Body:"));
		// Check that the body was logged (util.inspect will format it)
		expect(consoleLogSpy).toHaveBeenCalled();
	});

	it("should handle empty request body", () => {
		mockReq.body = {};
		loggingMiddleware(mockReq, mockRes, mockNext);

		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Request Body: (empty)"));
	});

	it("should log response time and data", async () => {
		const originalJsonSpy = vi.spyOn(mockRes, "json");
		loggingMiddleware(mockReq, mockRes, mockNext);

		const responseData = { result: "success" };
		mockRes.json(responseData);

		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Response sent in"));
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Response data:"));
		// The middleware wraps json, so check the original was called
		expect(originalJsonSpy).toHaveBeenCalled();
	});

	it("should log error responses", () => {
		loggingMiddleware(mockReq, mockRes, mockNext);

		mockRes.status(500);

		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Error response (500)"));
	});

	it("should label routes from originalUrl when mounted on the apiPrefix", () => {
		// Express strips the mount path from req.url for middleware mounted via
		// app.use(apiPrefix, ...), so labels must come from originalUrl
		mockReq.url = "/test_module/testFunction";
		mockReq.originalUrl = "/api/test_module/testFunction";

		loggingMiddleware(mockReq, mockRes, mockNext);

		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Module: test_module"));
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Function: testFunction"));
	});
});

describe("analyzeMiddlewareSource", () => {
	it("accepts a self-contained middleware function", () => {
		const fn = function authGuard(req, res, next) {
			const key = req.headers["x-api-key"];
			if (!key) {
				res.status(401).json({ error: "unauthorized" });
				return;
			}
			next();
		};

		const result = analyzeMiddlewareSource(fn.toString());
		expect(result.serializable).toBe(true);
		expect(result.freeVariables).toEqual([]);
	});

	it("accepts references to JS and Node globals", () => {
		const fn = (req, res, next) => {
			console.log(process.env.NODE_ENV, Date.now(), JSON.stringify(Buffer.from("x")), new URL("http://a"));
			next();
		};

		const result = analyzeMiddlewareSource(fn.toString());
		expect(result.serializable).toBe(true);
	});

	it("accepts newer runtime globals missing from older allowlists", () => {
		const fn = (req, res, next) => {
			req.meta = {
				wasm: typeof WebAssembly,
				ua: navigator.userAgent,
				iter: Iterator.from([]),
				enc: new TextEncoderStream(),
				dec: new TextDecoderStream(),
			};
			next();
		};

		const result = analyzeMiddlewareSource(fn.toString());
		expect(result.serializable).toBe(true);
		expect(result.freeVariables).toEqual([]);
	});

	it("reports which runtime globals an embeddable function references", () => {
		const fn = (req, res, next) => {
			req.id = crypto.randomUUID();
			req.ts = Date.now();
			next();
		};

		const result = analyzeMiddlewareSource(fn.toString());
		expect(result.serializable).toBe(true);
		expect(result.globalReferences.sort()).toEqual(["Date", "crypto"]);
	});

	it("reports no global references for a fully self-contained function", () => {
		const fn = (req, res, next) => next();

		const result = analyzeMiddlewareSource(fn.toString());
		expect(result.globalReferences).toEqual([]);
	});

	it("reports free identifiers captured from enclosing scope", () => {
		const secret = "s3cret";
		const fn = (req, res, next) => {
			req.auth = secret;
			next();
		};

		const result = analyzeMiddlewareSource(fn.toString());
		expect(result.serializable).toBe(false);
		expect(result.freeVariables).toContain("secret");
	});

	it("rejects the built-in logging middleware (captures the util import)", () => {
		// The exact identifier differs between runtimes (vitest's SSR transform
		// rewrites `util` to a generated import binding) - what matters is that
		// the captured import is detected as a free variable
		const result = analyzeMiddlewareSource(loggingMiddleware.toString());
		expect(result.serializable).toBe(false);
		expect(result.freeVariables.length).toBeGreaterThan(0);
	});

	it("rejects sources that are not valid standalone expressions", () => {
		// Object method shorthand toString() output cannot be re-parsed alone
		const result = analyzeMiddlewareSource("logging(req, res, next) { next(); }");
		expect(result.serializable).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

describe("generateMiddlewareCode", () => {
	let warnSpy;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("warns that embedded middleware's runtime-global references resolve to Node's globals", () => {
		const fn = (req, res, next) => {
			req.id = crypto.randomUUID();
			next();
		};

		const { mountCode } = generateMiddlewareCode({ apiPrefix: "/api", middleware: [fn] });

		// Still embedded - the warning discloses the assumption, it does not exclude
		expect(mountCode).toContain("randomUUID");
		const note = warnSpy.mock.calls.map((call) => String(call[0])).find((msg) => msg.includes("runtime global"));
		expect(note).toBeDefined();
		expect(note).toContain("middleware[0]");
		expect(note).toContain("crypto");
		expect(note).toContain("module path");
	});

	it("does not warn when embedded middleware references no globals", () => {
		const fn = (req, res, next) => next();

		generateMiddlewareCode({ apiPrefix: "/api", middleware: [fn] });

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("guards string-path mounts against modules without a function default export", () => {
		const { mountCode } = generateMiddlewareCode({ apiPrefix: "/api", middleware: ["./cors-middleware.js"] });
		const run = new Function("app", "serverActions", mountCode);
		const app = { use: vi.fn() };

		// A module with only named exports yields default === undefined; the
		// generated server must fail with a clear error, not app.use(undefined)
		expect(() => run(app, { __vsa_middleware_0: undefined })).toThrow(
			'middleware[0] module "./cors-middleware.js" must default-export a function',
		);
		expect(app.use).not.toHaveBeenCalled();

		const middleware = (req, res, next) => next();
		run(app, { __vsa_middleware_0: middleware });
		expect(app.use).toHaveBeenCalledWith("/api", middleware);
	});
});
