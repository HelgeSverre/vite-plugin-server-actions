import fs from "fs/promises";
import path from "path";
import express from "express";
// TODO: find a way to not use rollup directly
import { rollup } from "rollup";

export default function serverActions() {
	const serverFunctions = new Map();
	let app;

	return {
		name: "vite-plugin-server-actions",

		configureServer(server) {
			app = express();
			app.use(express.json());
			server.middlewares.use(app);
		},

		async resolveId(source, importer) {
			if (source.endsWith(".server.js") && importer) {
				const resolvedPath = path.resolve(path.dirname(importer), source);
				return resolvedPath;
			}
		},

		async load(id) {
			if (id.endsWith(".server.js")) {
				const code = await fs.readFile(id, "utf-8");
				const moduleName = path.basename(id, ".server.js");
				const exportRegex = /export\s+(async\s+)?function\s+(\w+)/g;
				const functions = [];
				let match;
				while ((match = exportRegex.exec(code)) !== null) {
					functions.push(match[2]);
				}

				serverFunctions.set(moduleName, { functions, id });

				if (process.env.NODE_ENV !== "production") {
					functions.forEach((functionName) => {
						const endpoint = `/api/${moduleName}/${functionName}`;
						app.post(endpoint, async (req, res) => {
							try {
								const module = await import(id);
								const result = await module[functionName](...req.body);
								res.json(result || "* No response *");
							} catch (error) {
								console.error(`Error in ${functionName}: ${error.message}`);
								res.status(500).json({ error: error.message });
							}
						});
					});
				}
				return generateClientProxy(moduleName, functions);
			}
		},

		async generateBundle(options, bundle) {
			// Create a virtual entry point for all server functions
			const virtualEntryId = "virtual:server-actions-entry";
			let virtualModuleContent = "";
			for (const [moduleName, { id }] of serverFunctions) {
				virtualModuleContent += `import * as ${moduleName} from '${id}';\n`;
			}
			virtualModuleContent += `export { ${Array.from(serverFunctions.keys()).join(", ")} };`;

			// Use Rollup to bundle the virtual module
			const build = await rollup({
				input: virtualEntryId,
				plugins: [
					{
						name: "virtual",
						resolveId(id) {
							if (id === virtualEntryId) {
								return id;
							}
						},
						load(id) {
							if (id === virtualEntryId) {
								return virtualModuleContent;
							}
						},
					},
					{
						name: "external-modules",
						resolveId(source) {
							if (!source.endsWith(".server.js") && !source.startsWith(".") && !path.isAbsolute(source)) {
								return { id: source, external: true };
							}
						},
					},
				],
			});

			const { output } = await build.generate({ format: "es" });

			if (output.length === 0) {
				throw new Error("Failed to bundle server functions");
			}

			// Get the bundled code
			const bundledCode = output[0].code;

			// Emit the bundled server functions
			this.emitFile({
				type: "asset",
				fileName: "actions.js",
				source: bundledCode,
			});

			// Generate server.js
			let serverCode = `
        import express from 'express';
        import * as serverActions from './actions.js';

        const app = express();

        // Middleware
        // --------------------------------------------------
        app.use(express.json());
        app.use(express.static('dist'));

				// Server functions
				// --------------------------------------------------
        ${Array.from(serverFunctions.entries())
					.flatMap(([moduleName, { functions }]) =>
						functions
							.map(
								(functionName) => `
            app.post('/api/${moduleName}/${functionName}', async (req, res) => {
              try {
                const result = await serverActions.${moduleName}.${functionName}(...req.body);
                res.json(result || "* No response *");
              } catch (error) {
                console.error(\`Error in ${functionName}: \${error.message}\`);
                res.status(500).json({ error: error.message });
              }
            });
          `,
							)
							.join("\n")
							.trim(),
					)
					.join("\n")
					.trim()}

				// Start server
				// --------------------------------------------------
        const port = process.env.PORT || 3000;
        app.listen(port, () => console.log(\`🚀 Server listening: http://localhost:\${port}\`));

        // List all server functions
				// --------------------------------------------------
      `;

			// TODO: Add a way to list all server functions in the console

			this.emitFile({
				type: "asset",
				fileName: "server.js",
				source: serverCode,
			});
		},
	};
}

function generateClientProxy(moduleName, functions) {
	let clientProxy = `\n// vite-server-actions: ${moduleName}\n`;
	functions.forEach((functionName) => {
		clientProxy += `
      export async function ${functionName}(...args) {
      	console.log("[Vite Server Actions] 🚀 - Executing ${functionName}");
        const response = await fetch('/api/${moduleName}/${functionName}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args)
        });

        if (!response.ok) {
        	console.log("[Vite Server Actions] ❗ - Error in ${functionName}");
          throw new Error('Server request failed');
        }

        console.log("[Vite Server Actions] ✅ - ${functionName} executed successfully");

        return response.json();
      }
    `;
	});
	return clientProxy;
}
