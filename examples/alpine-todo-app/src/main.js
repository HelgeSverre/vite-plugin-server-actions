import Alpine from "alpinejs";
import { serverActions } from "./alpine-server-actions.js";
// The plugin turns this import into client-side proxy functions that POST to
// /api/actions/todo/{functionName} - the namespace import gives us the whole
// module as a { getTodos, addTodo, updateTodo, deleteTodo } object.
import * as todos from "./actions/todo.server.js";
import "./app.css";

window.Alpine = Alpine;

Alpine.plugin(serverActions({ todos }));
Alpine.start();
