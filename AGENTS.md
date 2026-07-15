# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## Project Overview

This is **Vite Server Actions** (npm: `vite-plugin-server-actions`) - a Vite plugin that enables creating server-side functions and calling them from client-side code as seamless proxies. It includes built-in validation with Zod schemas and automatic OpenAPI documentation generation.

## Core Architecture

The plugin works by:

1. Scanning for files matching the `include` patterns (default: `**/*.server.js` and `**/*.server.ts`) during the build process
2. Extracting exported functions using AST parsing (`@babel/parser` via `src/ast-parser.js`)
3. In development: Creating Express middleware endpoints at `{apiPrefix}/{routePath}/{functionName}` (default prefix `/api`), where the route path comes from the configurable `routeTransform`. The default transform strips the leading `src/` and the `.server.js`/`.server.ts` suffix but keeps the directory hierarchy, so `src/actions/todo.server.js` maps to `/api/actions/todo/{functionName}`
4. In production: Bundling server functions and generating a standalone Express server with the same routes
5. Client imports are transformed to proxy functions that make HTTP POST requests to the server endpoints

Validation and OpenAPI are opt-in: `validation.enabled` defaults to `false`.

### Key files

- `src/index.js` - Main plugin implementation with Vite/Rollup integration; `DEFAULT_OPTIONS` near the top documents every plugin option
- `src/ast-parser.js` - Extracts exported functions and types from server files via Babel
- `src/validation.js` - Validation middleware and schema discovery system
- `src/validation-runtime.js` - Standalone validation runtime that gets bundled into the production server (no imports from `src/`)
- `src/openapi.js` - OpenAPI spec generation and Swagger UI integration
- `src/build-utils.js` - Production build utilities for validation and middleware code generation
- `src/middleware.js` - Built-in middleware (e.g. `loggingMiddleware`) users can add via the `middleware` option
- `src/middleware-analysis.js` - Free-variable analysis that decides whether a user middleware function can be safely embedded (via `toString()`) into the generated production server
- `src/schema-discovery-worker.js` - Disposable child process spawned during `vite build` that imports user server modules and converts their Zod schemas to OpenAPI form without side effects hanging the build
- `src/security.js` - Path sanitization guarding against directory traversal when resolving server files
- `src/type-generator.js` - Generates `.d.ts` definitions for discovered server actions
- `src/error-enhancer.js` / `src/dev-validator.js` - Developer-facing error messages and dev-time signature warnings
- `src/logger.js` - Internal logger; the `silent` plugin option suppresses log/info/warn (errors always print)

### Examples

`examples/` contains five working todo apps (`svelte-todo-app`, `vue-todo-app`, `react-todo-app`, `react-todo-app-typescript`, `alpine-todo-app`) plus `typescript-analytics-demo`. They share `examples/todos.template.json` as seed data; `npm run reset:todos` restores each app's `todos.json` from it.

## Development Commands

- `npm run format` - Format code with Prettier
- `npm test` - Run unit tests in watch mode
- `npm run test:run` - Run unit tests once
- `npm run typecheck` - Check TypeScript types
- `npm run check` - Run all quality checks (test:run + typecheck); also runs on prepublish
- `npm run sort` - Sort package.json
- `npm run test:e2e` - Playwright e2e tests (see Testing below)
- `npm run test:e2e:clean` - Reset example todos.json files, then run e2e tests
- `npm run example:svelte:dev` / `example:svelte:build` - Run or build the Svelte example (same pattern for `example:vue:*`, `example:react:*`, `example:react-ts:*`, `example:alpine:*`)

Each example app also has its own `dev`, `build`, `preview`, and `format` scripts runnable from its directory.

## Server Actions Pattern

Server functions must:

- Be in files ending with `.server.js` or `.server.ts`
- Export async functions
- Accept arguments that are JSON-serializable
- Return JSON-serializable values

The plugin transforms imports like:

```javascript
import { addTodo } from "./actions/todo.server.js";
```

Into client-side proxy functions that POST to the transformed route (for a file at `src/actions/todo.server.js`, the default `routeTransform` produces `/api/actions/todo/addTodo`).

## Production Build Output

The build process generates:

- `dist/actions.js` - Bundled server functions with attached Zod schemas
- `dist/server.js` - Express server with API endpoints, validation middleware, and OpenAPI support (filename configurable via `serverFileName`)
- `dist/openapi.json` - OpenAPI 3.0 specification (if OpenAPI is enabled)
- Client bundles with proxy functions replacing server imports

## Validation and OpenAPI

When validation is enabled (`validation: { enabled: true }`):

1. Functions can have attached Zod schemas: `myFunction.schema = z.object({...})`
2. Schemas are automatically discovered and used for request validation
3. OpenAPI spec is generated from schemas with proper types and descriptions
4. Swagger UI is available at `/api/docs` for interactive API exploration
5. Validation works in both development and production modes

## Testing

- Unit tests: `npm run test:run` - Plugin functionality, validation, OpenAPI generation, TypeScript handling, and regression suites (`tests/regressions-*.test.js`)
- E2E tests: `npm run test:e2e` - Tests the example apps with Playwright (requires example dependencies installed; uses ports 5273-5277 and 5278). E2E runs mutate the examples' `todos.json`; use `npm run test:e2e:clean` or `npm run reset:todos` to restore them
- Production build test: `tests/production-build.test.js` - Verifies production features
