import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    // Local CommonJS is otherwise served unbundled during development.
    include: ["ansi-to-react-component"],
  },
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/route-tree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "ansi-to-react-component": fileURLToPath(
        new URL("./src/components/ai-elements/ansi.cjs", import.meta.url),
      ),
    },
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:7331" },
  },
});
