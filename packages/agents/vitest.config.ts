import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/child-host/generate-programs.ts"],
  },
});
