import fs from "fs/promises";
import path from "path";
import { z } from "zod";

const TODO_FILE = path.join(process.cwd(), "todos.json");

// Validation schemas
const TodoSchema = z.object({
	text: z
		.string()
		.min(1, "Todo text is required")
		.max(500, "Todo text must be less than 500 characters"),
	description: z
		.string()
		.max(800, "Description must be less than 800 characters")
		.optional(),
	priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
	fileData: z.string().optional(), // Base64 encoded file data
	fileName: z.string().optional(), // Original filename for extension
});

const TodoUpdateSchema = z.object({
	text: z
		.string()
		.min(1, "Todo text is required")
		.max(500, "Todo text must be less than 500 characters")
		.optional(),
	description: z
		.string()
		.max(800, "Description must be less than 800 characters")
		.optional(),
	completed: z.boolean().optional(),
	priority: z.enum(["low", "medium", "high"]).optional(),
	fileData: z.string().optional(), // Base64 encoded file data for updating
	fileName: z.string().optional(), // Original filename for extension
});

const TodoIdSchema = z
	.number()
	.int()
	.positive("Todo ID must be a positive integer");

async function readTodos() {
	try {
		const data = await fs.readFile(TODO_FILE, "utf8");
		return JSON.parse(data);
	} catch (error) {
		console.log(error);
		if (error.code === "ENOENT") {
			// File doesn't exist, return an empty array
			return [];
		}
		if (error instanceof SyntaxError) {
			// JSON is corrupted, reset to empty array
			console.error("Corrupted todos.json, resetting to empty array");
			await writeTodos([]);
			return [];
		}
		console.error("Error reading todos:", error);
		throw error;
	}
}

async function writeTodos(todos) {
	try {
		await fs.writeFile(TODO_FILE, JSON.stringify(todos, null, 2), "utf8");
	} catch (error) {
		console.error("Error writing todos:", error);
		throw error;
	}
}

/**
 * Get all todos
 * @returns {Promise<Array>} List of all todos
 */
export async function getTodos() {
	return await readTodos();
}

/**
 * Add a new todo
 * @param {Object} todo - The todo to add
 * @param {string} todo.text - The todo text
 * @param {string} [todo.description] - Optional description
 * @param {'low'|'medium'|'high'} [todo.priority='medium'] - Priority level
 * @param {string} [todo.fileData] - Base64 encoded file data
 * @param {string} [todo.fileName] - Original filename
 * @returns {Promise<Object>} The created todo
 */
export async function addTodo(todo) {
	const todos = await readTodos();
	const newTodo = {
		id: Date.now(),
		text: todo.text,
		description: todo.description || null,
		completed: false,
		priority: todo.priority || "medium",
		createdAt: new Date().toISOString(),
	};

	// Handle file upload if provided
	if (todo.fileData && todo.fileName) {
		const extension = path.extname(todo.fileName);
		const filename = `${newTodo.id}${extension}`;
		const filepath = path.join(process.cwd(), "public", "uploads", filename);

		// Ensure uploads directory exists
		await fs.mkdir(path.join(process.cwd(), "public", "uploads"), {
			recursive: true,
		});

		// Save the file
		const buffer = Buffer.from(todo.fileData, "base64");
		await fs.writeFile(filepath, buffer);

		newTodo.filepath = `/uploads/${filename}`;
	}

	todos.push(newTodo);
	await writeTodos(todos);
	return newTodo;
}

/**
 * Update an existing todo
 * @param {number} id - Todo ID
 * @param {Object} updates - Updates to apply
 * @param {string} [updates.text] - New todo text
 * @param {string} [updates.description] - New description
 * @param {boolean} [updates.completed] - Completion status
 * @param {'low'|'medium'|'high'} [updates.priority] - Priority level
 * @param {string} [updates.fileData] - Base64 encoded file data
 * @param {string} [updates.fileName] - Original filename
 * @returns {Promise<Object>} The updated todo
 */
export async function updateTodo(id, updates) {
	const todos = await readTodos();
	const index = todos.findIndex((todo) => todo.id === id);
	if (index !== -1) {
		const oldTodo = todos[index];

		// Handle file update if provided
		if (updates.fileData && updates.fileName) {
			// Delete old file if exists
			if (oldTodo.filepath) {
				try {
					const oldFilePath = path.join(
						process.cwd(),
						"public",
						oldTodo.filepath.slice(1)
					); // Remove leading /
					await fs.unlink(oldFilePath);
				} catch (error) {
					console.warn("Failed to delete old file:", error);
				}
			}

			// Save new file
			const extension = path.extname(updates.fileName);
			const filename = `${id}${extension}`;
			const filepath = path.join(process.cwd(), "public", "uploads", filename);

			// Ensure uploads directory exists
			await fs.mkdir(path.join(process.cwd(), "public", "uploads"), {
				recursive: true,
			});

			// Save the file
			const buffer = Buffer.from(updates.fileData, "base64");
			await fs.writeFile(filepath, buffer);

			updates.filepath = `/uploads/${filename}`;
			// Remove the fileData and fileName from updates
			delete updates.fileData;
			delete updates.fileName;
		}

		todos[index] = {
			...oldTodo,
			...updates,
			updatedAt: new Date().toISOString(),
		};
		await writeTodos(todos);
		return todos[index];
	}
	throw new Error("Todo not found");
}

/**
 * Delete a todo
 * @param {number} id - Todo ID to delete
 * @returns {Promise<void>}
 */
export async function deleteTodo(id) {
	const todos = await readTodos();
	const todoToDelete = todos.find((todo) => todo.id === id);

	// Delete associated file if exists
	if (todoToDelete && todoToDelete.filepath) {
		try {
			const filePath = path.join(
				process.cwd(),
				"public",
				todoToDelete.filepath.slice(1)
			); // Remove leading /
			await fs.unlink(filePath);
		} catch (error) {
			console.warn("Failed to delete file:", error);
		}
	}

	const newTodos = todos.filter((todo) => todo.id !== id);
	await writeTodos(newTodos);
}

// Attach schemas to functions for validation
addTodo.schema = z.tuple([TodoSchema]);
updateTodo.schema = z.tuple([TodoIdSchema, TodoUpdateSchema]);
deleteTodo.schema = z.tuple([TodoIdSchema]);
