# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **Vite Server Actions** - a Vite plugin that enables creating server-side functions and calling them from client-side code as seamless proxies. It includes built-in validation with Zod schemas and automatic OpenAPI documentation generation.

## Core Architecture

The plugin works by:

1. Scanning for files ending with `.server.js` or `.server.ts` during the build process
2. Extracting exported functions using AST parsing (`@babel/parser` via `src/ast-parser.js`)
3. In development: Creating Express middleware endpoints at `/api/{routePath}/{functionName}`, where the route path comes from the configurable `routeTransform`. The default transform strips the leading `src/` and the `.server.js`/`.server.ts` suffix but keeps the directory hierarchy, so `src/actions/todo.server.js` maps to `/api/actions/todo/{functionName}`
4. In production: Bundling server functions and generating a standalone Express server with the same routes
5. Client imports are transformed to proxy functions that make HTTP POST requests to the server endpoints

Key files:

- `src/index.js` - Main plugin implementation with Vite/Rollup integration
- `src/validation.js` - Validation middleware and schema discovery system
- `src/openapi.js` - OpenAPI spec generation and Swagger UI integration
- `src/build-utils.js` - Production build utilities for validation code generation
- `examples/svelte-todo-app/` - Working Svelte example demonstrating all features

## Development Commands

### Main project:

- `npm run format` - Format code with Prettier
- `npm run test` - Run tests in watch mode
- `npm run test:run` - Run tests once
- `npm run typecheck` - Check TypeScript types
- `npm run check` - Run all quality checks (tests, typecheck)
- `npm run sort` - Sort package.json
- `npm run example:svelte:dev` - Run the Svelte todo app example in development
- `npm run example:svelte:build` - Build the Svelte todo app example

### Svelte todo app example:

- `cd examples/svelte-todo-app && npm run dev` - Development server
- `cd examples/svelte-todo-app && npm run build` - Production build
- `cd examples/svelte-todo-app && npm run preview` - Preview production build
- `cd examples/svelte-todo-app && npm run format` - Format example code

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
- `dist/server.js` - Express server with API endpoints, validation middleware, and OpenAPI support
- `dist/openapi.json` - OpenAPI 3.0 specification (if OpenAPI is enabled)
- Client bundles with proxy functions replacing server imports

## Validation and OpenAPI

When validation is enabled:

1. Functions can have attached Zod schemas: `myFunction.schema = z.object({...})`
2. Schemas are automatically discovered and used for request validation
3. OpenAPI spec is generated from schemas with proper types and descriptions
4. Swagger UI is available at `/api/docs` for interactive API exploration
5. Validation works in both development and production modes

## Testing

- Unit tests: `npm test` - Tests plugin functionality, validation, OpenAPI generation
- E2E tests: `npm run test:e2e` - Tests the todo app example with Playwright
- Production build test: `tests/production-build.test.js` - Verifies production features
