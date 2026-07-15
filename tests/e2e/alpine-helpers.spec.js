import { test, expect } from "@playwright/test";

// Alpine-specific tests for the helper primitives in
// examples/alpine-todo-app/src/alpine-server-actions.js
// ($server / $action / x-action / $query). Only runs in the "alpine" project.
test.describe("Alpine server action helpers", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");
		await expect(page.locator("h1")).toContainText("Todo List - Alpine Edition");

		// Clean slate: delete all todos via the API, then reload
		const todos = await page.request.post("/api/actions/todo/getTodos", { data: [] });
		if (todos.ok()) {
			const todoList = await todos.json();
			for (const todo of todoList) {
				await page.request.post("/api/actions/todo/deleteTodo", { data: [todo.id] });
			}
		}
		await page.reload();
		await expect(page.locator("h1")).toContainText("Todo List - Alpine Edition");
		await expect(page.getByTestId("todo-item")).toHaveCount(0);
	});

	test.afterEach(async ({ page }) => {
		await page.close();
	});

	test("x-action exposes pending state and disables the submit button while in flight", async ({ page }) => {
		// Slow the addTodo endpoint down so the pending window is observable
		await page.route("**/api/actions/todo/addTodo", async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			await route.continue();
		});

		await page.getByTestId("todo-input").fill("Slow todo");
		await page.getByTestId("add-button").click();

		// While the request is delayed, $formAction.pending drives the UI
		await expect(page.getByTestId("add-button")).toBeDisabled();
		await expect(page.getByTestId("form-pending")).toBeVisible();

		// Once the request settles, the todo appears and pending state clears
		await expect(page.getByTestId("todo-text").filter({ hasText: "Slow todo" })).toBeVisible();
		await expect(page.getByTestId("form-pending")).not.toBeVisible();
	});

	test("x-action maps 400 validation errors to inputs (aria-invalid + focus + message)", async ({ page }) => {
		// 501 characters exceeds the 500-char Zod limit but passes HTML validation
		const tooLong = "x".repeat(501);
		await page.getByTestId("todo-input").fill(tooLong);
		await page.getByTestId("add-button").click();

		// The invalid input is marked and focused
		await expect(page.getByTestId("todo-input")).toHaveAttribute("aria-invalid", "true");
		await expect(page.getByTestId("todo-input")).toBeFocused();

		// The field-level message from the server's validationErrors is shown
		await expect(page.locator(".field-error").filter({ hasText: "less than 500 characters" })).toBeVisible();

		// No todo was created
		await expect(page.getByTestId("todo-item")).toHaveCount(0);

		// A successful submit clears the invalid mark again
		await page.getByTestId("todo-input").fill("Valid todo");
		await page.getByTestId("add-button").click();
		await expect(page.getByTestId("todo-text").filter({ hasText: "Valid todo" })).toBeVisible();
		await expect(page.getByTestId("todo-input")).not.toHaveAttribute("aria-invalid", "true");
	});

	test("x-action.reset clears the form after a successful submit", async ({ page }) => {
		await page.getByTestId("todo-input").fill("Reset me");
		await page.getByTestId("todo-description").fill("A description that should be cleared");
		await page.getByTestId("priority-select").selectOption("high");
		await page.getByTestId("add-button").click();

		await expect(page.getByTestId("todo-text").filter({ hasText: "Reset me" })).toBeVisible();

		// All fields are back to their defaults
		await expect(page.getByTestId("todo-input")).toHaveValue("");
		await expect(page.getByTestId("todo-description")).toHaveValue("");
		await expect(page.getByTestId("priority-select")).toHaveValue("medium");

		// The x-model bound state was re-synced too: empty text disables the button
		await expect(page.getByTestId("add-button")).toBeDisabled();
	});

	test("$query with refetchOn updates the list after mutations without a manual refresh", async ({ page }) => {
		// Adding via the form bubbles sa:success up to the $query on <main>,
		// which refetches - the form never touches the list state directly.
		await page.getByTestId("todo-input").fill("Refetched todo");
		await page.getByTestId("add-button").click();
		await expect(page.getByTestId("todo-text").filter({ hasText: "Refetched todo" })).toBeVisible();

		// A row-level $action (toggle) also triggers the refetch
		await page.getByTestId("todo-checkbox").click();
		await expect(page.locator(".todo-item .todo-text.completed")).toContainText("Refetched todo");

		// And so does delete
		await page.getByTestId("delete-button").click();
		await expect(page.getByTestId("todo-item")).toHaveCount(0);
	});

	test("independent $action instances do not share pending state", async ({ page }) => {
		// Create two rows
		for (const text of ["Row A", "Row B"]) {
			await page.getByTestId("todo-input").fill(text);
			await page.getByTestId("add-button").click();
			await expect(page.getByTestId("todo-text").filter({ hasText: text })).toBeVisible();
		}

		// Delay all deletes so we can observe the in-flight state
		await page.route("**/api/actions/todo/deleteTodo", async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			await route.continue();
		});

		const rowA = page.getByTestId("todo-item").filter({ hasText: "Row A" });
		const rowB = page.getByTestId("todo-item").filter({ hasText: "Row B" });

		await rowA.getByTestId("delete-button").click();

		// Only row A's action is pending - row B's button stays enabled
		await expect(rowA.getByTestId("delete-button")).toBeDisabled();
		await expect(rowB.getByTestId("delete-button")).toBeEnabled();

		// Row A eventually disappears, row B is untouched
		await expect(rowA).toHaveCount(0);
		await expect(rowB).toHaveCount(1);
	});

	test("a full CRUD pass produces no console errors", async ({ page }) => {
		const errors = [];
		page.on("console", (message) => {
			if (message.type() === "error") errors.push(message.text());
		});
		page.on("pageerror", (error) => {
			errors.push(error.message);
		});

		// Create
		await page.getByTestId("todo-input").fill("Console check");
		await page.getByTestId("todo-description").fill("Ensure a clean console");
		await page.getByTestId("priority-select").selectOption("low");
		await page.getByTestId("add-button").click();
		await expect(page.getByTestId("todo-text").filter({ hasText: "Console check" })).toBeVisible();

		// Update (toggle completed)
		await page.getByTestId("todo-checkbox").click();
		await expect(page.locator(".todo-item .todo-text.completed")).toContainText("Console check");

		// Delete
		await page.getByTestId("delete-button").click();
		await expect(page.getByTestId("todo-item")).toHaveCount(0);

		expect(errors).toEqual([]);
	});
});
