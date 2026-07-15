import { test, expect } from "@playwright/test";

// This test suite runs for all framework implementations (Svelte, Vue, React)
// The framework is determined by the project name in playwright.config.js
test.describe("Todo App Integration", () => {
	const getFrameworkName = () => {
		// Get the current project name from the test info
		return test.info().project.name;
	};

	test.beforeEach(async ({ page }) => {
		// Start with a fresh page
		await page.goto("/");

		// Wait for the app to load - all frameworks have "Todo List" in the h1
		await expect(page.locator("h1")).toContainText("Todo List");

		// More aggressive cleanup - delete all todos via API first
		try {
			const todos = await page.request.post("/api/actions/todo/getTodos", { data: [] });
			if (todos.ok()) {
				const todoList = await todos.json();
				// Delete each todo via API
				for (const todo of todoList) {
					await page.request.post("/api/actions/todo/deleteTodo", { data: [todo.id] });
				}
			}
		} catch (error) {
			// If API cleanup fails, continue with UI cleanup
		}

		// Reload so the UI state reflects the API cleanup (some apps keep
		// deleted todos rendered and error when re-deleting them via the UI)
		await page.reload();
		await expect(page.locator("h1")).toContainText("Todo List");

		// Then clear any remaining via UI (with safer cleanup)
		const maxDeletions = 10; // Prevent infinite loops
		let deletions = 0;

		try {
			while (deletions < maxDeletions) {
				const deleteButtons = await page.getByTestId("delete-button").all();
				if (deleteButtons.length === 0) break;

				await deleteButtons[0].click();
				await page.waitForTimeout(100); // Small delay to ensure deletion
				deletions++;
			}
		} catch (error) {
			// If UI cleanup fails, that's okay - API cleanup should have worked
		}

		// Verify we have a clean slate (or close enough)
		const itemCount = await page.getByTestId("todo-item").count();
		if (itemCount > 5) {
			throw new Error(`Too many todos remaining after cleanup: ${itemCount}`);
		}
	});

	test.afterEach(async ({ page }) => {
		// Clean up any remaining state
		await page.close();
	});

	test("should load the todo app", async ({ page }) => {
		const framework = getFrameworkName();

		// Check that the page loads correctly
		const frameworkTitle = framework.charAt(0).toUpperCase() + framework.slice(1);
		await expect(page).toHaveTitle(new RegExp(`TODO Example ${frameworkTitle}`, "i"));

		// Check for main UI elements
		await expect(page.locator("h1")).toContainText(`Todo List - ${frameworkTitle} Edition`);
		await expect(page.getByTestId("todo-input")).toBeVisible();
		await expect(page.getByTestId("add-button")).toContainText("Add Todo");
	});

	test("should add a new todo", async ({ page }) => {
		const todoText = `Test todo item ${Date.now()}`;

		// Add a new todo
		await page.getByTestId("todo-input").fill(todoText);
		await page.getByTestId("add-button").click();

		// Wait for the todo to appear
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();

		// Verify input is cleared
		await expect(page.getByTestId("todo-input")).toHaveValue("");
	});

	test("should mark todo as completed", async ({ page }) => {
		const todoText = `Complete me ${Date.now()}`;

		// Add a todo
		await page.getByTestId("todo-input").fill(todoText);
		await page.getByTestId("add-button").click();

		// Wait for todo to appear
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();

		// Mark as completed
		await page.getByTestId("todo-checkbox").click();

		// Verify todo is marked as completed (has the completed class)
		await expect(page.locator(".todo-item span.completed, .todo-item .todo-text.completed")).toContainText(todoText);
	});

	test("should delete a todo", async ({ page }) => {
		const todoText = `Delete me ${Date.now()}`;

		// Add a todo
		await page.getByTestId("todo-input").fill(todoText);
		await page.getByTestId("add-button").click();

		// Wait for todo to appear
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();

		// Delete the todo
		await page.getByTestId("delete-button").click();

		// Verify todo is removed
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).not.toBeVisible();
	});

	test("should handle multiple todos", async ({ page }) => {
		// Add multiple todos
		const todos = ["First todo", "Second todo", "Third todo"];

		for (const todoText of todos) {
			await page.getByTestId("todo-input").fill(todoText);
			await page.getByTestId("add-button").click();
			await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();
		}

		// Verify all todos are present
		await expect(page.getByTestId("todo-item")).toHaveCount(3);

		// Mark second todo as completed
		await page.getByTestId("todo-item").nth(1).getByTestId("todo-checkbox").click();

		// Verify only second todo is completed
		await expect(page.locator(".todo-item span.completed, .todo-item .todo-text.completed")).toContainText(
			"Second todo",
		);
		await expect(page.locator(".todo-item span.completed, .todo-item .todo-text.completed")).toHaveCount(1);
	});

	test("should not add empty todos", async ({ page }) => {
		const framework = getFrameworkName();

		if (framework === "svelte") {
			// Svelte doesn't disable the button, so just verify no todo is created
			await page.getByTestId("add-button").click();

			// Wait for potential network activity
			await page.waitForTimeout(500);
		} else {
			// Vue and React disable the button when input is empty
			await expect(page.getByTestId("add-button")).toBeDisabled();

			// Fill and clear the input
			await page.getByTestId("todo-input").fill("Test");
			await expect(page.getByTestId("add-button")).toBeEnabled();

			await page.getByTestId("todo-input").clear();
			await expect(page.getByTestId("add-button")).toBeDisabled();
		}

		// Should not create any todo items
		await expect(page.getByTestId("todo-item")).toHaveCount(0);
	});
});

test.describe("API Integration", () => {
	test.afterEach(async ({ page }) => {
		await page.close();
	});

	test("should have working API endpoints", async ({ page }) => {
		// Test OpenAPI spec endpoint
		const response = await page.request.get("/api/openapi.json");
		expect(response.ok()).toBeTruthy();

		const spec = await response.json();
		expect(spec.openapi).toBe("3.0.3");

		// Title varies by framework
		const framework = test.info().project.name;
		const expectedTitle = `${framework.charAt(0).toUpperCase() + framework.slice(1)} Todo App API`;
		expect(spec.info.title).toBe(expectedTitle);

		// Verify API paths are using clean routes
		expect(spec.paths).toHaveProperty("/api/actions/todo/getTodos");
		expect(spec.paths).toHaveProperty("/api/actions/todo/addTodo");
		expect(spec.paths).toHaveProperty("/api/actions/todo/updateTodo");
		expect(spec.paths).toHaveProperty("/api/actions/todo/deleteTodo");
	});

	test("should have accessible API documentation", async ({ page }) => {
		await page.goto("/api/docs");

		// Should load Swagger UI
		await expect(page.locator(".swagger-ui").first()).toBeVisible();

		// Title check
		const framework = test.info().project.name;
		const expectedTitle = `${framework.charAt(0).toUpperCase() + framework.slice(1)} Todo App API`;
		await expect(page.locator(".info .title")).toContainText(expectedTitle);

		// Should show API endpoints
		await expect(page.getByText("/api/actions/todo/getTodos")).toBeVisible();
		await expect(page.getByText("/api/actions/todo/addTodo")).toBeVisible();
	});

	test("should validate API requests", async ({ page }) => {
		// Test adding todo with invalid data via API
		const response = await page.request.post("/api/actions/todo/addTodo", {
			data: [{ text: "", priority: "medium" }], // Invalid: empty text
		});

		expect(response.status()).toBe(400);
		const error = await response.json();
		expect(error.error).toBe(true);
		expect(error.message).toBe("Validation failed");
		expect(error.details).toBeDefined();
		expect(Array.isArray(error.details.validationErrors)).toBe(true);
		expect(error.details.validationErrors[0].message).toContain("Todo text is required");
	});

	test("should handle valid API requests", async ({ page }) => {
		// Test adding a valid todo
		const response = await page.request.post("/api/actions/todo/addTodo", {
			data: [{ text: "API Test Todo", priority: "medium" }],
		});

		expect(response.ok()).toBeTruthy();
		const result = await response.json();
		expect(result.text).toBe("API Test Todo");
		expect(result.completed).toBe(false);
		expect(result.id).toBeDefined();
	});
});

test.describe("File Upload and Enhanced Features", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");
		await expect(page.locator("h1")).toContainText("Todo List");

		// More aggressive cleanup - delete all todos via API first
		try {
			const todos = await page.request.post("/api/actions/todo/getTodos", { data: [] });
			if (todos.ok()) {
				const todoList = await todos.json();
				// Delete each todo via API
				for (const todo of todoList) {
					await page.request.post("/api/actions/todo/deleteTodo", { data: [todo.id] });
				}
			}
		} catch (error) {
			// If API cleanup fails, continue with UI cleanup
		}

		// Reload so the UI state reflects the API cleanup (some apps keep
		// deleted todos rendered and error when re-deleting them via the UI)
		await page.reload();
		await expect(page.locator("h1")).toContainText("Todo List");

		// Clear any remaining via UI
		const maxDeletions = 20;
		let deletions = 0;
		while ((await page.getByTestId("delete-button").count()) > 0 && deletions < maxDeletions) {
			await page.getByTestId("delete-button").first().click();
			await page.waitForTimeout(50);
			deletions++;
		}

		// Verify clean slate
		await expect(page.getByTestId("todo-item")).toHaveCount(0);
	});

	test.afterEach(async ({ page }) => {
		await page.close();
	});

	test("should handle file uploads", async ({ page }) => {
		const todoText = `Todo with attachment ${Date.now()}`;
		const description = "This todo has a file attached";

		// Fill in todo details
		await page.getByTestId("todo-input").fill(todoText);
		await page.getByTestId("todo-description").fill(description);
		await page.getByTestId("priority-select").selectOption("high");

		// Upload a test file
		const fileInput = page.getByTestId("file-input");
		const buffer = Buffer.from("Test file content for E2E test");
		await fileInput.setInputFiles({
			name: "test-file.txt",
			mimeType: "text/plain",
			buffer: buffer,
		});

		// Verify file name is shown
		await expect(page.locator(".file-label-text")).toContainText("test-file.txt");

		// Submit the todo
		await page.getByTestId("add-button").click();

		// Verify todo appears with all details
		const todoItem = page
			.locator(".todo-item")
			.filter({ has: page.getByTestId("todo-text").filter({ hasText: todoText }) });
		await expect(todoItem).toBeVisible();
		await expect(todoItem.locator(".todo-description-text")).toContainText(description);
		await expect(todoItem.getByTestId("todo-priority")).toContainText("high");
		await expect(todoItem.getByTestId("todo-file")).toBeVisible();

		// Verify file link works
		const fileLink = todoItem.getByTestId("todo-file");
		const href = await fileLink.getAttribute("href");
		// Handle both basic examples (numeric) and TypeScript (hash-based) filename patterns
		expect(href).toMatch(/^\/uploads\/(\d+\.txt|test-file-[0-9a-f]{16}\.txt)$/);
	});

	test("should handle image uploads with preview", async ({ page }) => {
		const todoText = `Todo with image ${Date.now()}`;

		// Fill in todo details
		await page.getByTestId("todo-input").fill(todoText);

		// Create a simple PNG image (1x1 red pixel)
		const pngBuffer = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
			"base64",
		);

		// Upload the image
		const fileInput = page.getByTestId("file-input");
		await fileInput.setInputFiles({
			name: "test-image.png",
			mimeType: "image/png",
			buffer: pngBuffer,
		});

		// Submit the todo
		await page.getByTestId("add-button").click();

		// Wait for the todo to appear and get the specific todo item
		const todoItem = page
			.locator(".todo-item")
			.filter({ has: page.getByTestId("todo-text").filter({ hasText: todoText }) });
		await expect(todoItem).toBeVisible();

		// Verify image preview appears
		await expect(todoItem.getByTestId("todo-file-preview")).toBeVisible();

		// Verify image src is correct
		const imgSrc = await todoItem.getByTestId("todo-file-preview").getAttribute("src");
		// Handle both basic examples (numeric) and TypeScript (hash-based) filename patterns
		expect(imgSrc).toMatch(/^\/uploads\/(\d+\.png|test-image-[0-9a-f]{16}\.png)$/);

		// Verify image can be clicked to open in new tab
		const imgLink = todoItem.getByTestId("todo-file-preview").locator("..");
		await expect(imgLink).toHaveAttribute("target", "_blank");
		await expect(imgLink).toHaveAttribute("rel", "noopener noreferrer");
	});

	test("should handle priority and description fields", async ({ page }) => {
		// Add todo with all fields
		await page.getByTestId("todo-input").fill("Complete todo");
		await page.getByTestId("todo-description").fill("This is a detailed description of the todo item");
		await page.getByTestId("priority-select").selectOption("low");
		await page.getByTestId("add-button").click();

		// Verify all fields are displayed for the specific todo
		const completeTodoItem = page
			.locator(".todo-item")
			.filter({ has: page.getByTestId("todo-text").filter({ hasText: "Complete todo" }) });
		await expect(completeTodoItem.locator(".todo-description-text")).toContainText("This is a detailed description");
		await expect(completeTodoItem.getByTestId("todo-priority")).toContainText("low");

		// Add todo without description but with priority
		await page.getByTestId("todo-input").fill("Simple todo");
		await page.getByTestId("todo-description").clear();
		await page.getByTestId("priority-select").selectOption("medium");
		await page.getByTestId("add-button").click();

		// Verify todo appears with priority and no description
		const simpleTodoVisible = page
			.locator(".todo-item")
			.filter({ has: page.getByTestId("todo-text").filter({ hasText: "Simple todo" }) });
		await expect(simpleTodoVisible).toBeVisible();
		await expect(simpleTodoVisible.getByTestId("todo-priority")).toContainText("medium");

		// Description should not be present for simple todo
		const simpleTodoItem = page
			.locator(".todo-item")
			.filter({ has: page.getByTestId("todo-text").filter({ hasText: "Simple todo" }) });
		await expect(simpleTodoItem.locator(".todo-description-text")).not.toBeVisible();
	});
});
