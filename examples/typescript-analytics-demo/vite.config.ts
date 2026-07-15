import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import serverActions from "vite-plugin-server-actions";

export default defineConfig({
  plugins: [
    serverActions({
      include: ["**/*.server.ts", "**/*.server.js"],
      validation: {
        enabled: true,
      },
      openAPI: {
        enabled: true,
        info: {
          title: "TypeScript Analytics Demo API",
          version: "1.0.0",
          description: "Advanced TypeScript patterns demonstration with analytics",
        },
      },
      // Cast needed: the linked plugin types resolve against the root repo's
      // copy of vite, which TS treats as a different module than this example's.
    }) as unknown as PluginOption,
    react(),
  ],
});