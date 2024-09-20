import fs from "fs/promises";
import path from "path";
import express from "express";

export default function viteServerFunctionsPlugin() {
	const serverFunctions = new Map();
	let app;
	const chunks = new Map();

	return {
		name: "vite-plugin-server-actions",

		configureServer(server) {
			app = express();
			app.use(express.json());
			server.middlewares.use(app);
		},

		async resolveId(source, importer) {
			if (source.endsWith(".server.js") && importer) {
				return source;
			}
		},

		async load(id) {
			if (id.endsWith(".server.js")) {
				const moduleName = path.basename(id, ".server.js");
				const code = await fs.readFile(id, "utf-8");

				const exportRegex = /export\s+(async\s+)?function\s+(\w+)/g;
				const functions = [];
				let match;
				while ((match = exportRegex.exec(code)) !== null) {
					functions.push(match[2]);
				}

				console.log(`Found server functions for ${moduleName}: ${functions.join(", ")}`);
				serverFunctions.set(moduleName, { functions, id });

				// TODO: extract this to a separate function
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

		buildStart() {
			serverFunctions.forEach(({ id }, moduleName) => {
				const chunkRefId = this.emitFile({
					type: "chunk",
					id,
					name: `${moduleName}.server`,
				});
				chunks.set(moduleName, chunkRefId);
			});
		},

		async generateBundle(options, bundle) {
			let serverCode = `
        import express from 'express';
        const app = express();
        app.use(express.json());
      `;

			// TODO: generate imports for server functions
			serverCode += "\n// TODO: generate imports for server functions here\n";

			serverFunctions.forEach(({ functions }, moduleName) => {
				functions.forEach((functionName) => {
					serverCode += `
            app.post('/api/${moduleName}/${functionName}', async (req, res) => {
              try {
                const result = await ${moduleName}Module.${functionName}(...req.body);
                res.json(result);
              } catch (error) {
                res.status(500).json({ error: error.message });
              }
            });
          `;
				});
			});

			serverCode += `
        const port = process.env.PORT || 3000;
        app.listen(port, () => console.log(\`Server listening on port \${port}\`));
      `;

			this.emitFile({
				type: "asset",
				fileName: "server.js",
				source: serverCode,
			});

			// Generate client proxy
			const clientProxy = Array.from(serverFunctions.entries())
				.map(([moduleName, { functions }]) => generateClientProxy(moduleName, functions))
				.join("\n");

			this.emitFile({
				type: "asset",
				fileName: "client.js",
				source: clientProxy,
			});
		},
	};
}

function generateClientProxy(moduleName, functions) {
	let clientProxy = `\n// vite-server-actions client proxy for ${moduleName} module`;
	// TODO: Improve this
	functions.forEach((functionName) => {
		clientProxy += `
            export async function ${functionName}(...args) {
              const response = await fetch('/api/${moduleName}/${functionName}', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args)
              });
              if (!response.ok) {
                throw new Error('Server request failed');
              }
              console.log('✅  Server request successful for ${functionName}');
              return response.json();
            }

          `;
	});

	return clientProxy;
}
