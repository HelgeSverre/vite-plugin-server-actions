import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import serverActions from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("TypeScript imports", () => {
	let viteServer;
	let tempDir;

	beforeAll(async () => {
		// Create a temporary directory for test files
		// Temp dir must live inside the project root so sanitizePath containment passes.
		tempDir = await fs.mkdtemp(path.join(process.cwd(), "node_modules", "vsa-ts-imports-"));

		// Create test TypeScript files with imports
		// types.ts - shared types
		await fs.writeFile(
			path.join(tempDir, "types.ts"),
			`
export type User = {
  id: string;
  name: string;
  email: string;
};

export type Order = {
  id: string;
  userId: string;
  total: number;
};

export function formatUser(user: User): string {
  return \`\${user.name} <\${user.email}>\`;
}
      `.trim(),
		);

		// utils.server.ts - server file that imports types
		await fs.writeFile(
			path.join(tempDir, "utils.server.ts"),
			`
import { User, formatUser } from "./types";

export async function getUserInfo(userId: string): Promise<User> {
  const user: User = {
    id: userId,
    name: "Test User",
    email: "test@example.com"
  };
  return user;
}

export async function getFormattedUser(userId: string): Promise<string> {
  const user = await getUserInfo(userId);
  return formatUser(user);
}
      `.trim(),
		);

		// main.server.ts - server file that imports from another server file
		await fs.writeFile(
			path.join(tempDir, "main.server.ts"),
			`
import { getUserInfo, getFormattedUser } from "./utils.server";
import { Order } from "./types";

export async function getUserWithOrders(userId: string): Promise<{ user: any; orders: Order[] }> {
  const user = await getUserInfo(userId);
  const orders: Order[] = [
    { id: "order1", userId, total: 100 },
    { id: "order2", userId, total: 200 }
  ];
  return { user, orders };
}

export async function getFullUserInfo(userId: string): Promise<{ formatted: string; orderCount: number }> {
  const formatted = await getFormattedUser(userId);
  const { orders } = await getUserWithOrders(userId);
  return { formatted, orderCount: orders.length };
}
      `.trim(),
		);

		// Create Vite server with the plugin
		viteServer = await createServer({
			root: tempDir,
			server: { middlewareMode: true },
			plugins: [
				serverActions({
					include: ["**/*.server.ts"],
					validation: { enabled: false },
				}),
			],
		});
	});

	afterAll(async () => {
		await viteServer.close();
		// Clean up temp directory
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("should load TypeScript server files without timeout", async () => {
		const mainPath = path.join(tempDir, "main.server.ts");

		// Use the plugin's load hook to process the file
		const plugin = viteServer.config.plugins.find((p) => p.name === "vite-plugin-server-actions");

		const startTime = Date.now();
		const result = await plugin.load(mainPath);
		const loadTime = Date.now() - startTime;

		// Should load quickly (not timeout after 60s)
		expect(loadTime).toBeLessThan(5000); // 5 seconds max
		expect(result).toBeTruthy();
		expect(result).toContain("getUserWithOrders");
		expect(result).toContain("getFullUserInfo");
	});

	it("should handle nested TypeScript imports via SSR", async () => {
		const mainPath = path.join(tempDir, "main.server.ts");

		// Test loading via Vite's SSR module system
		const startTime = Date.now();
		const module = await viteServer.ssrLoadModule(mainPath);
		const loadTime = Date.now() - startTime;

		// Should load without timeout
		expect(loadTime).toBeLessThan(5000);
		expect(module).toBeTruthy();
		expect(typeof module.getUserWithOrders).toBe("function");
		expect(typeof module.getFullUserInfo).toBe("function");

		// Test that the functions actually work
		const result = await module.getUserWithOrders("test123");
		expect(result.user.id).toBe("test123");
		expect(result.orders).toHaveLength(2);

		const fullInfo = await module.getFullUserInfo("test456");
		expect(fullInfo.formatted).toBe("Test User <test@example.com>");
		expect(fullInfo.orderCount).toBe(2);
	});

	it("should not cause recursion when loading circular imports", async () => {
		// Create files with circular dependencies
		await fs.writeFile(
			path.join(tempDir, "circular-a.server.ts"),
			`
import { functionB } from "./circular-b.server";

export async function functionA(): Promise<string> {
  return "A";
}

export async function callB(): Promise<string> {
  return await functionB();
}
      `.trim(),
		);

		await fs.writeFile(
			path.join(tempDir, "circular-b.server.ts"),
			`
import { functionA } from "./circular-a.server";

export async function functionB(): Promise<string> {
  return "B";
}

export async function callA(): Promise<string> {
  return await functionA();
}
      `.trim(),
		);

		const circularPath = path.join(tempDir, "circular-a.server.ts");
		const plugin = viteServer.config.plugins.find((p) => p.name === "vite-plugin-server-actions");

		// Should handle circular imports without hanging
		const startTime = Date.now();
		const result = await plugin.load(circularPath);
		const loadTime = Date.now() - startTime;

		expect(loadTime).toBeLessThan(5000);
		expect(result).toBeTruthy();
	});

	// Regression for issue #5: a .server.ts importing Node built-ins (fs, path,
	// crypto) must reach the browser only as a fetch proxy. If any server code
	// leaks into the client output, Vite externalizes the built-ins and the
	// browser throws "Module 'fs' has been externalized for browser
	// compatibility".
	it("should generate an fs-free client proxy for .server.ts files using Node built-ins", async () => {
		const fsPath = path.join(tempDir, "write.server.ts");
		await fs.writeFile(
			fsPath,
			`
import nodeFs from "fs";
import nodePath from "path";
import crypto from "crypto";

export async function writeToFile(filename: string, content: string) {
  const safe = nodePath.basename(filename) + "-" + crypto.randomUUID();
  nodeFs.writeFileSync(safe, content, "utf8");
  return { success: true, filename: safe };
}
      `.trim(),
		);

		const plugin = viteServer.config.plugins.find((p) => p.name === "vite-plugin-server-actions");
		const result = await plugin.load(fsPath);

		// The client module is a proxy for the exported function...
		expect(result).toBeTruthy();
		expect(result).toContain("writeToFile");
		expect(result).toContain("fetch(");

		// ...and carries none of the server-side implementation or imports.
		expect(result).not.toMatch(/from\s+["'](node:)?fs["']/);
		expect(result).not.toMatch(/from\s+["'](node:)?crypto["']/);
		expect(result).not.toContain("writeFileSync");

		// The server still executes the real module (fs and friends intact).
		const module = await viteServer.ssrLoadModule(fsPath);
		expect(typeof module.writeToFile).toBe("function");
	});

	it("should cache TypeScript modules to avoid recompilation", async () => {
		const utilsPath = path.join(tempDir, "utils.server.ts");

		// First load
		const startTime1 = performance.now();
		const module1 = await viteServer.ssrLoadModule(utilsPath);
		const loadTime1 = performance.now() - startTime1;

		// Second load (should be cached)
		const startTime2 = performance.now();
		const module2 = await viteServer.ssrLoadModule(utilsPath);
		const loadTime2 = performance.now() - startTime2;

		// Second load should be much faster due to caching (or at least not slower)
		// If both are very fast, just check that caching works (same instance)
		if (loadTime1 < 1 && loadTime2 < 1) {
			// Both loads are very fast, just verify caching works
			expect(module1).toBe(module2); // Should be the same module instance
		} else {
			// Normal case - second load should be faster
			expect(loadTime2).toBeLessThan(loadTime1);
			expect(module1).toBe(module2); // Should be the same module instance
		}
	});
});
