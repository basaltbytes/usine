import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import vite from "./vite.config.ts";

export default mergeConfig(
  vite,
  defineConfig({
    test: {
      // Keep browser layout tests from oversubscribing the monorepo test gate.
      maxWorkers: 2,
      attachmentsDir: "./node_modules/.cache/vitest/attachments",
      projects: [
        {
          extends: true,
          test: { name: "unit", exclude: [...configDefaults.exclude, "**/*.browser.test.tsx"] },
        },
        {
          extends: true,
          test: {
            name: "browser",
            include: ["test/**/*.browser.test.tsx"],
            browser: {
              enabled: true,
              headless: true,
              screenshotDirectory: "./node_modules/.cache/vitest/screenshots",
              provider: playwright(),
              instances: [{ browser: "chromium" }],
            },
          },
        },
      ],
    },
  }),
);
