import { Effect, FileSystem } from "effect";

/** Whether this process runs with `NoNewPrivs` set, as under systemd's `NoNewPrivileges=yes`. */
export const noNewPrivileges = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const status = yield* fs.readFileString("/proc/self/status");
  return /^NoNewPrivs:\s*1$/mu.test(status);
}).pipe(Effect.orElseSucceed(() => false));

/** Why rootless Podman can't run supervisor sandboxes in a process with `NoNewPrivs` set. */
export const ROOTLESS_PODMAN_REFUSAL =
  "rootless Podman can't run under NoNewPrivileges, because it needs the setuid helpers newuidmap and newgidmap; use Docker";
