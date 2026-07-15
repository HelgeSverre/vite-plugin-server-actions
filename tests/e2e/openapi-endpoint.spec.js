import { test, expect } from "@playwright/test";

test.describe("OpenAPI endpoint", () => {
	test("should return OpenAPI spec with todo endpoints", async ({ request, baseURL }) => {
		// The dev server is already running via webServer config
		const response = await request.get(`${baseURL}/api/openapi.json`);
		expect(response.ok()).toBeTruthy();

		const spec = await response.json();
		console.log("OpenAPI spec paths:", Object.keys(spec.paths || {}));

		expect(spec.openapi).toBe("3.0.3");

		// Title varies by framework: each example configures "<Framework> Todo App API"
		const framework = test.info().project.name;
		const expectedTitle = `${framework.charAt(0).toUpperCase() + framework.slice(1)} Todo App API`;
		expect(spec.info.title).toBe(expectedTitle);
		expect(spec.paths).toBeDefined();

		// Check for expected endpoints with clean routes
		const paths = Object.keys(spec.paths || {});
		expect(paths.length).toBeGreaterThan(0);

		// With the default clean route transform, the paths should be:
		// src/actions/todo.server.js -> actions/todo
		expect(spec.paths["/api/actions/todo/getTodos"]).toBeDefined();
		expect(spec.paths["/api/actions/todo/addTodo"]).toBeDefined();
		expect(spec.paths["/api/actions/todo/updateTodo"]).toBeDefined();
		expect(spec.paths["/api/actions/todo/deleteTodo"]).toBeDefined();
	});
});
