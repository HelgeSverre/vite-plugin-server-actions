/**
 * Alpine.js helpers for Vite Server Actions.
 *
 * This file is intentionally self-contained so you can copy it straight into
 * your own project. It turns the plain async functions that
 * vite-plugin-server-actions generates on the client into idiomatic Alpine
 * primitives:
 *
 *   $server           - a registry of your server modules ($server.todos.addTodo)
 *   $action(fn)       - a callable, reactive wrapper with pending/error/data state
 *   x-action          - a <form> directive that submits FormData to an action
 *   $query(fn, opts)  - a reactive "fetch on init" wrapper with refetch support
 *
 * Usage:
 *
 *   import Alpine from "alpinejs";
 *   import { serverActions } from "./alpine-server-actions.js";
 *   import * as todos from "./actions/todo.server.js";
 *
 *   Alpine.plugin(serverActions({ todos }));
 *   Alpine.start();
 */

/**
 * Create the Alpine plugin. Pass in the server modules you want to expose:
 *
 *   serverActions({ todos, users })  ->  $server.todos.addTodo, $server.users.login
 *
 * @param {Record<string, Record<string, Function>>} modules
 * @returns {(Alpine: import("alpinejs").Alpine) => void} an Alpine plugin function
 */
export function serverActions(modules) {
	return function (Alpine) {
		const registry = createRegistry(modules);

		// $server - the registry of server action functions.
		Alpine.magic("server", () => registry);

		// $action(fn) - wrap a server action in reactive call state.
		// `el` is the element the expression was evaluated on; sa:* events
		// bubble up from there so ancestors (like a $query) can react.
		Alpine.magic("action", (el) => (fn) => createAction(Alpine, fn, el));

		// $query(fn, opts) - fetch immediately, expose { data, loading, error, refetch }.
		Alpine.magic(
			"query",
			(el) => (fn, opts) => createQuery(Alpine, fn, el, opts)
		);

		// x-action - declarative form submission (see registerActionDirective).
		registerActionDirective(Alpine);
	};
}

// ---------------------------------------------------------------------------
// $server - module registry
// ---------------------------------------------------------------------------

/**
 * Build a frozen, proxy-guarded registry over the passed modules. A typo like
 * `$server.todo.addTodo` (instead of `todos`) fails immediately with a message
 * that lists what IS registered, instead of a confusing
 * "undefined is not a function" further down the line.
 */
function createRegistry(modules) {
	const moduleNames = Object.keys(modules);

	const wrapped = {};
	for (const [moduleName, mod] of Object.entries(modules)) {
		// Copy the module namespace into a plain frozen object so the Proxy
		// below fully controls property access.
		const functions = Object.freeze({ ...mod });
		const functionNames = Object.keys(functions).filter(
			(name) => typeof functions[name] === "function"
		);

		wrapped[moduleName] = new Proxy(functions, {
			get(target, prop, receiver) {
				// Let symbol lookups (Symbol.toPrimitive etc.) pass through -
				// the JS runtime probes these internally.
				if (typeof prop === "symbol" || prop in target) {
					return Reflect.get(target, prop, receiver);
				}
				throw new Error(
					`[alpine-server-actions] Unknown server action "$server.${moduleName}.${String(prop)}". ` +
						`Registered actions on "${moduleName}": ${functionNames.join(", ")}`
				);
			},
		});
	}

	return new Proxy(Object.freeze(wrapped), {
		get(target, prop, receiver) {
			if (typeof prop === "symbol" || prop in target) {
				return Reflect.get(target, prop, receiver);
			}
			throw new Error(
				`[alpine-server-actions] Unknown server module "$server.${String(prop)}". ` +
					`Registered modules: ${moduleNames.join(", ")}`
			);
		},
	});
}

// ---------------------------------------------------------------------------
// $action - callable reactive wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a server action in a callable object with reactive call state:
 *
 *   x-data="{ save: $action($server.todos.updateTodo) }"
 *   @click="save(todo.id, { completed: true })"
 *   :disabled="save.pending"
 *   x-text="save.error?.message"
 *
 * State properties (all reactive, safe to use in x-show / x-text / :bind):
 *   .pending  - true while the latest call is in flight
 *   .error    - null or { message, status, code, validationErrors }
 *   .data     - the last successful result
 *   .ok       - true after the latest call succeeded
 *
 * Plus a convenience helper:
 *   .errorFor(name) - the validation error message for a field, or null
 *
 * Calling the action returns the underlying promise, so you can still
 * `await save(...)` when you need the result. Rejections are pre-handled
 * internally (state.error captures them), so fire-and-forget calls in event
 * handlers never produce "unhandled rejection" noise.
 *
 * Concurrency: each call gets a monotonically increasing id, and only the
 * LATEST call is allowed to write state. A slow older response can never
 * clobber the result of a newer call.
 */
function createAction(Alpine, fn, el) {
	const state = Alpine.reactive({
		pending: false,
		error: null,
		data: null,
		ok: false,
	});

	let latestCallId = 0;

	function call(...args) {
		const callId = ++latestCallId;
		state.pending = true;
		state.error = null;
		state.ok = false;

		const promise = Promise.resolve()
			.then(() => fn(...args))
			.then((data) => {
				if (callId === latestCallId) {
					state.data = data;
					state.ok = true;
					state.pending = false;
					dispatch(el, "sa:success", { data });
				}
				return data;
			})
			.catch((rawError) => {
				const error = normalizeError(rawError);
				if (callId === latestCallId) {
					state.error = error;
					state.pending = false;
					dispatch(el, "sa:error", { error });
				}
				throw rawError;
			});

		// Mark the rejection as handled so fire-and-forget usage in templates
		// (e.g. @click="remove(todo.id)") doesn't trigger unhandledrejection.
		// Callers who await the returned promise still see the rejection.
		promise.catch(() => {});

		return promise;
	}

	/**
	 * Look up the validation error message for a form field by name.
	 * Server validation paths look like "0.text" (argument index + field
	 * path); we compare against the path with the argument index stripped.
	 */
	function errorFor(name) {
		const validationErrors = state.error?.validationErrors;
		if (!validationErrors) return null;
		const match = validationErrors.find(
			(issue) => fieldNameFromPath(issue.path) === name
		);
		return match ? match.message : null;
	}

	// A Proxy over the function keeps it callable while delegating state
	// property reads to the reactive object - so `action.pending` inside an
	// Alpine expression registers a reactive dependency and re-renders when
	// the call settles.
	return new Proxy(call, {
		get(target, prop, receiver) {
			if (prop === "errorFor") return errorFor;
			if (typeof prop === "string" && prop in state) return state[prop];
			return Reflect.get(target, prop, receiver);
		},
	});
}

// ---------------------------------------------------------------------------
// x-action - declarative form submission
// ---------------------------------------------------------------------------

/**
 * Usage:
 *
 *   <form x-action.reset="$server.todos.addTodo">
 *     <input name="text" />
 *     <select name="priority">...</select>
 *     <input type="file" name="file" />
 *     <button type="submit" :disabled="$formAction.pending">Add</button>
 *   </form>
 *
 * On submit the directive:
 *   1. prevents the default submission,
 *   2. serializes the form into ONE plain object argument (see buildPayload),
 *   3. calls the action through an internal $action instance that is exposed
 *      to the form's Alpine scope as `$formAction` (pending/error/data/ok),
 *   4. disables submit buttons while the call is in flight,
 *   5. with the `.reset` modifier, resets the form after success,
 *   6. on a 400 validation error, marks the offending inputs with
 *      aria-invalid="true" and focuses the first one.
 *
 * The same bubbling `sa:success` / `sa:error` events fire from the form, so a
 * `$query(..., { refetchOn: "sa:success" })` higher up refreshes automatically.
 */
function registerActionDirective(Alpine) {
	Alpine.directive(
		"action",
		(el, { expression, modifiers }, { evaluateLater, cleanup }) => {
			if (!(el instanceof HTMLFormElement)) {
				console.warn(
					"[alpine-server-actions] x-action only works on <form> elements",
					el
				);
				return;
			}

			// Alpine's evaluator auto-invokes an expression that evaluates to a bare
			// function (with no arguments!), which is not what we want - we need the
			// function itself so we can call it with the serialized form payload.
			// Wrapping the expression in an array literal ("[expr]") is the standard
			// trick to get the function back un-called.
			const getAction = evaluateLater(`[${expression}]`);

			// Resolve the expression at submit time (not once at init), so it can
			// point at anything in scope - including other $action state.
			const submitAction = createAction(
				Alpine,
				(payload) =>
					new Promise((resolve, reject) => {
						getAction(([fn]) => {
							if (typeof fn !== "function") {
								reject(
									new Error(
										`[alpine-server-actions] x-action expression "${expression}" is not a function`
									)
								);
								return;
							}
							Promise.resolve(fn(payload)).then(resolve, reject);
						});
					}),
				el
			);

			// Make `$formAction` available to every Alpine expression inside the
			// form (Alpine.addScopeToNode pushes an extra frame onto the scope
			// chain that child expressions resolve against).
			Alpine.addScopeToNode(el, { $formAction: submitAction });

			const onSubmit = async (event) => {
				event.preventDefault();

				const submitButtons = Array.from(
					el.querySelectorAll('button[type="submit"], input[type="submit"]')
				);
				submitButtons.forEach((button) => (button.disabled = true));
				clearValidationMarks(el);

				try {
					// Reading files is async, hence the await before calling.
					const payload = await buildPayload(el);
					await submitAction(payload);
					if (modifiers.includes("reset")) {
						resetForm(el);
					}
				} catch {
					// The error is already captured on $formAction.error; here we
					// only translate validation issues into accessible field marks.
					applyValidationMarks(el, submitAction.error);
				} finally {
					submitButtons.forEach((button) => (button.disabled = false));
				}
			};

			el.addEventListener("submit", onSubmit);
			cleanup(() => el.removeEventListener("submit", onSubmit));
		}
	);
}

/**
 * Serialize a form into a single plain object:
 *   - text-like fields   -> strings, keyed by their `name` attribute
 *   - checkboxes         -> booleans (checked state)
 *   - radios             -> the checked radio's value
 *   - file inputs        -> `<name>Data` (base64 string) + `<name>Name`
 *                           (original filename), matching the convention the
 *                           todo.server.js actions expect (fileData/fileName)
 *
 * A file input named "file" therefore produces { fileData, fileName } - the
 * exact shape addTodo's Zod schema validates and writes to /public/uploads.
 */
async function buildPayload(form) {
	const payload = {};

	for (const field of Array.from(form.elements)) {
		if (!field.name || field.disabled) continue;
		if (
			field.type === "submit" ||
			field.type === "button" ||
			field.type === "reset"
		)
			continue;

		if (field.type === "checkbox") {
			payload[field.name] = field.checked;
		} else if (field.type === "radio") {
			if (field.checked) payload[field.name] = field.value;
		} else if (field.type === "file") {
			const file = field.files && field.files[0];
			if (file && file.name) {
				payload[`${field.name}Data`] = await fileToBase64(file);
				payload[`${field.name}Name`] = file.name;
			}
		} else {
			payload[field.name] = field.value;
		}
	}

	return payload;
}

/**
 * Read a File as base64 (without the "data:...;base64," prefix), which is
 * what the server action decodes with Buffer.from(data, "base64").
 */
function fileToBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1]);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/**
 * Reset the form, then fire input/change events on every named control so
 * Alpine bindings (x-model, @change handlers) pick up the reset values -
 * form.reset() alone changes the DOM without notifying Alpine.
 */
function resetForm(form) {
	form.reset();
	for (const field of Array.from(form.elements)) {
		if (!field.name) continue;
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new Event("change", { bubbles: true }));
	}
}

/**
 * Mark invalid fields after a 400 validation error: set aria-invalid on each
 * input whose name matches a validation issue, and focus the first one.
 */
function applyValidationMarks(form, error) {
	const validationErrors = error?.validationErrors;
	if (!validationErrors) return;

	let firstInvalid = null;
	for (const issue of validationErrors) {
		const name = fieldNameFromPath(issue.path);
		const field = name ? form.elements.namedItem(name) : null;
		if (field && typeof field.setAttribute === "function") {
			field.setAttribute("aria-invalid", "true");
			if (!firstInvalid) firstInvalid = field;
		}
	}
	if (firstInvalid) firstInvalid.focus();
}

function clearValidationMarks(form) {
	for (const field of Array.from(form.elements)) {
		field.removeAttribute("aria-invalid");
	}
}

// ---------------------------------------------------------------------------
// $query - reactive read wrapper
// ---------------------------------------------------------------------------

/**
 * Fetch data reactively:
 *
 *   x-data="{ todos: $query($server.todos.getTodos, { refetchOn: 'sa:success' }) }"
 *   <template x-for="todo in todos.data ?? []"> ... </template>
 *   <p x-show="todos.loading">Loading...</p>
 *
 * Returns a reactive object: { data, loading, error, refetch }.
 * - Fetches immediately on creation.
 * - `refetch()` re-runs the fetch manually.
 * - `opts.refetchOn` registers a listener for a (bubbling) event name on the
 *   element the magic was evaluated on - create the query in the x-data of a
 *   component root and every `sa:success` fired by descendant actions/forms
 *   will refresh the list automatically. The listener lives on the component
 *   element itself, so it is released together with the element when the
 *   component is removed from the DOM (no manual cleanup needed).
 * - Stale responses are discarded: like $action, only the latest fetch may
 *   write state, so an old slow response never overwrites fresh data.
 */
function createQuery(Alpine, fn, el, options = {}) {
	let latestFetchId = 0;

	const query = Alpine.reactive({
		data: null,
		loading: true,
		error: null,
		async refetch() {
			const fetchId = ++latestFetchId;
			query.loading = true;
			try {
				const data = await fn();
				if (fetchId === latestFetchId) {
					query.data = data;
					query.error = null;
					query.loading = false;
				}
				return data;
			} catch (rawError) {
				if (fetchId === latestFetchId) {
					query.error = normalizeError(rawError);
					query.loading = false;
				}
				return undefined;
			}
		},
	});

	if (options.refetchOn) {
		el.addEventListener(options.refetchOn, () => query.refetch());
	}

	query.refetch();

	return query;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the errors thrown by the generated client proxies into one
 * predictable shape: { message, status, code, validationErrors }.
 *
 * The proxies throw an Error with `.status` (HTTP status) and `.details`
 * (the error body's details, e.g. `details.validationErrors` for Zod
 * failures). Network failures are re-thrown WITHOUT a status, so "no status"
 * means the request never got a response.
 */
function normalizeError(error) {
	if (typeof error?.status === "number") {
		const validationErrors = error.details?.validationErrors ?? null;
		return {
			message: error.message,
			status: error.status,
			code:
				error.code ??
				(validationErrors ? "VALIDATION_ERROR" : "SERVER_ACTION_ERROR"),
			validationErrors,
		};
	}
	return {
		message: error?.message ?? "Network error",
		status: 0,
		code: "NETWORK_ERROR",
		validationErrors: null,
	};
}

/**
 * Server validation paths look like "0.text": the argument index, then the
 * field path within that argument. Strip leading numeric segments to get the
 * field name a form input would use.
 */
function fieldNameFromPath(path) {
	const segments = String(path).split(".");
	while (segments.length > 1 && /^\d+$/.test(segments[0])) {
		segments.shift();
	}
	return segments.join(".");
}

/** Dispatch a bubbling CustomEvent so ancestors can react (e.g. $query refetchOn). */
function dispatch(el, name, detail) {
	el.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
}
