#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function resetTodos() {
	const templatePath = path.join(__dirname, "..", "examples", "todos.template.json");
	const exampleDirs = [
		"svelte-todo-app",
		"vue-todo-app",
		"react-todo-app",
		"react-todo-app-typescript",
		"alpine-todo-app",
	];

	try {
		// Read the template
		const templateContent = await fs.readFile(templatePath, "utf-8");

		// Reset todos.json in each example directory
		for (const dir of exampleDirs) {
			const todoPath = path.join(__dirname, "..", "examples", dir, "todos.json");
			await fs.writeFile(todoPath, templateContent, "utf-8");
			console.log(`✅ Reset ${dir}/todos.json`);
		}

		console.log("\n✨ All todos.json files have been reset to template state");
	} catch (error) {
		console.error("❌ Error resetting todos:", error.message);
		process.exit(1);
	}
}

resetTodos();
