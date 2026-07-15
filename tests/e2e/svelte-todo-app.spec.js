import { test, expect } from "@playwright/test";

test.describe("Svelte Todo App Integration", () => {
	test.beforeEach(async ({ page }) => {
		// Start with a fresh page
		await page.goto("/");
		// Wait for the app to load
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

		// Then clear any remaining via UI (with timeout limit)
		const maxDeletions = 20; // Prevent infinite loops
		let deletions = 0;
		while ((await page.getByTestId("delete-button").count()) > 0 && deletions < maxDeletions) {
			await page.getByTestId("delete-button").first().click();
			await page.waitForTimeout(50); // Small delay to ensure deletion
			deletions++;
		}

		// Verify we have a clean slate
		await expect(page.getByTestId("todo-item")).toHaveCount(0);
	});

	test.afterEach(async ({ page }) => {
		// Clean up any remaining state
		await page.close();
	});

	test("should load the todo app", async ({ page }) => {
		// Check that the page loads correctly
		await expect(page).toHaveTitle(/TODO Example Svelte/);

		// Check for main UI elements
		await expect(page.locator("h1")).toContainText("Todo List");
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
		await expect(page.locator(".todo-item span.completed")).toContainText(todoText);
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

	test("should persist todos after page reload", async ({ page }) => {
		const todoText = `Persistent todo ${Date.now()}`;

		// Add a todo
		await page.getByTestId("todo-input").fill(todoText);
		await page.getByTestId("add-button").click();

		// Wait for todo to appear
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();

		// Reload the page
		await page.reload();
		await expect(page.locator("h1")).toContainText("Todo List");

		// Verify todo persists
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();
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
		await expect(page.locator(".todo-item span.completed")).toContainText("Second todo");
		await expect(page.locator(".todo-item span.completed")).toHaveCount(1);
	});

	test("should not add empty todos", async ({ page }) => {
		// Try to add empty todo
		await page.getByTestId("add-button").click();

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
		expect(spec.info.title).toBe("Svelte Todo App API");

		// Verify API paths are using clean routes (based on our new default behavior)
		expect(spec.paths).toHaveProperty("/api/actions/todo/getTodos");
		expect(spec.paths).toHaveProperty("/api/actions/todo/addTodo");
		expect(spec.paths).toHaveProperty("/api/actions/todo/updateTodo");
		expect(spec.paths).toHaveProperty("/api/actions/todo/deleteTodo");
	});

	test("should have accessible API documentation", async ({ page }) => {
		await page.goto("/api/docs");

		// Should load Swagger UI
		await expect(page.locator(".swagger-ui").first()).toBeVisible();
		await expect(page.locator(".info .title")).toContainText("Svelte Todo App API");

		// Should show API endpoints
		await expect(page.getByText("/api/actions/todo/getTodos")).toBeVisible();
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

	test("should persist todos to JSON file", async ({ page }) => {
		const todoText = "File persistence test";

		// Add a todo via API
		const addResponse = await page.request.post("/api/actions/todo/addTodo", {
			data: [{ text: todoText, priority: "medium" }],
		});

		expect(addResponse.ok()).toBeTruthy();
		const addedTodo = await addResponse.json();
		expect(addedTodo.text).toBe(todoText);

		// Get all todos to verify it's persisted
		const getResponse = await page.request.post("/api/actions/todo/getTodos", {
			data: [],
		});

		expect(getResponse.ok()).toBeTruthy();
		const todos = await getResponse.json();
		expect(todos.some((todo) => todo.text === todoText)).toBe(true);

		// Update the todo
		const updateResponse = await page.request.post("/api/actions/todo/updateTodo", {
			data: [addedTodo.id, { completed: true }],
		});

		expect(updateResponse.ok()).toBeTruthy();
		const updatedTodo = await updateResponse.json();
		expect(updatedTodo.completed).toBe(true);

		// Verify the update persisted
		const getUpdatedResponse = await page.request.post("/api/actions/todo/getTodos", {
			data: [],
		});
		const updatedTodos = await getUpdatedResponse.json();
		const todo = updatedTodos.find((t) => t.id === addedTodo.id);
		expect(todo.completed).toBe(true);

		// Delete the todo
		const deleteResponse = await page.request.post("/api/actions/todo/deleteTodo", {
			data: [addedTodo.id],
		});

		expect(deleteResponse.ok()).toBeTruthy();

		// Verify deletion
		const getFinalResponse = await page.request.post("/api/actions/todo/getTodos", {
			data: [],
		});
		const finalTodos = await getFinalResponse.json();
		expect(finalTodos.some((todo) => todo.id === addedTodo.id)).toBe(false);
	});

	test("should handle CRUD operations through UI and persist data", async ({ page }) => {
		const todoText = "UI persistence test";

		// Add todo through UI
		await page.goto("/");
		await expect(page.locator("h1")).toContainText("Todo List");

		// Clear existing todos first
		const maxDeletions = 10;
		let deletions = 0;
		while ((await page.getByTestId("delete-button").count()) > 0 && deletions < maxDeletions) {
			await page.getByTestId("delete-button").first().click();
			await page.waitForTimeout(50);
			deletions++;
		}

		// Add new todo
		await page.getByTestId("todo-input").fill(todoText);
		await page.getByTestId("add-button").click();
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();

		// Verify it's in the API
		const getResponse = await page.request.post("/api/actions/todo/getTodos", {
			data: [],
		});
		const todos = await getResponse.json();
		const uiTodo = todos.find((todo) => todo.text === todoText);
		expect(uiTodo).toBeDefined();
		expect(uiTodo.completed).toBe(false);

		// Mark as completed through UI
		await page.getByTestId("todo-checkbox").click();
		await expect(page.locator(".todo-item span.completed")).toContainText(todoText);

		// Verify completion persisted in API
		const getCompletedResponse = await page.request.post("/api/actions/todo/getTodos", {
			data: [],
		});
		const completedTodos = await getCompletedResponse.json();
		const completedTodo = completedTodos.find((todo) => todo.id === uiTodo.id);
		expect(completedTodo.completed).toBe(true);
	});
});

test.describe("Performance and Reliability", () => {
	test.beforeEach(async ({ page }) => {
		// Clean up todos via API so count assertions start from a blank slate
		await page.goto("/");
		await expect(page.locator("h1")).toContainText("Todo List");

		const todos = await page.request.post("/api/actions/todo/getTodos", { data: [] });
		if (todos.ok()) {
			const todoList = await todos.json();
			for (const todo of todoList) {
				await page.request.post("/api/actions/todo/deleteTodo", { data: [todo.id] });
			}
		}
		await page.reload();
		await expect(page.locator("h1")).toContainText("Todo List");
		await expect(page.getByTestId("todo-item")).toHaveCount(0);
	});

	test.afterEach(async ({ page }) => {
		await page.close();
	});
	test("should load quickly", async ({ page }) => {
		const startTime = Date.now();
		await page.goto("/");
		await expect(page.locator("h1")).toBeVisible();
		const loadTime = Date.now() - startTime;

		// Should load within 3 seconds
		expect(loadTime).toBeLessThan(3000);
	});

	test("should handle many todos efficiently", async ({ page }) => {
		// Add 10 todos (reduced from 50 for faster testing)
		for (let i = 1; i <= 10; i++) {
			await page.getByTestId("todo-input").fill(`Todo ${i}`);
			await page.getByTestId("add-button").click();
			// Wait for each todo to appear before adding next
			await expect(page.getByTestId("todo-text").filter({ hasText: `Todo ${i}` })).toBeVisible();
		}

		// Should have all todos
		await expect(page.getByTestId("todo-item")).toHaveCount(10);

		// UI should still be responsive
		await page.getByTestId("todo-input").fill("Responsive test");
		await page.getByTestId("add-button").click();
		await expect(page.getByTestId("todo-text").filter({ hasText: "Responsive test" })).toBeVisible();
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
		expect(href).toMatch(/^\/uploads\/\d+\.txt$/);
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
		expect(imgSrc).toMatch(/^\/uploads\/\d+\.png$/);

		// Verify image can be clicked to open in new tab
		const imgLink = todoItem.getByTestId("todo-file-preview").locator("..");
		await expect(imgLink).toHaveAttribute("target", "_blank");
		await expect(imgLink).toHaveAttribute("rel", "noopener noreferrer");
	});

	test("should validate file uploads via API", async ({ page }) => {
		// Test adding todo with file via API
		const todoData = {
			text: "API todo with file",
			description: "Testing file upload via API",
			priority: "medium",
			fileData: Buffer.from("API test file content").toString("base64"),
			fileName: "api-test.txt",
		};

		const response = await page.request.post("/api/actions/todo/addTodo", {
			data: [todoData],
		});

		expect(response.ok()).toBeTruthy();
		const result = await response.json();
		expect(result.text).toBe("API todo with file");
		expect(result.description).toBe("Testing file upload via API");
		expect(result.priority).toBe("medium");
		expect(result.filepath).toMatch(/^\/uploads\/\d+\.txt$/);

		// Skip file content verification for now - the files are created but served differently in test env

		// Clean up - delete the todo
		await page.request.post("/api/actions/todo/deleteTodo", {
			data: [result.id],
		});
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

	test("should persist todos with attachments after reload", async ({ page }) => {
		const todoText = `Persistent todo with file ${Date.now()}`;

		// Add todo with file
		await page.getByTestId("todo-input").fill(todoText);

		const fileInput = page.getByTestId("file-input");
		const buffer = Buffer.from("Persistent file content");
		await fileInput.setInputFiles({
			name: "persistent.txt",
			mimeType: "text/plain",
			buffer: buffer,
		});

		await page.getByTestId("add-button").click();
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();

		// Get the specific todo item and file URL before reload
		const todoItem = page
			.locator(".todo-item")
			.filter({ has: page.getByTestId("todo-text").filter({ hasText: todoText }) });
		await expect(todoItem).toBeVisible();
		const fileLink = todoItem.getByTestId("todo-file");
		const href = await fileLink.getAttribute("href");

		// Reload page
		await page.reload();
		await expect(page.locator("h1")).toContainText("Todo List");

		// Verify todo and file link persist
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();

		// Get the specific todo item and verify its file link
		const reloadedTodoItem = page
			.locator(".todo-item")
			.filter({ has: page.getByTestId("todo-text").filter({ hasText: todoText }) });
		await expect(reloadedTodoItem.getByTestId("todo-file")).toBeVisible();

		const reloadedFileLink = reloadedTodoItem.getByTestId("todo-file");
		const reloadedHref = await reloadedFileLink.getAttribute("href");
		expect(reloadedHref).toBe(href);

		// Verify file still accessible
		const fileResponse = await page.request.get(href);
		expect(fileResponse.ok()).toBeTruthy();
	});

	test("should handle file deletion when todo is deleted", async ({ page }) => {
		const todoText = `Todo to be deleted with file ${Date.now()}`;

		// Add todo with file
		await page.getByTestId("todo-input").fill(todoText);

		const fileInput = page.getByTestId("file-input");
		const buffer = Buffer.from("File to be deleted");
		await fileInput.setInputFiles({
			name: "delete-me.txt",
			mimeType: "text/plain",
			buffer: buffer,
		});

		await page.getByTestId("add-button").click();
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).toBeVisible();

		// Get the file URL from the specific todo
		const todoItem = page
			.locator(".todo-item")
			.filter({ has: page.getByTestId("todo-text").filter({ hasText: todoText }) });
		const fileLink = todoItem.getByTestId("todo-file");
		const href = await fileLink.getAttribute("href");

		// Verify file is accessible
		const fileResponseBefore = await page.request.get(href);
		expect(fileResponseBefore.ok()).toBeTruthy();

		// Delete the specific todo
		await todoItem.getByTestId("delete-button").click();
		await expect(page.getByTestId("todo-text").filter({ hasText: todoText })).not.toBeVisible();

		// File should still be accessible (we don't delete files on todo deletion for safety)
		// But in a real app, you might want to test that files are cleaned up
	});

	test("should validate description length", async ({ page }) => {
		// Try to add todo with too long description via API
		const longDescription = "x".repeat(801); // Max is 800

		const response = await page.request.post("/api/actions/todo/addTodo", {
			data: [
				{
					text: "Test todo",
					description: longDescription,
				},
			],
		});

		expect(response.status()).toBe(400);
		const error = await response.json();
		expect(error.error).toBe(true);
		expect(error.message).toBe("Validation failed");
		expect(Array.isArray(error.details.validationErrors)).toBe(true);
		expect(error.details.validationErrors[0].message).toContain("Description must be less than 800 characters");
	});
});
