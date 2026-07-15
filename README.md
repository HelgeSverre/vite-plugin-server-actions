# Vite Server Actions

[![npm version](https://img.shields.io/npm/v/vite-plugin-server-actions.svg?style=flat)](https://www.npmjs.com/package/vite-plugin-server-actions)
[![Downloads](https://img.shields.io/npm/dm/vite-plugin-server-actions.svg?style=flat)](https://www.npmjs.com/package/vite-plugin-server-actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Write server functions. Call them from the client. That's it.**

Vite Server Actions brings the simplicity of server-side development to your Vite applications. Import server functions into your client code and call them directly - no API routes, no HTTP handling, no boilerplate.

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

- **Zero API Boilerplate** - No need to define routes, handle HTTP methods, or parse request bodies
- **TypeScript Support** - Full TypeScript support with automatic type generation
- **Built-in Validation** - Automatic request validation using Zod schemas
- **Auto Documentation** - OpenAPI 3.0 specs and Swagger UI generated automatically
- **Production Ready** - Builds to optimized Node.js Express server
- **Developer Experience** - Clear error messages, hot reload, and development-time validation

## Core Features

- **Seamless Imports** - Import server functions like any other module
- **Secure by Default** - Server code never exposed to client, path traversal protection
- **TypeScript** - Full support with cross-file imports, automatic compilation via Vite's SSR module system
- **Validation** - Zod schemas with type inference and OpenAPI generation
- **Documentation** - OpenAPI 3.0 specs with Swagger UI
- **Middleware Support** - Authentication, logging, CORS, and custom middleware
- **Flexible Routing** - Multiple routing strategies with hierarchical paths
- **Developer Experience** - Helpful error messages and development warnings
- **Production Optimized** - Efficient Express server builds

## Requirements

- Node.js 18+ to use the plugin with Vite 4–6; Vite 7 and 8 themselves require Node `^20.19 || >=22.12`
- Vite 4–8 (peer dependency range `^4 || ^5 || ^6 || ^7 || ^8`). The automated test suite and all example apps run against Vite 8 on Node 20/22/24/26 in CI; Vite 4–7 are accepted by the peer range but not covered by automated tests
- Validation requires zod v3 (`zod@^3`). zod 4 is not yet supported: its changed `ZodError` shape makes the generated production server return HTTP 500 instead of 400 for validation failures

## Quick Start

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
    serverActions(), // That's it! Zero config needed
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

### 4. Use in Your Client

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

That's it! The plugin automatically:

- Creates API endpoints for each function
- Handles serialization/deserialization
- Provides TypeScript support
- Works in development and production

## Real-World Examples

### Database Operations

```javascript
// server/database.server.js
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function getUser(id) {
  return await prisma.user.findUnique({
    where: { id },
    include: { profile: true },
  });
}

export async function updateUser(id, data) {
  return await prisma.user.update({
    where: { id },
    data,
  });
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

### External API Integration

```javascript
// server/weather.server.js
export async function getWeather(city) {
  const response = await fetch(`https://api.weather.com/v1/current?city=${city}&key=${process.env.API_KEY}`);
  return response.json();
}
```

### With Validation

```javascript
// server/auth.server.js
import { z } from "zod";
import bcrypt from "bcrypt";
import { signJWT } from "./jwt";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function login(credentials) {
  // Validation happens automatically!
  const user = await db.users.findByEmail(credentials.email);

  if (!user || !(await bcrypt.compare(credentials.password, user.passwordHash))) {
    throw new Error("Invalid credentials");
  }

  return { token: signJWT(user), user };
}

// Attach schema for automatic validation
login.schema = LoginSchema;
```

### Complete Examples

- [Todo App with Svelte](examples/svelte-todo-app) - Full-featured todo application with validation
- [Todo App with Vue](examples/vue-todo-app) - Same todo app built with Vue 3
- [Todo App with React](examples/react-todo-app) - Same todo app built with React
- More examples coming soon for other frameworks

## How It Works

When you import a `.server.js` file in your client code, Vite Server Actions:

1. **Intercepts the import** - Replaces server module imports with client proxies
2. **Creates proxy functions** - Each exported function becomes a client-side proxy
3. **Generates API endpoints** - Maps each function to an HTTP endpoint
4. **Handles the transport** - Serializes arguments and return values automatically

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

### Development vs Production

- **Development**: Server functions run as Express middleware in Vite's dev server
- **Production**: Builds to a standalone Express server with all your functions

## Configuration

### Common Use Cases

#### Enable Validation & API Documentation

```javascript
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

#### Add Authentication Middleware

```javascript
serverActions({
  middleware: [
    // Runs for EVERY request under the API prefix (all server actions,
    // OPTIONS preflights, and the OpenAPI spec/docs endpoints)
    (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      next();
    },
  ],
});
```

Entries can also be a string path to a module (resolved relative to the Vite root) whose default export is a middleware function. See [Custom Middleware](#custom-middleware) for the full contract, including the serialization constraint for production builds.

#### Custom API Routes

```javascript
serverActions({
  apiPrefix: "/rpc", // Change from /api to /rpc
  routeTransform: (filePath, functionName) => {
    // users.server.js -> /rpc/users.list
    const module = filePath.replace(".server.js", "");
    return `${module}.${functionName}`;
  },
});
```

### All Configuration Options

| Option           | Type                                         | Default                                | Description                                                                                                   |
| ---------------- | -------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apiPrefix`      | `string`                                     | `"/api"`                               | URL prefix for all endpoints                                                                                  |
| `include`        | `string \| string[]`                         | `["**/*.server.js", "**/*.server.ts"]` | Files to process                                                                                              |
| `exclude`        | `string \| string[]`                         | `[]`                                   | Files to ignore                                                                                               |
| `middleware`     | `Function \| string \| (Function\|string)[]` | `[]`                                   | Middleware mounted on the API prefix: functions or module paths (see [Custom Middleware](#custom-middleware)) |
| `routeTransform` | `Function`                                   | See below                              | Customize URL generation                                                                                      |
| `validation`     | `Object`                                     | `{ enabled: false }`                   | Validation settings                                                                                           |
| `openAPI`        | `Object`                                     | `{ enabled: false }`                   | OpenAPI documentation settings                                                                                |

#### Route Transform Options

The plugin uses clean hierarchical paths by default (e.g., `actions/todo/create` instead of `src_actions_todo/create`).

```javascript
import { pathUtils } from "vite-plugin-server-actions";

// Available presets:
pathUtils.createCleanRoute; // (default) src/actions/auth.server.js → /api/actions/auth/login
pathUtils.createLegacyRoute; // src/actions/auth.server.js → /api/src_actions_auth/login
pathUtils.createMinimalRoute; // actions/auth.server.js → /api/actions/auth.server/login
```

#### Validation Options

Validation is disabled by default. Enable it explicitly in your configuration. Schemas must be written with zod v3 (see [Requirements](#requirements)).

| Option    | Type      | Default | Description                              |
| --------- | --------- | ------- | ---------------------------------------- |
| `enabled` | `boolean` | `false` | Enable request validation                |
| `adapter` | `string`  | `"zod"` | Validation library adapter (only zod v3) |

#### OpenAPI Options

| Option      | Type      | Default               | Description                               |
| ----------- | --------- | --------------------- | ----------------------------------------- |
| `enabled`   | `boolean` | `false`               | Enable OpenAPI generation                 |
| `swaggerUI` | `boolean` | `true`                | Enable Swagger UI when OpenAPI is enabled |
| `info`      | `Object`  | See below             | OpenAPI specification info                |
| `docsPath`  | `string`  | `"/api/docs"`         | Path for Swagger UI                       |
| `specPath`  | `string`  | `"/api/openapi.json"` | Path for OpenAPI JSON spec                |

Default `info` object:

```javascript
{
  title: "Server Actions API",
  version: "1.0.0",
  description: "Auto-generated API documentation for Vite Server Actions"
}
```

## 🔍 Built-in Middleware

### Logging Middleware

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

The logging middleware displays:

- 🚀 Action trigger details (module, function, endpoint)
- 📦 Formatted request body with syntax highlighting
- ✅ Response time and data
- ❌ Error responses with status codes

Example output:

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

### Custom Middleware

The `middleware` option accepts a single entry or an array. Each entry is either:

- an Express-style middleware function `(req, res, next)`, or
- a string path to a module (resolved relative to the Vite root) whose default export is a middleware function.

Entries run in array order, after JSON body parsing and before validation and the action handlers. Middleware is mounted on the API prefix itself (equivalent to `app.use(apiPrefix, mw)`), not on individual action routes — every request whose path starts with `apiPrefix` passes through it, regardless of HTTP method. That includes OPTIONS CORS preflights, GET requests to the OpenAPI spec/docs, and requests to unknown API paths. Entries that are neither functions nor strings are ignored with a warning in development and excluded with a warning from production builds.

Note: because of Express mount-path semantics, `req.url` inside your middleware has the `apiPrefix` stripped — use `req.originalUrl` for the full path.

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

#### Middleware in development

String entries are re-imported on each request via the plugin's module loader (Vite's `ssrLoadModule` when available), so editing the middleware file hot-reloads it without a dev-server restart. If the module's default export is not a function, the request fails with an error passed to `next()`.

#### Production and the serialization constraint

`vite build` emits a standalone `dist/server.js`, and your middleware must travel into that file. User middleware is applied to ALL API-prefix requests, including OPTIONS, via `app.use('<apiPrefix>', ...)` emitted before the action routes and static file serving. Entries get there in one of two ways:

- **String entries become real imports.** The module is bundled (with its local dependencies; npm packages stay external) into `dist/actions.js` under a `__vsa_middleware_N` binding and mounted from there, keeping `dist` self-contained.
- **Function entries are serialized with `fn.toString()` and embedded verbatim — but only if they are self-contained.** The build statically analyzes each function (via `@babel/parser`): every identifier it references must be one of its own parameters/locals or a standard JS/Node global (`process`, `console`, `Buffer`, `URL`, `URLSearchParams`, `fetch`, `JSON`, `Date`, `Promise`, timers, streams, `crypto`, etc.). If a function captures anything else (imports, closure variables, module-level constants), the build emits a prominent warning naming the middleware by index and function name and listing the captured identifiers — and that middleware is EXCLUDED from the generated server rather than embedded broken. Pass a file path instead.

The `authMiddleware` and `corsMiddleware` above are self-contained, so they serialize and run in production. The built-in `middleware.logging` captures its `util` import, so it works in dev but is excluded from production builds with a warning.

## ✅ Automatic Validation & Documentation

Add validation to any server function by attaching a Zod schema. The plugin automatically validates requests and generates OpenAPI documentation.

### Quick Setup

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

### Add Validation to Any Function

```javascript
// server/users.server.js
import { z } from "zod";

const CreateUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(["admin", "user"]).default("user"),
});

export async function createUser(data) {
  // Input is pre-validated - this will never run with invalid data
  const user = await db.users.create({ data });

  // Send welcome email, etc...
  return user;
}

// Just attach the schema!
createUser.schema = CreateUserSchema;
```

### What You Get

1. **Automatic Validation** - Invalid requests return 400 with detailed errors
2. **Type Safety** - Full TypeScript inference from your Zod schemas
3. **API Documentation** - Browse and test your API at `/api/docs`
4. **OpenAPI Spec** - Machine-readable spec at `/api/openapi.json`

### Advanced Validation

```javascript
// Handle arrays and complex inputs
const BulkUpdateSchema = z.array(
  z.object({
    id: z.number(),
    status: z.enum(["active", "inactive"]),
  }),
);

export async function bulkUpdateUsers(updates) {
  // Type: { id: number, status: 'active' | 'inactive' }[]
  return await db.users.updateMany(updates);
}
bulkUpdateUsers.schema = BulkUpdateSchema;

// Validate multiple parameters
export async function getDateRange(startDate, endDate) {
  // Validate both parameters
  return await db.analytics.query({ startDate, endDate });
}
getDateRange.schema = z.tuple([
  z.string().datetime(), // startDate
  z.string().datetime(), // endDate
]);
```

## 🚀 Production Deployment

### Building for Production

```bash
npm run build
```

This generates:

- `dist/server.js` - Your Express server with all endpoints
- `dist/actions.js` - Bundled server functions
- `dist/actions.d.ts` - Type definitions for the bundled functions
- `dist/openapi.json` - API specification (if enabled)
- Client assets with proxy functions

### Running in Production

```bash
node dist/server.js
```

Or with PM2:

```bash
pm2 start dist/server.js --name my-app
```

The generated `dist/server.js` is working-directory independent: it resolves every sibling file relative to the script itself via `import.meta.url` (`const __dirname = dirname(fileURLToPath(import.meta.url))`). Static client assets are served with `express.static(__dirname)` — the `dist` directory containing `server.js` — and `openapi.json` is read from `join(__dirname, 'openapi.json')`. So `node dist/server.js`, `pm2 start dist/server.js`, systemd units, and Docker entrypoints work from ANY working directory: `index.html`, hashed assets, the API routes, `/api/openapi.json`, and `/api/docs` all serve correctly. Note: paths inside your own action code (e.g. `process.cwd()`-based data files) remain relative to whatever directory you start the server from.

### Environment Variables

```javascript
// Access environment variables in server functions
export async function sendEmail(to, subject, body) {
  const apiKey = process.env.SENDGRID_API_KEY;
  // ...
}
```

## 🛡️ Security Considerations

### Server Code Isolation

- Server files (`.server.js` and `.server.ts`) are never bundled into client code
- Development builds include safety checks to prevent accidental imports
- Production builds completely separate server and client code

### Best Practices

1. **Never trust client input** - Always validate with Zod schemas
2. **Use middleware for auth** - Add authentication checks globally
3. **Sanitize file operations** - Be careful with file paths from clients
4. **Limit exposed functions** - Only export what clients need
5. **Use environment variables** - Keep secrets out of code

### Example: Secure File Access

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

## TypeScript Support

Vite Server Actions provides TypeScript support with automatic type generation:

### TypeScript Features

- **Automatic Type Generation** - `.d.ts` files generated for all server actions
- **Real-time Compilation** - TypeScript files compiled on-the-fly in development
- **Helpful Error Messages** - Development-time suggestions for TypeScript usage
- **Production Build Support** - Full TypeScript compilation in build process

```typescript
// server/users.server.ts
export interface User {
  id: number;
  name: string;
  email: string;
}

/**
 * Get user by ID with full type safety
 * @param id - The user ID to fetch
 * @returns Promise containing user data or null
 */
export async function getUser(id: number): Promise<User | null> {
  return await db.users.findUnique({ where: { id } });
}

// Client.tsx - Automatic type inference and IntelliSense!
import { getUser, type User } from "./server/users.server";

const user = await getUser(123); // Type: User | null
```

### Validation with Type Safety

```typescript
import { z } from "zod";

// Define your schemas with TypeScript interfaces
export interface CreateUserInput {
  name: string;
  email: string;
  age?: number;
}

const CreateUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email format"),
  age: z.number().optional(),
});

export async function createUser(data: CreateUserInput): Promise<User> {
  const validated = CreateUserSchema.parse(data);
  return await db.users.create({ data: validated });
}

// Attach schema for automatic validation and OpenAPI generation
createUser.schema = z.tuple([CreateUserSchema]);
```

### Documentation Generation

TypeScript types and JSDoc comments automatically generate API documentation:

```typescript
/**
 * Upload a file with validation and type safety
 * @param fileData - File upload data with filename, content, and metadata
 * @returns Promise containing upload result with file path and metadata
 */
export async function uploadFile(fileData: {
  filename: string;
  content: string;
  mimetype: string;
}): Promise<FileUploadResult> {
  // Implementation...
}
```

This automatically generates:

- **OpenAPI 3.0 specs** with TypeScript types
- **Swagger UI documentation** with interactive examples
- **Type definitions** (`.d.ts`) for client-side imports

## Developer Experience

Vite Server Actions provides development feedback and suggestions to improve code quality:

### Code Analysis

The plugin uses AST-based parsing to analyze your server functions and provide helpful feedback:

```typescript
// The plugin analyzes your code and provides suggestions:

// ⚠️ Warning: Function should be async
export function syncFunction() {
  return "data";
}
// 💡 Suggestion: Change to: export async function syncFunction()

// ⚠️ Warning: Missing return type annotation
export async function getUser(id) {
  return await db.user.findUnique({ where: { id } });
}
// 💡 Suggestion: Add return type like: Promise<User | null>

// ⚠️ Warning: Missing validation schema
export async function updateUser(id, data) {
  return await db.user.update({ where: { id }, data });
}
// Suggestion: Add schema: updateUser.schema = z.tuple([...])
```

### Development Warnings & Suggestions

- **Type Safety Hints** - Suggestions for adding TypeScript types and return annotations
- **Schema Validation** - Recommendations for adding Zod schemas to improve API reliability
- **Function Structure** - Best practices for async functions and proper exports
- **Security Warnings** - Path traversal detection and secure coding suggestions
- **Performance Tips** - Optimization suggestions for production builds

### Test Coverage

- **Test Coverage** - Unit and e2e test suites
- **Framework Support** - Tested with Svelte, Vue, React, and TypeScript React
- **Production Testing** - Feature parity between development and production modes
- **Cross-platform** - Works across different operating systems

## Error Handling

Server errors are automatically caught and returned with a standard error body of the shape `{ error: true, status, message, code, timestamp, details? }` — in both the development middleware and the generated production server:

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

An error without a usable HTTP status is deliberately opaque: HTTP 500 with message `"Internal server error"`. The `code` differs by mode: the development middleware sends `INTERNAL_ERROR`, while the generated production server sends `SERVER_ACTION_ERROR` (the fallback when the thrown error has no `code` of its own). `details` with the message/stack appears only when `NODE_ENV` is `development` — production responses omit it.

### Custom Error Responses

Error-status parity (dev == prod): a server action may throw an `Error` carrying an HTTP status via `error.status` or the common Express alias `error.statusCode`. In BOTH the development middleware and the generated production server, an integer status in the 400-599 range (other than 500) is honored: the HTTP response uses that status and the standard body shape above, where `message` is the thrown error's message and `code` is the error's own `code` property when set, falling back to `"SERVER_ACTION_ERROR"`. In development the body additionally includes `details.stack`.

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

Non-numeric statuses, out-of-range statuses (e.g. `302` or `999`), an explicit `500`, or no status at all keep the opaque behavior: HTTP 500 with message `"Internal server error"`. Internal classifications always take precedence over a user-set status: `FUNCTION_NOT_FOUND` → 404, `INVALID_REQUEST_BODY` → 400, and Zod `VALIDATION_ERROR` → 400. On the client, the proxy surfaces the HTTP status as `error.status` and the body's message and `details`, so custom statuses round-trip to your `catch` blocks unchanged.

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

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

This project is [MIT](LICENSE) licensed.

---

<p align="center">
  Made with ❤️ by <a href="https://helgesver.re">Helge Sverre</a>
</p>
