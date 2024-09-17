import fs from 'fs/promises';
import path from 'path';
import express from 'express';

export default function viteServerFunctionsPlugin() {
	const serverFunctions = new Map();
	let app;
	let logger;

	return {
		name: 'vite-plugin-server-actions',

		configureServer(server) {
			logger = server.config.logger;
			logger.info('🔧 Configuring vite-plugin-server-actions');
			app = express();
			app.use(express.json()); // Add this line to parse JSON bodies
			server.middlewares.use(app);
			logger.info('✅  Express middleware registered with Vite server');
		},

		async resolveId(source, importer) {
			if (source.endsWith('.server.js') && importer) {
				logger.info(`🔍 Resolving server file: ${source} imported in ${importer}`);
				// This is a client-side import of a server file
				return source; // Mark it as "resolved" so we can handle it in the load hook
			}
		},

		async load(id) {
			if (id.endsWith('.server.js')) {
				logger.info(`📂 Loading server file: ${id}`);
				const moduleName = path.basename(id, '.server.js');

				logger.info(`📄 Reading content of ${id}`);
				const code = await fs.readFile(id, 'utf-8');

				logger.info(`🔎 Extracting exported functions from ${moduleName}`);
				const exportRegex = /export\s+(async\s+)?function\s+(\w+)/g;
				const functions = [];
				let match;
				while ((match = exportRegex.exec(code)) !== null) {
					functions.push(match[2]);
				}
				logger.info(`📊 Found ${functions.length} exported functions in ${moduleName}: ${functions.join(', ')}`);

				// Store the functions for this module
				serverFunctions.set(moduleName, functions);

				logger.info(`🛠 Creating API endpoints for ${moduleName}`);
				functions.forEach(functionName => {
					const endpoint = `/api/${moduleName}/${functionName}`;
					logger.info(`🔗 Creating endpoint: ${endpoint}`);
					const pad = " ".repeat(4);

					app.post(endpoint, async (req, res) => {
						logger.info(pad + `→ Received request at ${endpoint}`);
						try {
							const module = await import(id);
							logger.info(pad + `✨ Executing ${functionName} in ${moduleName}`);
							const result = await module[functionName](...req.body);
							logger.info(pad + `✅ Successfully executed ${functionName}`);
							res.json(result || "* No response *");
						} catch (error) {
							logger.error(pad + `❌ Error in ${functionName}: ${error.message}`);
							res.status(500).json({error: error.message});
						}
					});
				});

				logger.info(`🔄 Generating client-side proxy for ${moduleName}`);
				let clientProxy = `
          // Client-side proxy for ${moduleName}
        `;

				functions.forEach(functionName => {
					logger.info(`📝 Adding proxy function for ${functionName}`);
					clientProxy += `
            export async function ${functionName}(...args) {
              console.log('🚀 Calling server function: ${functionName}');
              const response = await fetch('/api/${moduleName}/${functionName}', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args)
              });
              if (!response.ok) {
                console.error('❌ Server request failed for ${functionName}');
                throw new Error('Server request failed');
              }
              console.log('✅  Server request successful for ${functionName}');
              return response.json();
            }
          `;
				});

				logger.info(`✅  Generated client-side proxy for ${moduleName}`);
				return clientProxy;
			}
		},

		async generateBundle() {
			logger.info('📦 Generating production server.js file');
			let serverCode = `
        import express from 'express';
        const app = express();
        app.use(express.json());
      `;

			serverFunctions.forEach((functions, moduleName) => {
				logger.info(`📄 Adding endpoints for ${moduleName} to production server`);
				serverCode += `import * as ${moduleName}Module from './${moduleName}.server.js';\n`;
				functions.forEach(functionName => {
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

			logger.info('💾 Writing production server.js file');
			await fs.writeFile('dist/server.js', serverCode);
			logger.info('✅  Production server.js file generated');
		}
	};
}
