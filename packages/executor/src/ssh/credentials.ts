import type { AttemptId } from "@usine/core/attempt";
import { type RepositoryName, safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import { Cache, Effect, Redacted } from "effect";
import { credentialEnvironment, ghHostsConfig } from "../credential-environment.ts";
import { CredentialProvider, type ExecutorError, type ExecutorOperation } from "../executor.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import type { RemoteAccess } from "../remote/machine.ts";
import { renewableCredential } from "../renewable-credential.ts";
import type { SshMachine } from "./model.ts";

/**
 * Writes the Attempt's credential directory `$2` inside the credentials root
 * `$1` from standard input: the token on the first line, gh's `hosts.yml`
 * after it. Both directories get mode 700 even when they already exist. Only
 * shell builtins see the token, so it never appears in a process's arguments
 * on the machine, and renames keep readers from seeing a partly written file.
 */
const WRITE_CREDENTIAL_SCRIPT = String.raw`
set -e
umask 077
mkdir -p "$1" "$2"
chmod 700 "$1" "$2"
IFS= read -r token
printf '%s' "$token" > "$2/token.next"
cat > "$2/hosts.next"
test -f "$2/config.yml" || printf 'version: "1"\n' > "$2/config.yml"
mv "$2/token.next" "$2/token"
mv "$2/hosts.next" "$2/hosts.yml"
`.trim();

/** Where an SSH Worker keeps the credential directory of each Attempt it runs. */
const credentialsRoot = (machine: SshMachine): string => `${machine.workerDirectory}/credentials`;

/**
 * Gives each Attempt the single-repository token the orchestrator mints, in a
 * directory beside the Worker's checkouts that only the SSH user can read,
 * renewed before it expires and removed when the Attempt's scope closes.
 * Every Attempt on the Worker runs as that user, so each can read the others'
 * tokens while they run (ADR 0026). The first use of each Worker in this
 * process removes every credential an earlier process left there: no Attempt
 * can still use one, because a reattached Attempt is given a fresh credential.
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
  // A failed removal is logged and remembered: the tokens it leaves expire
  // within the hour, and the next start removes them.
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
      token: Redacted.Redacted<string>,
    ) {
      yield* Effect.annotateCurrentSpan({ host: machine.shell.destination, directory });
      const payload = Redacted.make(
        `${Redacted.value(token)}\n${ghHostsConfig(Redacted.value(token))}`,
      );
      yield* commands
        .runWithInput(
          operation,
          machine.shell,
          "sh",
          ["-c", WRITE_CREDENTIAL_SCRIPT, "sh", credentialsRoot(machine), directory],
          payload,
        )
        .pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(payload))));
    },
    // Scope closure waits for a write in flight, so the removal that follows
    // it cannot be overtaken by a late renewal.
    Effect.uninterruptible,
  );

  const acquire = Effect.fn("SshExecutor.acquireCredential")(function* (
    attemptId: AttemptId,
    worker: WorkerName,
    repository: RepositoryName,
    machine: SshMachine,
    operation: ExecutorOperation,
  ) {
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ attemptId, worker, repository, host });
    yield* reclaim(worker);
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
    const credential = yield* renewableCredential(provider.issue, repository, attemptId, (token) =>
      write(operation, machine, directory, token),
    );
    const environment = credentialEnvironment(directory);
    return {
      environment,
      gitEnvironment: environment,
      scrub: credential.scrub,
    } satisfies RemoteAccess;
  });

  return { acquire, reclaim };
});
