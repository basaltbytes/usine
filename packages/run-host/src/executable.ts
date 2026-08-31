import { fileURLToPath } from "node:url";

/**
 * Node command that launches the executable shipped by this package. Resolved
 * at call time so importing this module stays inert.
 */
export const executableCommand = () => ({
  command: process.execPath,
  args: [fileURLToPath(new URL("./bin.js", import.meta.url))],
});
