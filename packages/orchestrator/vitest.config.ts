import { defineConfig } from "vitest/config";

// These suites run real SQLite work, which slows down when the machine is busy.
export default defineConfig({ test: { testTimeout: 30_000 } });
