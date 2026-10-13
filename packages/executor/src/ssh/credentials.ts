import type { AttemptId } from "@usine/core/attempt";
import { type RepositoryName, safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import { Cache, Effect, Redacted } from "effect";
import { credentialEnvironment, GH_CONFIG, ghHostsConfig } from "../credential-environment.ts";
import { CredentialProvider, type ExecutorError, type ExecutorOperation } from "../executor.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import type { RemoteAccess } from "../remote/machine.ts";
import { renewableCredential } from "../renewable-credential.ts";
import type { SshMachine } from "./model.ts";

/**
 * Writes the Attempt's credential directory `$3` inside the credentials root
 * `$2`: the token from the first line of standard input, gh's `hosts.yml`
 * from the rest of it, and gh's `config.yml` from `$1`. Both directories get
 * mode 700 even when they already exist. The token arrives on standard input,
 * so it never appears in a process's arguments or environment on the machine,
 * and renames keep readers from seeing a partly written file.
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
          ["-c", WRITE_CREDENTIAL_SCRIPT, "sh", GH_CONFIG, credentialsRoot(machine), directory],
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
      refresh: credential.refresh(),
      scrub: credential.scrub,
    } satisfies RemoteAccess;
  });

  return { acquire, reclaim };
});
