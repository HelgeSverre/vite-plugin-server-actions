<script>
	import { onMount } from "svelte";
	import { addTodo, deleteTodo, getTodos, updateTodo } from "./todo.server.js";

	let todos = [];
	let newTodoText = "";

	onMount(() => {
		loadTodos();
	});

	async function loadTodos() {
		console.log("Loading todos...");
		todos = await getTodos();
	}

	async function handleAddTodo() {
		if (newTodoText.trim()) {
			const newTodo = await addTodo({ text: newTodoText });
			todos = [...todos, newTodo];
			newTodoText = "";
		}
	}

	async function handleToggleTodo(id) {
		const todo = todos.find((t) => t.id === id);
		if (todo) {
			const updatedTodo = await updateTodo(id, { completed: !todo.completed });
			todos = todos.map((t) => (t.id === id ? updatedTodo : t));
		}
	}

	async function handleDeleteTodo(id) {
		await deleteTodo(id);
		await loadTodos();
	}
</script>

<main>
	<h1>Todo List</h1>

	<form class="todo-form" on:submit|preventDefault={handleAddTodo}>
		<input class="todo-input" bind:value={newTodoText} placeholder="Add a new todo" />
		<button class="todo-button" type="submit">Add</button>
	</form>

	{#if todos.length > 0}
		<ul class="todo-list">
			{#each todos as todo}
				<li class="todo-item">
					<input type="checkbox" checked={todo.completed} on:change={() => handleToggleTodo(todo.id)} />
					<span class:completed={todo.completed}>{todo.text}</span>
					<button class="delete-button" on:click={() => handleDeleteTodo(todo.id)}>Delete</button>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	/* Basic global styling */
	main {
		font-family: sans-serif;
		max-width: 600px;
		margin: 2rem auto;
		padding: 1rem;
		background-color: #f8f8f8;
		border-radius: 8px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}

	h1 {
		text-align: center;
		color: #333;
		margin-bottom: 1rem;
	}

	.todo-form {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.todo-input {
		flex: 1;
		padding: 0.5rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		font-size: 1rem;
	}

	.todo-button {
		padding: 0.5rem 1rem;
		font-size: 1rem;
		color: white;
		background-color: #333;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.todo-button:hover {
		background-color: #555;
	}

	.todo-list {
		list-style: none;
		padding: 0;
		margin: 0;
		border-top: 1px solid #e0e0e0;
	}

	.todo-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem;
		border-bottom: 1px solid #e0e0e0;
	}

	.todo-item:last-child {
		border-bottom: none;
	}

	.todo-item input[type="checkbox"] {
		margin-right: 1rem;
	}

	.todo-item span {
		flex: 1;
		font-size: 1rem;
		color: #333;
	}

	.todo-item span.completed {
		text-decoration: line-through;
		color: #888;
	}

	.delete-button {
		padding: 0.25rem 0.5rem;
		font-size: 0.875rem;
		color: #fff;
		background-color: #cc0000;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.delete-button:hover {
		background-color: #ff3333;
	}
</style>
