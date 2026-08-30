import { fileURLToPath } from "node:url";

/** Absolute path to the run-host executable shipped by this package. */
export const executablePath = fileURLToPath(new URL("./bin.js", import.meta.url));

/** Node command that launches the executable shipped by this package. */
export const executableCommand = {
  command: process.execPath,
  args: [executablePath],
} as const;
