import { Duration, type Effect, Match, Option, Schema } from "effect";
import type { backup } from "./backup.ts";
import type { CliUsageError, CliVersionError } from "./cli.ts";
import type { upDetached } from "./detach.ts";
import type { exportRun } from "./export-run.ts";
import type { instanceEnvironment } from "./instance/environment.ts";
import type { restart } from "./restart.ts";
import type { status } from "./status.ts";
import type { LifecycleCommandName, stop } from "./stop.ts";
import type { up } from "./up.ts";
import type { UpgradeFailedError, upgrade } from "./upgrade.ts";

/** The expected failures of CLI commands. Defects aren't included and still crash. */
export type CliFailure =
  | CliUsageError
  | CliVersionError
  | Effect.Error<ReturnType<typeof instanceEnvironment>>
  | Effect.Error<ReturnType<typeof up>>
  | Effect.Error<ReturnType<typeof upDetached>>
  | Effect.Error<ReturnType<typeof status>>
  | Effect.Error<ReturnType<typeof stop>>
  | Effect.Error<ReturnType<typeof restart>>
  | Effect.Error<ReturnType<typeof upgrade>>
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
        ? `Could not save the backup to ${destination} (${reason}): the file already exists. Choose a different filename.`
        : `Could not save the backup to ${destination} (${reason}). Check the destination path and permissions. The filesystem must support hard links.`,
    ),
    Match.exhaustive,
  );
};

const holderOf = (holder: Option.Option<number>): string =>
  Option.match(holder, { onNone: () => "", onSome: (pid) => ` (pid ${pid})` });

const runList = (runs: ReadonlyArray<string>): string =>
  `${runs.length === 1 ? "run" : "runs"} ${runs.join(", ")}`;

const waitingFor = (runs: ReadonlyArray<string>): string =>
  runs.length === 0 ? "" : `, waiting for the running attempts of ${runList(runs)}`;

const stopTimeout = (
  command: LifecycleCommandName,
  pid: number,
  timeout: Duration.Duration,
  runs: ReadonlyArray<string>,
): string => {
  const still = `usine (pid ${pid}) is still stopping after ${Duration.format(timeout)}${waitingFor(runs)}. Its drain continues.`;
  return Match.value(command).pipe(
    Match.when(
      "stop",
      () =>
        `${still} Run usine stop again to keep waiting, or usine stop --force to stop without waiting; the next usine up reattaches the running attempts.`,
    ),
    Match.when(
      "restart",
      () =>
        `usine restart started no new process: ${still} Wait for it with usine stop, then run usine up --detach, or run usine restart --force to stop without waiting.`,
    ),
    Match.when(
      "upgrade",
      () =>
        `usine upgrade left the pin unchanged: ${still} Run usine upgrade again after it exits, or run usine upgrade --force to stop without waiting.`,
    ),
    Match.exhaustive,
  );
};

const rollback = (failure: UpgradeFailedError): string =>
  [
    `To roll back to ${failure.previous}:`,
    `1. ${Option.match(failure.commit, {
      onNone: () => `Set @usine/server back to ${failure.previous} in package.json.`,
      onSome: (commit) =>
        `Run git revert --no-edit ${commit}, or set @usine/server back to ${failure.previous} in package.json.`,
    })}`,
    `2. Run ${failure.packageManager} install.`,
    ...Option.toArray(
      Option.map(
        failure.backup,
        (backup) =>
          `3. Move .usine/runtime.sqlite and .usine/durable.sqlite aside with their -wal and -shm files. Copy ${backup} to .usine/runtime.sqlite, and ${backup.replace(/\.sqlite$/u, ".durable.sqlite")}, if it exists, to .usine/durable.sqlite.`,
      ),
    ),
    `${Option.isSome(failure.backup) ? 4 : 3}. Run usine up --detach.`,
  ].join("\n");

const logLines = (tail: string): string =>
  tail === "" ? "The log is empty." : `The last lines of .usine/usine.log:\n${tail}`;

/**
 * Returns the operator message for a failed CLI command, with the file, setting, Worker, or Run at
 * fault and the next step.
 */
export const failureMessage = (failure: CliFailure): string =>
  Match.valueTags(failure, {
    CliUsageError: ({ message }) => message,
    CliVersionError: ({ cause }) =>
      `Could not read the installed @usine/server version${because(cause)}. Reinstall @usine/server.`,
    EnvironmentFileError: ({ path, reason }) =>
      `usine did nothing: could not read ${path} (${clause(reason)}). usine reads it for the variables that the environment doesn't set. Make it readable, or remove it.`,
    RunNotFoundError: ({ runId }) => `Run ${runId} was not found.`,
    RunExportError: ({ runId, operation, path, reason }) =>
      `Could not ${operation} the evidence for run ${runId} at ${path} (${reason}). Check the instance database, and choose a new writable output path.`,
    RuntimeStoreBackupError: (error) =>
      backupFailure(
        error,
        "Run usine backup from the instance folder that contains .usine/runtime.sqlite.",
      ),
    DurableStorageBackupError: (error) =>
      backupFailure(error, "Check that the instance's .usine/durable.sqlite is a readable file."),
    VolatileInstanceDirectoryError: ({ directory, root }) =>
      `usine up did not start: ${directory} is inside ${root}, which the OS clears. The runtime store in it is the only copy of every run and transcript. Move the instance folder, or pass --allow-volatile-instance (or set USINE_ALLOW_VOLATILE_INSTANCE=1) to start anyway.`,
    InstanceInUseError: ({ directory, holder }) =>
      `usine up did not start: another usine process${holderOf(holder)} is running in ${directory}. It might still be finishing its attempts. Wait for it to exit, or stop it, then run usine up again.`,
    InstanceLockError: ({ directory, reason }) =>
      `usine up did not start: could not lock ${directory}/.usine/instance.lock (${reason}). Check that the folder is writable.`,
    PortInUseError: ({ port, holder }) =>
      `usine up stopped: port ${port} is already in use${holderOf(holder)}. Stop that process, or run usine up --port <port> with another port.`,
    ServerStartError: ({ port, cause }) =>
      `usine up stopped: could not listen on 127.0.0.1:${port}${because(cause)}. Run usine up --port <port> to use another port.`,
    ResourceAttributesError: ({ variable, message }) =>
      `usine up did not start: ${variable} is invalid: ${clause(message)}. Set it to comma-separated key=value pairs with percent-encoded keys and values, or unset it.`,
    FactoryConfigError: ({ file, stage, message }) =>
      stage === "read"
        ? `usine up did not start: could not read ${file} (${clause(message)}). Run usine up from the instance folder, which contains usine.yaml, agents/, and loops/.`
        : `usine up did not start: ${file} is invalid (${stage}): ${clause(message)}. Fix the file and run usine up again.`,
    UnsupportedWorkerError: ({ worker, kind }) =>
      `usine up did not start: worker "${worker}" has kind ${kind}, which differs from the other workers in usine.yaml. usine up runs all workers with one executor. Give every worker under workers the same kind.`,
    WorkerCapabilityError: ({ worker, capability, message, cause }) =>
      `usine up did not start: worker "${worker}" failed its ${capability} check: ${clause(message)}${because(cause, message)}. Fix the worker or its entry under workers in usine.yaml, then run usine up again.`,
    ExecutorOperationError: ({ operation, message, cause }) =>
      `usine up stopped: worker ${operation} failed: ${clause(message)}${because(cause, message)}.`,
    CredentialUnavailableError: ({ repository, message }) =>
      `usine up stopped: no GitHub access to "${repository}": ${clause(message)}. Check that the GitHub App is installed on "${repository}".`,
    AppAuthenticationError: ({ message }) =>
      `usine up stopped: the GitHub App could not authenticate: ${clause(message)}. Check USINE_GITHUB_APP_ID and USINE_GITHUB_PRIVATE_KEY, or .usine/github-app.json.`,
    EnginePersistenceError: ({ operation, cause }) =>
      `usine up stopped: runtime store error: could not ${operation}${because(cause)}. Check .usine/runtime.sqlite and its folder.`,
    DurableHarnessError: ({ operation, message }) =>
      `usine up did not start: durable storage error: could not ${operation} (${clause(message)}). Check .usine/durable.sqlite and its folder, then run usine up again.`,
    AttemptCancellationError: ({ attemptId, cause }) =>
      `usine up stopped: attempt ${attemptId} could not be canceled${because(cause)}.`,
    RunOperationRejectedError: ({ runId, operation, state }) =>
      `Cannot ${operation} run ${runId} while it is ${state.toLowerCase()}.`,
    RunRetryBlockedError: ({ message }) => message,
    RunInterventionRejectedError: ({ message }) => message,
    SignalError: ({ pid, signal, reason }) =>
      `Could not send ${signal} to pid ${pid} (${clause(reason)}). Run the command as the user that started usine.`,
    StopTimeoutError: ({ command, pid, timeout, runs }) => stopTimeout(command, pid, timeout, runs),
    InstanceNotRunningError: ({ command, directory }) =>
      `usine ${command} did nothing: usine is not running in ${directory}. Start it with usine up --detach.`,
    UnrecordedInstanceError: ({ command, directory, pid }) =>
      Option.match(pid, {
        onNone: () =>
          `usine ${command} did nothing: a process holds ${directory}/.usine/instance.lock, but .usine/instance.pid names no running process. Wait for it to finish starting, then run usine ${command} again.`,
        onSome: (holder) =>
          `usine ${command} did nothing: usine (pid ${holder}) runs in ${directory} without a readable .usine/instance.json, so its port and command line are unknown. It is a usine version that doesn't write one, or it is still starting. Stop it with usine stop, then start it with usine up --detach.`,
      }),
    MissingEnvironmentError: ({ command, variables }) =>
      `usine ${command} left the instance running: neither this shell nor .env sets ${variables.join(", ")}, which the new usine up reads at startup for its ${variables.length === 1 ? "gateway" : "gateways"}. The new process gets the environment of the shell that runs usine ${command}, and reads .env in the instance folder. Add ${variables.length === 1 ? "it" : "them"} to .env, then run usine ${command} again.`,
    LiveAttemptsError: ({ command, runs }) =>
      `usine ${command} left the instance running: ${runList(runs)} ${runs.length === 1 ? "has a running attempt" : "have running attempts"}. Wait for ${runs.length === 1 ? "it" : "them"} to end, or run usine ${command} --force to stop without waiting; the next start reattaches the attempts.`,
    DetachedStartError: ({ outcome, pid, exit, timeout, port, log, tail }) =>
      outcome === "exited"
        ? `usine up exited (${Option.getOrElse(exit, () => "unknown status")}) before it listened on port ${port}. ${logLines(tail)}`
        : `usine up${holderOf(pid)} didn't answer on port ${port} within ${Duration.format(timeout)}. It still runs. Check ${log}, or stop it with usine stop.`,
    DetachedSpawnError: ({ command, reason }) =>
      `Could not start ${command} in the background (${clause(reason)}).`,
    EngineOutsideInstanceError: ({ script, version, packaged }) =>
      packaged
        ? `usine upgrade changed nothing: the running engine, @usine/server ${version}, runs from ${script}, outside this instance's node_modules. Update that install with its package manager, then run usine restart.`
        : `usine upgrade changed nothing: the running engine, @usine/server ${version}, runs from ${script}, a checkout outside this instance. Pull and build that checkout (git pull, pnpm install --frozen-lockfile, pnpm build), then run usine restart.`,
    EnginePinError: ({ path, missing, linked }) =>
      missing
        ? `usine upgrade changed nothing: ${path} doesn't exist. usine upgrade moves the @usine/server pin of an instance that installs the engine from npm.`
        : Option.match(linked, {
            onNone: () =>
              `usine upgrade changed nothing: ${path} doesn't pin @usine/server to a registry version. Add it with an exact version, such as "@usine/server": "0.3.0", and install it.`,
            onSome: (spec) =>
              `usine upgrade changed nothing: ${path} points @usine/server at ${spec}. Update that folder, then run usine restart.`,
          }),
    InstanceManifestError: ({ path, reason }) =>
      `Could not read ${path} (${clause(reason)}). Fix the file, then run the command again.`,
    PackageLookupError: ({ name, spec, reason }) =>
      `Could not find ${name}@${spec} on the npm registry (${clause(reason)}). Check the version, and the registry in .npmrc.`,
    UpgradeFileError: ({ path, reason }) =>
      `usine upgrade stopped: could not access ${path} (${clause(reason)}).`,
    UpgradeFailedError: (failure) =>
      Match.value(failure.stage).pipe(
        Match.when(
          "install",
          () =>
            `usine upgrade could not install @usine/server ${failure.target}: ${clause(failure.reason)}. package.json and the lockfile are back at ${failure.previous}, and the instance is stopped. Run ${failure.packageManager} install, then usine up --detach.`,
        ),
        Match.when(
          "start",
          () =>
            `@usine/server ${failure.target} did not start: ${failure.reason}. The instance is stopped. ${logLines(failure.tail)}\n\n${rollback(failure)}`,
        ),
        Match.when(
          "listen",
          () =>
            `@usine/server ${failure.target} started, but ${failure.reason}. It still runs: check .usine/usine.log, or stop it with usine stop. ${logLines(failure.tail)}\n\n${rollback(failure)}`,
        ),
        Match.exhaustive,
      ),
  });
