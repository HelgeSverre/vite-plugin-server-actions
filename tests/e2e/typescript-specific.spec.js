import { test, expect } from "@playwright/test";

test.describe("TypeScript React App", () => {
	test("should load and show todos", async ({ page }) => {
		// Navigate to the app
		await page.goto("/");

		// Wait for the app to load
		await page.waitForSelector('h1:has-text("Todo List - React-ts Edition")', { timeout: 10000 });

		// Ensure at least one todo exists so the list renders
		const addResponse = await page.request.post("/api/actions/todo/addTodo", {
			data: [{ text: "TypeScript smoke test todo", priority: "medium" }],
		});
		expect(addResponse.ok()).toBe(true);
		const addedTodo = await addResponse.json();

		// Check that the API call works
		const response = await page.request.post("/api/actions/todo/getTodos", {
			data: [],
		});

		console.log("API Response Status:", response.status());

		expect(response.ok()).toBe(true);

		// Check that todos are displayed after reload
		await page.reload();
		await page.waitForSelector(".todo-item", { timeout: 5000 });

		const todos = await page.locator(".todo-item").count();
		expect(todos).toBeGreaterThan(0);

		// Clean up the todo we created
		await page.request.post("/api/actions/todo/deleteTodo", { data: [addedTodo.id] });
	});

	test("API endpoints should work", async ({ request, baseURL }) => {
		// Test getTodos
		const getTodosResponse = await request.post(`${baseURL}/api/actions/todo/getTodos`, {
			data: [],
		});

		console.log("getTodos status:", getTodosResponse.status());

		expect(getTodosResponse.ok()).toBe(true);

		const todos = await getTodosResponse.json();
		expect(Array.isArray(todos)).toBe(true);
	});
});
