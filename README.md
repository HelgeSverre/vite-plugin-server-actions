# Vite Server Actions

[![npm version](https://img.shields.io/npm/v/vite-plugin-server-actions.svg?style=flat)](https://www.npmjs.com/package/vite-plugin-server-actions)
[![Downloads](https://img.shields.io/npm/dm/vite-plugin-server-actions.svg?style=flat)](https://www.npmjs.com/package/vite-plugin-server-actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Write server functions. Call them from the client. That's it.**

Import server functions into your client code and call them directly - no API routes, no HTTP handling, no boilerplate.

```javascript
// server/db.server.js
export async function getUsers() {
  return await database.users.findAll();
}

// App.vue
import { getUsers } from "./server/db.server.js";

const users = await getUsers(); // Just call it!
```

## Why Vite Server Actions?

- **Zero API Boilerplate** - No routes to define, no HTTP methods to handle, no request bodies to parse
- **Secure by Default** - Server code never exposed to the client, with path traversal protection
- **TypeScript** - Full support with cross-file imports, automatic `.d.ts` generation, compilation via Vite's SSR module system
- **Built-in Validation** - Automatic request validation using Zod schemas
- **Auto Documentation** - OpenAPI 3.0 specs and Swagger UI generated automatically
- **Middleware Support** - Authentication, logging, CORS, and custom middleware
- **Flexible Routing** - Multiple routing strategies with hierarchical paths
- **Production Ready** - Builds to an optimized standalone Node.js Express server

## Table of Contents

- [Getting Started](#getting-started)
- Guides
  - [Validation with Zod](#validation-with-zod)
  - [OpenAPI & Swagger UI](#openapi--swagger-ui)
  - [Middleware](#middleware)
  - [TypeScript](#typescript)
  - [Routing](#routing)
  - [Production Deployment](#production-deployment)
  - [Error Handling](#error-handling)
  - [Common Patterns](#common-patterns)
- Reference
  - [Configuration Options](#configuration-options)
  - [HTTP Contract](#http-contract)
  - [Error Response Shape](#error-response-shape)
  - [Build Outputs](#build-outputs)
  - [Requirements & Compatibility](#requirements--compatibility)
  - [Exports](#exports)
- [How It Works](#how-it-works)
- [Examples](#examples)
- [Contributing](#contributing)
- [License](#license)

## Getting Started

### 1. Install

```bash
npm install vite-plugin-server-actions
```

### 2. Configure Vite

```javascript
// vite.config.js
import { defineConfig } from "vite";
import serverActions from "vite-plugin-server-actions";

export default defineConfig({
  plugins: [
    serverActions(), // Zero config needed
  ],
});
```

### 3. Create a Server Function

Any file ending with `.server.js` or `.server.ts` becomes a server module:

```javascript
// actions/todos.server.js
import { db } from "./database";

export async function getTodos(userId) {
  // This runs on the server with full Node.js access
  return await db.todos.findMany({ where: { userId } });
}

export async function addTodo(text, userId) {
  return await db.todos.create({
    data: { text, userId, completed: false },
  });
}
```

### 4. Call It from the Client

```javascript
// App.jsx
import { getTodos, addTodo } from './actions/todos.server.js'

function TodoApp({ userId }) {
  const [todos, setTodos] = useState([])

  useEffect(() => {
    // Just call the server function!
    getTodos(userId).then(setTodos)
  }, [userId])

  async function handleAdd(text) {
    const newTodo = await addTodo(text, userId)
    setTodos([...todos, newTodo])
  }

  return (
    // Your UI here...
  )
}
```

That's it. The plugin automatically:

- Creates API endpoints for each function
- Handles serialization/deserialization
- Provides TypeScript support
- Works in development and production

From here, add [validation](#validation-with-zod), [middleware](#middleware), or read [how it works](#how-it-works).

## Validation with Zod

Add validation to any server function by attaching a Zod schema. The plugin automatically validates requests and generates OpenAPI documentation. Schemas must be written with zod v3 (see [Requirements & Compatibility](#requirements--compatibility)).

Enable validation in your config (it is disabled by default):

```javascript
// vite.config.js
serverActions({
  validation: {
    enabled: true,
  },
});
```

Then attach a schema to a function:

```javascript
// actions/todos.server.js
import { z } from "zod";

const AddTodoSchema = z.object({
  text: z.string().min(1),
  priority: z.enum(["low", "high"]).default("low"),
});

export async function addTodo(todo) {
  // Input is pre-validated - this will never run with invalid data
  return await db.todos.create({ data: { ...todo, completed: false } });
}

// Just attach the schema!
addTodo.schema = AddTodoSchema;
```

What you get:

1. **Automatic Validation** - Invalid requests return 400 with detailed errors
2. **Type Safety** - Full TypeScript inference from your Zod schemas
3. **API Documentation** - OpenAPI spec and Swagger UI when [OpenAPI is enabled](#openapi--swagger-ui)

### Arrays and Multiple Parameters

```javascript
// Handle arrays and complex inputs
const BulkUpdateSchema = z.array(
  z.object({
    id: z.number(),
    completed: z.boolean(),
  }),
);

export async function bulkUpdateTodos(updates) {
  // Type: { id: number, completed: boolean }[]
  return await db.todos.updateMany(updates);
}
bulkUpdateTodos.schema = BulkUpdateSchema;

// Validate multiple parameters with a tuple
export async function getTodosInRange(startDate, endDate) {
  // Validate both parameters
  return await db.todos.query({ startDate, endDate });
}
getTodosInRange.schema = z.tuple([
  z.string().datetime(), // startDate
  z.string().datetime(), // endDate
]);
```

## OpenAPI & Swagger UI

Generate an OpenAPI 3.0 spec and interactive documentation from your server functions and their Zod schemas:

```javascript
// vite.config.js
serverActions({
  validation: {
    enabled: true,
  },
  openAPI: {
    enabled: true,
    swaggerUI: true,
  },
});
```

This gives you:

- Automatic request validation with Zod schemas
- OpenAPI spec at `/api/openapi.json`
- Interactive docs at `/api/docs`

The spec is generated from the Zod schemas attached to your functions. All paths and the spec's `info` block are configurable; see [OpenAPI options](#openapi-options).

## Middleware

Run Express-style middleware in front of your server actions - authentication, CORS, logging, auditing.

The `middleware` option accepts a single entry or an array. Each entry is either:

- an Express-style middleware function `(req, res, next)`, or
- a string path to a module (resolved relative to the Vite root) whose default export is a middleware function.

Entries run in array order, after JSON body parsing and before validation and the action handlers. Middleware is mounted on the API prefix itself (equivalent to `app.use(apiPrefix, mw)`), not on individual action routes - every request whose path starts with `apiPrefix` passes through it, regardless of HTTP method. That includes OPTIONS CORS preflights, GET requests to the OpenAPI spec/docs, and requests to unknown API paths. Entries that are neither functions nor strings are ignored with a warning in development and excluded with a warning from production builds.

Note: because of Express mount-path semantics, `req.url` inside your middleware has the `apiPrefix` stripped - use `req.originalUrl` for the full path.

```javascript
import serverActions from "vite-plugin-server-actions";

// Authentication middleware (self-contained: works in dev AND production)
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Verify token...
  next();
};

// CORS middleware (self-contained). Because middleware sees OPTIONS
// preflights, it can answer them itself:
const corsMiddleware = (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
};

export default defineConfig({
  plugins: [
    serverActions({
      // Functions and module paths can be mixed; entries run in order
      middleware: [corsMiddleware, authMiddleware, "./src/middleware/audit.js"],
    }),
  ],
});
```

### Middleware in Development

String entries are re-imported on each request via the plugin's module loader (Vite's `ssrLoadModule` when available), so editing the middleware file hot-reloads it without a dev-server restart. If the module's default export is not a function, the request fails with an error passed to `next()`.

### Production and the Serialization Constraint

`vite build` emits a standalone `dist/server.js`, and your middleware must travel into that file. User middleware is applied to ALL API-prefix requests, including OPTIONS, via `app.use('<apiPrefix>', ...)` emitted before the action routes and static file serving. Entries get there in one of two ways:

- **String entries become real imports.** The module is bundled (with its local dependencies; npm packages stay external) into `dist/actions.js` under a `__vsa_middleware_N` binding and mounted from there, keeping `dist` self-contained.
- **Function entries are serialized with `fn.toString()` and embedded verbatim - but only if they are self-contained.** The build statically analyzes each function (via `@babel/parser`): every identifier it references must be one of its own parameters/locals or a standard JS/Node global (`process`, `console`, `Buffer`, `URL`, `URLSearchParams`, `fetch`, `JSON`, `Date`, `Promise`, timers, streams, `crypto`, etc.). If a function captures anything else (imports, closure variables, module-level constants), the build emits a prominent warning naming the middleware by index and function name and listing the captured identifiers - and that middleware is EXCLUDED from the generated server rather than embedded broken. Pass a file path instead.

The `authMiddleware` and `corsMiddleware` above are self-contained, so they serialize and run in production. The built-in `middleware.logging` captures its `util` import, so it works in dev but is excluded from production builds with a warning.

### Rate Limiting

A small fixed-window rate limiter, keyed by client IP:

```javascript
// src/middleware/rate-limit.js
const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 100; // per IP per window

// Module-level state: this Map lives in the module's scope and persists
// across requests. That is exactly why this middleware must be passed as
// a file path - toString() serialization would strip the module scope
// and lose the Map.
const hits = new Map();

export default function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return next();
  }

  entry.count += 1;
  if (entry.count > MAX_REQUESTS) {
    res.set("Retry-After", String(Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000)));
    return res.status(429).json({ error: true, status: 429, message: "Too many requests" });
  }

  next();
}
```

Register it by file path:

```javascript
serverActions({
  middleware: ["./src/middleware/rate-limit.js"],
});
```

Use the file-path form here, not an inline function. The limiter holds its state (the `hits` Map) in module scope, so it is NOT self-contained: serializing the function with `toString()` would leave `hits` as a dangling reference, and the build would exclude it from the production server with a warning. As a file path, the module is bundled whole into `dist/actions.js` - state and all - so the same limiter runs in development and production.

### Built-in Logging Middleware

Vite Server Actions includes a built-in logging middleware that provides detailed console output for debugging. It is development-only: because it captures its `util` import, it cannot be serialized into the generated production server and is excluded from production builds with a warning (see [the serialization constraint](#production-and-the-serialization-constraint)).

```javascript
import serverActions, { middleware } from "vite-plugin-server-actions";

export default defineConfig({
  plugins: [
    serverActions({
      middleware: middleware.logging,
    }),
  ],
});
```

The logging middleware displays action trigger details (module, function, endpoint), the formatted request body with syntax highlighting, response time and data, and error responses with status codes:

```
[2024-01-21T10:30:45.123Z] 🚀 Server Action Triggered
├─ Module: actions/todo
├─ Function: addTodo
├─ Method: POST
└─ Endpoint: /api/actions/todo/addTodo

📦 Request Body:
{
  text: 'Buy groceries',
  priority: 'high'
}

✅ Response sent in 25ms
📤 Response data:
{
  id: 1,
  text: 'Buy groceries',
  priority: 'high',
  completed: false
}
──────────────────────────────────────────────────
```

## TypeScript

Vite Server Actions provides TypeScript support with automatic type generation:

- **Automatic Type Generation** - `.d.ts` files generated for all server actions
- **Real-time Compilation** - TypeScript files compiled on-the-fly in development
- **Helpful Error Messages** - Development-time suggestions for TypeScript usage
- **Production Build Support** - Full TypeScript compilation in build process

```typescript
// actions/todos.server.ts
export interface Todo {
  id: number;
  text: string;
  completed: boolean;
}

/**
 * Get a todo by ID with full type safety
 * @param id - The todo ID to fetch
 * @returns Promise containing todo data or null
 */
export async function getTodo(id: number): Promise<Todo | null> {
  return await db.todos.findUnique({ where: { id } });
}

// Client.tsx - Automatic type inference and IntelliSense!
import { getTodo, type Todo } from "./actions/todos.server";

const todo = await getTodo(123); // Type: Todo | null
```

### Validation with Type Safety

```typescript
import { z } from "zod";

// Define your schemas with TypeScript interfaces
export interface AddTodoInput {
  text: string;
  priority?: string;
}

const AddTodoSchema = z.object({
  text: z.string().min(1, "Text is required"),
  priority: z.string().optional(),
});

export async function addTodo(data: AddTodoInput): Promise<Todo> {
  const validated = AddTodoSchema.parse(data);
  return await db.todos.create({ data: validated });
}

// Attach schema for automatic validation and OpenAPI generation
addTodo.schema = z.tuple([AddTodoSchema]);
```

### Type Definitions

TypeScript types flow through to the generated client: a `dist/actions.d.ts` with ambient module declarations is emitted at build time, and in development your editor resolves types directly from the `.server.ts` source. API documentation (OpenAPI spec and Swagger UI) is generated from [Zod schemas](#validation-with-zod), not from TypeScript types or JSDoc.

## Routing

Change where your endpoints live with `apiPrefix` and `routeTransform`:

```javascript
serverActions({
  apiPrefix: "/rpc", // Change from /api to /rpc
  routeTransform: (filePath, functionName) => {
    // todos.server.js -> /rpc/todos.list
    const module = filePath.replace(".server.js", "");
    return `${module}.${functionName}`;
  },
});
```

The plugin uses clean hierarchical paths by default (e.g., `actions/todo/create` instead of `src_actions_todo/create`). Three presets are exported as `pathUtils`:

```javascript
import { pathUtils } from "vite-plugin-server-actions";

// Available presets:
pathUtils.createCleanRoute; // (default) src/actions/auth.server.js → /api/actions/auth/login
pathUtils.createLegacyRoute; // src/actions/auth.server.js → /api/src_actions_auth/login
pathUtils.createMinimalRoute; // actions/auth.server.js → /api/actions/auth.server/login
```

## Production Deployment

### Building

```bash
npm run build
```

This generates a standalone Express server plus your client assets - see [Build Outputs](#build-outputs) for the full list.

### Running

```bash
node dist/server.js
```

Or with PM2:

```bash
pm2 start dist/server.js --name my-app
```

The server listens on `process.env.PORT`, defaulting to `3000`.

The generated server shuts down gracefully on `SIGTERM` and `SIGINT`: it stops accepting new connections, lets in-flight requests finish, then exits with code 0. If draining takes longer than 10 seconds, it force-exits with code 1. This works out of the box with PM2, systemd, Docker, and Kubernetes rolling deploys.

The generated `dist/server.js` (or the configured `serverFileName`) is working-directory independent: it resolves every sibling file relative to the script itself via `import.meta.url` (`const __dirname = dirname(fileURLToPath(import.meta.url))`). Static client assets are served with `express.static(__dirname)` - the `dist` directory containing the generated server - and `openapi.json` is read from `join(__dirname, 'openapi.json')`. So `node dist/server.js`, `pm2 start dist/server.js`, systemd units, and Docker entrypoints work from ANY working directory: `index.html`, hashed assets, the API routes, `/api/openapi.json`, and `/api/docs` all serve correctly. Note: paths inside your own action code (e.g. `process.cwd()`-based data files) remain relative to whatever directory you start the server from.

The generated server's `express.static` protection applies only when you run that server. Do not serve `dist/` directly with nginx, a CDN, or other static hosting: doing so exposes private build artifacts.

### Docker

Because `dist` is self-contained apart from npm packages, a minimal image copies `dist` and your production `node_modules`:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

## Error Handling

Errors thrown in server actions are automatically caught and returned to the client with a standard JSON body - see [Error Response Shape](#error-response-shape) for the exact format. An error without a usable HTTP status is deliberately opaque: HTTP 500 with message `"Internal server error"`.

To send a specific status, throw an `Error` carrying an HTTP status via `error.status` or the common Express alias `error.statusCode`. Error-status parity holds (dev == prod): in BOTH the development middleware and the generated production server, an integer status in the 400-599 range (other than 500) is honored - the HTTP response uses that status and the standard body shape, where `message` is the thrown error's message and `code` is the error's own `code` property when set, falling back to `"SERVER_ACTION_ERROR"`. In development the body additionally includes `details.stack`.

```javascript
export async function authenticate(token) {
  if (!token) {
    const error = new Error("No token provided");
    error.status = 401; // or the Express alias: error.statusCode = 401
    error.code = "NO_TOKEN"; // optional, defaults to "SERVER_ACTION_ERROR"
    throw error;
  }
  // ...
}

// Client receives status 401 with:
// { "error": true, "status": 401, "message": "No token provided", "code": "NO_TOKEN", "timestamp": "..." }
```

Non-numeric statuses, out-of-range statuses (e.g. `302` or `999`), an explicit `500`, or no status at all keep the opaque behavior: HTTP 500 with message `"Internal server error"`. Internal classifications always take precedence over a user-set status: `FUNCTION_NOT_FOUND` → 404, `INVALID_REQUEST_BODY` → 400, and Zod `VALIDATION_ERROR` → 400.

On the client, the proxy surfaces the HTTP status as `error.status` and the body's message and `details`, so custom statuses round-trip to your `catch` blocks unchanged:

```javascript
try {
  await authenticate(null);
} catch (error) {
  console.log(error.status); // 401
  console.log(error.message); // "No token provided"
}
```

## Common Patterns

### Authenticated Actions

```javascript
// server/auth.server.js
export async function withAuth(handler) {
  return async (...args) => {
    const token = args[args.length - 1]; // Pass token as last arg
    const user = await verifyToken(token);
    if (!user) throw new Error("Unauthorized");

    return handler(...args.slice(0, -1), user);
  };
}

// server/protected.server.js
import { withAuth } from "./auth.server";

export const getSecretData = withAuth(async (user) => {
  return await db.secrets.findMany({ userId: user.id });
});
```

### Caching

```javascript
const cache = new Map();

export async function getExpensiveData(key) {
  if (cache.has(key)) {
    return cache.get(key);
  }

  const data = await expensiveOperation(key);
  cache.set(key, data);

  // Clear after 5 minutes
  setTimeout(() => cache.delete(key), 5 * 60 * 1000);

  return data;
}
```

### File Uploads

```javascript
// server/upload.server.js
import { writeFile } from "fs/promises";
import path from "path";

export async function uploadFile(filename, base64Data) {
  const buffer = Buffer.from(base64Data, "base64");
  const filepath = path.join(process.cwd(), "uploads", filename);

  await writeFile(filepath, buffer);
  return { success: true, path: `/uploads/${filename}` };
}
```

### External APIs and Environment Variables

Server actions run in Node, so `process.env` and secrets are available (and never shipped to the client):

```javascript
// server/weather.server.js
export async function getWeather(city) {
  const response = await fetch(`https://api.weather.com/v1/current?city=${city}&key=${process.env.API_KEY}`);
  return response.json();
}
```

### Secure File Access

```javascript
// ❌ Dangerous - allows arbitrary file access
export async function readFile(path) {
  return await fs.readFile(path, "utf-8");
}

// ✅ Safe - validates and restricts access
import { z } from "zod";

const FileSchema = z.enum(["report.pdf", "summary.txt"]);

export async function readAllowedFile(filename) {
  const safePath = path.join(SAFE_DIR, filename);
  return await fs.readFile(safePath, "utf-8");
}
readAllowedFile.schema = FileSchema;
```

## Configuration Options

| Option           | Type                                         | Default                                | Description                                                                                     |
| ---------------- | -------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apiPrefix`      | `string`                                     | `"/api"`                               | URL prefix for all endpoints                                                                    |
| `include`        | `string \| string[]`                         | `["**/*.server.js", "**/*.server.ts"]` | Files to process                                                                                |
| `exclude`        | `string \| string[]`                         | `[]`                                   | Files to ignore                                                                                 |
| `middleware`     | `Function \| string \| (Function\|string)[]` | `[]`                                   | Middleware mounted on the API prefix: functions or module paths (see [Middleware](#middleware)) |
| `routeTransform` | `Function`                                   | `pathUtils.createCleanRoute`           | Customize URL generation (see [Routing](#routing))                                              |
| `serverFileName` | `string`                                     | `"server.js"`                          | Filename of the generated production server in `dist/` (plain filename, no path separators)     |
| `silent`         | `boolean`                                    | `false`                                | Suppress the plugin's informational console output (see note below)                             |
| `validation`     | `Object`                                     | `{ enabled: false }`                   | Validation settings                                                                             |
| `openAPI`        | `Object`                                     | `{ enabled: false }`                   | OpenAPI documentation settings                                                                  |

`silent: true` suppresses the plugin's own dev/build-time chatter: the dev startup feedback banner, HMR cleanup logs, endpoint/schema discovery messages, and advisory warnings (non-async function hints, module-name collisions, schema discovery fallbacks). Errors always print. Warnings about middleware being **excluded** from the production build are routed through Rollup's build warning path, so they remain visible during `vite build` even with `silent: true` - dropping code from the build should never be invisible. The generated production server's own runtime logging is unaffected by this option.

### Validation Options

Validation is disabled by default. Enable it explicitly in your configuration. Schemas must be written with zod v3 (see [Requirements & Compatibility](#requirements--compatibility)).

| Option    | Type      | Default | Description                              |
| --------- | --------- | ------- | ---------------------------------------- |
| `enabled` | `boolean` | `false` | Enable request validation                |
| `adapter` | `string`  | `"zod"` | Validation library adapter (only zod v3) |

### OpenAPI Options

| Option       | Type      | Default               | Description                                                                                   |
| ------------ | --------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `enabled`    | `boolean` | `false`               | Enable OpenAPI generation                                                                     |
| `swaggerUI`  | `boolean` | `true`                | Enable Swagger UI when OpenAPI is enabled                                                     |
| `info`       | `Object`  | See below             | OpenAPI specification info                                                                    |
| `docsPath`   | `string`  | `"/api/docs"`         | Path for Swagger UI                                                                           |
| `specPath`   | `string`  | `"/api/openapi.json"` | Path for OpenAPI JSON spec                                                                    |
| `outputFile` | `string`  | `"openapi.json"`      | Filename of the emitted spec in `dist/` (plain filename; serving paths above are independent) |

Default `info` object:

```javascript
{
  title: "Server Actions API",
  version: "1.0.0",
  description: "Auto-generated API documentation for Vite Server Actions"
}
```

## HTTP Contract

Every exported server function maps to one HTTP endpoint:

- **Method**: `POST`
- **URL**: `{apiPrefix}/{route}` (e.g. `/api/actions/todos/addTodo` with the default route transform)
- **Request body**: the function's arguments as a JSON array (`JSON.stringify(args)`), with `Content-Type: application/json`
- **Response**: the function's return value as JSON; if the function returns `undefined`, the server responds `204 No Content` and the client proxy resolves to `undefined`
- **Errors**: non-2xx responses use the [error response shape](#error-response-shape); the client proxy throws an `Error` with `error.status` set to the HTTP status and `error.details` from the body

## Error Response Shape

Server errors are returned with a standard body of the shape `{ error: true, status, message, code, timestamp, details? }` - in both the development middleware and the generated production server:

```javascript
// server/api.server.js
export async function riskyOperation() {
  throw new Error("Something went wrong");
}

// Client receives status 500 with:
// {
//   "error": true,
//   "status": 500,
//   "message": "Internal server error",
//   "code": "INTERNAL_ERROR", // development; the generated production server sends "SERVER_ACTION_ERROR"
//   "timestamp": "2024-01-21T10:30:45.123Z",
//   "details": { "message": "Something went wrong", "stack": "..." } // development only
// }
```

The `code` differs by mode: the development middleware sends `INTERNAL_ERROR`, while the generated production server sends `SERVER_ACTION_ERROR` (the fallback when the thrown error has no `code` of its own). `details` with the message/stack appears only when `NODE_ENV` is `development` - production responses omit it. For controlling the status and code from your own actions, see [Error Handling](#error-handling).

## Build Outputs

`vite build` generates:

- `dist/server.js` - Your Express server with all endpoints (filename configurable via `serverFileName`)
- `dist/actions.js` - Bundled server functions
- `dist/actions.d.ts` - Type definitions for the bundled functions
- `dist/openapi.json` - API specification (if enabled; filename configurable via `openAPI.outputFile`)
- Client assets with proxy functions

## Requirements & Compatibility

- Node.js 18+ to use the plugin with Vite 4–6; Vite 7 and 8 themselves require Node `^20.19 || >=22.12`
- Vite 4–8 (peer dependency range `^4 || ^5 || ^6 || ^7 || ^8`). The automated test suite and all example apps run against Vite 8 on Node 20/22/24/26 in CI; Vite 4–7 are accepted by the peer range but not covered by automated tests
- Validation requires zod v3 (`zod@^3`). zod 4 is not yet supported: its changed `ZodError` shape makes the generated production server return HTTP 500 instead of 400 for validation failures
- Tested with Svelte, Vue, React, TypeScript React, and Alpine.js, with feature parity between development and production modes

## Exports

| Export               | Description                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `serverActions`      | Default export - the Vite plugin                                                                                                           |
| `pathUtils`          | Route transform presets: `createCleanRoute` (default), `createLegacyRoute`, `createMinimalRoute` (see [Routing](#routing))                 |
| `middleware.logging` | Built-in request logger. Development-only: excluded from production builds with a warning (see [Middleware](#built-in-logging-middleware)) |

## How It Works

### The Transform Pipeline

1. **Scan** - The plugin finds files matching the `include` globs (`**/*.server.js`, `**/*.server.ts` by default)
2. **Parse** - Exported functions are extracted with AST-based parsing, which also powers development warnings (async-function suggestions, missing return types, missing validation schemas, path traversal detection)
3. **Proxy generation** - Client imports of server modules are replaced with proxy functions; each exported function becomes a client-side proxy that POSTs to its endpoint
4. **Serve** - In development, server functions run as Express middleware in Vite's dev server. In production, `vite build` generates a standalone Express server with all your functions

```javascript
// What you write:
import { getUser } from "./user.server.js";
const user = await getUser(123);

// What runs in the browser:
const user = await fetch("/api/user/getUser", {
  method: "POST",
  body: JSON.stringify([123]),
}).then((r) => r.json());
```

### Why the Serialization Constraints Exist

Everything crossing the client/server boundary travels as JSON, so arguments and return values must be JSON-serializable. Configured middleware faces a second boundary: the production server is _generated code_, so function entries must be embedded via `fn.toString()` - which only works when the function is self-contained (no captured imports or closure variables). String (file path) entries avoid this entirely because they become real imports in the bundle. See [the serialization constraint](#production-and-the-serialization-constraint) for the full contract.

### Security Model

- **Server code isolation** - Server files (`.server.js` and `.server.ts`) are never bundled into client code, and development builds include safety checks to prevent accidental imports. In production, the client assets and private build artifacts are co-located in `dist/`: the configured `serverFileName` output (default `server.js`), `actions.js`, `actions.d.ts`, and (when enabled) the OpenAPI output. The generated server blocks direct static requests for those private artifacts before serving client assets, but the action bundle still exists on the server filesystem.
- **Path containment** - Server module file paths are sanitized and contained to the Vite project root (plus Vite's explicitly allowed directories); traversal attempts are rejected
- **Module-name sanitization** - Module names are derived from file paths and reduced to safe JavaScript identifiers (no dots, no reserved words) before being embedded in generated code

Best practices for your own actions:

1. **Never trust client input** - Always validate with Zod schemas
2. **Use middleware for auth** - Add authentication checks globally
3. **Sanitize file operations** - Be careful with file paths from clients (see [Secure File Access](#secure-file-access))
4. **Limit exposed functions** - Only export what clients need
5. **Use environment variables** - Keep secrets out of code

## Examples

- [Todo App with Svelte](examples/svelte-todo-app) - Full-featured todo application with validation
- [Todo App with Vue](examples/vue-todo-app) - Same todo app built with Vue 3
- [Todo App with React](examples/react-todo-app) - Same todo app built with React
- [Todo App with React + TypeScript](examples/react-todo-app-typescript) - Fully-typed version of the React todo app
- [Todo App with Alpine.js](examples/alpine-todo-app) - Same todo app built with Alpine.js, demonstrating copy-pasteable helper primitives (`$server`, `$action`, `x-action`, `$query`) for calling server actions from Alpine markup
- [TypeScript Analytics Demo](examples/typescript-analytics-demo) - Analytics dashboard demonstrating advanced TypeScript features

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

This project is [MIT](LICENSE) licensed.
