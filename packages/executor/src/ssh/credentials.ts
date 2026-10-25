import type { AttemptId } from "@usine/core/attempt";
import type { LoopPermissions } from "@usine/core/loop";
import { type RepositoryName, safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import { Cache, Effect, Redacted } from "effect";
import { credentialEnvironment, GH_CONFIG, ghHostsConfig } from "../credential-environment.ts";
import {
  CredentialProvider,
  type ExecutorError,
  type ExecutorOperation,
  type WorkerCredential,
} from "../executor.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import type { RemoteAccess } from "../remote/machine.ts";
import { renewableCredential } from "../renewable-credential.ts";
import type { SshMachine } from "./model.ts";

/**
 * A script that writes the Attempt's credential directory `$3` inside the credentials root
 * `$2`: the token from the first stdin line, gh's `hosts.yml` from the rest, and gh's
 * `config.yml` from `$1`. Sets mode 700 on both directories. Reading the token from stdin keeps
 * it out of arguments and the environment; each file is written then renamed.
 */
const WRITE_CREDENTIAL_SCRIPT = String.raw`
set -e
umask 077
mkdir -p "$2" "$3"
chmod 700 "$2" "$3"
IFS= read -r token
printf '%s' "$token" > "$3/token.next"
cat > "$3/hosts.next"
test -f "$3/config.yml" || printf '%s' "$1" > "$3/config.yml"
mv "$3/token.next" "$3/token"
mv "$3/hosts.next" "$3/hosts.yml"
`.trim();

const credentialsRoot = (machine: SshMachine): string => `${machine.workerDirectory}/credentials`;

/**
 * Writes each Attempt's token to a directory next to the Worker's checkouts that only the SSH
 * user can read, renews it before expiry, and removes it when the Attempt's scope closes. All
 * Attempts on the Worker can read each other's tokens (ADR 0026). `reclaim` removes credentials
 * left by an earlier process, once per process.
 */
export const sshCredentialsFor = Effect.fn("SshExecutor.credentialsFor")(function* (
  commands: RemoteCommands,
  machineFor: (worker: WorkerName) => Effect.Effect<SshMachine, ExecutorError>,
) {
  const provider = yield* CredentialProvider;

  const removeStale = Effect.fn("SshExecutor.removeStaleCredentials")(function* (
    worker: WorkerName,
  ) {
    const machine = yield* machineFor(worker);
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ worker, host });
    yield* commands.run("cleanup", machine.shell, "rm", ["-rf", credentialsRoot(machine)]);
    yield* Effect.logInfo("Removed credentials an earlier process left on the SSH Worker", {
      worker,
      host,
    });
  });
  // A failed removal is logged and cached, not retried: the remaining tokens expire within an
  // hour and the next start removes them.
  const reclaimed = yield* Cache.make({
    capacity: Number.POSITIVE_INFINITY,
    lookup: (worker: WorkerName) =>
      removeStale(worker).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not remove stale credentials from the SSH Worker", {
            worker,
            message: error.message,
          }),
        ),
        Effect.ignore,
      ),
  });
  const reclaim = (worker: WorkerName) => Cache.get(reclaimed, worker);

  const write = Effect.fn("SshExecutor.writeCredential")(
    function* (
      operation: ExecutorOperation,
      machine: SshMachine,
      directory: string,
      { value }: WorkerCredential,
    ) {
      yield* Effect.annotateCurrentSpan({ host: machine.shell.destination, directory });
      const payload = Redacted.make(
        `${Redacted.value(value)}\n${ghHostsConfig(Redacted.value(value))}`,
      );
      yield* commands
        .runWithInput(
          operation,
          machine.shell,
          "sh",
          ["-c", WRITE_CREDENTIAL_SCRIPT, "sh", GH_CONFIG, credentialsRoot(machine), directory],
          payload,
        )
        .pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(payload))));
    },
    // Scope closure waits for an in-flight write, so a late renewal cannot run after the removal.
    Effect.uninterruptible,
  );

  const acquire = Effect.fn("SshExecutor.acquireCredential")(function* (
    attemptId: AttemptId,
    worker: WorkerName,
    repository: RepositoryName,
    permissions: LoopPermissions,
    machine: SshMachine,
    operation: ExecutorOperation,
  ) {
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ attemptId, worker, repository, permissions, host });
    const directory = `${credentialsRoot(machine)}/${safeSegment(attemptId)}`;
    yield* Effect.addFinalizer(() =>
      commands.run("cleanup", machine.shell, "rm", ["-rf", directory]).pipe(
        Effect.tap(() =>
          Effect.logInfo("Removed the Attempt's credential from the SSH Worker", {
            attemptId,
            worker,
            host,
          }),
        ),
        Effect.tapError((error) =>
          Effect.logError(
            "Could not remove the Attempt's credential from the SSH Worker; it expires within the hour",
            { attemptId, worker, host, message: error.message },
          ),
        ),
        Effect.ignore,
      ),
    );
    const credential = yield* renewableCredential(
      provider.issue,
      repository,
      attemptId,
      permissions,
      (issued) => write(operation, machine, directory, issued),
    );
    const environment = credentialEnvironment(directory);
    return {
      environment,
      gitEnvironment: environment,
      shell: machine.shell,
      secrets: {},
      readOnlyPaths: [directory],
      refresh: credential.refresh(),
      scrub: credential.scrub,
    } satisfies RemoteAccess;
  });

  return { acquire, reclaim };
});
