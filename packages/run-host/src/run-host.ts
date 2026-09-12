import {
  AgentRuntime,
  type ChildSessions,
  LaunchRequest,
  type RunningSession,
  toAttemptFailure,
  WorkingDirectory,
} from "@usine/agents/runtime";
import { AgentSessionId } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { CommitSha, RepositoryRevision } from "@usine/core/repository";
import { Commit, PullRequest, StepResult } from "@usine/core/step/result";
import { DateTime, Effect, Fiber, Queue, Path, Ref, Result, Schema, Stdio, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** The run host could not read its instructions, report activity, or collect the Attempt's Git results. */
export class RunHostError extends Schema.TaggedError<RunHostError>("@usine/run-host/RunHostError")(
  "RunHostError",
  {
    stage: Schema.Literals(["input", "output", "git", "github"]),
    message: Schema.NonEmptyString,
    cause: Schema.Defect(),
  },
) {}

/** Rejects a frame with any unknown key; the protocol is strict by contract. */
const decodeInput = (line: string) =>
  Schema.decodeUnknownEffect(AttemptChannel.InputFrameFromJson)(line, {
    onExcessProperty: "error",
  });
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(AttemptChannel.OutboundEnvelope));
const PullRequestResponse = Schema.Struct({
  number: PullRequest.fields.number,
  url: Schema.URLFromString,
  head: Schema.Struct({ sha: CommitSha }),
}).pipe(Schema.encodeKeys({ url: "html_url" }));
const decodePullRequestPages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Array(PullRequestResponse))),
);

const hostError = (stage: RunHostError["stage"], message: string, cause: unknown): RunHostError =>
  new RunHostError({ stage, message, cause });

/** Hosts one Attempt described by the Start frame on stdin, sending session activity and its final outcome on stdout. */
export const runHost = Effect.fn("RunHost.run")(() =>
  Effect.scoped(
    Effect.gen(function* () {
      const agents = yield* AgentRuntime;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const stdio = yield* Stdio.Stdio;
      const path = yield* Path.Path;
      const frames = yield* Queue.make<AttemptChannel.InputFrame, RunHostError>();
      const input = stdio.stdin.pipe(
        Stream.mapError((cause) => hostError("input", "Could not read protocol input", cause)),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          decodeInput(line).pipe(
            Effect.mapError((cause) => hostError("input", "Invalid protocol input frame", cause)),
            Effect.flatMap((decoded) => Queue.offer(frames, decoded)),
          ),
        ),
        Effect.andThen(
          Queue.fail(
            frames,
            hostError(
              "input",
              "The protocol input channel closed before the run host finished",
              new Error("unexpected end of input"),
            ),
          ),
        ),
        Effect.catch((error) => Queue.fail(frames, error)),
      );
      yield* Effect.forkScoped(input);

      const first = yield* Queue.take(frames);
      if (first._tag !== "Start") {
        return yield* hostError(
          "input",
          "The first protocol frame must be Start",
          new Error(first._tag),
        );
      }
      const spec = first.spec;
      yield* Effect.annotateCurrentSpan({
        agent: spec.agent.name,
        attemptId: spec.attemptId,
        repository: spec.repository,
      });
      yield* Effect.logInfo("Run host accepted the Start frame");
      // The lifecycle has one writer at a time: Started, session events, terminal.
      let nextSequence = 1;

      const emit = Effect.fn("RunHost.emit")(
        function* (payload: AttemptChannel.OutboundPayload) {
          yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId });
          const envelope = new AttemptChannel.OutboundEnvelope({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId: spec.attemptId,
            sequence: AttemptChannel.Sequence.make(nextSequence++),
            sentAt: yield* DateTime.now,
            payload,
          });
          yield* Stream.run(
            Stream.make(`${encodeOutput(envelope)}\n`),
            stdio.stdout({ endOnDone: false }),
          );
        },
        Effect.mapError((cause) => hostError("output", "Could not write protocol output", cause)),
      );

      const commandLines = Effect.fn("RunHost.commandLines")(function* (
        command: "git" | "gh",
        args: ReadonlyArray<string>,
      ) {
        const stage = command === "git" ? "git" : "github";
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make(command, args));
            const stderrFiber = yield* handle.stderr.pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.forkChild,
            );
            const lines = yield* handle.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runCollect,
            );
            const exitCode = yield* handle.exitCode;
            const stderr = yield* Fiber.join(stderrFiber);
            if (Number(exitCode) !== 0) {
              return yield* hostError(
                stage,
                `${command} exited with code ${String(exitCode)}`,
                new Error(stderr.trim()),
              );
            }
            return lines;
          }),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof RunHostError
              ? cause
              : hostError(stage, `Could not inspect Attempt results with ${command}`, cause),
          ),
        );
      });

      const harvestCommits = Effect.fn("RunHost.harvestCommits")(function* () {
        const lines = yield* commandLines("git", [
          "log",
          "--reverse",
          "--format=%H%x00%s",
          `${spec.baseCommit}..HEAD`,
        ]);
        return yield* Effect.forEach(lines, (line) =>
          Effect.gen(function* () {
            const separator = line.indexOf("\u0000");
            const sha = yield* Schema.decodeUnknownEffect(CommitSha)(
              separator < 0 ? line : line.slice(0, separator),
            ).pipe(
              Effect.mapError((cause) =>
                hostError("git", "git returned an invalid commit id", cause),
              ),
            );
            const summary = separator < 0 ? "" : line.slice(separator + 1).trim();
            if (summary.length === 0) {
              return yield* hostError(
                "git",
                `Commit ${sha} has no summary`,
                new Error("empty commit summary"),
              );
            }
            return new Commit({ sha, summary });
          }),
        );
      });

      const harvestPullRequests = Effect.fn("RunHost.harvestPullRequests")(function* () {
        yield* Effect.annotateCurrentSpan({
          attemptId: spec.attemptId,
          repository: spec.repository,
        });
        const head = yield* Schema.decodeUnknownEffect(CommitSha)(
          (yield* commandLines("git", ["rev-parse", "HEAD"])).join(""),
        ).pipe(
          Effect.mapError((cause) => hostError("git", "git returned an invalid final HEAD", cause)),
        );
        const branch = (yield* commandLines("git", ["branch", "--show-current"])).join("");
        // Executors start detached. An unchanged default-branch Attempt has no
        // PR candidate; a fixed revision, changed HEAD, or agent-created branch does.
        if (
          head === spec.baseCommit &&
          spec.revision !== RepositoryRevision.make(spec.baseCommit) &&
          branch === ""
        ) {
          yield* Effect.logDebug("No pull request candidate in the Attempt checkout");
          return [];
        }
        const output = yield* commandLines("gh", [
          "api",
          `repos/${spec.repository}/commits/${head}/pulls?per_page=100`,
          "--paginate",
          "--slurp",
        ]);
        const pages = yield* decodePullRequestPages(output.join("\n")).pipe(
          Effect.mapError((cause) =>
            hostError("github", "GitHub returned invalid pull request results", cause),
          ),
        );
        // Associated PRs can contain this commit as an ancestor. Record only
        // PRs whose head is the checkout's final commit, once across all pages.
        const facts = new Map<number, PullRequest>();
        for (const pr of pages.flat()) {
          if (pr.head.sha === head)
            facts.set(pr.number, new PullRequest({ number: pr.number, url: pr.url }));
        }
        yield* Effect.logInfo("Collected Attempt pull request results", {
          head,
          pullRequests: [...facts.keys()],
        });
        return [...facts.values()];
      });

      // The parent and each live child are addressable by the id they report in
      // the event stream, so an inbound frame can steer or interrupt one directly.
      const sessions = yield* Ref.make(new Map<AgentSessionId, RunningSession>());
      const record = (target: RunningSession) =>
        Ref.update(sessions, (current) => new Map(current).set(target.session.id, target));
      const childSessions: ChildSessions = {
        register: (child) =>
          record(child).pipe(
            Effect.andThen(
              Effect.addFinalizer(() =>
                Ref.update(sessions, (current) => {
                  const next = new Map(current);
                  next.delete(child.session.id);
                  return next;
                }),
              ),
            ),
          ),
      };

      const launched = yield* Effect.result(
        agents.launch(
          new LaunchRequest({
            spec,
            cwd: WorkingDirectory.make(path.resolve(".")),
          }),
          childSessions,
        ),
      );
      if (Result.isFailure(launched)) {
        yield* Effect.logError("Agent session failed to launch", {
          errorTag: launched.failure._tag,
          message: launched.failure.message,
        });
        yield* emit(new AttemptChannel.Failed({ failure: toAttemptFailure(launched.failure) }));
        return;
      }
      const session = launched.success;
      yield* record(session);
      yield* emit(new AttemptChannel.Started({ parentModel: session.session.brain.model }));

      // Delivers one inbound frame to its target session. A parent Interrupt stays
      // the terminal cancel signal; a child Interrupt only stops that child.
      const route = Effect.fn("RunHost.route")(function* (
        envelope: AttemptChannel.InboundEnvelope,
      ) {
        const targetId =
          envelope.target._tag === "Parent" ? session.session.id : envelope.target.sessionId;
        yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, target: targetId });
        const controls = (yield* Ref.get(sessions)).get(targetId);
        if (controls === undefined) {
          yield* Effect.logWarning("Operator input addressed a session that is no longer live", {
            target: targetId,
            payload: envelope.payload._tag,
          });
          return;
        }
        const payload = envelope.payload;
        switch (payload._tag) {
          case "Steer":
            yield* Effect.logDebug("Routing a Steer frame", { target: targetId });
            return yield* controls.steer(payload.message);
          case "OperatorMessage":
            // Joined to the session as a user turn through the streaming-input bridge;
            // a takeover Hold on the first child message lands in a later change (ADR 0018).
            yield* Effect.logInfo("Routing an operator message", { target: targetId });
            return yield* controls.steer(payload.message);
          case "Interrupt":
            yield* Effect.logInfo("Routing a child Interrupt frame", { target: targetId });
            return yield* controls.interrupt;
          case "Release":
            // A Release ends a Hold, which does not exist yet, so nothing is held.
            yield* Effect.logInfo("Received a Release frame with no open hold", {
              target: targetId,
            });
            return;
        }
      });
      const readCommands = Effect.gen(function* () {
        let expected = 1;
        while (true) {
          const command = yield* Queue.take(frames);
          if (command._tag === "Start") {
            return yield* hostError(
              "input",
              "The run host received a second Start frame",
              new Error("duplicate Start"),
            );
          }
          if (command.attemptId !== spec.attemptId) {
            return yield* hostError(
              "input",
              "The run host received a command for another Attempt",
              new Error(String(command.attemptId)),
            );
          }
          if (command.sequence !== expected) {
            return yield* hostError(
              "input",
              "The run host received a non-contiguous input sequence",
              new Error(`expected ${expected}, received ${command.sequence}`),
            );
          }
          expected += 1;
          if (command.payload._tag === "Interrupt" && command.target._tag === "Parent") {
            yield* Effect.logInfo("Run host received a parent Interrupt frame");
            return new AttemptChannel.Interrupted();
          }
          yield* route(command);
        }
      });

      const completed = Effect.gen(function* () {
        // Both must finish before harvesting; either failure ends the Attempt
        // even when the SDK leaves the other channel open.
        const [sessionResult] = yield* Effect.all(
          [
            session.result,
            session.events.pipe(
              Stream.runForEach((event) => emit(new AttemptChannel.SessionEvent({ event }))),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const commits = yield* harvestCommits();
        const pullRequests = yield* harvestPullRequests().pipe(
          Effect.timeout("10 seconds"),
          // Result discovery is read-only enrichment after the agent completed.
          // A GitHub outage must not automatically repeat already-pushed work.
          Effect.catchTags({
            RunHostError: (error) =>
              Effect.logWarning(
                "Pull request discovery failed; retaining the completed agent result",
                {
                  attemptId: spec.attemptId,
                  repository: spec.repository,
                  stage: error.stage,
                  message: error.message,
                },
              ).pipe(Effect.as([])),
            TimeoutError: () =>
              Effect.logWarning(
                "Pull request discovery timed out; retaining the completed agent result",
                {
                  attemptId: spec.attemptId,
                  repository: spec.repository,
                },
              ).pipe(Effect.as([])),
          }),
        );
        return new AttemptChannel.Final({
          result: new StepResult({
            message: sessionResult.message,
            facts: [...commits, ...pullRequests],
          }),
        });
      });
      const outcome = yield* Effect.raceFirst(completed, readCommands).pipe(Effect.result);
      if (Result.isFailure(outcome)) {
        if (outcome.failure._tag === "RunHostError") {
          yield* Effect.logError("Run host protocol failure", {
            stage: outcome.failure.stage,
            message: outcome.failure.message,
          });
          return yield* outcome.failure;
        }
        yield* Effect.logError("Agent session failed", {
          errorTag: outcome.failure._tag,
          message: outcome.failure.message,
        });
        yield* emit(new AttemptChannel.Failed({ failure: toAttemptFailure(outcome.failure) }));
        return;
      }
      if (outcome.success._tag === "Interrupted") {
        // The race has stopped result collection and event forwarding. An SDK
        // that fails its result on abort can no longer change this outcome.
        yield* Effect.forkScoped(
          session.interrupt.pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Session interrupt delivery failed", {
                attemptId: spec.attemptId,
                repository: spec.repository,
                errorTag: error._tag,
                message: error.message,
              }),
            ),
            Effect.ignore,
          ),
          { startImmediately: true },
        );
        yield* Effect.logInfo("Run host acknowledged the interrupted session");
      } else {
        yield* Effect.logInfo("Run host completed the Attempt", {
          facts: outcome.success.result.facts.length,
        });
      }
      yield* emit(outcome.success);
    }),
  ),
);
