import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/child-host/programs.ts"],
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, "**/src/child-host/worker/**"],
  },
});
