import { configDefaults, defineConfig } from "vitest/config";

const latencyTests = [
  "test/operator-reads/latency.test.ts",
  "test/coordinator/journal-latency.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          exclude: [...configDefaults.exclude, ...latencyTests],
        },
      },
      {
        test: {
          name: "latency",
          include: latencyTests,
          // Measure latency after other server tests release the CPU.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
});
