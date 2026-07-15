# TODO

## Future Tasks

- [x] Ensure user defined middleware is bundled into production server build (self-contained middleware functions are
      embedded via `toString()` with free-variable analysis in `src/middleware-analysis.js`; string-path middleware
      modules are bundled - see `src/build-utils.js`)

### Configuration Enhancements

- [x] Add configurable output server filename (default to server.js) (`serverFileName` option; plain-filename
      validation at config time; covered by `tests/config-options.test.js`)
- [x] Add ability to disable openapi.json and swagger-ui separately (`openAPI.enabled` toggles the spec,
      `openAPI.swaggerUI: false` disables the UI while keeping the spec, in both dev and prod)
- [x] Allow configuring the output filename/location for openapi.json and swagger-ui when building (`openAPI.outputFile`
      controls the emitted spec filename and the generated server reads it via `join(__dirname, <outputFile>)`; serve
      paths stay configurable via `openAPI.specPath`/`openAPI.docsPath`; covered by `tests/config-options.test.js`)
- [x] Allow silencing the logging (`silent: true` suppresses the plugin's log/info/warn chatter via `src/logger.js`;
      errors always print and middleware-exclusion warnings route through Rollup's build warning path; covered by
      `tests/config-options.test.js`)

### Additional Examples

- [x] Add Vue.js example todo app (exact replica of Svelte functionality)
- [x] Add React example todo app (exact replica of Svelte functionality)
- [ ] Add Riot.js example todo app (exact replica of Svelte functionality)
- [x] Add Alpine.js example todo app (exact replica of Svelte functionality) - `examples/alpine-todo-app`, runs the shared e2e suite plus `tests/e2e/alpine-helpers.spec.js` and ships copy-pasteable Alpine helpers (`$server`/`$action`/`x-action`/`$query`) in `src/alpine-server-actions.js`

### Features

- [ ] Add WebSocket support for real-time server actions (alternative transport mechanism instead of HTTP fetch calls
      from the client-side)
- [x] Add rate limiting middleware example (fixed-window per-IP limiter documented in the README's Middleware guide as
      file-path middleware; the example code is exercised by `tests/config-options.test.js`)
- [ ] Add "drop-in" simple authentication middleware that uses cookies/sessions and json/sqlite for storing user
      accounts and authenticated session (not really meant for prod usage, but it could i guess)
- [ ] Add support for streaming responses

## Future Improvements

### Security Enhancements (High Priority)

- [ ] Add request timeout middleware with configurable timeouts per action
- [ ] Implement rate limiting middleware with memory store for dev and Redis example for production
- [ ] Add request body size limits and file upload size restrictions
- [ ] Implement CSRF protection with token generation/validation
- [ ] Add security headers middleware (helmet.js integration)
- [ ] Implement API key/token authentication options
- [ ] Add file type validation and virus scanning hooks for uploads

### Production Readiness (High Priority)

- [x] Add graceful shutdown handling (SIGTERM/SIGINT) with connection draining (the generated production server stops
      accepting connections, drains in-flight requests, exits 0, and force-exits 1 after 10s; covered by a real
      boot/SIGTERM test in `tests/config-options.test.js`)
- [ ] Implement health check endpoints (/health, /ready) with custom checks
- [ ] Add request ID tracking for debugging and correlation
- [ ] Include structured logging for production environments
- [ ] Add clustering support for multi-core utilization
- [ ] Implement proper error tracking with configurable error reporting
- [ ] Add monitoring/APM integration hooks (OpenTelemetry, etc.)
- [ ] Create deployment guides for common platforms (Docker, K8s, serverless)

### Performance Optimizations (Medium Priority)

- [ ] Add response compression (gzip/brotli) to production builds
- [ ] Implement AST parsing cache with LRU eviction
- [ ] Add proper memory management for TypeScript module cache
- [ ] Implement request deduplication for identical concurrent requests
- [ ] Add connection pooling examples for database operations
- [ ] Implement response caching layer with invalidation strategies
- [ ] Add request queuing for rate-limited operations

### Code Organization (Medium Priority)

- [ ] Split large index.js file (~1300 lines) into smaller modules
- [ ] Extract TypeScript handling to separate module
- [ ] Reorganize middleware into dedicated directory structure
- [x] Create separate build utilities module (`src/build-utils.js`)
- [ ] Implement plugin system for extensibility
- [ ] Add middleware composition utilities

### Developer Experience Enhancements

- [ ] Add authentication middleware examples (JWT/session-based)
- [ ] Implement WebSocket transport for real-time server actions
- [ ] Add request/response interceptor support
- [ ] Create batch operations support for multiple actions
- [ ] Add GraphQL-like field selection to reduce payload size
- [ ] Implement automatic retry with exponential backoff
- [ ] Add playground UI for interactive API exploration
- [ ] Create migration guide from traditional API routes
- [ ] Add SSR framework support (Next.js, Nuxt.js)
- [x] Implement HMR for schema changes (the dev watcher invalidates cached modules and their schemas on `.server.js`/`.server.ts` edits and re-discovers on next request; covered by `tests/hmr.test.js`)
- [ ] Add TypeScript declaration maps for better IDE support

---

## Completed Tasks (v1.0.0)

### NPM Publishing Preparation

- [x] Update package.json with proper metadata
  - [x] Add keywords for discoverability
  - [x] Update description
  - [x] Add repository, bugs, and homepage fields
  - [x] Set proper entry points
  - [x] Add files field to specify what to publish
- [x] Create CHANGELOG.md file
- [x] Create LICENSE file
- [x] Create .npmignore file

### CI/CD Setup

- [x] Create GitHub Actions workflow for automated testing
  - [x] Run unit tests on push/PR
  - [x] Run E2E tests
  - [x] Run linting and type checking
- [x] Add workflow for automated npm publishing on release
- [x] Add PR check workflow for commit linting and bundle size
- [x] Remove Husky in favor of GitHub Actions CI

### E2E Integration Tests

- [x] Add file upload tests to E2E integration tests for todo app

### Production Features

- [x] Production build validation and OpenAPI support
- [x] Fix TypeScript definitions
- [x] Add validation context to middleware

### Configuration Updates

- [x] Don't nest configuration for openapi under validation
- [x] Update TypeScript definitions for separated config
- [x] Update all tests to use new configuration structure
- [x] Update README documentation for new config options

### Documentation

- [x] README rewrite for production release
- [x] Create CONTRIBUTING.md

### Example App Enhancements

- [x] File Upload Feature for Todo App
  - [x] Add priority field to todo items
  - [x] Add file upload capability to todos
  - [x] Add description field to todos
  - [x] Implement Notion-style design
  - [x] Store files in public/uploads folder
  - [x] Add filepath field to todo.json
  - [x] Generate colorful test images
- [x] Create Vue.js example todo app with identical functionality to Svelte
- [x] Create React example todo app with identical functionality to Svelte
- [x] Unify visual styling across all three framework examples
- [x] Add framework-specific titles to distinguish apps
- [x] Remove unused authentication code from examples
