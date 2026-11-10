import { RemoteShell, type SshCommand } from "@usine/agents/child-host";
import { Redacted } from "effect";
import { fileURLToPath } from "node:url";
import type { ExecEndpoint } from "../../model.ts";
import { BOXD_SHELL_ENVIRONMENT } from "./environment.ts";

/** The boxd shell under this Node.js, next to this module in the built package. */
const BOXD_SHELL: SshCommand = {
  command: process.execPath,
  args: [fileURLToPath(new URL("shell.js", import.meta.url))],
};

/**
 * Returns the `RemoteShell` that runs commands on the machine at `endpoint` through the boxd
 * shell. The shell's environment is `environment` with the endpoint's API URL and credential.
 */
export const boxdShellFor = (
  endpoint: ExecEndpoint,
  environment: Readonly<Record<string, string>>,
): RemoteShell =>
  RemoteShell.make({
    ssh: BOXD_SHELL,
    sshEnvironment: {
      ...environment,
      [BOXD_SHELL_ENVIRONMENT.endpoint]: endpoint.api,
      [BOXD_SHELL_ENVIRONMENT.credential]: Redacted.value(endpoint.credential),
    },
    destination: endpoint.machine,
  });
