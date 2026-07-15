/**
 * Build-time schema discovery worker.
 *
 * Runs as a disposable child process during `vite build` (spawned from
 * generateBundle in index.js): it imports each user server module, converts
 * every function's attached Zod schema to its OpenAPI form, writes the result
 * to the output file, and hard-exits. Importing user modules in a child
 * process keeps their top-level side effects (DB connection pools,
 * setInterval, listeners) from executing - and hanging - inside the build
 * process itself.
 *
 * Usage: node schema-discovery-worker.js <json-payload> <output-file>
 * where <json-payload> is {"modules": [{"moduleName": string, "id": string}]}
 */
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { ZodAdapter } from "./validation.js";

/**
 * Import a user server module. TypeScript files can't be imported natively,
 * so they are compiled with esbuild to a temp file next to the original
 * (keeping relative imports resolvable) and imported from there.
 * @param {string} id - Absolute path to the server module
 * @returns {Promise<any>}
 */
async function importUserModule(id) {
	if (!id.endsWith(".ts")) {
		return import(pathToFileURL(id).href);
	}

	const esbuild = (await import("esbuild")).default;
	const source = await fs.readFile(id, "utf-8");
	const result = await esbuild.transform(source, {
		loader: "ts",
		target: "node16",
		format: "esm",
		sourcefile: id,
	});

	const dir = path.dirname(id);
	const basename = path.basename(id, ".ts");
	const tmpFile = path.join(dir, `.${basename}.schema-worker.mjs`);
	await fs.writeFile(tmpFile, result.code, "utf-8");
	try {
		return await import(pathToFileURL(tmpFile).href);
	} finally {
		await fs.unlink(tmpFile).catch(() => {});
	}
}

async function main() {
	const { modules } = JSON.parse(process.argv[2]);
	const outputFile = process.argv[3];

	const adapter = new ZodAdapter();
	const schemas = {};
	const warnings = [];

	for (const { moduleName, id } of modules) {
		try {
			const module = await importUserModule(id);
			for (const [functionName, fn] of Object.entries(module)) {
				if (typeof fn === "function" && fn.schema) {
					const schema = fn.schema;
					schemas[`${moduleName}.${functionName}`] = {
						// Live Zod instances can't cross the process boundary, so the
						// OpenAPI conversion happens here and the parent gets plain JSON
						preconverted: true,
						isTuple: schema._def?.typeName === "ZodTuple",
						openAPISchema: adapter.toOpenAPISchema(schema),
					};
				}
			}
		} catch (error) {
			warnings.push(`Failed to discover schemas from ${id} for OpenAPI generation: ${error.message}`);
		}
	}

	// Components registered for nested .openapi('Name') schemas, so emitted
	// $ref pointers can be resolved by the spec generator in the parent
	const components = adapter.discoveredComponents || {};
	for (const entry of Object.values(schemas)) {
		entry.components = components;
	}

	await fs.writeFile(outputFile, JSON.stringify({ schemas, warnings }), "utf-8");
}

main()
	.then(() => {
		// Hard-exit: imported user modules may have started timers, connection
		// pools, or servers that would otherwise keep this process alive
		process.exit(0);
	})
	.catch((error) => {
		process.stderr.write(String(error?.stack || error));
		process.exit(1);
	});
