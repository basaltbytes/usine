import { ChildProcess } from "effect/unstable/process";
import { homedir } from "node:os";
import { type ChildHost, type HostInvocation, sshArguments } from "./child-host.ts";

/**
 * The process this machine starts to run `invocation` on `host`. On this
 * machine the command runs directly with exactly `environment`; on a remote
 * shell it is one SSH command whose client sees only `sshEnvironment`.
 */
export const hostCommand = (
  host: ChildHost,
  invocation: HostInvocation & { readonly environment: Readonly<Record<string, string>> },
  options: ChildProcess.CommandOptions,
): ChildProcess.Command => {
  switch (host._tag) {
    case "LocalProcess":
      return ChildProcess.make(invocation.command, invocation.args, {
        ...options,
        cwd: invocation.cwd ?? homedir(),
        env: { ...invocation.environment },
        extendEnv: false,
      });
    case "RemoteShell":
      return ChildProcess.make(host.ssh.command, sshArguments(host, invocation), {
        ...options,
        env: { ...host.sshEnvironment },
        extendEnv: false,
      });
  }
};
