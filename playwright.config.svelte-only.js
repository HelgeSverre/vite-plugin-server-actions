import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 30 * 1000,
	expect: {
		timeout: 5000,
	},
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	// The app shares a single todos.json, so tests that mutate state must not
	// run in parallel against the same dev server.
	workers: 1,
	reporter: "list",
	use: {
		baseURL: "http://localhost:5273",
		trace: "on-first-retry",
	},
	projects: [
		{
			// Named "svelte" so shared specs derive the right framework name/titles
			name: "svelte",
			use: { browserName: "chromium" },
			testMatch: ["**/todo-app-shared.spec.js", "**/svelte-todo-app.spec.js", "**/openapi-endpoint.spec.js"],
		},
	],
	webServer: {
		command: "cd examples/svelte-todo-app && npm run dev -- --port 5273 --strictPort",
		url: "http://localhost:5273",
		reuseExistingServer: !process.env.CI,
	},
});
