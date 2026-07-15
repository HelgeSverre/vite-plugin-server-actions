# Contributing to Vite Server Actions

Thank you for your interest in contributing to Vite Server Actions! This document provides guidelines and instructions for contributing to the project.

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ (Node 16 reached EOL)
- npm or yarn
- Git

### Development Setup

```bash
# Clone the repository
git clone git@github.com:HelgeSverre/vite-plugin-server-actions.git
cd vite-plugin-server-actions

# Install dependencies
npm install

# Run tests in watch mode
npm test
```

## 📁 Project Structure

```
vite-plugin-server-actions/
├── src/                             # Plugin source code
│   ├── index.js                     # Main plugin implementation
│   ├── ast-parser.js                # AST-based export/schema extraction
│   ├── validation.js                # Validation middleware and schema discovery
│   ├── validation-runtime.js        # Runtime validation helpers (dev + prod)
│   ├── openapi.js                   # OpenAPI generation and Swagger UI
│   ├── middleware.js                # Built-in middleware (logging)
│   ├── middleware-analysis.js       # Free-variable analysis for embedding user middleware in prod builds
│   ├── schema-discovery-worker.js   # Build-time schema discovery (child process)
│   ├── build-utils.js               # Production build utilities
│   ├── security.js                  # Path sanitization helpers
│   ├── type-generator.js            # .d.ts generation for server modules
│   ├── dev-validator.js             # Development-time DX warnings
│   ├── error-enhancer.js            # Enhanced error messages
│   └── types.ts                     # TypeScript type definitions
├── tests/                           # Vitest unit/integration tests
│   └── e2e/                         # Playwright end-to-end tests
├── examples/                        # Six example apps:
│   ├── svelte-todo-app/             #   Svelte todo example
│   ├── vue-todo-app/                #   Vue todo example
│   ├── react-todo-app/              #   React todo example
│   ├── react-todo-app-typescript/   #   React + TypeScript todo example
│   ├── alpine-todo-app/             #   Alpine.js todo example (helper primitives)
│   └── typescript-analytics-demo/   #   Advanced TypeScript patterns demo
├── scripts/
│   └── reset-todos.js               # Resets example todos.json files (used after E2E runs)
├── docs/                            # Landing page for serveractions.dev
└── index.d.ts                       # Public TypeScript definitions
```

## 🛠️ Development Commands

### Testing

```bash
# Run tests in watch mode
npm test

# Run tests once
npm run test:run

# Run a specific test file
npx vitest run tests/validation.test.js

# Coverage report (no npm script; uses @vitest/coverage-v8)
npx vitest run --coverage
```

### E2E Tests

E2E tests use Playwright and require some one-time setup:

1. Install dependencies in each example app: `npm install` inside every `examples/*` directory
2. Install Playwright browsers: `npx playwright install chromium`

Playwright starts the example dev servers itself on ports 5273-5277 (todo apps) and 5278 (analytics demo, skipped in CI), so those ports must be free.

```bash
# Run E2E tests
npm run test:e2e

# Run E2E tests with UI / headed browser
npm run test:e2e:ui
npm run test:e2e:headed

# Reset example todos.json files first, then run E2E tests
npm run test:e2e:clean
```

The tests mutate each todo app's `todos.json`. Run `npm run reset:todos` afterwards to restore them from `examples/todos.template.json`.

### Code Quality

```bash
# Check TypeScript types
npm run typecheck

# Format code with Prettier
npm run format

# Run all checks (tests, typecheck)
npm run check
```

### Working with Examples

```bash
# Run examples in development (from the repo root)
npm run example:svelte:dev
npm run example:vue:dev
npm run example:react:dev
npm run example:react-ts:dev
npm run example:alpine:dev

# Build examples
npm run example:svelte:build
npm run example:vue:build
npm run example:react:build
npm run example:react-ts:build
npm run example:alpine:build

# Test production build
cd examples/svelte-todo-app && npm run build && node dist/server.js
```

## 🧪 Writing Tests

### Unit Tests

Unit tests are located in `tests/` and use Vitest. Follow these patterns:

```javascript
import { describe, it, expect } from "vitest";

describe("Feature Name", () => {
  it("should do something specific", () => {
    // Arrange
    const input = createTestInput();

    // Act
    const result = functionUnderTest(input);

    // Assert
    expect(result).toBe(expectedValue);
  });
});
```

### E2E Tests

E2E tests use Playwright and test the example apps in the browser:

```javascript
import { test, expect } from "@playwright/test";

test.describe("Todo App Integration", () => {
  test("should add a new todo", async ({ page }) => {
    await page.goto("/");

    // Using data-testid for framework-agnostic testing
    await page.getByTestId("todo-input").fill("New todo");
    await page.getByTestId("add-button").click();

    await expect(page.getByTestId("todo-item")).toContainText("New todo");
  });
});
```

The five todo-app examples (Svelte, Vue, React, React + TypeScript, Alpine.js) share the suite in `tests/e2e/todo-app-shared.spec.js`; the Alpine example additionally runs `tests/e2e/alpine-helpers.spec.js`, and the analytics demo has its own spec (`tests/e2e/analytics-demo.spec.js`).

## 📝 Coding Standards

### JavaScript Style

- Use ES modules (`import`/`export`)
- Use `async`/`await` over promises
- Prefer `const` over `let`
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Use tabs for indentation (enforced via `.editorconfig`)
- Semicolons are used (Prettier default, `semi: true` in `.prettierrc`)

### Commit Messages

Follow conventional commits:

```
feat: add validation middleware
fix: handle edge case in route transformation
docs: update README examples
test: add tests for production build
chore: update dependencies
```

### Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Add/update tests as needed
5. Run `npm run check` to ensure all checks pass
6. Run `npm run format` to format your code
7. Commit your changes with a descriptive message
8. Push to your fork
9. Open a Pull Request with:
   - Clear description of changes
   - Link to related issue (if any)
   - Screenshots/demos for UI changes
   - Test results showing all tests pass

## 🐛 Reporting Issues

When reporting issues, please include:

- Node.js version
- Vite version
- Plugin version
- Minimal reproduction code
- Error messages/stack traces
- Expected vs actual behavior

## 💡 Feature Requests

Feature requests are welcome! Please:

- Check existing issues first
- Provide use cases and examples
- Explain why this would benefit users
- Consider submitting a PR if you can implement it

## 🔒 Security

If you discover a security vulnerability, please email helge.sverre@gmail.com instead of using the issue tracker.

## 🚢 Release Process

Releases are managed through GitHub Actions:

1. Update version in `package.json`
2. Update `CHANGELOG.md` with release notes
3. Commit with message: `chore: release v{version}`
4. Create and push a tag: `git tag v{version} && git push origin v{version}`
5. GitHub Actions will automatically publish to npm

## 📚 Resources

- [Plugin Documentation](https://serveractions.dev)
- [Vite Plugin API](https://vitejs.dev/guide/api-plugin.html)
- [Express.js Documentation](https://expressjs.com/)
- [Zod Documentation](https://zod.dev/)
- [OpenAPI Specification](https://swagger.io/specification/)
- [Playwright Documentation](https://playwright.dev/)

## ❓ Questions?

Feel free to open a discussion or reach out in issues if you have questions about contributing.

---

Thank you for contributing to Vite Server Actions! 🎉
