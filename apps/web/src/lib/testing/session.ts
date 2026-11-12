import { beforeEach } from "vitest";
import { commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    sessionPermissions: () => Promise<void>;
  }
}

beforeEach(() => {
  // Browser memory, such as board lane folds, would otherwise carry from one test to the next.
  localStorage.clear();
  return commands.sessionPermissions();
});
