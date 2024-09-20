# ⚡ Vite Server Actions

[![npm version](https://img.shields.io/npm/v/vite-plugin-server-actions.svg?style=flat)](https://www.npmjs.com/package/vite-plugin-server-actions)
[![Downloads](https://img.shields.io/npm/dm/vite-plugin-server-actions.svg?style=flat)](https://www.npmjs.com/package/vite-plugin-server-actions)
[![Build Status](https://img.shields.io/github/workflow/status/HelgeSverre/vite-plugin-server-actions/CI)](https://github.com/HelgeSverre/vite-plugin-server-actions/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> 🚧 **Experimental:** This is currently a proof of concept. Use at your own risk.

**Vite Server Actions** is a Vite plugin that enables you to create server-side functions and call them from your
client-side code as if they were local functions.

## ✨ Features

- 🔄 Automatic API endpoint creation for server functions (e.g. `POST /api/todos/addTodo`)
- 🔗 Seamless client-side proxies for easy usage (e.g. `import {addTodo} from './server/todos.server.js'`)
- 🛠 Support for both development and production environments ( `vite build` )
- 🚀 Zero-config setup for instant productivity

## 🚀 Quick Start

1. Install the plugin:

```bash
# Install using npm
npm install vite-plugin-server-actions

# Or using yarn
yarn add vite-plugin-server-actions
```

2. Add to your `vite.config.js` file ([example](examples/todo-app/vite.config.js)):

```javascript
// vite.config.js
import { defineConfig } from "vite";
import serverActions from "vite-plugin-server-actions";

export default defineConfig({
  plugins: [serverActions()],
});
```

2. Create a server action file (e.g., `todo.server.js`):

You can put it anywhere in your project, but it has to end with `.server.js`.

```javascript
// ex: src/actions/todo.server.js
import fs from "fs";
import path from "path";

const TODO_FILE_PATH = path.join(process.cwd(), "list-of-todos.json");

export async function deleteTodoById(id) {
  const data = fs.readFileSync(TODO_FILE_PATH, "utf-8");
  const todos = JSON.parse(data);
  const newTodos = todos.filter((todo) => todo.id !== id);
  fs.writeFileSync(TODO_FILE_PATH, JSON.stringify(newTodos, null, 2));
}

export async function saveTodoToJsonFile(todo) {
  const data = fs.readFileSync(TODO_FILE_PATH, "utf-8");
  const todos = JSON.parse(data);
  todos.push(todo);
  fs.writeFileSync(TODO_FILE_PATH, JSON.stringify(todos, null, 2));
}

export async function listTodos() {
  const data = fs.readFileSync(TODO_FILE_PATH, "utf-8");
  return JSON.parse(data);
}
```

4. Import and use your server actions in your client-side code:

```svelte
<!-- ex: src/App.svelte -->
<script>
  import { deleteTodoById, listTodos, saveTodoToJsonFile } from "./actions/todo.server.js";

  let todos = [];
  let newTodoText = "";

  async function fetchTodos() {
    todos = await listTodos();
  }

  async function addTodo() {
    await saveTodoToJsonFile({ id: Math.random(), text: newTodoText });
    newTodoText = "";
    await fetchTodos();
}

  async function removeTodo(id) {
    await deleteTodoById(id);
    await fetchTodos();
}

  fetchTodos();
</script>

<div>
  <h1>Todos</h1>
  <ul>
    {#each todos as todo}
    <li>
      {todo.text}
      <button on:click="{() => removeTodo(todo.id)}">Remove</button>
    </li>
    {/each}
  </ul>
  <input type="text" bind:value="{newTodoText}" />
  <button on:click="{addTodo}">Add Todo</button>
</div>
```

That's it! Your server actions are now ready to use. 🎉

## 📚 How it works

**Vite Server Actions** creates an API endpoint for each server function you define. When you import a server action in
your client-side code, it returns a proxy function) that sends a request to the server endpoint instead of executing the
function locally.

In _development_, the server actions run as a middleware in the Vite dev server.
While in _production_, it's bundled into a single file that can be run with Node.js.

## 🔧 Configuration

Vite Server Actions works out of the box, but you can customize it by passing options to the plugin:

```javascript
serverActions({
  // Options (coming soon)
});
```

## 🛠️ Configuration Options

Coming soon...

## TODO

This is a proof of concept, and things are still missing, such as:

- [ ] Add configuration options
- [ ] Add tests
- [ ] Allow customizing the HTTP method for each action (e.g. `GET`, `POST`, `PUT`, `DELETE`)
- [ ] Make sure name collisions are handled correctly
- [ ] Make sure the actions are only available on the server when running in production mode.
- [ ] Add more examples (Vue, React, etc.)
- [ ] Publish to npm

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to
check [issues page](https://github.com/helgesverre/vite-plugin-server-actions/issues).

## 🧑‍💻 Development setup

```shell
# Clone the repository
git clone git@github.com:HelgeSverre/vite-plugin-server-actions.git
cd vite-plugin-server-actions

# Install dependencies
npm install
npm run dev

# Format code
npm run format

# Lint code
npm run lint
```

## 📝 License

This project is [MIT](https://opensource.org/licenses/MIT) licensed.
