# Vite Server Actions - Alpine.js TODO App Example

The same todo app as the Svelte/Vue/React examples, built with [Alpine.js](https://alpinejs.dev/) and [Vite Server Actions](https://github.com/HelgeSverre/vite-plugin-server-actions). Server actions save, list, update, and delete TODOs stored in a JSON file, with Zod validation and OpenAPI docs.

What makes this example special: it ships a small set of **Alpine helper primitives** in [`src/alpine-server-actions.js`](src/alpine-server-actions.js). The file is self-contained and heavily commented - **copy it into your own project** and register it as an Alpine plugin:

```javascript
import Alpine from "alpinejs";
import { serverActions } from "./alpine-server-actions.js";
import * as todos from "./actions/todo.server.js";

Alpine.plugin(serverActions({ todos }));
Alpine.start();
```

## The primitives

### `$server` - the action registry

Namespaced access to your server actions from any Alpine expression. Typos fail loudly with a list of what is registered.

```html
<button @click="$server.todos.deleteTodo(42)">Delete</button>
```

### `$action(fn)` - reactive call state

Wraps an action in a callable object with reactive `pending` / `error` / `data` / `ok` state. Each instance is independent, concurrent calls are latest-wins, and every settlement dispatches a bubbling `sa:success` / `sa:error` event.

```html
<li x-data="{ remove: $action($server.todos.deleteTodo) }">
  <button @click="remove(todo.id)" :disabled="remove.pending">Delete</button>
  <span x-show="remove.error" x-text="remove.error?.message"></span>
</li>
```

### `x-action` - declarative form submission

Put it on a `<form>`: on submit it serializes the fields into one object argument (file inputs become base64 `fileData`/`fileName`), calls the action, disables the submit button while pending, and exposes the call state as `$formAction`. The `.reset` modifier clears the form on success; 400 validation errors mark the offending inputs with `aria-invalid` and focus the first one.

```html
<form x-action.reset="$server.todos.addTodo">
  <input name="text" />
  <p x-text="$formAction.errorFor('text')"></p>
  <button type="submit" :disabled="$formAction.pending">Add Todo</button>
</form>
```

### `$query(fn, opts?)` - reactive reads

Fetches immediately, exposes `{ data, loading, error, refetch }`, and can auto-refetch on a bubbling event - pair it with the `sa:success` events from actions and forms and the list refreshes itself after every mutation.

```html
<main
  x-data="{ todos: $query($server.todos.getTodos, { refetchOn: 'sa:success' }) }"
>
  <template x-for="todo in todos.data ?? []">...</template>
</main>
```

## Routes

The plugin exposes each exported function of `src/actions/todo.server.js` as a clean hierarchical endpoint:

- `POST /api/actions/todo/getTodos`
- `POST /api/actions/todo/addTodo`
- `POST /api/actions/todo/updateTodo`
- `POST /api/actions/todo/deleteTodo`
- `GET /api/openapi.json` - OpenAPI 3.0 spec
- `GET /api/docs` - Swagger UI

## Commands

```shell
npm install
npm run dev      # development server
npm run build    # production build (client + dist/server.js)
npm run preview  # preview the production client build
npm run format   # prettier
```

To run the production build: `npm run build && node dist/server.js`.
