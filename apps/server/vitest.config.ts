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
          // Measure read latency after other server tests release the CPU.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
});
