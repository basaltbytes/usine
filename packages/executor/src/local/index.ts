import { Attempt, AttemptChannel, AttemptFailure, Repository } from "@usine/core";
import { executableCommand as defaultRunHost } from "@usine/run-host/executable";
import {
  Cause,
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
  SynchronizedRef,
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
  PreflightReport,
  type ChannelIo,
  type ExecutorOperation,
} from "../index.ts";

export interface RunHostCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface LocalExecutorOptions {
  readonly instanceDirectory: string;
  readonly runHost?: RunHostCommand;
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
  readonly io: ChannelIo;
  readonly sequence: Ref.Ref<number>;
}

type TerminalEnvelope =
  | { readonly _tag: "Final"; readonly result: AttemptChannel.Final["result"] }
  | { readonly _tag: "Failed"; readonly failure: AttemptChannel.Failed["failure"] };

type ChannelState = "AwaitingStarted" | "Running" | "Terminal";

const inputFrameToJson = Schema.encodeSync(AttemptChannel.InputFrameFromJson);
const decodeOutboundEnvelope = Schema.decodeUnknownEffect(AttemptChannel.OutboundEnvelopeFromJson);
const isExecutorError = Schema.is(ExecutorError);
const encoder = new TextEncoder();

const frame = (input: AttemptChannel.InputFrame): Uint8Array =>
  encoder.encode(`${inputFrameToJson(input)}\n`);

const executorError = (
  operation: ExecutorOperation,
  message: string,
  cause: unknown,
): ExecutorOperationError => new ExecutorOperationError({ operation, message, cause });

const infrastructureFailure = (message: string, cause: unknown) =>
  new AttemptFailure.InfraFailure({ message, cause });

const safeSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

const credentialEnvironment = (credential: Redacted.Redacted<string>) => {
  const token = Redacted.value(credential);
  return {
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
    const preparedStates = yield* SynchronizedRef.make(new Map<Attempt.AttemptId, PreparedState>());
    const activeAttempts = yield* SynchronizedRef.make(new Map<Attempt.AttemptId, ActiveAttempt>());
    const repositoryUrl =
      options.repositoryUrl ??
      ((repository: Repository.Name): string => `https://github.com/${repository}.git`);
    const runHost = options.runHost ?? defaultRunHost;
    const interruptGrace = options.interruptGrace ?? "2 seconds";

    const executeCommand = Effect.fn("LocalExecutor.executeCommand")(function* (
      operation: ExecutorOperation,
      command: string,
      args: ReadonlyArray<string>,
      commandOptions: ChildProcess.CommandOptions = {},
    ) {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make(command, args, commandOptions));
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
        Effect.mapError((cause) =>
          executorError(operation, `${command} could not be executed`, cause),
        ),
      );
      if (Number(result.exitCode) !== 0) {
        return yield* executorError(
          operation,
          `${command} exited with code ${String(result.exitCode)}`,
          new Error(result.stderr.trim() || `${command} exited without an error message`),
        );
      }
      return result.stdout;
    });

    const output = executeCommand;

    const run = Effect.fn("LocalExecutor.run")(function* (
      operation: ExecutorOperation,
      command: string,
      args: ReadonlyArray<string>,
      commandOptions: ChildProcess.CommandOptions = {},
    ) {
      yield* executeCommand(operation, command, args, commandOptions);
    });

    const preflight = Effect.fn("LocalExecutor.preflight")(function* (
      worker: CheckoutRequest["worker"],
    ) {
      const gitVersion = (yield* output("preflight", "git", ["--version"])).trim();
      if (!gitVersion.startsWith("git version ")) {
        return yield* executorError(
          "preflight",
          `Worker ${worker} returned an unrecognized git version`,
          new Error(gitVersion),
        );
      }
      const reported = (yield* output("preflight", runHost.command, [
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
      return new PreflightReport({
        gitVersion,
        protocolVersion: AttemptChannel.PROTOCOL_VERSION,
      });
    });

    const prepare = Effect.fn("LocalExecutor.prepare")(function* (request: CheckoutRequest) {
      const credential = yield* credentials.issue(request.repository, request.attemptId);
      const workerRoot = path.join(options.instanceDirectory, ".usine", "workers", request.worker);
      const cache = path.join(workerRoot, "repos", `${safeSegment(request.repository)}.git`);
      const worktree = path.join(workerRoot, "attempts", safeSegment(request.attemptId));
      const environment = credentialEnvironment(credential);
      const commandOptions = { env: environment, extendEnv: true } as const;

      const prepared = yield* fetches
        .withPermit(request.repository)(
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(path.dirname(cache), { recursive: true });
            yield* fileSystem.makeDirectory(path.dirname(worktree), { recursive: true });
            yield* fileSystem.remove(worktree, { recursive: true, force: true });
            if (!(yield* fileSystem.exists(cache))) {
              yield* run(
                "prepare",
                "git",
                ["clone", "--bare", "--filter=blob:none", repositoryUrl(request.repository), cache],
                commandOptions,
              );
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
            const resolved = (yield* output(
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
                task: request.task,
              }),
              worktree,
            });
          }),
        )
        .pipe(
          Effect.tapError(() =>
            fileSystem.remove(worktree, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
          Effect.mapError((error) =>
            isExecutorError(error)
              ? error
              : executorError("prepare", "Attempt workspace preparation failed", error),
          ),
          Effect.onError(() => Effect.sync(() => Redacted.wipeUnsafe(credential))),
        );

      yield* SynchronizedRef.update(preparedStates, (current) => {
        const next = new Map(current);
        next.set(request.attemptId, { cache, credential });
        return next;
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
              active.handle
                .kill({ killSignal: "SIGKILL" })
                .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
            ),
          );
          const completed = yield* active.handle.exitCode.pipe(
            Effect.timeoutOption(interruptGrace),
          );
          if (Option.isNone(completed) && (yield* active.handle.isRunning)) {
            yield* active.handle.kill({ killSignal: "SIGKILL" });
          }
        }),
      );
    });

    const cancel = Effect.fn("LocalExecutor.cancel")(function* (attemptId: Attempt.AttemptId) {
      const active = (yield* SynchronizedRef.get(activeAttempts)).get(attemptId);
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
      io: ChannelIo,
    ) {
      const stored = (yield* SynchronizedRef.get(preparedStates)).get(prepared.spec.attemptId);
      if (stored === undefined) {
        return yield* infrastructureFailure(
          `Attempt ${prepared.spec.attemptId} has no prepared credential`,
          new Error("prepared Attempt state missing"),
        );
      }

      const execute = Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.make<Uint8Array, Cause.Done>();
          const handle = yield* spawner.spawn(
            ChildProcess.make(runHost.command, runHost.args, {
              cwd: prepared.worktree,
              env: credentialEnvironment(stored.credential),
              extendEnv: true,
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
          yield* SynchronizedRef.update(activeAttempts, (current) => {
            const next = new Map(current);
            next.set(prepared.spec.attemptId, active);
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
              Ref.update(stderr, (current) => `${current}${chunk}`.slice(-4_096)),
            ),
            Effect.forkChild,
          );
          const terminal = yield* Ref.make(Option.none<TerminalEnvelope>());
          const expectedSequence = yield* Ref.make(1);
          const channelState = yield* Ref.make<ChannelState>("AwaitingStarted");

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
                if (envelope.attemptId !== prepared.spec.attemptId) {
                  return yield* infrastructureFailure(
                    "The run host emitted a frame for another Attempt",
                    new Error(String(envelope.attemptId)),
                  );
                }
                const expected = yield* Ref.get(expectedSequence);
                if (envelope.sequence !== expected) {
                  return yield* infrastructureFailure(
                    "The run host emitted a non-contiguous sequence",
                    new Error(`expected ${expected}, received ${envelope.sequence}`),
                  );
                }
                yield* Ref.set(expectedSequence, expected + 1);
                const state = yield* Ref.get(channelState);
                if (state === "AwaitingStarted" && envelope.payload._tag !== "Started") {
                  return yield* infrastructureFailure(
                    "The run host did not begin with a Started envelope",
                    new Error(envelope.payload._tag),
                  );
                }
                if (state === "Running" && envelope.payload._tag === "Started") {
                  return yield* infrastructureFailure(
                    "The run host emitted more than one Started envelope",
                    new Error("duplicate Started envelope"),
                  );
                }
                if (state === "Terminal") {
                  return yield* infrastructureFailure(
                    "The run host emitted an envelope after its terminal envelope",
                    new Error(envelope.payload._tag),
                  );
                }
                yield* Ref.set(
                  channelState,
                  envelope.payload._tag === "Final" || envelope.payload._tag === "Failed"
                    ? "Terminal"
                    : "Running",
                );
                yield* io.append("outbound", envelope);
                if (envelope.payload._tag === "Final") {
                  yield* Ref.set(
                    terminal,
                    Option.some({ _tag: "Final", result: envelope.payload.result }),
                  );
                  yield* Queue.end(input);
                } else if (envelope.payload._tag === "Failed") {
                  yield* Ref.set(
                    terminal,
                    Option.some({ _tag: "Failed", failure: envelope.payload.failure }),
                  );
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
          const ended = yield* Ref.get(terminal);
          if (Option.isNone(ended)) {
            return yield* infrastructureFailure(
              "The run-host channel closed without a final envelope",
              new Error(
                `run host exited with code ${String(exitCode)}: ${(yield* Ref.get(stderr)).trim()}`,
              ),
            );
          }
          if (ended.value._tag === "Failed") return yield* ended.value.failure;
          if (Number(exitCode) !== 0) {
            return yield* infrastructureFailure(
              `The run host exited with code ${String(exitCode)} after its final envelope`,
              new Error((yield* Ref.get(stderr)).trim()),
            );
          }
          return ended.value.result;
        }),
      );

      return yield* execute.pipe(
        Effect.onInterrupt(() =>
          cancel(prepared.spec.attemptId).pipe(Effect.catch(() => Effect.void)),
        ),
        Effect.ensuring(
          SynchronizedRef.update(activeAttempts, (current) => {
            const next = new Map(current);
            next.delete(prepared.spec.attemptId);
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
      const state = (yield* SynchronizedRef.get(preparedStates)).get(prepared.spec.attemptId);
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
            : executorError("cleanup", `Could not clean Attempt ${prepared.spec.attemptId}`, cause),
        ),
      );
      yield* finish.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* SynchronizedRef.update(preparedStates, (current) => {
              const next = new Map(current);
              next.delete(prepared.spec.attemptId);
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
