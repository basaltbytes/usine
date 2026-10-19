import { assert, describe, it } from "@effect/vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { StorageRejected } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { TextOutput } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  AgentFailure,
  BlockedFailure,
  InfraFailure,
  QuestionFailure,
  RunawayFailure,
} from "@usine/core/attempt/failure";
import { CommitSha } from "@usine/core/repository";
import { Comment, Commit, StepResult } from "@usine/core/step/result";
import { LocalProcess, RemoteShell } from "@usine/agents/child-host";
import { Context, DateTime, Effect, Exit, Fiber, Layer, Logger, Option, Result } from "effect";
import {
  AttemptReport,
  AttemptRuntime,
  harvestedResult,
  ParentFailed,
  ParentReported,
  ResultRecorded,
} from "../src/attempt-runtime.ts";
import { AttemptRecordDoc } from "../src/attempt/documents.ts";
import { layer as attemptRuntimeLayer } from "../src/attempt/runtime.ts";
import { SUBAGENT_TOOL } from "../src/attempt/subagent.ts";
import {
  DurableHarness,
  durableError,
  layer as durableHarnessLayer,
  StuckStepReports,
} from "../src/harness.ts";
import {
  answer,
  delegate,
  fauxParent,
  layer,
  type ParentStep,
  stubChildBackendLayer,
  StubChildren,
} from "../src/testing.ts";
import {
  assertAdmitted,
  attemptRequest,
  recordingSink,
  temporaryDatabase,
  trace,
  workerEnvironment,
} from "./support.ts";

/** Keeps every log line as its level and JSON-encoded message. */
const capturedLogs = () => {
  const lines: Array<{ readonly level: string; readonly text: string }> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    lines.push({ level: logLevel, text: JSON.stringify(message) });
  });
  return {
    layer: Logger.layer([logger]),
    matching: (pattern: RegExp) => lines.filter(({ text }) => pattern.test(text)),
  };
};

const REPORTED = /pi-durable reported/u;

/** Each operator input's receipts in order: its action, input sequence, and what the receipt says. */
const receipts = (envelopes: ReadonlyArray<AttemptChannel.OutboundEnvelope>) =>
  envelopes.flatMap(({ payload }) => {
    if (payload._tag === "InterventionRejected")
      return [[payload.intervention.action._tag, payload.inputSequence, "rejected"]];
    if (payload._tag !== "InterventionApplied") return [];
    return [
      [
        payload.intervention.action._tag,
        payload.inputSequence,
        payload.state.queued ? "queued" : "delivered",
      ],
    ];
  });

describe("durable AttemptRuntime", () => {
  it.live("relays one whole Attempt and reports the parent's final answer", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const children = yield* StubChildren;
        const request = attemptRequest("run/step/1");
        const recording = recordingSink();
        const lastAnsweredAt = DateTime.makeUnsafe("2026-10-15T19:42:00Z");
        const silent = new AttemptChannel.WorkerUnresponsive({
          worker: request.worker,
          lastAnsweredAt,
          reason: "Connection timed out during banner exchange",
        });
        assert.isFalse(yield* runtime.isLive(request.spec.attemptId));
        // Nothing relays an Attempt that has not started here, so its notice is dropped.
        yield* runtime.notify(request.spec.attemptId, silent);
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
        const child = yield* children.next;
        assert.deepStrictEqual(child.request.environment, workerEnvironment);
        assert.strictEqual(child.request.cwd, "/workspace/usine");
        assert.deepStrictEqual(child.request.host, new LocalProcess());
        assert.match(child.request.prompt, /Fix the flaky test/u);
        assert.isTrue(yield* runtime.isLive(request.spec.attemptId));
        yield* runtime.notify(request.spec.attemptId, silent);
        yield* runtime.notify(
          request.spec.attemptId,
          new AttemptChannel.WorkerResponsive({ worker: request.worker, lastAnsweredAt }),
        );
        yield* child.reply("Child fixed the test.");
        const report = yield* Fiber.join(execution);
        assert.strictEqual(report.message, "Fixed the flaky test and opened a pull request.");
        assert.isFalse(yield* runtime.isLive(request.spec.attemptId));
        const outbound = recording.outbound();
        assertAdmitted(request.spec.attemptId, outbound);
        assert.deepStrictEqual(
          trace(outbound).filter((tag) => tag.startsWith("Worker")),
          ["WorkerUnresponsive", "WorkerResponsive"],
          "the notices sent while the Attempt runs, each once",
        );
        assert.deepStrictEqual(
          trace(outbound).filter((tag) => !tag.startsWith("Worker")),
          [
            "Started",
            "parent.SessionStarted",
            "parent.ToolStarted:subagent",
            "child.SessionStarted",
            "child.TextOutput",
            "child.SessionFinished",
            "parent.ToolFinished:subagent",
            "parent.TextOutput",
            "parent.SessionFinished",
            "Final",
          ],
        );
        assert.isTrue(
          outbound.some(
            ({ payload }) =>
              payload._tag === "SessionEvent" && payload.event._tag === "SessionTokensUpdated",
          ),
        );
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: [
              delegate("Fix the flaky test"),
              answer("Fixed the flaky test and opened a pull request."),
            ],
          }),
        ),
      );
      // A restarted orchestrator still reads the report, then the harvested result once recorded.
      const attemptId = attemptRequest("run/step/1").spec.attemptId;
      const harvested = new StepResult({ message: "Fixed it.", facts: [] });
      const finished = yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const reported = yield* runtime.finished(attemptId);
        yield* runtime.recordResult(attemptId, harvested);
        return { reported, recorded: yield* runtime.finished(attemptId) };
      }).pipe(Effect.provide(layer({ database, parent: [] })));
      assert.deepStrictEqual(
        finished.reported,
        Option.some(
          new ParentReported({
            report: new AttemptReport({
              message: "Fixed the flaky test and opened a pull request.",
            }),
          }),
        ),
      );
      assert.deepStrictEqual(
        finished.recorded,
        Option.some(new ResultRecorded({ result: harvested })),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "resumes an Attempt after a restart: same task, same turn, the child settles as interrupted",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = attemptRequest("run/step/2");
        const recording = recordingSink();
        const turn = (harness: DurableHarness["Service"]) =>
          harness.use("read the first turn", async (opened, context) => {
            const record = await opened.snapshot(AttemptRecordDoc, request.spec.attemptId, context);
            const parent = record?.parentConversation ?? undefined;
            if (record === undefined || parent === undefined || record.taskId === null)
              return undefined;
            const requestId = `usine.attempt:${record.taskId}:turn:1`;
            const submission = await opened.commit(
              (tx) => tx.submissionByRequest(parent, requestId),
              context,
            );
            const entries = await (
              await opened.conversation(parent, context)
            )?.entries({}, 100, undefined, context);
            const prompts = entries?.items.filter((entry) => entry.kind === "pi.user").length;
            return { parent, taskId: record.taskId, submission: submission?.id, prompts };
          });

        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(
              layer({ database, parent: [delegate("Fix the flaky test")] }),
            );
            const runtime = Context.get(services, AttemptRuntime);
            const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
            const child = yield* Context.get(services, StubChildren).next;
            yield* child.emit(
              new TextOutput({ session: child.request.session, text: "Half way there." }),
            );
            // Running tool output is committed at most every 100 ms.
            yield* Effect.sleep("400 millis");
            const found = yield* turn(Context.get(services, DurableHarness));
            yield* Fiber.interrupt(execution);
            return { child, found };
          }),
        );
        yield* before.child.interrupted.pipe(Effect.timeout("5 seconds"));
        assert(before.found !== undefined);
        const taskId = before.found.taskId;

        const after = yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(
              layer({ database, parent: [answer("Finished after the restart.")] }),
            );
            const runtime = Context.get(services, AttemptRuntime);
            const harness = Context.get(services, DurableHarness);
            // The resumed task finishes before any execute call relays it.
            const settled = yield* harness.use("wait for the resumed task", (opened, context) =>
              opened.waitForTask(taskId, context),
            );
            assert.strictEqual(settled.state.outcome.status, "completed");
            assert.isTrue(yield* runtime.isLive(request.spec.attemptId));
            const report = yield* runtime.execute(request, recording.sink);
            assert.isFalse(yield* runtime.isLive(request.spec.attemptId));
            const found = yield* turn(harness);
            return { report, found };
          }),
        );
        assert.strictEqual(after.report.message, "Finished after the restart.");
        assert.deepStrictEqual(after.found, before.found);
        assert.strictEqual(after.found?.prompts, 1);
        const outbound = recording.outbound();
        assertAdmitted(request.spec.attemptId, outbound);
        assert.strictEqual(outbound.filter(({ payload }) => payload._tag === "Started").length, 1);
        const finished = outbound.flatMap(({ payload }) =>
          payload._tag === "SessionEvent" &&
          payload.event._tag === "ToolFinished" &&
          payload.event.session._tag === "ParentSession"
            ? [payload.event]
            : [],
        );
        assert.strictEqual(finished.length, 1);
        assert.isTrue(finished[0]?.isError);
        const output = JSON.stringify(finished[0]?.output);
        assert.match(output, /Half way there/u);
        assert.match(output, /interrupted/u);
      }).pipe(Effect.scoped),
  );

  it.live("relays an entry again after a crash between its appends and its commit", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/9");
        const recording = recordingSink();
        const appended: Array<AttemptChannel.OutboundEnvelope> = [];
        let crashed = false;
        // The crash comes after the parent entry's last envelope is appended, before its commit.
        const sink: AttemptChannel.Sink = {
          append: (direction, envelope) =>
            Effect.gen(function* () {
              yield* recording.sink.append(direction, envelope);
              if (envelope._tag !== "OutboundEnvelope") return;
              appended.push(envelope);
              const { payload } = envelope;
              if (crashed || payload._tag !== "SessionEvent") return;
              if (payload.event._tag !== "ToolStarted") return;
              crashed = true;
              return yield* new InfraFailure({ message: "The orchestrator stopped", cause: null });
            }),
          salvage: () => Effect.void,
        };
        const stopped = yield* runtime.execute(request, sink).pipe(Effect.flip);
        assert.strictEqual(stopped._tag, "InfraFailure");
        const record = yield* (yield* DurableHarness).use("read the record", (harness, context) =>
          harness.snapshot(AttemptRecordDoc, request.spec.attemptId, context),
        );
        const entry = recording
          .outbound()
          .filter(({ payload }) => payload._tag === "SessionEvent")
          .slice(-2);
        assert.deepStrictEqual(trace(entry), ["parent.TextOutput", "parent.ToolStarted:subagent"]);
        assert.strictEqual(record?.nextOutbound, entry[0]?.sequence);

        const execution = yield* Effect.forkChild(runtime.execute(request, sink));
        yield* (yield* (yield* StubChildren).next).reply("Child fixed the test.");
        const report = yield* Fiber.join(execution);
        assert.strictEqual(report.message, "Fixed after the replay.");
        const replayed = appended.filter(({ sequence }) =>
          entry.some((first) => first.sequence === sequence),
        );
        assert.deepStrictEqual(
          replayed.map(({ sequence, payload }) => [sequence, payload]),
          [...entry, ...entry].map(({ sequence, payload }) => [sequence, payload]),
        );
        const outbound = recording.outbound();
        assertAdmitted(request.spec.attemptId, outbound);
        assert.deepStrictEqual(trace(outbound), [
          "Started",
          "parent.SessionStarted",
          "parent.TextOutput",
          "parent.ToolStarted:subagent",
          "child.SessionStarted",
          "child.TextOutput",
          "child.SessionFinished",
          "parent.ToolFinished:subagent",
          "parent.TextOutput",
          "parent.SessionFinished",
          "Final",
        ]);
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: [
              fauxAssistantMessage(
                [
                  fauxText("Delegating the fix."),
                  fauxToolCall(SUBAGENT_TOOL, { task: "Fix the flaky test" }),
                ],
                { stopReason: "toolUse" },
              ),
              answer("Fixed after the replay."),
            ],
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "reports a steer to a delegating parent queued until the child returns, then delivered",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const seen: Array<string> = [];
        const steered: ParentStep = (context) => {
          for (const message of context.messages) {
            if (message.role !== "user") continue;
            seen.push(JSON.stringify(message.content));
          }
          return answer("Used pnpm as asked.");
        };
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const request = attemptRequest("run/step/3");
          const recording = recordingSink();
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const child = yield* (yield* StubChildren).next;
          yield* runtime.intervene(
            request.spec.attemptId,
            new AttemptChannel.Intervention({
              operator: "philippe",
              target: new AttemptChannel.ParentTarget(),
              action: new AttemptChannel.Steer({ message: "Use pnpm, not npm." }),
            }),
          );
          assert.deepStrictEqual(receipts(recording.outbound()), [["Steer", 1, "queued"]]);
          yield* child.reply("Child done.");
          const report = yield* Fiber.join(execution);
          assert.strictEqual(report.message, "Used pnpm as asked.");
          assert.include(seen.at(-1), "Use pnpm, not npm.");
          const inbound = recording.inbound();
          assert.deepStrictEqual(
            inbound.map(({ sequence, payload }) => [sequence, payload._tag]),
            [[1, "Steer"]],
          );
          assert.deepStrictEqual(receipts(recording.outbound()), [
            ["Steer", 1, "queued"],
            ["Steer", 1, "delivered"],
          ]);
          // The parent never stopped working, so nothing says it resumed.
          assert.notInclude(trace(recording.outbound()), "parent.SessionResumed");
          // Its last turn only answered the steer, which the executor must not take for the task's result.
          assert.isTrue(report.answeredOperator);
          assertAdmitted(request.spec.attemptId, recording.outbound());
        }).pipe(
          Effect.provide(layer({ database, parent: [delegate("Fix the flaky test"), steered] })),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "reports a message to a working child queued until the child reads it, then delivered",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const request = attemptRequest("run/step/31");
          const recording = recordingSink();
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const child = yield* (yield* StubChildren).next;
          const operator = (action: AttemptChannel.OperatorAction) =>
            runtime.intervene(
              request.spec.attemptId,
              new AttemptChannel.Intervention({
                operator: "philippe",
                target: new AttemptChannel.ChildTarget({ sessionId: child.request.session.id }),
                action,
              }),
            );
          yield* operator(new AttemptChannel.OperatorMessage({ message: "Use pnpm, not npm." }));
          assert.deepStrictEqual(receipts(recording.outbound()), [
            ["OperatorMessage", 1, "queued"],
          ]);
          yield* child.readQueued;
          yield* Effect.gen(function* () {
            while (receipts(recording.outbound()).length < 2) yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          yield* operator(new AttemptChannel.Release());
          yield* child.reply("Switched the scripts to pnpm.");
          const report = yield* Fiber.join(execution);
          assert.strictEqual(report.message, "The child switched to pnpm.");
          const outbound = recording.outbound();
          assertAdmitted(request.spec.attemptId, outbound);
          assert.deepStrictEqual(receipts(outbound), [
            ["OperatorMessage", 1, "queued"],
            ["OperatorMessage", 1, "delivered"],
            ["Release", 2, "delivered"],
          ]);
          assert.deepStrictEqual(
            outbound.flatMap(({ payload }) =>
              payload._tag === "InterventionApplied" ? [payload.state.held] : [],
            ),
            [true, true, false],
          );
          // The child never stopped working, so nothing says it resumed.
          assert.notInclude(trace(outbound), "child.SessionResumed");
          const record = yield* (yield* DurableHarness).use("read the record", (harness, context) =>
            harness.snapshot(AttemptRecordDoc, request.spec.attemptId, context),
          );
          assert.deepStrictEqual(record?.queuedInputs ?? [], []);
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [delegate("Fix the flaky test"), answer("The child switched to pnpm.")],
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "reports a message to a working child rejected when the child stops before reading it",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const request = attemptRequest("run/step/32");
          const recording = recordingSink();
          const operator = (
            target: AttemptChannel.SessionTarget,
            action: AttemptChannel.OperatorAction,
          ) =>
            runtime.intervene(
              request.spec.attemptId,
              new AttemptChannel.Intervention({ operator: "philippe", target, action }),
            );
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const child = yield* (yield* StubChildren).next;
          yield* operator(
            new AttemptChannel.ChildTarget({ sessionId: child.request.session.id }),
            new AttemptChannel.Steer({ message: "Skip the docs." }),
          );
          const parent = new AttemptChannel.ParentTarget();
          yield* operator(parent, new AttemptChannel.Interrupt());
          yield* child.interrupted.pipe(Effect.timeout("5 seconds"));
          const steerReceipts = () =>
            receipts(recording.outbound()).filter(([action]) => action === "Steer");
          yield* Effect.gen(function* () {
            while (steerReceipts().length < 2) yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          yield* operator(parent, new AttemptChannel.Release());
          const report = yield* Fiber.join(execution);
          assert.strictEqual(report.message, "Continued after the release.");
          assertAdmitted(request.spec.attemptId, recording.outbound());
          assert.deepStrictEqual(steerReceipts(), [
            ["Steer", 1, "queued"],
            ["Steer", 1, "rejected"],
          ]);
          const record = yield* (yield* DurableHarness).use("read the record", (harness, context) =>
            harness.snapshot(AttemptRecordDoc, request.spec.attemptId, context),
          );
          assert.deepStrictEqual(record?.queuedInputs ?? [], []);
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [delegate("Fix the flaky test"), answer("Continued after the release.")],
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "holds a parent the operator messaged while it delegated, then continues the task once released",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const resumedWith: Array<string> = [];
        const afterRelease: ParentStep = (context) => {
          const last = context.messages.at(-1);
          if (last?.role === "user") resumedWith.push(JSON.stringify(last.content));
          return delegate("Open the pull request");
        };
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const children = yield* StubChildren;
          const request = attemptRequest("run/step/12");
          const recording = recordingSink();
          const operator = (action: AttemptChannel.OperatorAction) =>
            runtime.intervene(
              request.spec.attemptId,
              new AttemptChannel.Intervention({
                operator: "philippe",
                target: new AttemptChannel.ParentTarget(),
                action,
              }),
            );
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const fixer = yield* children.next;
          yield* operator(new AttemptChannel.OperatorMessage({ message: "What failed earlier?" }));
          yield* fixer.reply("Fixed the flaky test.");
          yield* Effect.gen(function* () {
            while (!trace(recording.outbound()).includes("parent.SessionIdle"))
              yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          // The parent answered the operator; under the Hold that answer ends nothing.
          yield* Effect.sleep("300 millis");
          assert.isUndefined(execution.pollUnsafe());
          assert.isTrue(yield* runtime.isLive(request.spec.attemptId));
          yield* operator(new AttemptChannel.Release());
          yield* (yield* children.next).reply("Opened pull request 7.");
          const report = yield* Fiber.join(execution);
          assert.strictEqual(report.message, "Opened the pull request.");
          assert.isFalse(report.answeredOperator);
          assert.deepStrictEqual(resumedWith.length, 1);
          assert.include(resumedWith[0], "Continue the task");
          const outbound = recording.outbound();
          assertAdmitted(request.spec.attemptId, outbound);
          assert.deepStrictEqual(receipts(outbound), [
            ["OperatorMessage", 1, "queued"],
            ["OperatorMessage", 1, "delivered"],
            ["Release", 2, "delivered"],
          ]);
          assert.deepStrictEqual(
            outbound.flatMap(({ payload }) =>
              payload._tag === "InterventionApplied" ? [payload.state.held] : [],
            ),
            [true, true, false],
          );
          assert.deepStrictEqual(
            trace(outbound).filter((step) => step.startsWith("parent.Session")),
            [
              "parent.SessionStarted",
              "parent.SessionIdle",
              "parent.SessionResumed",
              "parent.SessionFinished",
            ],
          );
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [
                delegate("Fix the flaky test"),
                answer("The first run hit a flaky timeout; the child fixed it."),
                afterRelease,
                answer("Opened the pull request."),
              ],
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "succeeds an Attempt whose released parent reported a review it posted after the release",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const children = yield* StubChildren;
          const request = attemptRequest("run/step/13");
          const recording = recordingSink();
          const operator = (action: AttemptChannel.OperatorAction) =>
            runtime.intervene(
              request.spec.attemptId,
              new AttemptChannel.Intervention({
                operator: "philippe",
                target: new AttemptChannel.ParentTarget(),
                action,
              }),
            );
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const reviewer = yield* children.next;
          yield* operator(new AttemptChannel.OperatorMessage({ message: "Is the review ready?" }));
          yield* reviewer.reply("Drafted three findings.");
          yield* Effect.gen(function* () {
            while (!trace(recording.outbound()).includes("parent.SessionIdle"))
              yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          yield* operator(new AttemptChannel.Release());
          const report = yield* Fiber.join(execution);
          // The release guidance is the parent's last user turn, so its final answer counts as one to the operator.
          assert.isTrue(report.answeredOperator);
          const review = new Comment({
            url: new URL("https://github.com/basaltbytes/usine/pull/176#pullrequestreview-1"),
            kind: "review",
          });
          assert.deepStrictEqual(
            harvestedResult(report, [review]),
            Result.succeed(new StepResult({ message: report.message, facts: [review] })),
          );
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [
                delegate("Review pull request 176"),
                answer("The child drafted three findings; I will post them."),
                answer("Posted the review with three findings on pull request 176."),
              ],
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it("fails an Attempt whose parent ended on its answer to the operator with nothing delivered", () => {
    const report = new AttemptReport({
      message: "The child returned no details.",
      answeredOperator: true,
    });
    const failed = harvestedResult(report, []);
    assert(Result.isFailure(failed));
    assert.include(failed.failure.message, "The child returned no details.");
    const commit = new Commit({
      sha: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
      summary: "Fix the flaky test",
    });
    assert.deepStrictEqual(
      harvestedResult(report, [commit]),
      Result.succeed(new StepResult({ message: report.message, facts: [commit] })),
    );
  });

  it.live("holds an interrupted parent until the operator releases it", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/4");
        const recording = recordingSink();
        const operator = (action: AttemptChannel.OperatorAction) =>
          runtime.intervene(
            request.spec.attemptId,
            new AttemptChannel.Intervention({
              operator: "philippe",
              target: new AttemptChannel.ParentTarget(),
              action,
            }),
          );
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
        const child = yield* (yield* StubChildren).next;
        yield* operator(new AttemptChannel.OperatorMessage({ message: "Skip the docs." }));
        yield* operator(new AttemptChannel.Interrupt());
        yield* child.interrupted.pipe(Effect.timeout("5 seconds"));
        yield* Effect.sleep("300 millis");
        assert.isUndefined(execution.pollUnsafe());
        assert.isTrue(yield* runtime.isLive(request.spec.attemptId));
        yield* operator(new AttemptChannel.Release());
        const report = yield* Fiber.join(execution);
        assert.strictEqual(report.message, "Continued after the release.");
        const outbound = recording.outbound();
        assertAdmitted(request.spec.attemptId, outbound);
        // The pause withdrew the queued message, so its second receipt says it was not read.
        assert.deepStrictEqual(receipts(outbound), [
          ["OperatorMessage", 1, "queued"],
          ["OperatorMessage", 1, "rejected"],
          ["Interrupt", 2, "delivered"],
          ["Release", 3, "delivered"],
        ]);
        const states = outbound.flatMap(({ payload }) =>
          payload._tag === "InterventionApplied" &&
          payload.intervention.action._tag !== "OperatorMessage"
            ? [[payload.intervention.action._tag, payload.state.paused]]
            : [],
        );
        assert.deepStrictEqual(states, [
          ["Interrupt", true],
          ["Release", false],
        ]);
        const lifecycle = trace(outbound).filter(
          (step) => step === "parent.SessionIdle" || step === "parent.SessionResumed",
        );
        assert.deepStrictEqual(lifecycle, ["parent.SessionIdle", "parent.SessionResumed"]);
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: [delegate("Fix the flaky test"), answer("Continued after the release.")],
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("gives every child the child host its execute call supplies", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const host = new RemoteShell({
        ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
        sshEnvironment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
        destination: "worker.exe.xyz",
      });
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/11", 3, host);
        const execution = yield* Effect.forkChild(runtime.execute(request, recordingSink().sink));
        const child = yield* (yield* StubChildren).next;
        assert.deepStrictEqual(child.request.host, host);
        yield* child.reply("Done.");
        yield* Fiber.join(execution);
      }).pipe(
        Effect.provide(
          layer({ database, parent: [delegate("Fix the flaky test"), answer("Done.")] }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("cancels an Attempt bottom-up and settles its execute call", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/5");
        const recording = recordingSink();
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
        const child = yield* (yield* StubChildren).next;
        yield* runtime.cancel(request.spec.attemptId);
        yield* child.interrupted.pipe(Effect.timeout("5 seconds"));
        const exit = yield* Fiber.await(execution);
        assert(Exit.isFailure(exit));
        const outbound = recording.outbound();
        assertAdmitted(request.spec.attemptId, outbound);
        assert.strictEqual(outbound.at(-1)?.payload._tag, "Interrupted");
        assert.deepStrictEqual(
          recording.inbound().map(({ payload, operator }) => [payload._tag, operator]),
          [["Cancel", "engine"]],
        );
        assert.isFalse(yield* runtime.isLive(request.spec.attemptId));
        assert.deepStrictEqual(yield* runtime.finished(request.spec.attemptId), Option.none());
      }).pipe(Effect.provide(layer({ database, parent: [delegate("Fix the flaky test")] })));
    }).pipe(Effect.scoped),
  );

  it.live("leaves no live Attempt once the executor canceled it after a failed relay", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/10");
        // The sink fails the relay before its terminal envelope, as the runaway guard does at a ceiling.
        const sink: AttemptChannel.Sink = {
          append: (_direction, envelope) =>
            envelope._tag === "OutboundEnvelope" &&
            envelope.payload._tag === "SessionEvent" &&
            envelope.payload.event._tag === "ToolStarted"
              ? Effect.fail(new RunawayFailure({ ceiling: "tokens" }))
              : Effect.void,
          salvage: () => Effect.void,
        };
        const failure = yield* runtime.execute(request, sink).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "RunawayFailure");
        assert.isTrue(yield* runtime.isLive(request.spec.attemptId));
        yield* runtime.cancel(request.spec.attemptId);
        assert.isFalse(yield* runtime.isLive(request.spec.attemptId));
      }).pipe(Effect.provide(layer({ database, parent: [delegate("Fix the flaky test")] })));
    }).pipe(Effect.scoped),
  );

  it.live("reopens a Session poisoned by a failed commit and finishes the Attempt", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      let opened = 0;
      let failNextCommit = false;
      const openStorage = Effect.tryPromise({
        try: async () => {
          opened += 1;
          const storage = await openNodeSqliteStorage(database);
          const commit = storage.commit.bind(storage);
          storage.commit = (writes, context) => {
            if (!failNextCommit) return commit(writes, context);
            failNextCommit = false;
            return Promise.reject(new Error("disk I/O error"));
          };
          return storage;
        },
        catch: (cause) => durableError("open the durable storage", cause),
      });
      const services = attemptRuntimeLayer.pipe(
        Layer.provideMerge(
          durableHarnessLayer({
            ...fauxParent([delegate("Fix the flaky test"), answer("Recovered after the reopen.")]),
            openStorage,
          }),
        ),
        Layer.provideMerge(stubChildBackendLayer),
      );
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/6");
        const recording = recordingSink();
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
        const child = yield* (yield* StubChildren).next;
        failNextCommit = true;
        yield* child.emit(new TextOutput({ session: child.request.session, text: "Working." }));
        yield* child.interrupted.pipe(Effect.timeout("5 seconds"));
        const report = yield* Fiber.join(execution);
        assert.strictEqual(report.message, "Recovered after the reopen.");
        assert.strictEqual(opened, 2);
        assertAdmitted(request.spec.attemptId, recording.outbound());
      }).pipe(Effect.provide(services));
    }).pipe(Effect.scoped),
  );

  it.live(
    "closing the runtime while a child runs reports no failure and leaves the task to resume",
    () => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = attemptRequest("run/step/12");
        const recording = recordingSink();
        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(
              layer({ database, parent: [delegate("Fix the flaky test")] }),
            );
            // Detached like an Attempt fiber the orchestrator stops only after its runtime closes.
            const execution = yield* Effect.forkDetach(
              Context.get(services, AttemptRuntime).execute(request, recording.sink),
            );
            const child = yield* Context.get(services, StubChildren).next;
            yield* child.emit(
              new TextOutput({ session: child.request.session, text: "Half way there." }),
            );
            return { child, execution };
          }),
        );
        yield* before.child.interrupted.pipe(Effect.timeout("5 seconds"));
        yield* Fiber.interrupt(before.execution);

        const report = yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          assert.isTrue(yield* runtime.isLive(request.spec.attemptId));
          return yield* runtime.execute(request, recording.sink);
        }).pipe(
          Effect.provide(layer({ database, parent: [answer("Finished after the restart.")] })),
        );
        assert.strictEqual(report.message, "Finished after the restart.");
        assertAdmitted(request.spec.attemptId, recording.outbound());
        assert.deepStrictEqual(logs.matching(REPORTED), []);
      }).pipe(Effect.scoped, Effect.provide(logs.layer));
    },
  );

  it.live(
    "stops a harness whose step pi-durable cannot settle and fails the Attempt with the cause",
    () => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = attemptRequest("run/step/13");
        const recording = recordingSink();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(
              layer({ database, parent: [delegate("Fix the flaky test")] }),
            );
            const execution = yield* Effect.forkChild(
              Context.get(services, AttemptRuntime).execute(request, recording.sink),
            );
            yield* Context.get(services, StubChildren).next;
            yield* Fiber.interrupt(execution);
          }),
        );
        // The parent's live state no longer reads back, as when a delta in its chain does not
        // apply, and the storage refuses the commit that would replace it.
        const openStorage = Effect.tryPromise({
          try: async () => {
            const storage = await openNodeSqliteStorage(database);
            const read = storage.document.bind(storage);
            storage.document = async (id, at, context) => {
              const stored = await read(id, at, context);
              if (stored?.record.kind === "pi.live") {
                throw new Error('unresolvable path: ["tools",0]');
              }
              return stored;
            };
            const commit = storage.commit.bind(storage);
            storage.commit = (writes, context) =>
              writes.some(({ type }) => type === "document.retire")
                ? Promise.reject(new StorageRejected("the storage is read-only"))
                : commit(writes, context);
            return storage;
          },
          catch: (cause) => durableError("open the durable storage", cause),
        });
        const services = attemptRuntimeLayer.pipe(
          Layer.provideMerge(
            durableHarnessLayer({ ...fauxParent([answer("Never reached.")]), openStorage }),
          ),
          Layer.provideMerge(stubChildBackendLayer),
        );
        const failure = yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          return yield* runtime.execute(request, recording.sink).pipe(Effect.flip);
        }).pipe(Effect.provide(services), Effect.provideService(StuckStepReports, 20));
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.match(failure.message, /unresolvable path/u);
        assert.lengthOf(logs.matching(/Could not repair the durable storage/u), 2);
        assert.lengthOf(logs.matching(/Stopped the durable harness/u), 1);
        assert.isAtMost(logs.matching(REPORTED).length, 4);
      }).pipe(Effect.scoped, Effect.provide(logs.layer));
    },
  );

  it.live(
    "fails only the Attempt whose parent conversation no longer reads back, and the other one finishes",
    () => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const poisoned = attemptRequest("run/step/14");
        const healthy = attemptRequest("run/step/15");
        const recording = recordingSink();
        const parentOf = yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(
              layer({ database, parent: [delegate("First part"), delegate("Second part")] }),
            );
            const runtime = Context.get(services, AttemptRuntime);
            const executions = yield* Effect.forEach([poisoned, healthy], (request) =>
              Effect.forkChild(runtime.execute(request, recording.sink)),
            );
            const children = Context.get(services, StubChildren);
            yield* children.next;
            yield* children.next;
            yield* Effect.forEach(executions, Fiber.interrupt);
            const record = yield* Context.get(services, DurableHarness).use(
              "read the poisoned Attempt",
              (harness, context) =>
                harness.snapshot(AttemptRecordDoc, poisoned.spec.attemptId, context),
            );
            return record?.parentConversation ?? null;
          }),
        );
        assert(parentOf !== null);
        // The poisoned parent's live state no longer reads back, as when a delta in its chain does not apply.
        let unreadable: number | undefined;
        const openStorage = Effect.tryPromise({
          try: async () => {
            const storage = await openNodeSqliteStorage(database);
            const read = storage.document.bind(storage);
            storage.document = async (id, at, context) => {
              const stored = await read(id, at, context);
              const { record } = stored ?? {};
              if (
                record?.kind === "pi.live" &&
                record.scope.kind === "conversation" &&
                record.scope.conversationId === parentOf
              ) {
                unreadable ??= record.id;
              }
              if (record !== undefined && record.id === unreadable) {
                throw new Error('unresolvable path: ["tools",0]');
              }
              return stored;
            };
            return storage;
          },
          catch: (cause) => durableError("open the durable storage", cause),
        });
        const services = attemptRuntimeLayer.pipe(
          Layer.provideMerge(
            durableHarnessLayer({
              ...fauxParent([answer("Finished the second part after the restart.")]),
              openStorage,
            }),
          ),
          Layer.provideMerge(stubChildBackendLayer),
        );
        const settled = yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          return yield* Effect.all(
            [
              runtime.execute(poisoned, recording.sink).pipe(Effect.flip),
              runtime.execute(healthy, recording.sink),
            ],
            { concurrency: "unbounded" },
          );
        }).pipe(Effect.provide(services));
        const [failure, report] = settled;
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.match(failure.message, /pi\.live: unresolvable path/u);
        assert.strictEqual(report.message, "Finished the second part after the restart.");
        assert.lengthOf(logs.matching(/Replaced the unreadable documents/u), 1);
        assert.lengthOf(logs.matching(/Stopped the durable harness/u), 0);
        assert.lengthOf(logs.matching(/keeps retrying a step/u), 0);
      }).pipe(Effect.scoped, Effect.provide(logs.layer));
    },
  );

  it.live("fails the Attempt when the parent exceeds its child-session budget", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/7", 1);
        const recording = recordingSink();
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
        yield* (yield* (yield* StubChildren).next).reply("First child done.");
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ChildSessionBudgetFailure");
        const outbound = recording.outbound();
        assertAdmitted(request.spec.attemptId, outbound);
        assert.strictEqual(outbound.at(-1)?.payload._tag, "Failed");
        assert.deepStrictEqual(
          yield* runtime.finished(request.spec.attemptId),
          Option.some(new ParentFailed({ failure })),
        );
      }).pipe(
        Effect.provide(
          layer({ database, parent: [delegate("First part"), delegate("Second part")] }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("ends the Attempt with the operator question a child asked", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/9");
        const recording = recordingSink();
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
        yield* (yield* (yield* StubChildren).next).ask("HTTP CONNECT or SOCKS for egress?");
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        assert.deepStrictEqual(
          failure,
          new QuestionFailure({ question: "HTTP CONNECT or SOCKS for egress?" }),
        );
        assertAdmitted(request.spec.attemptId, recording.outbound());
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: [delegate("Fix the P0 finding"), answer("The child needs a decision.")],
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("ends the Attempt with the parent's own operator question", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/10");
        const failure = yield* runtime.execute(request, recordingSink().sink).pipe(Effect.flip);
        assert.deepStrictEqual(
          failure,
          new QuestionFailure({ question: "Should the migration keep the old column?" }),
        );
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: [answer("[usine:question]\nShould the migration keep the old column?")],
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("ends the Attempt with the parent's own blocker", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/16");
        const failure = yield* runtime.execute(request, recordingSink().sink).pipe(Effect.flip);
        assert.deepStrictEqual(
          failure,
          new BlockedFailure({ message: "The baseline gate fails on main." }),
        );
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: [answer("[usine:blocked]\nThe baseline gate fails on main.")],
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("fails the Attempt with a child's blocker the parent did not relay", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/8");
        const recording = recordingSink();
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
        yield* (yield* (yield* StubChildren).next).block("Publishing permission denied.");
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        assert.deepStrictEqual(
          failure,
          new BlockedFailure({ message: "Publishing permission denied." }),
        );
        assertAdmitted(request.spec.attemptId, recording.outbound());
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: [delegate("Publish the package"), answer("The child could not publish.")],
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "ends the Attempt with AgentFailure for a child's harness failure, relayed verbatim or not",
    () =>
      Effect.gen(function* () {
        // The parent returns its last subagent result verbatim, as its guidance asks for a report.
        const relay: ParentStep = (context) => {
          const result = [...context.messages].reverse().find(({ role }) => role === "toolResult");
          const parts = result?.role === "toolResult" ? result.content : [];
          return answer(
            parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          );
        };
        for (const [attempt, parentAnswer] of [
          ["run/step/17", relay],
          ["run/step/18", answer("The child's harness failed.")],
        ] as const) {
          const database = yield* temporaryDatabase;
          yield* Effect.gen(function* () {
            const runtime = yield* AttemptRuntime;
            const execution = yield* Effect.forkChild(
              runtime.execute(attemptRequest(attempt), recordingSink().sink),
            );
            yield* (yield* (yield* StubChildren).next).fail("Codex turn failed: stream closed.");
            const failure = yield* Fiber.join(execution).pipe(Effect.flip);
            assert.deepStrictEqual(
              failure,
              new AgentFailure({ message: "Codex turn failed: stream closed." }),
            );
          }).pipe(
            Effect.provide(
              layer({ database, parent: [delegate("Run the Codex turn"), parentAnswer] }),
            ),
          );
        }
      }).pipe(Effect.scoped),
  );
});
