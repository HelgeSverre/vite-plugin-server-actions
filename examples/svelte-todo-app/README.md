# Vite Server Actions - TODO App Example

This is an example of a simple TODO application that
uses [Vite Server Actions](https://github.com/HelgeSverre/vite-plugin-server-actions)
and [Svelte](https://svelte.dev/) to demonstrate a real-world use case, where server actions are used to save, list, and
delete TODOs, with data stored in a JSON file.

## 🚀 Quick Start

### Clone the repository and install dependencies

```shell
git clone https://github.com/HelgeSverre/vite-plugin-server-actions.git
cd vite-plugin-server-actions/examples/svelte-todo-app
npm install
```

## Run in development mode

```shell
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) to view it in your browser. (Note: The port may vary, check the
console output for the correct port)

## Build and run in production mode

Server Actions works in production mode by bundling the server into a single file that can be run with Node.js.

Here's how you can build and run the example in production mode:

```shell
# Install dependencies and build the project
npm install
npm run build

# Run the generated express.js server
node dist/server.js
```

Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

## 📁 Project Structure

The important files and directories in this example are:

- `src/` - Contains the client-side Svelte application
- `src/actions/` - Contains the server action files (functions that are run on the server, note the `.server.js` suffix)
  - `src/actions/todo.server.js` - Contains server actions for managing TODOs, with Zod schemas attached for validation
- `src/App.svelte` - The main Svelte component that imports and calls the server actions to manage TODOs.
- `vite.config.js` - Vite configuration file that includes the Server Actions plugin `serverActions()`
- `dist/` - The output directory for the production build.
- `dist/server.js` - The express server that serves the client-side application and the server actions (automatically
  created by the plugin)
- `todos.json` - The JSON file where the TODOs are stored (serves the purpose of a simple database for this example)

## 🌐 API Endpoints

This example enables validation, OpenAPI documentation, and the built-in logging middleware. Server actions are exposed
at clean hierarchical routes, e.g. `src/actions/todo.server.js` exporting `addTodo` becomes
`POST /api/actions/todo/addTodo`.

- Swagger UI: [http://localhost:5173/api/docs](http://localhost:5173/api/docs)
- OpenAPI spec: [http://localhost:5173/api/openapi.json](http://localhost:5173/api/openapi.json)
