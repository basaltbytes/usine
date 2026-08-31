import { Attempt, AttemptChannel, AttemptFailure, Instance, Repository } from "@usine/core";
import {
  Array as Arr,
  Cause,
  Config,
  DateTime,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PartitionedSemaphore,
  Path,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
import {
  CheckoutRequest,
  CredentialProvider,
  Executor,
  ExecutorError,
  ExecutorOperationError,
  PreparedAttempt,
  WorktreePath,
  type ExecutorOperation,
} from "../index.ts";

export interface RunHostCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface LocalExecutorOptions {
  readonly instanceDirectory: Instance.Directory;
  /** How to launch the one-shot run host; the composition root resolves it. */
  readonly runHost: RunHostCommand;
  readonly repositoryUrl?: (repository: Repository.Name) => string;
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
}

interface PreparedState {
  readonly cache: string;
  readonly credential: Redacted.Redacted<string>;
}

interface ActiveAttempt {
  readonly cancelStarted: Ref.Ref<boolean>;
  readonly handle: ChildProcessHandle;
  readonly input: Queue.Queue<Uint8Array, Cause.Done>;
  readonly io: AttemptChannel.Sink;
  readonly sequence: Ref.Ref<number>;
}

const inputFrameToJson = Schema.encodeSync(AttemptChannel.InputFrameFromJson);
/** Strict by contract: an unknown key on a protocol frame is a rejected frame. */
const decodeOutboundEnvelope = (line: string) =>
  Schema.decodeUnknownEffect(AttemptChannel.OutboundEnvelopeFromJson)(line, {
    onExcessProperty: "error",
  });
const isExecutorError = Schema.is(ExecutorError);
const encoder = new TextEncoder();

/** Every git invocation is bounded: a hung clone or fetch must stay cancellable. */
const COMMAND_TIMEOUT = "10 minutes";
const STDERR_TAIL_BYTES = 4_096;

/**
 * The run host gets a minimal environment, never the orchestrator's: the App
 * private key and every other orchestrator secret must not reach the agent
 * (ADR 0011's single-repo worker token is the only credential it holds).
 */
const HOST_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
] as const;

const hostEnvironment: Effect.Effect<Record<string, string>> = Effect.forEach(
  HOST_ENVIRONMENT_ALLOWLIST,
  (name) =>
    Effect.map(Config.option(Config.string(name)), (value) =>
      Option.map(value, (found) => [name, found] as const),
    ),
).pipe(
  Effect.map((entries) => Object.fromEntries(Arr.getSomes(entries))),
  // An unreadable process environment at layer build is startup breakage.
  Effect.orDie,
);

const frame = (input: AttemptChannel.InputFrame): Uint8Array =>
  encoder.encode(`${inputFrameToJson(input)}\n`);

const executorError = (
  operation: ExecutorOperation,
  message: string,
  cause: unknown,
): ExecutorOperationError => new ExecutorOperationError({ operation, message, cause });

const infrastructureFailure = (message: string, cause: unknown) =>
  new AttemptFailure.InfraFailure({ message, cause });

const violationFailure = (violation: AttemptChannel.Violation) =>
  infrastructureFailure(violation.message, new Error(violation.detail));

const safeSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

/** The credential must never survive into a persisted error message. */
const scrubbed = (text: string, credential: Redacted.Redacted<string>): string =>
  text.replaceAll(Redacted.value(credential), "[REDACTED]");

const credentialEnvironment = (
  base: Record<string, string>,
  credential: Redacted.Redacted<string>,
) => {
  const token = Redacted.value(credential);
  return {
    ...base,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f",
  } as const;
};

const makeLocalExecutor = (options: LocalExecutorOptions) =>
  Effect.gen(function* () {
    const credentials = yield* CredentialProvider;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fetches = yield* PartitionedSemaphore.make<string>({ permits: 1 });
    const preparedStates = yield* Ref.make(new Map<Attempt.AttemptId, PreparedState>());
    const activeAttempts = yield* Ref.make(new Map<Attempt.AttemptId, ActiveAttempt>());
    const baseEnvironment = yield* hostEnvironment;
    const repositoryUrl =
      options.repositoryUrl ??
      ((repository: Repository.Name): string => `https://github.com/${repository}.git`);
    const runHost = options.runHost;
    const interruptGrace = options.interruptGrace ?? "2 seconds";
    const workersRoot = path.join(options.instanceDirectory, ".usine", "workers");

    const executeCommand = Effect.fn("LocalExecutor.executeCommand")(function* (
      operation: ExecutorOperation,
      command: string,
      args: ReadonlyArray<string>,
      commandOptions: ChildProcess.CommandOptions = {},
    ) {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              env: baseEnvironment,
              extendEnv: false,
              ...commandOptions,
            }),
          );
          const stdoutFiber = yield* handle.stdout.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.forkChild,
          );
          const stderrFiber = yield* handle.stderr.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.forkChild,
          );
          const exitCode = yield* handle.exitCode;
          const [stdout, stderr] = yield* Effect.all([
            Fiber.join(stdoutFiber),
            Fiber.join(stderrFiber),
          ]);
          return { exitCode, stderr, stdout } as const;
        }),
      ).pipe(
        Effect.timeout(COMMAND_TIMEOUT),
        Effect.mapError((cause) =>
          executorError(operation, `${command} could not be executed`, cause),
        ),
      );
      if (Number(result.exitCode) !== 0) {
        yield* Effect.logWarning("Executor command exited non-zero", {
          operation,
          command,
          args: args.join(" "),
          exitCode: String(result.exitCode),
        });
        return yield* executorError(
          operation,
          `${command} exited with code ${String(result.exitCode)}`,
          new Error(result.stderr.trim() || `${command} exited without an error message`),
        );
      }
      return result.stdout;
    });

    const run = Effect.fn("LocalExecutor.run")(function* (
      operation: ExecutorOperation,
      command: string,
      args: ReadonlyArray<string>,
      commandOptions: ChildProcess.CommandOptions = {},
    ) {
      yield* executeCommand(operation, command, args, commandOptions);
    });

    // ADR 0006: worktrees never outlive their Attempt. A crashed orchestrator
    // leaves both directories and bare-cache registrations behind; the sweep
    // reclaims them at the next layer build, before new Attempts start.
    const sweepAbandonedWorktrees = Effect.fn("LocalExecutor.sweepAbandonedWorktrees")(
      function* () {
        if (!(yield* fileSystem.exists(workersRoot))) return;
        const workers = yield* fileSystem.readDirectory(workersRoot);
        for (const worker of workers) {
          const attemptsRoot = path.join(workersRoot, worker, "attempts");
          if (yield* fileSystem.exists(attemptsRoot)) {
            const leftovers = yield* fileSystem.readDirectory(attemptsRoot);
            for (const leftover of leftovers) {
              const target = path.join(attemptsRoot, leftover);
              yield* Effect.logInfo("Sweeping abandoned Attempt worktree", { worktree: target });
              yield* fileSystem.remove(target, { recursive: true, force: true });
            }
          }
          const reposRoot = path.join(workersRoot, worker, "repos");
          if (yield* fileSystem.exists(reposRoot)) {
            const caches = yield* fileSystem.readDirectory(reposRoot);
            for (const cache of caches) {
              yield* run("cleanup", "git", [
                "--git-dir",
                path.join(reposRoot, cache),
                "worktree",
                "prune",
              ]).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Could not prune a bare cache during the sweep", {
                    cache,
                    message: error.message,
                  }),
                ),
                Effect.ignore,
              );
            }
          }
        }
      },
    );
    yield* sweepAbandonedWorktrees().pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Abandoned-worktree sweep failed; continuing", {
          message: String(error),
        }),
      ),
      Effect.ignore,
    );

    const preflight = Effect.fn("LocalExecutor.preflight")(function* (
      worker: CheckoutRequest["worker"],
    ) {
      const gitVersion = (yield* executeCommand("preflight", "git", ["--version"])).trim();
      if (!gitVersion.startsWith("git version ")) {
        return yield* executorError(
          "preflight",
          `Worker ${worker} returned an unrecognized git version`,
          new Error(gitVersion),
        );
      }
      const reported = (yield* executeCommand("preflight", runHost.command, [
        ...runHost.args,
        "--protocol-version",
      ])).trim();
      if (reported !== String(AttemptChannel.PROTOCOL_VERSION)) {
        return yield* executorError(
          "preflight",
          `Worker ${worker} has run-host protocol ${reported || "unknown"}; expected ${AttemptChannel.PROTOCOL_VERSION}`,
          new Error("run-host protocol mismatch"),
        );
      }
      yield* Effect.logInfo("Worker preflight verified", {
        worker,
        gitVersion,
        protocolVersion: AttemptChannel.PROTOCOL_VERSION,
      });
    });

    const prepare = Effect.fn("LocalExecutor.prepare")(function* (request: CheckoutRequest) {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
      });
      const credential = yield* credentials.issue(request.repository, request.attemptId);
      const workerRoot = path.join(workersRoot, request.worker);
      const cache = path.join(workerRoot, "repos", `${safeSegment(request.repository)}.git`);
      const worktree = path.join(workerRoot, "attempts", safeSegment(request.attemptId));
      const environment = credentialEnvironment(baseEnvironment, credential);
      const commandOptions = { env: environment, extendEnv: false } as const;
      yield* Effect.logInfo("Preparing Attempt workspace", {
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
        revision: request.revision,
        cache,
        worktree,
      });

      const prepared = yield* fetches
        .withPermit(request.repository)(
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(path.dirname(cache), { recursive: true });
            yield* fileSystem.makeDirectory(path.dirname(worktree), { recursive: true });
            yield* fileSystem.remove(worktree, { recursive: true, force: true });
            if (!(yield* fileSystem.exists(cache))) {
              // Clone into a sibling staging directory and rename on success:
              // an interrupted clone must never leave a half-initialized cache
              // that every later fetch for this repository would poison.
              const staging = `${cache}.cloning`;
              yield* fileSystem.remove(staging, { recursive: true, force: true });
              yield* run(
                "prepare",
                "git",
                [
                  "clone",
                  "--bare",
                  "--filter=blob:none",
                  repositoryUrl(request.repository),
                  staging,
                ],
                commandOptions,
              ).pipe(
                Effect.onError(() =>
                  fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
                ),
              );
              yield* fileSystem.rename(staging, cache);
            } else {
              yield* run(
                "prepare",
                "git",
                [
                  "--git-dir",
                  cache,
                  "remote",
                  "set-url",
                  "origin",
                  repositoryUrl(request.repository),
                ],
                commandOptions,
              );
            }
            yield* run(
              "prepare",
              "git",
              ["--git-dir", cache, "fetch", "--force", "--prune", "origin", request.revision],
              commandOptions,
            );
            const resolved = (yield* executeCommand(
              "prepare",
              "git",
              ["--git-dir", cache, "rev-parse", "FETCH_HEAD"],
              commandOptions,
            )).trim();
            const baseCommit = yield* Schema.decodeUnknownEffect(Repository.CommitSha)(
              resolved,
            ).pipe(
              Effect.mapError((cause) =>
                executorError("prepare", "git returned an invalid object id", cause),
              ),
            );
            yield* run(
              "prepare",
              "git",
              ["--git-dir", cache, "worktree", "add", "--detach", worktree, baseCommit],
              commandOptions,
            );
            return new PreparedAttempt({
              worker: request.worker,
              spec: new AttemptChannel.RunSpec({
                attemptId: request.attemptId,
                repository: request.repository,
                revision: request.revision,
                baseCommit,
                payload: request.payload,
                task: request.task,
                agent: request.agent,
                parentModel: request.parentModel,
              }),
              worktree: WorktreePath.make(worktree),
            });
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            isExecutorError(error)
              ? error
              : executorError("prepare", "Attempt workspace preparation failed", error),
          ),
          Effect.onError(() =>
            Effect.gen(function* () {
              yield* fileSystem
                .remove(worktree, { recursive: true, force: true })
                .pipe(Effect.ignore);
              Redacted.wipeUnsafe(credential);
            }),
          ),
        );

      yield* Ref.update(preparedStates, (current) => {
        const next = new Map(current);
        next.set(request.attemptId, { cache, credential });
        return next;
      });
      yield* Effect.logInfo("Attempt workspace ready", {
        attemptId: request.attemptId,
        baseCommit: prepared.spec.baseCommit,
        worktree,
      });
      return prepared;
    });

    const cancelActive = Effect.fn("LocalExecutor.cancelActive")(function* (
      attemptId: Attempt.AttemptId,
      active: ActiveAttempt,
    ) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const first = yield* Ref.modify(
            active.cancelStarted,
            (started) => [!started, true] as const,
          );
          if (!first) return;
          yield* Effect.logInfo("Sending the interrupt envelope", { attemptId });
          const sequence = yield* Ref.getAndUpdate(active.sequence, (value) => value + 1);
          const envelope = new AttemptChannel.InboundEnvelope({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId,
            sequence: AttemptChannel.Sequence.make(sequence),
            sentAt: yield* DateTime.now,
            payload: new AttemptChannel.Interrupt(),
          });
          yield* active.io.append("inbound", envelope).pipe(
            Effect.andThen(Queue.offer(active.input, frame(envelope))),
            Effect.catch((error) =>
              Effect.logWarning("Interrupt could not be delivered; hard-killing the run host", {
                attemptId,
                message: String(error),
              }).pipe(
                Effect.andThen(active.handle.kill({ killSignal: "SIGKILL" })),
                Effect.ignore,
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          );
          const completed = yield* active.handle.exitCode.pipe(
            Effect.timeoutOption(interruptGrace),
          );
          if (Option.isNone(completed) && (yield* active.handle.isRunning)) {
            yield* Effect.logWarning("Interrupt grace expired; sending SIGKILL", { attemptId });
            yield* active.handle.kill({ killSignal: "SIGKILL" });
          } else {
            yield* Effect.logInfo("Run host stopped within the interrupt grace", { attemptId });
          }
        }),
      );
    });

    const cancel = Effect.fn("LocalExecutor.cancel")(function* (attemptId: Attempt.AttemptId) {
      const active = (yield* Ref.get(activeAttempts)).get(attemptId);
      if (active === undefined) return;
      yield* cancelActive(attemptId, active).pipe(
        Effect.mapError((cause) =>
          isExecutorError(cause)
            ? cause
            : executorError("cancel", `Could not cancel Attempt ${attemptId}`, cause),
        ),
      );
    });

    const launch = Effect.fn("LocalExecutor.launch")(function* (
      prepared: PreparedAttempt,
      io: AttemptChannel.Sink,
    ) {
      const attemptId = prepared.spec.attemptId;
      yield* Effect.annotateCurrentSpan({ attemptId, worker: prepared.worker });
      const stored = (yield* Ref.get(preparedStates)).get(attemptId);
      if (stored === undefined) {
        return yield* infrastructureFailure(
          `Attempt ${attemptId} has no prepared credential`,
          new Error("prepared Attempt state missing"),
        );
      }
      const scrub = (text: string): string => scrubbed(text, stored.credential);

      const execute = Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.make<Uint8Array, Cause.Done>();
          yield* Effect.logInfo("Launching the run host", {
            attemptId,
            command: runHost.command,
            worktree: prepared.worktree,
          });
          const handle = yield* spawner.spawn(
            ChildProcess.make(runHost.command, runHost.args, {
              cwd: prepared.worktree,
              env: credentialEnvironment(baseEnvironment, stored.credential),
              extendEnv: false,
              stdin: { stream: Stream.fromQueue(input), endOnDone: true },
            }),
          );
          const active: ActiveAttempt = {
            cancelStarted: yield* Ref.make(false),
            handle,
            input,
            io,
            sequence: yield* Ref.make(1),
          };
          yield* Ref.update(activeAttempts, (current) => {
            const next = new Map(current);
            next.set(attemptId, active);
            return next;
          });
          yield* Queue.offer(
            input,
            frame(
              new AttemptChannel.Start({
                version: AttemptChannel.PROTOCOL_VERSION,
                spec: prepared.spec,
              }),
            ),
          );

          const stderr = yield* Ref.make("");
          const stderrFiber = yield* handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Ref.update(stderr, (current) => `${current}${chunk}`.slice(-STDERR_TAIL_BYTES)),
            ),
            Effect.forkChild,
          );
          const terminal = yield* Ref.make(
            Option.none<
              AttemptChannel.Final | AttemptChannel.Failed | AttemptChannel.Interrupted
            >(),
          );
          const progress = yield* Ref.make(AttemptChannel.initialProgress);

          yield* handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.gen(function* () {
                const envelope = yield* decodeOutboundEnvelope(line).pipe(
                  Effect.mapError((cause) =>
                    infrastructureFailure("The run host emitted an invalid frame", cause),
                  ),
                );
                const before = yield* Ref.get(progress);
                const admitted = AttemptChannel.admit(before, attemptId, envelope);
                if (Result.isFailure(admitted)) {
                  return yield* violationFailure(admitted.failure);
                }
                yield* Ref.set(progress, admitted.success);
                yield* io.append("outbound", envelope);
                const payload = envelope.payload;
                if (
                  payload._tag === "Final" ||
                  payload._tag === "Failed" ||
                  payload._tag === "Interrupted"
                ) {
                  yield* Effect.logInfo("Run host reached its terminal envelope", {
                    attemptId,
                    terminal: payload._tag,
                    sequence: envelope.sequence,
                  });
                  yield* Ref.set(terminal, Option.some(payload));
                  yield* Queue.end(input);
                }
              }),
            ),
            Effect.mapError((error) =>
              Schema.is(AttemptFailure.AttemptFailure)(error)
                ? error
                : infrastructureFailure("The run-host channel failed", error),
            ),
          );
          const exitCode = yield* handle.exitCode.pipe(
            Effect.mapError((cause) =>
              infrastructureFailure("Could not read the run-host exit code", cause),
            ),
          );
          yield* Fiber.join(stderrFiber).pipe(Effect.ignore);
          yield* Effect.logInfo("Run host exited", { attemptId, exitCode: String(exitCode) });
          const ended = yield* Ref.get(terminal);
          if (Option.isNone(ended)) {
            return yield* infrastructureFailure(
              "The run-host channel closed without a final envelope",
              new Error(
                `run host exited with code ${String(exitCode)}: ${scrub((yield* Ref.get(stderr)).trim())}`,
              ),
            );
          }
          if (ended.value._tag === "Failed") return yield* ended.value.failure;
          if (ended.value._tag === "Interrupted") {
            // The cancel path has already closed the Attempt as Canceled; the
            // wire confirmation only needs a typed way out of this fiber.
            return yield* new AttemptFailure.AgentFailure({
              message: "The run host confirmed the interrupt and stopped",
            });
          }
          if (Number(exitCode) !== 0) {
            return yield* infrastructureFailure(
              `The run host exited with code ${String(exitCode)} after its final envelope`,
              new Error(scrub((yield* Ref.get(stderr)).trim())),
            );
          }
          return ended.value.result;
        }).pipe(
          // Inside the scope: the interrupt handshake must run while the
          // spawn finalizer (which kills the process group) is still pending.
          Effect.onInterrupt(() =>
            cancel(attemptId).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Cancel-on-interrupt failed", {
                  attemptId,
                  message: String(error),
                }),
              ),
              Effect.ignore,
            ),
          ),
        ),
      );

      return yield* execute.pipe(
        Effect.ensuring(
          Ref.update(activeAttempts, (current) => {
            const next = new Map(current);
            next.delete(attemptId);
            return next;
          }),
        ),
        Effect.mapError((error) =>
          Schema.is(AttemptFailure.AttemptFailure)(error)
            ? error
            : infrastructureFailure("The local executor failed", error),
        ),
      );
    });

    const cleanup = Effect.fn("LocalExecutor.cleanup")(function* (prepared: PreparedAttempt) {
      const attemptId = prepared.spec.attemptId;
      yield* Effect.logInfo("Cleaning Attempt workspace", {
        attemptId,
        worktree: prepared.worktree,
      });
      const state = (yield* Ref.get(preparedStates)).get(attemptId);
      if (state === undefined) {
        yield* fileSystem
          .remove(prepared.worktree, { recursive: true, force: true })
          .pipe(
            Effect.mapError((cause) =>
              executorError("cleanup", `Could not remove ${prepared.worktree}`, cause),
            ),
          );
        return;
      }
      const finish = Effect.gen(function* () {
        const removedFromGit = yield* run("cleanup", "git", [
          "--git-dir",
          state.cache,
          "worktree",
          "remove",
          "--force",
          prepared.worktree,
        ]).pipe(Effect.result);
        const removedFromDisk = yield* fileSystem
          .remove(prepared.worktree, { recursive: true, force: true })
          .pipe(
            Effect.mapError((cause) =>
              executorError("cleanup", `Could not remove ${prepared.worktree}`, cause),
            ),
            Effect.result,
          );
        const pruned = yield* run("cleanup", "git", [
          "--git-dir",
          state.cache,
          "worktree",
          "prune",
        ]).pipe(Effect.result);
        for (const result of [removedFromGit, removedFromDisk, pruned]) {
          if (Result.isFailure(result)) {
            return yield* result.failure;
          }
        }
      }).pipe(
        Effect.mapError((cause) =>
          isExecutorError(cause)
            ? cause
            : executorError("cleanup", `Could not clean Attempt ${attemptId}`, cause),
        ),
      );
      yield* finish.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Ref.update(preparedStates, (current) => {
              const next = new Map(current);
              next.delete(attemptId);
              return next;
            });
            Redacted.wipeUnsafe(state.credential);
          }),
        ),
      );
    });

    return Executor.of({ cancel, cleanup, launch, preflight, prepare });
  });

/** Node-only local executor; the package root remains platform-free. */
export const layer = (
  options: LocalExecutorOptions,
): Layer.Layer<
  Executor,
  never,
  CredentialProvider | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(Executor, makeLocalExecutor(options));
