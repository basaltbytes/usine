import { defineConfig } from "vitest/config";

// The Gateway tests run real cryptography, which slows down when the machine is busy.
export default defineConfig({ test: { testTimeout: 30_000 } });
