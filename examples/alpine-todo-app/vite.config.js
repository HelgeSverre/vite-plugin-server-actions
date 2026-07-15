import { defineConfig } from "vite";
import serverActions from "../../src/index.js";

export default defineConfig({
	plugins: [
		serverActions({
			validation: {
				enabled: true,
			},
			openAPI: {
				enabled: true,
				info: {
					title: "Alpine Todo App API",
					version: "1.0.0",
					description: "API documentation for the Alpine Todo App",
				},
			},
		}),
	],
});
