import {
  StepOutput,
  StepOutputName,
  StepOutputType,
  StepOutputSha256,
} from "@usine/core/step/output";
import { jsonKey } from "@usine/core/json-key";
// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, describe, it } from "@effect/vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AttemptTask } from "@usine/core/attempt";
import { ModelId } from "@usine/core/agent/brain";
import { TextOutput } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  AgentFailure,
  ProviderCapacityFailure,
  BlockedFailure,
  InfraFailure,
  QuestionFailure,
  RunawayFailure,
} from "@usine/core/attempt/failure";
import { CommitSha } from "@usine/core/repository";
import { type GatewayCredentialKind, MachineId } from "@usine/core/worker";
import { Commit, StepCompletion, StepResult } from "@usine/core/step/result";
import { LocalProcess, RemoteShell } from "@usine/agents/child-host";
import { ChildBackend, SessionOperationError } from "@usine/agents/runtime";
import {
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Ref,
  Result,
  Schema,
  Scope,
} from "effect";
import {
  AttemptReport,
  AttemptRequest,
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
  DurableStorageFailed,
  layer as durableHarnessLayer,
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

/** Captures each log line as its level and JSON-encoded message. */
const capturedLogs = () => {
  const lines: Array<{ readonly level: string; readonly text: string }> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    lines.push({
      level: logLevel,
      text: jsonKey(message),
    });
  });
  const matching = (pattern: RegExp) => lines.filter(({ text }) => pattern.test(text));
  return {
    layer: Logger.layer([logger]),
    matching,
    /** Waits until a line matches `pattern`, or fails after 5 seconds. */
    logged: (pattern: RegExp) =>
      Effect.gen(function* () {
        while (matching(pattern).length === 0) yield* Effect.sleep("20 millis");
      }).pipe(Effect.timeout("5 seconds")),
  };
};

const REPORTED = /pi-durable reported/u;

/** Returns each operator input's receipts in order, as `[action, input sequence, receipt kind]`. */
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

const refusingSteerBackend = Layer.effectContext(
  Effect.gen(function* () {
    const services = yield* Effect.context<ChildBackend | StubChildren>();
    const base = Context.get(services, ChildBackend);
    return Context.add(services, ChildBackend, {
      launch: (request) =>
        base.launch(request).pipe(
          Effect.map((child) => ({
            ...child,
            intervene: () =>
              Effect.fail(
                SessionOperationError.make({
                  operation: "steer",
                  sessionId: Option.some(child.session.id),
                  message: "The child has already stopped accepting input",
                  cause: "closed input",
                }),
              ),
          })),
        ),
    });
  }),
).pipe(Layer.provide(stubChildBackendLayer));

describe("durable AttemptRuntime", () => {
  it.live("preserves the task when the parent delegates a summary", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const children = yield* StubChildren;
        const initial = attemptRequest("run/step/1");
        const task = AttemptTask.make(
          "Review PR #818.\n\n  Add `ready-to-merge` on a clean review.\nDo not wait for CI.\n",
        );
        const request = AttemptRequest.make({
          ...initial,
          spec: AttemptChannel.RunSpec.make({ ...initial.spec, task }),
        });
        const recording = recordingSink();
        const lastAnsweredAt = DateTime.makeUnsafe("2026-10-15T19:42:00Z");
        const silent = AttemptChannel.WorkerUnresponsive.make({
          worker: request.worker,
          lastAnsweredAt,
          reason: "Connection timed out during banner exchange",
        });
        const live = yield* runtime.isLive(request.spec.attemptId);
        assert.isFalse(live);
        // Sent before `execute` starts, so the notice is buffered until the parent starts.
        yield* runtime.notify(request.spec.attemptId, silent);
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
        const child = yield* children.next;
        assert.deepStrictEqual(child.request.environment, workerEnvironment);
        assert.strictEqual(child.request.cwd, "/workspace/usine");
        assert.deepStrictEqual(child.request.host, LocalProcess.make());
        assert.include(child.request.prompt, `# Delegated task\n\n${task}\n`);
        assert.include(child.request.prompt, `"commit": "${request.spec.baseCommit}"`);
        assert.include(
          child.request.prompt,
          "Manage labels precisely. Run required gates foreground.",
        );
        assert.isBelow(
          child.request.prompt.indexOf("# Parent context"),
          child.request.prompt.indexOf("# Delegated task"),
        );
        const currentLive = yield* runtime.isLive(request.spec.attemptId);
        assert.isTrue(currentLive);
        const currentUnsupervised = yield* runtime.unsupervised(request.spec.attemptId);
        assert.isTrue(Option.isNone(currentUnsupervised));
        yield* runtime.recordUnsupervised(request.spec.attemptId, Duration.seconds(42));
        // A shorter time (an earlier record committed late) must not replace the stored one.
        yield* runtime.recordUnsupervised(request.spec.attemptId, Duration.seconds(30));
        yield* runtime.notify(
          request.spec.attemptId,
          AttemptChannel.WorkerResponsive.make({ worker: request.worker, lastAnsweredAt }),
        );
        yield* child.reply("Child fixed the test.");
        const report = yield* Fiber.join(execution);
        assert.strictEqual(report.message, "Fixed the flaky test and opened a pull request.");
        const nextLive = yield* runtime.isLive(request.spec.attemptId);
        assert.isFalse(nextLive);
        const outbound = recording.outbound();
        const parentEvents = outbound.flatMap(({ payload }) =>
          payload._tag === "SessionEvent" && payload.event.session._tag === "ParentSession"
            ? [payload.event]
            : [],
        );
        assert.isAbove(parentEvents.length, 0);
        for (const { session } of parentEvents) {
          assert.deepStrictEqual(session.pool, Option.some("apiKeys"));
          assert.deepStrictEqual(session.endpoint, Option.some("faux"));
        }
        const launch = outbound.flatMap(({ payload }) =>
          payload._tag === "SessionEvent" &&
          payload.event._tag === "SessionStarted" &&
          payload.event.session._tag === "ChildSession"
            ? [payload.event]
            : [],
        );
        assert.strictEqual(launch.length, 1);
        assert.deepStrictEqual(launch[0]?.prompt, Option.some(child.request.prompt));
        assertAdmitted(request.spec.attemptId, outbound);
        assert.deepStrictEqual(
          trace(outbound).filter((tag) => tag.startsWith("Worker")),
          ["WorkerUnresponsive", "WorkerResponsive"],
          "the notice sent before the Attempt started and the one sent while it runs, each once",
        );
        assert.deepStrictEqual(trace(outbound).slice(0, 3), [
          "Started",
          "parent.SessionStarted",
          "WorkerUnresponsive",
        ]);
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
              delegate("Manage labels precisely. Run required gates foreground."),
              answer("Fixed the flaky test and opened a pull request."),
            ],
          }),
        ),
      );
      // After a restart, the report, the harvested result, and the unsupervised time are still
      // readable.
      const attemptId = attemptRequest("run/step/1").spec.attemptId;
      const harvested = StepCompletion.fromResult(
        StepResult.make({ message: "Fixed it.", facts: [] }),
        [
          StepOutput.make({
            name: StepOutputName.make("walkthrough"),
            type: StepOutputType.make("balade.walkthrough"),
            commit: Option.none(),
            content: { title: "Stored across restart" },
            size: 33,
            sha256: StepOutputSha256.make("a".repeat(64)),
          }),
        ],
      );
      const finished = yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const reported = yield* runtime.finished(attemptId);
        const harness = yield* DurableHarness;
        const record = yield* harness.use("read persisted parent billing", (runtime, context) =>
          runtime.snapshot(AttemptRecordDoc, attemptId, context),
        );
        assert.strictEqual(record?.parentPool, "apiKeys");
        assert.strictEqual(record?.parentEndpoint, "faux");
        yield* runtime.recordResult(attemptId, harvested);
        return {
          reported,
          recorded: yield* runtime.finished(attemptId),
          unsupervised: yield* runtime.unsupervised(attemptId),
        };
      }).pipe(Effect.provide(layer({ database, parent: [] })));
      assert.deepStrictEqual(
        Option.map(finished.unsupervised, Duration.toMillis),
        Option.some(42_000),
      );
      assert.deepStrictEqual(
        finished.reported,
        Option.some(
          ParentReported.make({
            report: AttemptReport.make({
              message: "Fixed the flaky test and opened a pull request.",
            }),
          }),
        ),
      );
      assert.deepStrictEqual(
        finished.recorded,
        Option.some(ResultRecorded.make({ result: harvested })),
      );
      const reopened = yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        return yield* runtime.finished(attemptId);
      }).pipe(Effect.provide(layer({ database, parent: [] })));
      assert.deepStrictEqual(reopened, Option.some(ResultRecorded.make({ result: harvested })));
    }).pipe(Effect.scoped),
  );

  it.live(
    "keeps the latest Worker notice sent before the Attempt starts, after the WorkerUnresponsive it answers",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const request = attemptRequest("run/step/40");
          const recording = recordingSink();
          const lastAnsweredAt = DateTime.makeUnsafe("2026-10-15T19:42:00Z");
          const silent = (reason: string) =>
            AttemptChannel.WorkerUnresponsive.make({
              worker: request.worker,
              lastAnsweredAt,
              reason,
            });
          const answering = AttemptChannel.WorkerResponsive.make({
            worker: request.worker,
            lastAnsweredAt,
          });
          for (const notice of [silent("first"), answering, silent("second"), answering])
            yield* runtime.notify(request.spec.attemptId, notice);
          yield* runtime.execute(request, recording.sink);
          const outbound = recording.outbound();
          assertAdmitted(request.spec.attemptId, outbound);
          assert.deepStrictEqual(trace(outbound), [
            "Started",
            "parent.SessionStarted",
            "WorkerUnresponsive",
            "WorkerResponsive",
            "parent.TextOutput",
            "parent.SessionFinished",
            "Final",
          ]);
          assert.deepStrictEqual(
            outbound.flatMap(({ payload }) =>
              payload._tag === "WorkerUnresponsive" || payload._tag === "WorkerResponsive"
                ? [payload]
                : [],
            ),
            [silent("second"), answering],
          );
        }).pipe(Effect.provide(layer({ database, parent: [answer("Nothing to fix.")] })));
      }).pipe(Effect.scoped),
  );

  it.live("drops the Worker notices kept for a parent that never starts", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const logs = capturedLogs();
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const base = attemptRequest("run/step/41");
        const request = AttemptRequest.make({
          ...base,
          spec: AttemptChannel.RunSpec.make({
            ...base.spec,
            parentModel: Option.some(ModelId.make("faux/missing")),
          }),
        });
        const recording = recordingSink();
        yield* runtime.notify(
          request.spec.attemptId,
          AttemptChannel.WorkerUnresponsive.make({
            worker: request.worker,
            lastAnsweredAt: DateTime.makeUnsafe("2026-10-15T19:42:00Z"),
            reason: "Connection timed out during banner exchange",
          }),
        );
        yield* runtime.execute(request, recording.sink).pipe(Effect.flip);
        const outbound = recording.outbound();
        assertAdmitted(request.spec.attemptId, outbound);
        assert.deepStrictEqual(trace(outbound), ["Failed"]);
        assert.lengthOf(
          logs.matching(/Dropped the Worker notices kept for a parent that never started/u),
          1,
        );
      }).pipe(Effect.provide(layer({ database, parent: [] }).pipe(Layer.provideMerge(logs.layer))));
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
              TextOutput.make({ session: child.request.session, text: "Half way there." }),
            );
            // Running tool output is committed at most every 100 ms.
            yield* Effect.sleep("400 millis");
            const found = yield* turn(Context.get(services, DurableHarness));
            yield* Fiber.interrupt(execution);
            yield* Context.get(services, DurableHarness).use(
              "restore the legacy record format",
              (opened, context) =>
                opened.commit(async (tx) => {
                  const record = await tx.doc(AttemptRecordDoc, request.spec.attemptId, null);
                  assert.deepStrictEqual(record.pendingOutbound, []);
                  delete record.pendingOutbound;
                }, context),
            );
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
            const live = yield* runtime.isLive(request.spec.attemptId);
            assert.isTrue(live);
            const report = yield* runtime.execute(request, recording.sink);
            const currentLive = yield* runtime.isLive(request.spec.attemptId);
            assert.isFalse(currentLive);
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
        const json1 = jsonKey(finished[0]?.output);
        const output = json1;
        assert.match(output, /Half way there/u);
        assert.match(output, /interrupted/u);
      }).pipe(Effect.scoped),
  );

  for (const boundary of ["before", "after"] as const) {
    it.live(`replays a child envelope after a restart ${boundary} its append`, () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = attemptRequest(`outbox/child/${boundary}`);
        const recording = recordingSink();
        const deliveries: Array<AttemptChannel.OutboundEnvelope> = [];
        let stopped = false;
        const sink: AttemptChannel.Sink = {
          ...recording.sink,
          append: (direction, envelope) =>
            Effect.gen(function* () {
              const payload = envelope.payload;
              const target =
                envelope._tag === "OutboundEnvelope" &&
                payload._tag === "SessionEvent" &&
                payload.event._tag === "TextOutput" &&
                payload.event.session._tag === "ChildSession";
              if (target) deliveries.push(envelope);
              if (target && !stopped) {
                stopped = true;
                if (boundary === "after") yield* recording.sink.append(direction, envelope);
                return yield* InfraFailure.make({
                  message: "The orchestrator stopped",
                  cause: null,
                });
              }
              yield* recording.sink.append(direction, envelope);
            }),
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(layer({ database, parent: [delegate("Fix it")] }));
            const runtime = Context.get(services, AttemptRuntime);
            const execution = yield* Effect.forkChild(
              runtime.execute(request, sink).pipe(Effect.result),
            );
            const child = yield* Context.get(services, StubChildren).next;
            yield* child.emit(
              TextOutput.make({ session: child.request.session, text: "Durable child output" }),
            );
            const result = yield* Fiber.join(execution);
            assert.isTrue(Result.isFailure(result));
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(layer({ database, parent: [answer("Recovered")] }));
            const runtime = Context.get(services, AttemptRuntime);
            const report = yield* runtime.execute(request, sink);
            assert.strictEqual(report.message, "Recovered");
          }),
        );
        assert.strictEqual(deliveries.length, 2);
        assert.deepStrictEqual(deliveries[1], deliveries[0]);
        const outbound = recording.outbound();
        assertAdmitted(request.spec.attemptId, outbound);
        const childOutput = outbound.findIndex(
          ({ payload }) =>
            payload._tag === "SessionEvent" &&
            payload.event._tag === "TextOutput" &&
            payload.event.session._tag === "ChildSession",
        );
        assert.isAtLeast(childOutput, 0);
        assert.strictEqual(outbound[childOutput + 1]?.sequence, (deliveries[0]?.sequence ?? 0) + 1);
        assert.strictEqual(outbound.at(-1)?.payload._tag, "Final");
      }).pipe(Effect.scoped),
    );

    it.live(`keeps a terminal envelope recoverable after a restart ${boundary} its append`, () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = attemptRequest(`outbox/terminal/${boundary}`);
        const recording = recordingSink();
        const deliveries: Array<AttemptChannel.OutboundEnvelope> = [];
        const sink: AttemptChannel.Sink = {
          ...recording.sink,
          append: (direction, envelope) =>
            Effect.gen(function* () {
              if (envelope._tag === "OutboundEnvelope" && envelope.payload._tag === "Final") {
                deliveries.push(envelope);
                if (deliveries.length <= 2) {
                  if (boundary === "after") yield* recording.sink.append(direction, envelope);
                  return yield* InfraFailure.make({
                    message: "The orchestrator stopped",
                    cause: null,
                  });
                }
              }
              yield* recording.sink.append(direction, envelope);
            }),
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(layer({ database, parent: [answer("Finished")] }));
            const runtime = Context.get(services, AttemptRuntime);
            yield* runtime.execute(request, sink).pipe(Effect.flip);
            const live = yield* runtime.isLive(request.spec.attemptId);
            assert.isTrue(live);
            const currentFinished = yield* runtime.finished(request.spec.attemptId);
            assert.isTrue(Option.isNone(currentFinished));
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(layer({ database, parent: [] }));
            const runtime = Context.get(services, AttemptRuntime);
            const live = yield* runtime.isLive(request.spec.attemptId);
            assert.isTrue(live);
            const attached = yield* Effect.forkChild(runtime.attached(request.spec.attemptId), {
              startImmediately: true,
            });
            const failure = yield* runtime.execute(request, sink).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "InfraFailure");
            yield* Fiber.join(attached).pipe(Effect.timeout("1 second"));
            const currentLive = yield* runtime.isLive(request.spec.attemptId);
            assert.isTrue(currentLive);
            const currentFinished = yield* runtime.finished(request.spec.attemptId);
            assert.isTrue(Option.isNone(currentFinished));
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(layer({ database, parent: [] }));
            const runtime = Context.get(services, AttemptRuntime);
            const attached = yield* Effect.forkChild(runtime.attached(request.spec.attemptId), {
              startImmediately: true,
            });

            assert.strictEqual((yield* runtime.execute(request, sink)).message, "Finished");
            yield* Fiber.join(attached).pipe(Effect.timeout("1 second"));
            const live = yield* runtime.isLive(request.spec.attemptId);
            assert.isFalse(live);
            const currentFinished = yield* runtime.finished(request.spec.attemptId);
            assert.isTrue(Option.isSome(currentFinished));
            const record = yield* Context.get(services, DurableHarness).use(
              "read the delivered outbox",
              (harness, context) =>
                harness.snapshot(AttemptRecordDoc, request.spec.attemptId, context),
            );
            assert.deepStrictEqual(record?.pendingOutbound, []);
          }),
        );
        assert.strictEqual(deliveries.length, 3);
        assert.deepStrictEqual(deliveries[1], deliveries[0]);
        assert.deepStrictEqual(deliveries[2], deliveries[0]);
        assertAdmitted(request.spec.attemptId, recording.outbound());
      }).pipe(Effect.scoped),
    );
  }

  it.live("replays a failed intervention receipt before the next live envelope", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("outbox/intervention");
        const recording = recordingSink();
        const receipts: Array<AttemptChannel.OutboundEnvelope> = [];
        const sink: AttemptChannel.Sink = {
          ...recording.sink,
          append: (direction, envelope) =>
            Effect.gen(function* () {
              yield* recording.sink.append(direction, envelope);
              if (
                envelope._tag !== "OutboundEnvelope" ||
                envelope.payload._tag !== "InterventionApplied"
              )
                return;
              receipts.push(envelope);
              if (receipts.length === 1) {
                return yield* InfraFailure.make({
                  message: "Receipt delivery failed",
                  cause: null,
                });
              }
            }),
        };
        const execution = yield* Effect.forkChild(runtime.execute(request, sink));
        const child = yield* (yield* StubChildren).next;
        yield* runtime.attached(request.spec.attemptId);
        yield* runtime
          .intervene(
            request.spec.attemptId,
            AttemptChannel.Intervention.make({
              operator: "alice",
              target: AttemptChannel.ChildTarget.make({ sessionId: child.request.session.id }),
              action: AttemptChannel.Steer.make({ message: "Keep going" }),
            }),
          )
          .pipe(Effect.flip);
        yield* child.reply("Finished");
        yield* Fiber.join(execution);
        assert.isAtLeast(receipts.length, 2);
        assert.deepStrictEqual(receipts[1], receipts[0]);
        assertAdmitted(request.spec.attemptId, recording.outbound());
      }).pipe(
        Effect.provide(layer({ database, parent: [delegate("Fix it"), answer("Finished")] })),
      );
    }).pipe(Effect.scoped),
  );

  for (const appendedEvents of [1, 2]) {
    it.live(
      `replays a parent entry after ${appendedEvents} appends before its delivery commit`,
      () =>
        Effect.gen(function* () {
          const database = yield* temporaryDatabase;
          yield* Effect.gen(function* () {
            const runtime = yield* AttemptRuntime;
            const request = attemptRequest("run/step/9");
            const recording = recordingSink();
            const appended: Array<AttemptChannel.OutboundEnvelope> = [];
            let crashed = false;
            // Stops partway through the batch or after its last append, before clearing it.
            const sink: AttemptChannel.Sink = {
              append: (direction, envelope) =>
                Effect.gen(function* () {
                  yield* recording.sink.append(direction, envelope);
                  if (envelope._tag !== "OutboundEnvelope") return;
                  appended.push(envelope);
                  const { payload } = envelope;
                  if (crashed || payload._tag !== "SessionEvent") return;
                  if (payload.event._tag !== (appendedEvents === 1 ? "TextOutput" : "ToolStarted"))
                    return;
                  crashed = true;
                  return yield* InfraFailure.make({
                    message: "The orchestrator stopped",
                    cause: null,
                  });
                }),
              salvage: () => Effect.void,
              comments: () => Effect.void,
              outOfMemory: () => Effect.void,
              transcript: Effect.die("The durable runtime never reads the Attempt transcript"),
              windows: Effect.die("The durable runtime never reads the Attempt windows"),
            };
            const stopped = yield* runtime.execute(request, sink).pipe(Effect.flip);
            assert.strictEqual(stopped._tag, "InfraFailure");

            const record = yield* (yield* DurableHarness).use(
              "read the record",
              (harness, context) =>
                harness.snapshot(AttemptRecordDoc, request.spec.attemptId, context),
            );
            const entry = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.fromJsonString(AttemptChannel.OutboundEnvelope)),
            )(record?.pendingOutbound);
            assert.deepStrictEqual(trace(entry), [
              "parent.TextOutput",
              "parent.ToolStarted:subagent",
            ]);
            assert.strictEqual(record?.nextOutbound, (entry.at(-1)?.sequence ?? 0) + 1);
            assert.isAbove(record?.relayedEntry ?? 0, 0);

            const execution = yield* Effect.forkChild(runtime.execute(request, sink));

            yield* (yield* (yield* StubChildren).next).reply("Child fixed the test.");
            const report = yield* Fiber.join(execution);
            assert.strictEqual(report.message, "Fixed after the replay.");
            const replayed = appended.filter(({ sequence }) =>
              entry.some((first) => first.sequence === sequence),
            );
            assert.deepStrictEqual(replayed, [...entry.slice(0, appendedEvents), ...entry]);
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
  }

  it.live(
    "forwards a parent steer to its working child before the child reads its next input",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const seen: Array<string> = [];
        const steered: ParentStep = (context) => {
          for (const message of context.messages) {
            if (message.role !== "user") continue;
            seen.push(jsonKey(message.content));
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
            AttemptChannel.Intervention.make({
              operator: "philippe",
              target: AttemptChannel.ParentTarget.make(),
              action: AttemptChannel.Steer.make({ message: "Use pnpm, not npm." }),
            }),
          );
          assert.deepStrictEqual(receipts(recording.outbound()), [["Steer", 1, "queued"]]);
          const currentInterventions = yield* child.interventions;
          assert.deepStrictEqual(currentInterventions, [
            AttemptChannel.Steer.make({ message: "Use pnpm, not npm." }),
          ]);
          yield* child.readQueued;
          yield* child.reply("Child done.");
          const report = yield* Fiber.join(execution);
          assert.strictEqual(report.message, "Used pnpm as asked.");
          assert.notInclude(seen.at(-1), "Use pnpm, not npm.");
          const inbound = recording.inbound();
          assert.deepStrictEqual(
            inbound.map(({ sequence, payload }) => [sequence, payload._tag]),
            [[1, "Steer"]],
          );
          assert.deepStrictEqual(receipts(recording.outbound()), [
            ["Steer", 1, "queued"],
            ["Steer", 1, "delivered"],
          ]);
          assert.deepStrictEqual(
            recording
              .outbound()
              .flatMap(({ payload }) =>
                payload._tag === "InterventionApplied" ? [payload.state.forwardedTo] : [],
              ),
            [Option.some(child.request.session.id), Option.some(child.request.session.id)],
          );
          // The parent never stopped, so no `SessionResumed` is sent.
          assert.notInclude(trace(recording.outbound()), "parent.SessionResumed");
          assert.isFalse(report.answeredOperator);
          assertAdmitted(request.spec.attemptId, recording.outbound());
        }).pipe(
          Effect.provide(layer({ database, parent: [delegate("Fix the flaky test"), steered] })),
        );
      }).pipe(Effect.scoped),
  );

  for (const delivery of ["refused", "unread"] as const) {
    it.live(`requires another parent turn when its forwarded steer is ${delivery}`, () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const actOnSteer: ParentStep = (context) => {
          assert.include(jsonKey(context.messages.at(-1)), "Fix the third finding.");
          return delegate("Fix the third finding.");
        };
        const backend = delivery === "unread" ? stubChildBackendLayer : refusingSteerBackend;
        const harness = durableHarnessLayer({
          ...fauxParent([
            delegate("Fix the first two findings."),
            answer("The first two findings are fixed."),
            actOnSteer,
            answer("All three findings are fixed."),
          ]),
          openStorage: Effect.tryPromise({
            try: () => openNodeSqliteStorage(database),
            catch: (cause) => durableError("open the test database", cause),
          }),
        });
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const children = yield* StubChildren;
          const request = attemptRequest(`steering/${delivery}/1`);
          const recording = recordingSink();
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const child = yield* children.next;
          yield* runtime.intervene(
            request.spec.attemptId,
            AttemptChannel.Intervention.make({
              operator: "philippe",
              target: AttemptChannel.ParentTarget.make(),
              action: AttemptChannel.Steer.make({ message: "Fix the third finding." }),
            }),
          );
          if (delivery === "unread")
            yield* child.crash("The child stopped before reading the steer");
          else yield* child.reply("The first two findings are fixed.");
          const next = yield* children.next.pipe(Effect.timeout("5 seconds"));
          assert.include(next.request.prompt, "Fix the third finding.");
          assert.strictEqual(execution.pollUnsafe(), undefined);
          yield* next.reply("The third finding is fixed.");
          if (delivery === "unread") {
            const failure = yield* Fiber.join(execution).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "InfraFailure");
            assert.strictEqual(failure.message, "The child stopped before reading the steer");
          } else {
            const report = yield* Fiber.join(execution);
            assert.strictEqual(report.message, "All three findings are fixed.");
            assert.isFalse(report.answeredOperator);
          }
          const expected =
            delivery === "unread"
              ? [
                  ["Steer", 1, "queued"],
                  ["Steer", 1, "queued"],
                  ["Steer", 1, "delivered"],
                ]
              : [
                  ["Steer", 1, "queued"],
                  ["Steer", 1, "delivered"],
                ];
          assert.deepStrictEqual(receipts(recording.outbound()), expected);
          assertAdmitted(request.spec.attemptId, recording.outbound());
        }).pipe(
          Effect.provide(
            attemptRuntimeLayer.pipe(Layer.provideMerge(harness), Layer.provideMerge(backend)),
          ),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.live("returns an unread forwarded steer to the parent after an orchestrator restart", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = attemptRequest("steering/restart/1");
      const recording = recordingSink();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(
            layer({ database, parent: [delegate("Fix the findings.")] }),
          );
          const runtime = Context.get(services, AttemptRuntime);
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          yield* Context.get(services, StubChildren).next;
          yield* runtime.intervene(
            request.spec.attemptId,
            AttemptChannel.Intervention.make({
              operator: "philippe",
              target: AttemptChannel.ParentTarget.make(),
              action: AttemptChannel.Steer.make({ message: "Fix the third finding." }),
            }),
          );
          yield* Fiber.interrupt(execution);
        }),
      );
      const actOnSteer: ParentStep = (context) => {
        assert.include(jsonKey(context.messages.at(-1)), "Fix the third finding.");
        return delegate("Fix the third finding.");
      };
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));

        const child = yield* (yield* StubChildren).next.pipe(Effect.timeout("5 seconds"));
        assert.include(child.request.prompt, "Fix the third finding.");
        yield* child.reply("Third finding fixed.");
        const report = yield* Fiber.join(execution);
        assert.strictEqual(report.message, "Handled the steer after restart.");
        assertAdmitted(request.spec.attemptId, recording.outbound());
        assert.deepStrictEqual(receipts(recording.outbound()), [
          ["Steer", 1, "queued"],
          ["Steer", 1, "queued"],
          ["Steer", 1, "delivered"],
        ]);
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: [
              answer("The earlier work is done."),
              actOnSteer,
              answer("Handled the steer after restart."),
            ],
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  for (const delivery of ["forwarded", "refused"] as const) {
    it.live(`withdraws a ${delivery} steer when the operator interrupts its parent`, () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const request = attemptRequest(`steering/interrupt/${delivery}/1`);
          const recording = recordingSink();
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const child = yield* (yield* StubChildren).next;
          const operator = (action: AttemptChannel.OperatorAction) =>
            runtime.intervene(
              request.spec.attemptId,
              AttemptChannel.Intervention.make({
                operator: "philippe",
                target: AttemptChannel.ParentTarget.make(),
                action,
              }),
            );
          yield* operator(AttemptChannel.Steer.make({ message: "Fix the third finding." }));
          yield* operator(AttemptChannel.Interrupt.make());
          yield* child.interrupted.pipe(Effect.timeout("5 seconds"));
          yield* Effect.sleep("300 millis");
          assert.isUndefined(execution.pollUnsafe());
          const live = yield* runtime.isLive(request.spec.attemptId);
          assert.isTrue(live);
          yield* Effect.gen(function* () {
            while (
              !receipts(recording.outbound()).some(
                ([action, , kind]) => action === "Steer" && kind === "rejected",
              )
            )
              yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          assert.strictEqual(execution.pollUnsafe(), undefined);
          yield* operator(AttemptChannel.Release.make());
          const report = yield* Fiber.join(execution);
          assert.strictEqual(report.message, "Continued after release.");
          assertAdmitted(request.spec.attemptId, recording.outbound());
          assert.deepStrictEqual(
            receipts(recording.outbound()).filter(([action]) => action === "Steer"),
            [
              ["Steer", 1, "queued"],
              ["Steer", 1, "rejected"],
            ],
          );
        }).pipe(
          Effect.provide(
            attemptRuntimeLayer.pipe(
              Layer.provideMerge(
                durableHarnessLayer({
                  ...fauxParent([
                    delegate("Fix the findings."),
                    answer("Continued after release."),
                  ]),
                  openStorage: Effect.tryPromise({
                    try: () => openNodeSqliteStorage(database),
                    catch: (cause) => durableError("open the test database", cause),
                  }),
                }),
              ),
              Layer.provideMerge(
                delivery === "forwarded" ? stubChildBackendLayer : refusingSteerBackend,
              ),
            ),
          ),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.live(
    "completes `attached` once an execute call relays the Attempt's channel, which input sent before cannot reach",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const request = attemptRequest("run/step/33");
          const attemptId = request.spec.attemptId;
          const recording = recordingSink();
          const steer = AttemptChannel.Intervention.make({
            operator: "engine",
            target: AttemptChannel.ParentTarget.make(),
            action: AttemptChannel.Steer.make({ message: "Commit and push your work now." }),
          });
          // Waits before the Attempt has a task in this process, like a reattached runaway guard
          // (#178).
          const relayed = yield* Effect.forkChild(runtime.attached(attemptId));
          const early = yield* runtime.intervene(attemptId, steer).pipe(Effect.flip);
          assert.strictEqual(early.message, "This attempt no longer has a live channel");
          assert.strictEqual(relayed.pollUnsafe(), undefined);
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          yield* Fiber.join(relayed).pipe(Effect.timeout("5 seconds"));
          const child = yield* (yield* StubChildren).next;
          // Completes immediately while the channel is relayed.
          yield* runtime.attached(attemptId).pipe(Effect.timeout("1 second"));
          yield* runtime.intervene(attemptId, steer);
          yield* child.reply("Child done.");
          yield* Fiber.join(execution);
          assert.deepStrictEqual(
            recording.inbound().map(({ sequence, payload }) => [sequence, payload._tag]),
            [[1, "Steer"]],
          );
          assert.deepStrictEqual(receipts(recording.outbound()), [
            ["Steer", 1, "queued"],
            ["Steer", 1, "delivered"],
          ]);
          // The channel detached when `execute` returned, so a new wait is for the next call.
          const next = yield* Effect.forkChild(runtime.attached(attemptId));
          yield* Effect.sleep("50 millis");
          assert.strictEqual(next.pollUnsafe(), undefined);
          yield* Fiber.interrupt(next);
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [delegate("Fix the flaky test"), answer("Committed and pushed.")],
            }),
          ),
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
              AttemptChannel.Intervention.make({
                operator: "philippe",
                target: AttemptChannel.ChildTarget.make({ sessionId: child.request.session.id }),
                action,
              }),
            );
          yield* operator(AttemptChannel.OperatorMessage.make({ message: "Use pnpm, not npm." }));
          assert.deepStrictEqual(receipts(recording.outbound()), [
            ["OperatorMessage", 1, "queued"],
          ]);
          yield* child.readQueued;
          yield* Effect.gen(function* () {
            while (receipts(recording.outbound()).length < 2) yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          yield* operator(AttemptChannel.Release.make());
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
          // The child never stopped, so no `SessionResumed` is sent.
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
              AttemptChannel.Intervention.make({ operator: "philippe", target, action }),
            );
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const child = yield* (yield* StubChildren).next;
          yield* operator(
            AttemptChannel.ChildTarget.make({ sessionId: child.request.session.id }),
            AttemptChannel.Steer.make({ message: "Skip the docs." }),
          );
          const parent = AttemptChannel.ParentTarget.make();
          yield* operator(parent, AttemptChannel.Interrupt.make());
          yield* child.interrupted.pipe(Effect.timeout("5 seconds"));
          const steerReceipts = () =>
            receipts(recording.outbound()).filter(([action]) => action === "Steer");
          yield* Effect.gen(function* () {
            while (steerReceipts().length < 2) yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          yield* operator(parent, AttemptChannel.Release.make());
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
          if (last?.role === "user") resumedWith.push(jsonKey(last.content));
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
              AttemptChannel.Intervention.make({
                operator: "philippe",
                target: AttemptChannel.ParentTarget.make(),
                action,
              }),
            );
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const fixer = yield* children.next;
          yield* operator(AttemptChannel.OperatorMessage.make({ message: "What failed earlier?" }));
          yield* fixer.reply("Fixed the flaky test.");
          yield* Effect.gen(function* () {
            while (!trace(recording.outbound()).includes("parent.SessionIdle"))
              yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          // The parent answered the operator; under the Hold that answer does not end the Attempt.
          yield* Effect.sleep("300 millis");
          assert.isUndefined(execution.pollUnsafe());
          const live = yield* runtime.isLive(request.spec.attemptId);
          assert.isTrue(live);
          yield* operator(AttemptChannel.Release.make());

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
    "succeeds an Attempt whose released parent answered the release guidance with nothing harvested",
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
              AttemptChannel.Intervention.make({
                operator: "philippe",
                target: AttemptChannel.ParentTarget.make(),
                action,
              }),
            );
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const reviewer = yield* children.next;
          yield* operator(AttemptChannel.OperatorMessage.make({ message: "Is the review ready?" }));
          yield* reviewer.reply("Drafted three findings.");
          yield* Effect.gen(function* () {
            while (!trace(recording.outbound()).includes("parent.SessionIdle"))
              yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          yield* operator(AttemptChannel.Release.make());
          const report = yield* Fiber.join(execution);
          assert.isFalse(report.answeredOperator);
          assert.deepStrictEqual(
            harvestedResult(report, []),
            Result.succeed(
              StepCompletion.fromResult(StepResult.make({ message: report.message, facts: [] })),
            ),
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

  it.live(
    "reports a released parent that answered an operator message sent after the release as answering the operator",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const children = yield* StubChildren;
          const request = attemptRequest("run/step/17");
          const recording = recordingSink();
          const operator = (action: AttemptChannel.OperatorAction) =>
            runtime.intervene(
              request.spec.attemptId,
              AttemptChannel.Intervention.make({
                operator: "philippe",
                target: AttemptChannel.ParentTarget.make(),
                action,
              }),
            );
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
          const reviewer = yield* children.next;
          yield* operator(AttemptChannel.OperatorMessage.make({ message: "Is the review ready?" }));
          yield* reviewer.reply("Drafted three findings.");
          yield* Effect.gen(function* () {
            while (!trace(recording.outbound()).includes("parent.SessionIdle"))
              yield* Effect.sleep("20 millis");
          }).pipe(Effect.timeout("5 seconds"));
          yield* operator(AttemptChannel.Release.make());
          const poster = yield* children.next;
          yield* operator(
            AttemptChannel.OperatorMessage.make({ message: "Which findings did you post?" }),
          );
          // Released while the parent delegates, so its next answer ends the Attempt.
          yield* operator(AttemptChannel.Release.make());
          yield* poster.reply("Posted the review.");
          const report = yield* Fiber.join(execution);
          assert.strictEqual(report.message, "Posted all three findings.");
          assert.isTrue(report.answeredOperator);
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [
                delegate("Review pull request 176"),
                answer("The child drafted three findings; I will post them."),
                delegate("Post the three findings as a review on pull request 176"),
                answer("Posted all three findings."),
              ],
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it("fails an Attempt whose parent ended on its answer to the operator with nothing delivered", () => {
    const report = AttemptReport.make({
      message: "The child returned no details.",
      answeredOperator: true,
    });
    const failed = harvestedResult(report, []);
    assert(Result.isFailure(failed));
    assert.include(failed.failure.message, "The child returned no details.");
    const commit = Commit.make({
      sha: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
      summary: "Fix the flaky test",
    });
    assert.deepStrictEqual(
      harvestedResult(report, [commit]),
      Result.succeed(
        StepCompletion.fromResult(StepResult.make({ message: report.message, facts: [commit] })),
      ),
    );
    const output = StepOutput.make({
      name: StepOutputName.make("answer"),
      type: StepOutputType.make("example.answer"),
      commit: Option.none(),
      content: null,
      size: 4,
      sha256: StepOutputSha256.make("a".repeat(64)),
    });
    assert.deepStrictEqual(
      harvestedResult(report, [], [output]),
      Result.succeed(
        StepCompletion.fromResult(StepResult.make({ message: report.message, facts: [] }), [
          output,
        ]),
      ),
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
            AttemptChannel.Intervention.make({
              operator: "philippe",
              target: AttemptChannel.ParentTarget.make(),
              action,
            }),
          );
        const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));
        const child = yield* (yield* StubChildren).next;
        yield* operator(AttemptChannel.OperatorMessage.make({ message: "Skip the docs." }));
        yield* operator(AttemptChannel.Interrupt.make());
        yield* child.interrupted.pipe(Effect.timeout("5 seconds"));
        yield* Effect.sleep("300 millis");
        assert.isUndefined(execution.pollUnsafe());
        const live = yield* runtime.isLive(request.spec.attemptId);
        assert.isTrue(live);
        yield* operator(AttemptChannel.Release.make());
        const report = yield* Fiber.join(execution);
        assert.strictEqual(report.message, "Continued after the release.");
        const outbound = recording.outbound();
        assertAdmitted(request.spec.attemptId, outbound);
        // The pause withdrew the queued message, so its second receipt is a rejection.
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

  it.live(
    "gives every child the child host and machine its execute call supplies, and records on each child's session the Gateway credential in force when it starts",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const host = RemoteShell.make({
          ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
          sshEnvironment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
          destination: "worker.exe.xyz",
        });
        // A provisioned machine, whose Claude children share only its own login.
        const machine = Option.some(MachineId.make("52341896"));
        // Gateway credential kind recorded by the Worker's preflight.
        const recorded = yield* Ref.make(Option.some<GatewayCredentialKind>("api-key"));
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const request = AttemptRequest.make({
            ...attemptRequest("run/step/11", 3, host),
            machine,
            gatewayCredential: Ref.get(recorded),
          });
          const execution = yield* Effect.forkChild(runtime.execute(request, recordingSink().sink));
          const children = yield* StubChildren;
          const first = yield* children.next;
          assert.deepStrictEqual(first.request.host, host);
          assert.deepStrictEqual(first.request.machine, machine);
          assert.deepStrictEqual(first.request.session.gatewayCredential, Option.some("api-key"));
          // A preflight during the Attempt records a subscription token on the Gateway.
          yield* Ref.set(recorded, Option.some("subscription"));
          yield* first.reply("First part done.");
          const second = yield* children.next;
          assert.deepStrictEqual(second.request.host, host);
          assert.deepStrictEqual(
            second.request.session.gatewayCredential,
            Option.some("subscription"),
          );
          yield* second.reply("Second part done.");
          yield* Fiber.join(execution);
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [delegate("First part"), delegate("Second part"), answer("Done.")],
            }),
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
        const live = yield* runtime.isLive(request.spec.attemptId);
        assert.isFalse(live);
        const currentFinished = yield* runtime.finished(request.spec.attemptId);
        assert.deepStrictEqual(currentFinished, Option.none());
      }).pipe(Effect.provide(layer({ database, parent: [delegate("Fix the flaky test")] })));
    }).pipe(Effect.scoped),
  );

  it.live("abandons a child launch that has not returned when the Attempt is canceled", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const launching = yield* Deferred.make<void>();
      const abandoned = yield* Deferred.make<void>();
      // A launch that hasn't opened its harness, like a Claude child in a retry delay after losing
      // the login refresh lock.
      const backend = Layer.succeed(ChildBackend)({
        launch: () =>
          Deferred.succeed(launching, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(abandoned, undefined)),
          ),
      });
      const services = attemptRuntimeLayer.pipe(
        Layer.provideMerge(
          durableHarnessLayer({
            ...fauxParent([delegate("Fix the flaky test")]),
            openStorage: Effect.tryPromise({
              try: () => openNodeSqliteStorage(database),
              catch: (cause) => durableError("open the durable storage", cause),
            }),
          }),
        ),
        Layer.provideMerge(backend),
      );
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/42");
        const execution = yield* Effect.forkChild(runtime.execute(request, recordingSink().sink));
        yield* Deferred.await(launching).pipe(Effect.timeout("5 seconds"));
        yield* runtime.cancel(request.spec.attemptId);
        yield* Deferred.await(abandoned).pipe(Effect.timeout("5 seconds"));
        const executionResult = yield* Fiber.await(execution);
        assert(Exit.isFailure(executionResult));
      }).pipe(Effect.provide(services));
    }).pipe(Effect.scoped),
  );

  it.live(
    "closes the harness while a released Attempt's parent waits for an execute call to spawn a child",
    () => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = attemptRequest("run/step/573");
        const scope = yield* Scope.make();
        const services = yield* Layer.buildWithScope(
          layer({ database, parent: [delegate("First part"), delegate("Second part")] }),
          scope,
        );
        const runtime = Context.get(services, AttemptRuntime);
        const execution = yield* Effect.forkChild(runtime.execute(request, recordingSink().sink));
        const first = yield* Context.get(services, StubChildren).next;
        // Releases the Attempt as a forced shutdown does; its parent task keeps running.
        yield* Fiber.interrupt(execution);
        yield* first.reply("The first part is done.");
        yield* logs.logged(/Waiting for execute to supply/u);

        const closing = yield* Effect.forkDetach(Scope.close(scope, Exit.void));
        const closed = yield* Fiber.await(closing).pipe(Effect.timeoutOption("2 seconds"));
        assert(Option.isSome(closed), "The durable harness did not close");
        assert.lengthOf(logs.matching(/Abandoning the child spawn of an aborted tool call/u), 1);

        // The next process resumes the Attempt: the abandoned call ends as interrupted.
        const report = yield* Effect.scoped(
          Effect.gen(function* () {
            const reopened = yield* Layer.build(
              layer({ database, parent: [answer("Finished after the restart.")] }),
            );
            return yield* Context.get(reopened, AttemptRuntime).execute(
              request,
              recordingSink().sink,
            );
          }),
        );
        assert.strictEqual(report.message, "Finished after the restart.");
      }).pipe(Effect.scoped, Effect.provide(logs.layer));
    },
  );

  it.live("leaves no live Attempt once the executor canceled it after a failed relay", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/10");
        // Fails the relay before the terminal envelope, as the runaway guard does at a ceiling.
        const sink: AttemptChannel.Sink = {
          append: (_direction, envelope) =>
            envelope._tag === "OutboundEnvelope" &&
            envelope.payload._tag === "SessionEvent" &&
            envelope.payload.event._tag === "ToolStarted"
              ? Effect.fail(RunawayFailure.make({ ceiling: "tokens" }))
              : Effect.void,
          salvage: () => Effect.void,
          comments: () => Effect.void,
          outOfMemory: () => Effect.void,
          transcript: Effect.die("The durable runtime never reads the Attempt transcript"),
          windows: Effect.die("The durable runtime never reads the Attempt windows"),
        };
        const failure = yield* runtime.execute(request, sink).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "RunawayFailure");
        const live = yield* runtime.isLive(request.spec.attemptId);
        assert.isTrue(live);
        yield* runtime.cancel(request.spec.attemptId);
        const currentLive = yield* runtime.isLive(request.spec.attemptId);
        assert.isFalse(currentLive);
      }).pipe(Effect.provide(layer({ database, parent: [delegate("Fix the flaky test")] })));
    }).pipe(Effect.scoped),
  );

  it.live(
    "fails the running Attempt after a storage error and runs the next Attempt on a reopened harness",
    () => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
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
              ...fauxParent([delegate("Fix the flaky test"), answer("The next attempt finished.")]),
              openStorage,
            }),
          ),
          Layer.provideMerge(stubChildBackendLayer),
        );
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const failed = attemptRequest("run/step/6");
          const execution = yield* Effect.forkChild(runtime.execute(failed, recordingSink().sink));
          const child = yield* (yield* StubChildren).next;
          failNextCommit = true;
          yield* child.emit(TextOutput.make({ session: child.request.session, text: "Working." }));
          yield* child.interrupted.pipe(Effect.timeout("5 seconds"));
          const failure = yield* Fiber.join(execution).pipe(Effect.flip);
          if (failure._tag !== "InfraFailure") return assert.fail(`Got ${failure._tag}`);
          assert.match(
            failure.message,
            /^Durable storage failed during the attempt: disk I\/O error$/u,
          );
          assert.instanceOf(failure.cause, DurableStorageFailed);

          const next = attemptRequest("run/step/7");
          const recording = recordingSink();
          const report = yield* runtime.execute(next, recording.sink);
          assert.strictEqual(report.message, "The next attempt finished.");
          assert.strictEqual(opened, 2);
          assertAdmitted(next.spec.attemptId, recording.outbound());
          const live = yield* runtime.isLive(failed.spec.attemptId);
          assert.isFalse(live);
          assert.lengthOf(
            logs.matching(/Aborting the task of an Attempt that a storage failure ended/u),
            1,
          );
          assert.lengthOf(logs.matching(/Reopened the durable harness/u), 1);
        }).pipe(Effect.provide(services));
      }).pipe(Effect.scoped, Effect.provide(logs.layer));
    },
  );

  it.live("stops the harness when the storage fails again on reopening", () => {
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      let failCommits = false;
      const openStorage = Effect.tryPromise({
        try: async () => {
          const storage = await openNodeSqliteStorage(database);
          const commit = storage.commit.bind(storage);
          storage.commit = (writes, context) =>
            failCommits ? Promise.reject(new Error("disk I/O error")) : commit(writes, context);
          return storage;
        },
        catch: (cause) => durableError("open the durable storage", cause),
      });
      const services = attemptRuntimeLayer.pipe(
        Layer.provideMerge(
          durableHarnessLayer({ ...fauxParent([delegate("Fix the flaky test")]), openStorage }),
        ),
        Layer.provideMerge(stubChildBackendLayer),
      );
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const execution = yield* Effect.forkChild(
          runtime.execute(attemptRequest("run/step/16"), recordingSink().sink),
        );
        const child = yield* (yield* StubChildren).next;
        failCommits = true;
        yield* child.emit(TextOutput.make({ session: child.request.session, text: "Working." }));
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InfraFailure");

        const next = yield* runtime
          .execute(attemptRequest("run/step/17"), recordingSink().sink)
          .pipe(Effect.flip);
        assert.strictEqual(next._tag, "InfraFailure");
        assert.strictEqual(
          next.message,
          "The durable harness stopped after repeated storage errors: disk I/O error. Restart the orchestrator.",
        );
        assert.lengthOf(logs.matching(/Stopped the durable harness/u), 1);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.scoped, Effect.provide(logs.layer));
  });

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
            // Detached, like an Attempt fiber that the orchestrator stops after its runtime closes.
            const execution = yield* Effect.forkDetach(
              Context.get(services, AttemptRuntime).execute(request, recording.sink),
            );
            const child = yield* Context.get(services, StubChildren).next;
            yield* child.emit(
              TextOutput.make({ session: child.request.session, text: "Half way there." }),
            );
            return { child, execution };
          }),
        );
        yield* before.child.interrupted.pipe(Effect.timeout("5 seconds"));
        yield* Fiber.interrupt(before.execution);

        const report = yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const live = yield* runtime.isLive(request.spec.attemptId);
          assert.isTrue(live);
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
    "refuses to start when the storage cannot replace a document that no longer reads back",
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
        // The parent's live state can't be read, and the storage rejects the commit that would
        // replace it.
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
                ? Promise.reject(new Error("the storage is read-only"))
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
        const error = yield* Layer.build(services).pipe(Effect.scoped, Effect.flip);
        assert.strictEqual(error._tag, "DurableHarnessError");
        assert.strictEqual(error.operation, "resume the durable tasks");
        assert.strictEqual(error.message, "the storage is read-only");
        assert.instanceOf(error.cause, DurableStorageFailed);
        assert.lengthOf(logs.matching(/Could not repair the durable storage/u), 1);
        assert.lengthOf(logs.matching(/failed before its tasks resumed/u), 1);
        assert.lengthOf(logs.matching(/Reopening the durable harness/u), 0);
      }).pipe(Effect.scoped, Effect.provide(logs.layer));
    },
  );

  it.live(
    "fails only the Attempt whose parent conversation no longer reads back, and the other one finishes",
    () => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const broken = attemptRequest("run/step/14");
        const healthy = attemptRequest("run/step/15");
        const recording = recordingSink();
        const parentOf = yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(
              layer({ database, parent: [delegate("First part"), delegate("Second part")] }),
            );
            const runtime = Context.get(services, AttemptRuntime);
            const executions = yield* Effect.forEach([broken, healthy], (request) =>
              Effect.forkChild(runtime.execute(request, recording.sink)),
            );
            const children = Context.get(services, StubChildren);
            yield* children.next;
            yield* children.next;
            yield* Effect.forEach(executions, Fiber.interrupt);
            const record = yield* Context.get(services, DurableHarness).use(
              "read the broken Attempt",
              (harness, context) =>
                harness.snapshot(AttemptRecordDoc, broken.spec.attemptId, context),
            );
            return record?.parentConversation ?? null;
          }),
        );
        assert(parentOf !== null);
        // The broken parent's live state can't be read.
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
              runtime.execute(broken, recording.sink).pipe(Effect.flip),
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
        assert.lengthOf(logs.matching(/A storage error failed the durable harness/u), 0);
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
        const currentFinished = yield* runtime.finished(request.spec.attemptId);
        assert.deepStrictEqual(currentFinished, Option.some(ParentFailed.make({ failure })));
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
          QuestionFailure.make({ question: "HTTP CONNECT or SOCKS for egress?" }),
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
          QuestionFailure.make({ question: "Should the migration keep the old column?" }),
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

  it.live("keeps a child transport loss as infrastructure when the parent reports a blocker", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/824");
        const execution = yield* Effect.forkChild(runtime.execute(request, recordingSink().sink));

        yield* (yield* (yield* StubChildren).next).crash("Codex machine disappeared");
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.strictEqual(failure.message, "Codex machine disappeared");
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: [
              delegate("Complete the task"),
              answer("[usine:blocked]\nThe SSH connection failed."),
            ],
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "fails as infrastructure when the parent returns partial progress after a code-0 child exit",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const request = attemptRequest("run/step/824-zero-exit");
          const execution = yield* Effect.forkChild(runtime.execute(request, recordingSink().sink));

          yield* (yield* (yield* StubChildren).next).crash("Codex app-server exited with code 0");
          const failure = yield* Fiber.join(execution).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "InfraFailure");
          assert.strictEqual(failure.message, "Codex app-server exited with code 0");
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [
                delegate("Complete the task"),
                answer("Merged main and started the gate. No changes have been pushed."),
              ],
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  for (const report of ["ask", "block"] as const) {
    it.live(`prioritizes a child transport loss over an earlier child ${report} report`, () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const request = attemptRequest("run/step/824-earlier-report");
          const execution = yield* Effect.forkChild(runtime.execute(request, recordingSink().sink));

          yield* (yield* (yield* StubChildren).next)[report]("Publishing needs operator guidance.");

          yield* (yield* (yield* StubChildren).next).crash("Codex machine disappeared");
          const failure = yield* Fiber.join(execution).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "InfraFailure");
          assert.strictEqual(failure.message, "Codex machine disappeared");
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [
                delegate("Complete the task"),
                delegate("Inspect the checkout and continue"),
                answer("[usine:blocked]\nThe SSH connection failed."),
              ],
            }),
          ),
        );
      }).pipe(Effect.scoped),
    );
  }

  it.live("ends the Attempt with the parent's own blocker", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const request = attemptRequest("run/step/16");
        const failure = yield* runtime.execute(request, recordingSink().sink).pipe(Effect.flip);
        assert.deepStrictEqual(
          failure,
          BlockedFailure.make({ message: "The baseline gate fails on main." }),
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
          BlockedFailure.make({ message: "Publishing permission denied." }),
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
    "gives the parent the child's report, not its streamed text, as the subagent result",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const relay: ParentStep = (context) => {
          const result = [...context.messages].reverse().find(({ role }) => role === "toolResult");
          const parts = result?.role === "toolResult" ? result.content : [];
          return answer(
            parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          );
        };
        const report = yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const execution = yield* Effect.forkChild(
            runtime.execute(attemptRequest("run/step/19"), recordingSink().sink),
          );
          const child = yield* (yield* StubChildren).next;
          yield* child.emit(TextOutput.make({ session: child.request.session, text: "Reading." }));
          yield* child.reply("Fixed the flaky test.");
          return yield* Fiber.join(execution);
        }).pipe(
          Effect.provide(layer({ database, parent: [delegate("Fix the flaky test"), relay] })),
        );
        assert.strictEqual(report.message, "Fixed the flaky test.");
      }).pipe(Effect.scoped),
  );

  it.live.each([
    AgentFailure.make({ message: "Codex turn failed: stream closed." }),
    ProviderCapacityFailure.make({
      message: "Selected model is at capacity. Please try a different model.",
    }),
  ])("preserves a child's harness failure, relayed verbatim or not: $_tag", (expected) =>
    Effect.gen(function* () {
      // The parent returns its last subagent result verbatim as its report.
      const relay: ParentStep = (context) => {
        const result = [...context.messages].reverse().find(({ role }) => role === "toolResult");
        const parts = result?.role === "toolResult" ? result.content : [];
        return answer(parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
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

          yield* (yield* (yield* StubChildren).next).fail(expected.message);
          const failure = yield* Fiber.join(execution).pipe(Effect.flip);
          assert.deepStrictEqual(failure, expected);
        }).pipe(
          Effect.provide(
            layer({ database, parent: [delegate("Run the Codex turn"), parentAnswer] }),
          ),
        );
      }
    }).pipe(Effect.scoped),
  );

  // The Claude children of #602 ended with "Claude output stream failed" until the parent used
  // its budget; the parent's turn then ended without an answer.
  it.live(
    "fails the Attempt with InfraFailure when every child ends without a result and the parent's turn has no answer, then runs its retry",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const children = yield* StubChildren;
          const request = attemptRequest("run/step/20", 2);
          const recording = recordingSink();
          const execution = yield* Effect.forkChild(runtime.execute(request, recording.sink));

          yield* (yield* children.next).crash("Claude output stream failed");

          yield* (yield* children.next).crash("Claude output stream failed");
          const failure = yield* Fiber.join(execution).pipe(Effect.flip);
          assert(failure._tag === "InfraFailure");
          assert.strictEqual(
            failure.message,
            "The Pi parent's turn ended without an answer: model_error",
          );
          assertAdmitted(request.spec.attemptId, recording.outbound());
          const currentFinished = yield* runtime.finished(request.spec.attemptId);
          assert.deepStrictEqual(currentFinished, Option.some(ParentFailed.make({ failure })));

          const retry = yield* Effect.forkChild(
            runtime.execute(attemptRequest("run/step/21", 2), recordingSink().sink),
          );

          yield* (yield* children.next).reply("Child fixed the test.");

          assert.strictEqual((yield* Fiber.join(retry)).message, "Fixed the flaky test.");
        }).pipe(
          Effect.provide(
            layer({
              database,
              parent: [
                delegate("Fix the flaky test"),
                delegate("Fix the flaky test again"),
                fauxAssistantMessage([], {
                  stopReason: "error",
                  errorMessage: "Gateway forward closed",
                }),
                delegate("Fix the flaky test"),
                answer("Fixed the flaky test."),
              ],
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );
});

it.live(
  "preserves a Pi parent's provider overload as a capacity failure",
  () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const message = '529 {"error":{"type":"overloaded_error","message":"Overloaded"}}';
      const failure = yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        return yield* runtime
          .execute(attemptRequest("capacity/parent/1"), recordingSink().sink)
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          layer({
            database,
            parent: Array.from({ length: 4 }, () =>
              fauxAssistantMessage([], { stopReason: "error", errorMessage: message }),
            ),
          }),
        ),
      );
      assert.deepStrictEqual(failure, ProviderCapacityFailure.make({ message }));
    }).pipe(Effect.scoped),
  30_000,
);
