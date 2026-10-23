import { type Effect, Match, Option, Schema } from "effect";
import type { backup } from "./backup.ts";
import type { CliUsageError, CliVersionError } from "./cli.ts";
import type { exportRun } from "./export-run.ts";
import type { up } from "./up.ts";

/** The expected failures of CLI commands. Defects aren't included and still crash. */
export type CliFailure =
  | CliUsageError
  | CliVersionError
  | Effect.Error<ReturnType<typeof up>>
  | Effect.Error<ReturnType<typeof backup>>
  | Effect.Error<ReturnType<typeof exportRun>>;

const messageOf = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }));

/** Trims `text` and removes a final period, so it can end a sentence. */
const clause = (text: string): string => text.trim().replace(/\.$/u, "");

/**
 * Returns the first line of the cause's message in parentheses, or an empty string if `message`
 * already contains it.
 */
const because = (cause: unknown, message = ""): string =>
  Option.match(messageOf(cause), {
    onNone: () => "",
    onSome: ({ message: reason }) => {
      const line = clause(reason.split("\n")[0] ?? "");
      return line === "" || message.includes(line) ? "" : ` (${line})`;
    },
  });

/**
 * Returns the operator message for a failed backup of either store. `openHint` explains how to fix
 * an unreadable source.
 */
const backupFailure = (
  failure: {
    readonly operation: "open" | "stage" | "copy" | "publish";
    readonly source: string;
    readonly destination: string;
    readonly reason: string;
  },
  openHint: string,
) => {
  const { source, destination, reason } = failure;
  return Match.value(failure.operation).pipe(
    Match.when("open", () => `Could not open ${source} (${reason}). ${openHint}`),
    Match.when(
      "copy",
      () =>
        `Could not copy ${source} to ${destination} (${reason}). Check the source database and the output directory's free space and permissions.`,
    ),
    Match.when(
      "stage",
      () =>
        `Could not create a backup at ${destination} (${reason}). Choose an existing writable output directory.`,
    ),
    Match.when("publish", () =>
      reason === "AlreadyExists"
        ? `Could not save the backup to ${destination} (${reason}). Choose a different filename; the destination already exists.`
        : `Could not save the backup to ${destination} (${reason}). Check the destination path and permissions; its filesystem must support hard links.`,
    ),
    Match.exhaustive,
  );
};

const holderOf = (holder: Option.Option<number>): string =>
  Option.match(holder, { onNone: () => "", onSome: (pid) => ` (pid ${pid})` });

/**
 * Returns the operator message for a failed CLI command, with the file, setting, Worker, or Run at
 * fault and the next step.
 */
export const failureMessage = (failure: CliFailure): string =>
  Match.valueTags(failure, {
    CliUsageError: ({ message }) => message,
    CliVersionError: ({ cause }) =>
      `Could not read the installed @usine/server version${because(cause)}. Reinstall @usine/server.`,
    RunNotFoundError: ({ runId }) => `Run ${runId} was not found.`,
    RunExportError: ({ runId, operation, path, reason }) =>
      `Could not ${operation} evidence for Run ${runId} at ${path} (${reason}). Check the instance database and choose a new writable output path.`,
    RuntimeStoreBackupError: (error) =>
      backupFailure(
        error,
        "Run usine backup from the instance folder containing .usine/runtime.sqlite.",
      ),
    DurableStorageBackupError: (error) =>
      backupFailure(error, "Check that the instance's .usine/durable.sqlite is a readable file."),
    VolatileInstanceDirectoryError: ({ directory, root }) =>
      `Refusing to start: ${directory} sits under ${root}, which the OS clears. The runtime store there is the only copy of every Run and transcript. Move the instance folder, or pass --allow-volatile-instance (or USINE_ALLOW_VOLATILE_INSTANCE=1) to proceed anyway.`,
    InstanceInUseError: ({ directory, holder }) =>
      `usine up did not start: another usine process${holderOf(holder)} is running in ${directory}, possibly still draining its Attempts. Wait for it to exit or stop it, then run usine up again.`,
    InstanceLockError: ({ directory, reason }) =>
      `usine up did not start: could not lock ${directory}/.usine/instance.lock (${reason}). Check that the folder is writable.`,
    PortInUseError: ({ port, holder }) =>
      `usine up stopped: port ${port} is already in use${holderOf(holder)}. Stop the process using it or run usine up --port <port>.`,
    ServerStartError: ({ port, cause }) =>
      `usine up stopped: could not listen on 127.0.0.1:${port}${because(cause)}. Run usine up --port <port> to use another port.`,
    FactoryConfigError: ({ file, stage, message }) =>
      stage === "read"
        ? `usine up did not start: could not read ${file} (${clause(message)}). Run usine up from the instance folder, which holds usine.yaml, agents/, and loops/.`
        : `usine up did not start: ${file} is invalid (${stage}): ${clause(message)}. Fix the file and run usine up again.`,
    UnsupportedWorkerError: ({ worker, kind }) =>
      `usine up did not start: Worker ${worker} is of kind ${kind}, which cannot run beside the other Workers in usine.yaml. One usine up runs all its Workers with one executor; give every Worker under workers the same kind.`,
    WorkerCapabilityError: ({ worker, capability, message, cause }) =>
      `usine up did not start: Worker ${worker} failed its ${capability} check: ${clause(message)}${because(cause, message)}. Fix the Worker or its entry under workers in usine.yaml, then run usine up again.`,
    ExecutorOperationError: ({ operation, message, cause }) =>
      `usine up stopped: Worker ${operation} failed: ${clause(message)}${because(cause, message)}.`,
    CredentialUnavailableError: ({ repository, message }) =>
      `usine up stopped: no GitHub access to ${repository}: ${clause(message)}. Check that the GitHub App is installed on it.`,
    AppAuthenticationError: ({ message }) =>
      `usine up stopped: the GitHub App could not authenticate: ${clause(message)}. Check USINE_GITHUB_APP_ID and USINE_GITHUB_PRIVATE_KEY, or .usine/github-app.json.`,
    EnginePersistenceError: ({ operation, cause }) =>
      `usine up stopped: the runtime store could not ${operation}${because(cause)}. Check .usine/runtime.sqlite and its folder.`,
    DurableHarnessError: ({ operation, message }) =>
      `usine up stopped: the durable storage could not ${operation}: ${clause(message)}. Check .usine/durable.sqlite and its folder.`,
    AttemptCancellationError: ({ attemptId, cause }) =>
      `usine up stopped: Attempt ${attemptId} could not be canceled${because(cause)}.`,
    RunOperationRejectedError: ({ runId, operation, state }) =>
      `Cannot ${operation} Run ${runId} while it is ${state}.`,
    RunRetryBlockedError: ({ message }) => message,
    RunInterventionRejectedError: ({ message }) => message,
  });
