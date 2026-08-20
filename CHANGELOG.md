# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-08-21

A security-audit release: an adversarial review of the plugin and its generated production server found and fixed three exploitable issues (dependency auto-exposure, route-pattern injection, ambient-NODE_ENV error leakage) plus two lower-severity build-tooling flaws. Every fix is pinned by new regression tests that reproduce the original exploits against a running dev server and a spawned production server.

### Security

- **Dependencies are no longer treated as server actions** - Files inside `node_modules` never become HTTP endpoints or entries in the production actions bundle. Previously, any dependency shipping a `*.server.js` file that got imported was silently bundled into `dist/.vsa/actions.js` and exposed as an unauthenticated public POST endpoint in production (and its raw source was served to the browser in dev, because Vite's `?v=` cache-buster query made the include pattern miss). Enable `allowNodeModules: true` only for workspace packages symlinked into `node_modules`. A one-time warning is logged when a `node_modules` `.server.js` import is detected.
- **Route paths can no longer inject Express route patterns** - Route segments derived from file/directory names are escaped before registration in both dev and the generated production server. A file named `:id.server.js` previously registered `/api/:id/...` as a wildcard matching ANY single URL segment, hijacking other routes; it now matches only literally.
- **The generated production server no longer keys error details off `NODE_ENV`** - Booting `dist/server.js` with `NODE_ENV=development` previously served full stack traces and absolute filesystem paths to every client. Internal error details are now opt-in via the explicit `serverErrorDetails` option (default `false`); the same fix applies to the embedded validation runtime.
- **Build-time schema discovery writes to a private temp directory** - The worker output path was predictable (`$TMPDIR/vsa-schemas-<pid>-<timestamp>.json`) and written without exclusive-create semantics, letting a local attacker pre-plant a symlink to clobber arbitrary files as the build user or poison the emitted OpenAPI spec. It now uses `fs.mkdtemp`.
- **Generated `.d.ts` declarations cannot be broken out of via crafted file names** - `declare module "..."` names are now emitted as properly escaped string literals.

### Added

- **`allowNodeModules` option** - Opt back into processing files inside `node_modules` (for workspace packages symlinked into `node_modules`). Default `false`.
- **`serverErrorDetails` option** - Explicitly include internal error details (message + stack trace) in the generated production server's 500 responses. Default `false`.
- **`escapeRoutePath` export** - Escape route segments for literal Express matching when generating your own registrations from custom `routeTransform` output.

### Changed

- Bare specifiers (package imports) are no longer resolved relative to the importing file by the plugin's `resolveId`; they fall through to Vite's resolver, where the `node_modules` policy applies. Relative imports (`./x.server.js`, `../lib/x.server.js`) continue to work.

## [1.4.1] - 2026-08-12

### Security

- Block mixed-case aliases of the private `.vsa` directory on case-insensitive filesystems.
- Fail production builds instead of silently dropping middleware that cannot be serialized safely.
- Reject trailing action arguments not covered by a non-tuple validation schema; multi-argument actions must use tuple schemas.
- Strip server-action JSDoc from browser-facing proxy modules.

### Changed

- The built-in logging middleware is now self-contained and runs in generated production servers.

## [1.3.1] - 2026-07-15

Package-manager compatibility fixes, verified by running the full suite (435 unit + 103 e2e tests) from pristine installs with npm, yarn, pnpm, and bun in a clean container.

### Fixed

- **pnpm installs** - pnpm 10+ blocks dependency build scripts by default, which broke esbuild's binary download. Build allowances are now declared for both mechanisms: `allowBuilds` in `pnpm-workspace.yaml` (pnpm 11+, with `@scarf/scarf` telemetry explicitly denied) and the `pnpm` field in `package.json` (pnpm ≤10).
- **Phantom test dependency** - `tests/production-build.test.js` imported the undeclared `node-fetch` (masked by npm/yarn/bun hoisting, rejected by pnpm's strict layout); it now uses Node's global `fetch`.

## [1.3.0] - 2026-07-15

A large stabilization and hardening release: a full adversarially-verified audit fixed 47 bugs across the plugin, middleware became a real production feature, and the toolchain moved to Vite 8. Test coverage grew from 253 to 435 unit tests plus 103 Playwright e2e tests across six example apps.

### Added

- **Production Middleware** - User middleware now works in production builds. Self-contained middleware functions are embedded into the generated server via `fn.toString()`, gated by static free-variable analysis; middleware that captures module scope can be passed as a module path string, which is bundled into `dist/actions.js`. Middleware sees all API-prefix requests including CORS `OPTIONS` preflights, in both dev and production.
- **`serverFileName` option** - Configurable production server filename (default `server.js`).
- **`openAPI.outputFile` option** - Configurable emitted spec filename (default `openapi.json`).
- **`silent` option** - Suppresses the plugin's dev/build console output; errors and Rollup build warnings still surface.
- **Graceful shutdown** - The generated production server handles `SIGTERM`/`SIGINT`: stops accepting connections, drains in-flight requests, exits cleanly (10s force-exit backstop).
- **Alpine.js example** (`examples/alpine-todo-app`) - Full todo app built on a copyable Alpine plugin providing `$server` (action registry), `$action` (reactive pending/error/data state), `x-action` (form directive with validation-error mapping and a `.reset` modifier), and `$query` (SWR-style reads with event-driven refetch).
- **Rate limiting middleware example** in the README, demonstrating the module-path middleware form for stateful middleware.
- Regression tests for issues [#3](https://github.com/HelgeSverre/vite-plugin-server-actions/issues/3) (non-default ports reflected in the OpenAPI spec) and [#5](https://github.com/HelgeSverre/vite-plugin-server-actions/issues/5) (Node built-ins in `.server.ts` never leak into client bundles).

### Fixed

47 verified bugs, including:

- **Stale dev code** - Editing a `.server.js` file (or one of its helper imports) now serves fresh code on the next request; previously Node's ESM cache served stale code until a dev-server restart.
- **HMR schema wipe** - Editing one server file no longer silently disables Zod validation for all other modules; first-request validation bypass for `.server.ts` actions closed.
- **Empty production OpenAPI spec** - `dist/openapi.json` now contains real Zod-derived request schemas; schema discovery runs in a disposable child process so user-module side effects cannot hang `vite build`.
- **Stack trace leak** - The generated production server no longer includes stack traces and internal error details by default (only when `NODE_ENV=development`).
- **Module naming** - Files like `404.server.js` or `class.server.js` no longer break the build; distinct files that normalize to the same module name get deterministic suffixes instead of silently overwriting each other.
- **Codegen robustness** - Destructured parameters with defaults no longer crash proxy generation; re-exports warn instead of silently disappearing; generated `.d.ts` files are always valid TypeScript; file paths are escaped in all generated code.
- **Validation correctness** - Tuple schemas are no longer double-wrapped in the OpenAPI spec; nested `.openapi('Name')` schemas resolve their `$ref`s; query strings no longer bypass the standalone validation middleware; error response shapes are unified across dev, production, and the documented OpenAPI contract.
- **Error handling parity** - User-thrown errors with `status`/`statusCode` (400-599) are honored identically in dev and production; user errors whose message contains "not found" are no longer misclassified as 404s.
- **Path handling** - `include`/`exclude` support project-root-relative glob patterns; `sanitizePath` enforces containment in every `NODE_ENV` while honoring `server.fs.allow`; the production server resolves static assets and the spec relative to itself, so it runs from any working directory (pm2/systemd/Docker safe).

### Changed

- **Toolchain** - Vite 8 + Vitest 4; peer range widened to Vite `^4 || ^5 || ^6 || ^7 || ^8`; CI matrix now Node 20/22/24/26 (Vite 7+ requires Node `^20.19 || >=22.12`; Node 18 remains supported for consumers using Vite 4-6).
- **zod constraint** - Validation requires zod `^3` (declared as an optional peer dependency); zod 4's changed `ZodError` shape is not yet supported.
- **Documentation** - README restructured along Diátaxis lines (Getting Started / Guides / Reference / How It Works); every technical claim audited against the code. `CLAUDE.md` renamed to `AGENTS.md`.
- **Examples** - All examples upgraded to Vite 8; the Svelte example moved to Svelte 5.

### Removed

- Stale repository artifacts (`verification-demos/`, ad-hoc scripts, one-off release notes).

## [1.2.0] - 2025-12-21

This release focuses on stability, correctness, and documentation accuracy in preparation for public release.

### Fixed

- **Falsy Return Value Handling** - Server actions returning `0`, `false`, `""`, or `null` now work correctly. Previously these values were incorrectly treated as errors. Actions returning `undefined` now properly send HTTP 204 No Content.
- **Validation Adapter Initialization** - Fixed bug where validation adapter configured as a string (e.g., `"zod"`) was not properly instantiated, causing validation to fail silently.
- **Production Validation Runtime** - Fixed dev/prod validation behavior mismatch where production wasn't validating request body array structure.
- **OpenAPI Zod Conversion** - Added fallback converter for Zod schemas without `.openapi()` metadata, preventing "zodSchema.openapi is not a function" errors.
- **Module Cache Isolation** - Fixed global singleton module cache that could cause corruption across multiple plugin instances.
- **Error Response Consistency** - Aligned error response shapes across development, production, and OpenAPI schema documentation.
- **Analytics Demo Tests** - Fixed test timeouts by increasing timeout limits from 5s to 15s/30s.

### Added

- **Error Enhancement Tests** - 39 new tests covering error message formatting, typo detection, and helpful suggestions.
- **HMR Tests** - 8 new tests for Hot Module Replacement functionality including watcher setup and file change detection.

### Changed

- **Package Homepage** - Updated from GitHub URL to serveractions.dev for better documentation experience.
- **Test Count** - Increased from 206 to 253 tests (100% passing).
- **Type Definitions** - Improved `index.d.ts` to accurately reflect runtime behavior of validation and OpenAPI modules.
- **Documentation** - Clarified default route transform behavior and that validation is disabled by default.

### Removed

- **Dead Code** - Removed unreachable client proxy security check that could never trigger.

## [1.1.1] - 2025-07-14

### Added

- Enhanced TypeScript type generation with support for 95% of TypeScript type patterns
- Support for intersection types, tuple types, template literals, conditional types, and more
- Comprehensive test suite for TypeScript type generation (20+ test cases)
- Advanced TypeScript examples demonstrating complex type patterns

### Fixed

- Port configuration now correctly propagates to OpenAPI documentation
- Fixed hardcoded port 5173 in multiple locations
- Improved error handling for malformed TypeScript types

### Changed

- Reduced marketing language in documentation
- Minimized emoji usage throughout codebase
- Updated TODO.md with future improvement roadmap

## [1.1.0] - 2025-06-27

### Added

- **Enhanced TypeScript Support** - Full TypeScript integration with real-time compilation in development
- **Automatic Type Generation** - Generate `.d.ts` files for all server actions with proper TypeScript types
- **AST-Based Function Detection** - More reliable function parsing with detailed TypeScript analysis
- **TypeScript React Example** - Comprehensive example showcasing all DX features with full TypeScript support
- **Development Experience Improvements** - Smart code analysis with helpful warnings and suggestions
- **Enhanced Error Messages** - Detailed error messages with actionable suggestions for better code quality
- **Security Enhancements** - Path traversal protection and secure module name validation
- **Test Infrastructure** - Comprehensive test coverage (100% success rate) with both unit and e2e tests
- **OpenAPI Type Integration** - TypeScript types automatically extracted for OpenAPI documentation
- **Production TypeScript Compilation** - Full TypeScript support in production builds using esbuild

### Improved

- **TypeScript Development Mode** - On-the-fly TypeScript compilation with retry logic and cache busting
- **Module Import Reliability** - Enhanced import system with better error handling and recovery
- **Test Coverage** - Achieved 100% test success rate across all frameworks (Svelte, Vue, React, TypeScript React)
- **Documentation** - Updated README with comprehensive TypeScript examples and DX feature showcase
- **Developer Feedback** - Real-time validation warnings and best practice suggestions

### Fixed

- **TypeScript Import Issues** - Resolved module loading problems in development mode
- **Test Reliability** - Fixed flaky tests and improved test infrastructure
- **File Upload Compatibility** - Enhanced file upload testing across all framework implementations
- **Cache Management** - Better HMR cache handling for TypeScript files

## [1.0.1] - 2025-06-26

### Added

- Support for Vite 7
- Mobile responsiveness for code tabs in documentation site
- Improved terminal-style tabs design in documentation site

### Changed

- Dropped support for Vite 2 and 3 (now requires Vite 4+)
- Removed ESLint in favor of Prettier-only formatting

### Fixed

- Code tabs interference between examples in documentation
- Mobile scrolling behavior for code tabs (dots now stay fixed)

## [1.0.0] - 2025-06-23

First stable release! This version is production-ready with comprehensive features for building full-stack applications with Vite.

### Added

- File upload support in todo example app
- Priority field for todos (low/medium/high)
- Description field for todos (max 800 chars)
- Notion-style UI design for todo app
- Comprehensive E2E tests for file upload functionality
- Error handling for corrupted JSON files
- LICENSE file for MIT license
- .npmignore file for cleaner npm package
- GitHub Actions CI/CD workflows for automated testing and npm publishing
- PR check workflow for commit linting and bundle size verification

### Changed

- Improved package.json metadata for npm publishing
- Enhanced keywords for better discoverability
- Added proper exports field for ES modules
- Added files field to specify published files
- Added engines field for Node.js compatibility

### Fixed

- Test parallelization issues with proper cleanup
- ESLint errors in todo.server.js
- JSON import syntax for production builds

## [0.1.1] - 2025-06-22

### Added

- Production build support with validation and OpenAPI
- TypeScript type definitions
- Middleware support with validation context
- Swagger UI for API documentation
- File-based routing for server actions
- Request validation with Zod schemas
- Automatic OpenAPI spec generation

### Changed

- Complete README rewrite for production release
- Removed experimental warnings
- Improved error handling and validation

### Fixed

- TypeScript definition issues
- Production build validation
- API route generation

## [0.1.0] - 2025-06-20

### Added

- Initial release
- Basic server actions functionality
- Vite plugin for proxying backend functions
- Express server integration
- Hot module replacement support
- Basic todo app example

[1.2.0]: https://github.com/HelgeSverre/vite-plugin-server-actions/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/HelgeSverre/vite-plugin-server-actions/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/HelgeSverre/vite-plugin-server-actions/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/HelgeSverre/vite-plugin-server-actions/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/HelgeSverre/vite-plugin-server-actions/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/HelgeSverre/vite-plugin-server-actions/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/HelgeSverre/vite-plugin-server-actions/releases/tag/v0.1.0
