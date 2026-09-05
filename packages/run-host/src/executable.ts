import { fileURLToPath } from "node:url";

/**
 * The Node command that launches this package's executable, resolved at call
 * time so importing the module has no side effect.
 */
export const executableCommand = () => ({
  command: process.execPath,
  args: [fileURLToPath(new URL("./bin.js", import.meta.url))],
});
