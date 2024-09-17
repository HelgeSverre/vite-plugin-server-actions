import fs from "fs/promises";
import path from "path";

const TODO_FILE = path.join(process.cwd(), "todos.json");

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

export async function getTodos() {
	return await readTodos();
}

export async function addTodo(todo) {
	const todos = await readTodos();
	const newTodo = { id: Date.now(), text: todo.text, completed: false };
	todos.push(newTodo);
	await writeTodos(todos);
	return newTodo;
}

export async function updateTodo(id, updates) {
	const todos = await readTodos();
	const index = todos.findIndex((todo) => todo.id === id);
	if (index !== -1) {
		todos[index] = { ...todos[index], ...updates };
		await writeTodos(todos);
		return todos[index];
	}
	throw new Error("Todo not found");
}

export async function deleteTodo(id) {
	const todos = await readTodos();
	const newTodos = todos.filter((todo) => todo.id != id);
	console.log(newTodos);
	await writeTodos(newTodos);
}
