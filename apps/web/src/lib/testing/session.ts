import { beforeEach } from "vitest";
import { commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    sessionPermissions: () => Promise<void>;
  }
}

beforeEach(() => commands.sessionPermissions());
