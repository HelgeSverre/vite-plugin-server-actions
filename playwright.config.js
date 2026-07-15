import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 30 * 1000,
	expect: {
		timeout: 5000,
	},
	fullyParallel: false, // Run projects sequentially to avoid port conflicts
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	// Each app shares a single todos.json, so tests that mutate state must not
	// run in parallel against the same dev server.
	workers: 1,
	reporter: "list",
	use: {
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "svelte",
			use: {
				browserName: "chromium",
				baseURL: "http://localhost:5273",
			},
			testMatch: ["**/todo-app-shared.spec.js", "**/svelte-todo-app.spec.js", "**/openapi-endpoint.spec.js"],
		},
		{
			name: "vue",
			use: {
				browserName: "chromium",
				baseURL: "http://localhost:5274",
			},
			testMatch: ["**/todo-app-shared.spec.js", "**/openapi-endpoint.spec.js"],
		},
		{
			name: "react",
			use: {
				browserName: "chromium",
				baseURL: "http://localhost:5275",
			},
			testMatch: ["**/todo-app-shared.spec.js", "**/openapi-endpoint.spec.js"],
		},
		{
			name: "react-ts",
			use: {
				browserName: "chromium",
				baseURL: "http://localhost:5276",
			},
			testMatch: ["**/todo-app-shared.spec.js", "**/openapi-endpoint.spec.js", "**/typescript-specific.spec.js"],
		},
		// Skip analytics demo in CI due to esbuild conflicts
		...(!process.env.CI
			? [
					{
						name: "analytics-demo",
						use: {
							browserName: "chromium",
							baseURL: "http://localhost:5278",
						},
						testMatch: "**/analytics-demo.spec.js",
					},
				]
			: []),
	],
	webServer: [
		{
			command: "cd examples/svelte-todo-app && npm run dev -- --port 5273 --strictPort",
			url: "http://localhost:5273",
			reuseExistingServer: !process.env.CI,
			timeout: 120 * 1000,
		},
		{
			command: "cd examples/vue-todo-app && npm run dev -- --port 5274 --strictPort",
			url: "http://localhost:5274",
			reuseExistingServer: !process.env.CI,
			timeout: 120 * 1000,
		},
		{
			command: "cd examples/react-todo-app && npm run dev -- --port 5275 --strictPort",
			url: "http://localhost:5275",
			reuseExistingServer: !process.env.CI,
			timeout: 120 * 1000,
		},
		{
			command: "cd examples/react-todo-app-typescript && npm run dev -- --port 5276 --strictPort",
			url: "http://localhost:5276",
			reuseExistingServer: !process.env.CI,
			timeout: 120 * 1000,
		},
		// Skip analytics demo in CI due to esbuild conflicts
		...(!process.env.CI
			? [
					{
						command: "cd examples/typescript-analytics-demo && npm run dev -- --port 5278 --strictPort",
						url: "http://localhost:5278",
						reuseExistingServer: !process.env.CI,
						timeout: 120 * 1000,
					},
				]
			: []),
	],
});
