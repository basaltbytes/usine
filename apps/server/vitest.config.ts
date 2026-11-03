import { configDefaults, defineConfig } from "vitest/config";

const latencyTest = "test/operator-read-latency.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          exclude: [...configDefaults.exclude, latencyTest],
        },
      },
      {
        test: {
          name: "latency",
          include: [latencyTest],
          // Other suites' CPU and SQLite work must finish before measuring response times.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
