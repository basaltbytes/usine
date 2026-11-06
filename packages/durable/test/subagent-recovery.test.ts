// Durable storage transactions use Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { childContinuation } from "@usine/agents/continuation";
import { Agent } from "@usine/core/agent";
import { BrainSpec, Harness } from "@usine/core/agent/brain";
import { ChildBackend, SessionOperationError } from "@usine/agents/runtime";
import {
  ChildSession,
  HarnessSession,
  HarnessSessionId,
  SessionStarted,
  SessionTokensUpdated,
  TokenCount,
  UsdAmount,
  TextOutput,
} from "@usine/core/agent/session";
import { jsonKey } from "@usine/core/json-key";
import { BlockedFailure, InfraFailure } from "@usine/core/attempt/failure";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { GatewayCredentialKind, MachineId, WorkerName } from "@usine/core/worker";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Option, Result } from "effect";
import { AttemptRequest, AttemptRuntime } from "../src/attempt-runtime.ts";
import { SubagentDoc } from "../src/attempt/child.ts";
import { AttemptRecordDoc, type Hold, HoldDoc } from "../src/attempt/documents.ts";
import { layer as runtimeLayer } from "../src/attempt/runtime.ts";
import { DurableHarness, durableError, layer as harnessLayer } from "../src/harness.ts";
import {
  answer,
  delegate,
  fauxParent,
  layer,
  stubChildBackendLayer,
  StubChildren,
} from "../src/testing.ts";
import { assertAdmitted, attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

const recoveries = [
  ["resume", null],
  ["resume-twice", null],
  ["resume-after-infra", { kind: "infra", child: 1 }],
  ["block-after-infra", { kind: "infra", child: 1 }],
  ["resume-with-other-infra", { kind: "infra", child: 2 }],
  ["resume-with-blocker", { kind: "blocked", child: 1 }],
  ["resume-fails-after-infra", { kind: "infra", child: 1 }],
  ["resume-crashes-then-replacement", { kind: "infra", child: 1 }],
  ["worker-gone-then-replacement", { kind: "infra", child: 1 }],
  ["credential-changed", null],
  ["harness-changed", null],
  ["harness-changed-stop-fails", null],
  ["invalid-session", null],
  ["extra-saved-fields", null],
  ["missing-session", null],
  ["worker-gone", null],
  ["machine-gone", null],
  ["checkout-gone", null],
  ["resume-fails", null],
  ["home-gone-fallback", null],
] as const;
for (const [recovery, blocker, harness] of recoveries.flatMap(([recovery, blocker]) =>
  (recovery === "resume-crashes-then-replacement" ? ["claude", "codex", "pi"] : ["claude"]).map(
    (harness) => [recovery, blocker, harness] as const,
  ),
)) {
  it.live(`recovers a durable child call after restart (${recovery}, ${harness})`, () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const fs = yield* FileSystem.FileSystem;
      const home =
        recovery === "home-gone-fallback" ? `${database}.home` : "/workspace/usine/.usine/sessions";
      if (recovery === "home-gone-fallback") {
        yield* fs.makeDirectory(home);
        yield* fs.writeFileString(`${home}/session.jsonl`, "saved-child\n");
      }
      const harnessChanged =
        recovery === "harness-changed" || recovery === "harness-changed-stop-fails";
      const replaces =
        recovery === "resume-crashes-then-replacement" ||
        recovery === "worker-gone-then-replacement" ||
        recovery === "home-gone-fallback";
      const failsRecovery = [
        "missing-session",
        "invalid-session",
        "harness-changed",
        "harness-changed-stop-fails",
        "worker-gone",
        "machine-gone",
        "checkout-gone",
        "resume-fails",
        "home-gone-fallback",
        "resume-fails-after-infra",
        "resume-crashes-then-replacement",
        "worker-gone-then-replacement",
      ].includes(recovery);
      const childCount = blocker?.child ?? 1;
      const base = attemptRequest(
        `recovery/${recovery}/${harness}`,
        childCount + (replaces ? 1 : 0),
      );
      const request = AttemptRequest.make({
        ...base,
        spec: AttemptChannel.RunSpec.make({
          ...base.spec,
          agent: Agent.make({
            ...base.spec.agent,
            brain: BrainSpec.make({ ...base.spec.agent.brain, harness: Harness.make(harness) }),
          }),
        }),
        gatewayCredential: Effect.succeedSome(GatewayCredentialKind.make("subscription")),
      });
      const recording = recordingSink();
      const saved = HarnessSession.make({
        id: HarnessSessionId.make("saved-child"),
        cwd: request.cwd,
        home: Option.some(home),
      });
      const checkpoint = (text: string) =>
        Effect.gen(function* () {
          const committed = yield* Deferred.make<void>();
          return {
            append: (
              direction: Parameters<typeof recording.sink.append>[0],
              envelope: Parameters<typeof recording.sink.append>[1],
            ) =>
              recording.sink
                .append(direction, envelope)
                .pipe(
                  Effect.andThen(
                    envelope._tag === "OutboundEnvelope" &&
                      envelope.payload._tag === "SessionEvent" &&
                      envelope.payload.event._tag === "TextOutput" &&
                      envelope.payload.event.text === text
                      ? Deferred.succeed(committed, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
            committed: Deferred.await(committed),
          };
        });
      const stop = (parent: ReadonlyArray<ReturnType<typeof delegate>>, text: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(layer({ database, parent }));
            const output = yield* checkpoint(text);
            const runtime = Context.get(services, AttemptRuntime);
            const execution = yield* Effect.forkChild(
              runtime.execute(request, { ...recording.sink, append: output.append }),
            );
            const child = yield* Context.get(services, StubChildren).next;
            if (parent.length === 0) {
              assert(Option.isSome(child.request.resume));
              assert.deepStrictEqual(child.request.resume.value, saved);
              assert.deepStrictEqual(
                child.request.usage,
                Option.some({
                  totalTokens: TokenCount.make(1000),
                  costUsd: Option.some(UsdAmount.make(0.25)),
                  processUsage: Option.some({
                    totalTokens: TokenCount.make(400),
                    costUsd: Option.some(UsdAmount.make(0.1)),
                  }),
                }),
              );
            }
            if (recovery !== "missing-session")
              yield* child.emit(
                SessionStarted.make({
                  session: ChildSession.make({
                    ...child.request.session,
                    pool: Option.some("claudePlan"),
                  }),
                  harnessSession: Option.some(saved),
                }),
              );
            yield* child.emit(
              SessionTokensUpdated.make({
                session: child.request.session,
                totalTokens: TokenCount.make(parent.length === 0 ? 1500 : 1000),
                costUsd: Option.some(UsdAmount.make(parent.length === 0 ? 0.375 : 0.25)),
                processUsage: Option.some({
                  totalTokens: TokenCount.make(parent.length === 0 ? 900 : 400),
                  costUsd: Option.some(UsdAmount.make(parent.length === 0 ? 0.225 : 0.1)),
                }),
              }),
            );
            yield* child.emit(TextOutput.make({ session: child.request.session, text }));
            yield* output.committed;
            if (failsRecovery) {
              for (const action of [
                AttemptChannel.OperatorMessage.make({ message: "Review this with me." }),
                AttemptChannel.Interrupt.make(),
              ])
                yield* runtime.intervene(
                  request.spec.attemptId,
                  AttemptChannel.Intervention.make({
                    operator: "PhilDL",
                    target: AttemptChannel.ChildTarget.make({
                      sessionId: child.request.session.id,
                    }),
                    action,
                  }),
                );
            }
            if (
              recovery === "invalid-session" ||
              recovery === "extra-saved-fields" ||
              harnessChanged ||
              recovery === "credential-changed"
            )
              yield* Context.get(services, DurableHarness).use(
                "restore saved data from a different version",
                (opened, context) =>
                  opened.commit(async (tx) => {
                    const tasks = await tx.scanTasks({ kind: "pi.tool" }, 100);
                    assert.lengthOf(tasks.items, 1);
                    const task = tasks.items[0];
                    assert(task !== undefined);
                    const record = await tx.doc(SubagentDoc, task.id);
                    assert(record.saved !== null);
                    if (recovery === "invalid-session")
                      Object.assign(record.saved.session.brain, { effort: "retired-effort" });
                    else if (harnessChanged)
                      Object.assign(record.saved.session.brain, { harness: "codex" });
                    else if (recovery === "credential-changed") {
                      assert.notProperty(record.saved.session, "gatewayCredential");
                      assert.notProperty(record.saved.session, "pool");
                      assert.notProperty(record.saved.session, "endpoint");
                    } else {
                      Object.assign(record.saved, { newerField: true });
                      Object.assign(record.saved.session, { newerField: true });
                    }
                  }, context),
              );
            if (blocker !== null)
              yield* Context.get(services, DurableHarness).use(
                "persist the child blocker before shutdown",
                (opened, context) =>
                  opened.commit(async (tx) => {
                    const record = await tx.doc(AttemptRecordDoc, request.spec.attemptId, null);
                    record.children = childCount;
                    record.childBlocker = {
                      sessionId: `${child.request.session.parentId}:child:${blocker.child}`,
                      message: "The pre-restart child blocker.",
                      kind: blocker.kind,
                    };
                  }, context),
              );
            yield* Fiber.interrupt(execution);
            return child.request;
          }),
        );
      const first = yield* stop([delegate("Continue the task")], "Half way there.");
      if (recovery === "home-gone-fallback") yield* fs.remove(home, { recursive: true });
      if (recovery === "resume-twice") {
        const second = yield* stop([], "Still working.");
        assert.strictEqual(second.session.id, first.session.id);
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const recoveryBackend = Layer.effectContext(
            Effect.gen(function* () {
              const services = yield* Effect.context<ChildBackend | StubChildren>();
              const backend = Context.get(services, ChildBackend);
              const shared = childContinuation({
                stop: backend.stop,
                open: (request) =>
                  Effect.gen(function* () {
                    const running = yield* backend.launch(request);
                    if (Option.isSome(request.resume)) yield* running.result;
                    return { running, active: false, recover: () => Effect.void };
                  }),
              });
              return Context.add(services, ChildBackend, {
                ...backend,
                launch: (request) =>
                  recovery === "home-gone-fallback" && Option.isSome(request.resume)
                    ? fs.readFileString(`${home}/session.jsonl`).pipe(
                        Effect.mapError((cause) =>
                          SessionOperationError.make({
                            operation: "launch",
                            sessionId: Option.some(request.session.id),
                            message: "Saved session unavailable after home removal",
                            cause,
                          }),
                        ),
                        Effect.andThen(backend.launch(request)),
                      )
                    : recovery === "resume-crashes-then-replacement"
                      ? shared.launch(request).pipe(
                          Effect.tapError((error) =>
                            Effect.sync(() => {
                              assert.strictEqual(error._tag, "SessionInterruptedError");
                            }),
                          ),
                        )
                      : backend.launch(request),
                stop: (request) =>
                  backend.stop(request).pipe(
                    Effect.andThen(
                      recovery === "harness-changed-stop-fails"
                        ? SessionOperationError.make({
                            operation: "interrupt",
                            sessionId: Option.some(request.session.id),
                            message: "SSH connection unavailable",
                            cause: "SSH connection unavailable",
                          })
                        : Effect.void,
                    ),
                  ),
              });
            }),
          ).pipe(Layer.provide(stubChildBackendLayer));
          const services = yield* Layer.build(
            runtimeLayer.pipe(
              Layer.provideMerge(
                harnessLayer({
                  ...fauxParent([
                    ...(replaces ? [delegate("Try again")] : []),
                    answer("Finished after restart."),
                  ]),
                  openStorage: Effect.tryPromise({
                    try: () => openNodeSqliteStorage(database),
                    catch: (cause) => durableError("open the durable storage", cause),
                  }),
                }),
              ),
              Layer.provideMerge(recoveryBackend),
            ),
          );
          const runtime = Context.get(services, AttemptRuntime);
          const attached =
            recovery === "worker-gone" || recovery === "worker-gone-then-replacement"
              ? AttemptRequest.make({ ...request, worker: WorkerName.make("replacement") })
              : recovery === "machine-gone"
                ? AttemptRequest.make({
                    ...request,
                    machine: Option.some(MachineId.make("replacement")),
                  })
                : recovery === "checkout-gone"
                  ? AttemptRequest.make({ ...request, cwd: "/replacement-checkout" })
                  : recovery === "credential-changed"
                    ? AttemptRequest.make({
                        ...request,
                        gatewayCredential: Effect.succeedSome(
                          GatewayCredentialKind.make("api-key"),
                        ),
                      })
                    : request;
          let supervisionAtFinish: Hold | undefined;
          const execution = yield* Effect.forkChild(
            runtime.execute(attached, {
              ...recording.sink,
              append: (direction, envelope) =>
                recording.sink.append(direction, envelope).pipe(
                  Effect.andThen(() => {
                    if (
                      !failsRecovery ||
                      envelope._tag !== "OutboundEnvelope" ||
                      envelope.payload._tag !== "SessionEvent" ||
                      envelope.payload.event._tag !== "SessionFinished" ||
                      envelope.payload.event.session.id !== first.session.id
                    )
                      return Effect.void;
                    return Context.get(services, DurableHarness)
                      .use("read interrupted child supervision", async (opened, context) => {
                        const record = await opened.snapshot(
                          AttemptRecordDoc,
                          request.spec.attemptId,
                          context,
                        );
                        assert(record?.taskId !== null && record?.taskId !== undefined);
                        supervisionAtFinish = await opened.snapshot(
                          HoldDoc,
                          record.taskId,
                          context,
                        );
                      })
                      .pipe(Effect.orDie);
                  }),
                ),
            }),
          );
          if (
            ![
              "missing-session",
              "invalid-session",
              "harness-changed",
              "harness-changed-stop-fails",
              "worker-gone",
              "worker-gone-then-replacement",
              "machine-gone",
              "checkout-gone",
              "home-gone-fallback",
            ].includes(recovery)
          ) {
            const child = yield* Context.get(services, StubChildren).next;
            assert.strictEqual(child.request.session.id, first.session.id);
            assert.deepStrictEqual(child.request.resume, Option.some(saved));
            assert.deepStrictEqual(
              child.request.usage,
              Option.some({
                totalTokens: TokenCount.make(recovery === "resume-twice" ? 1500 : 1000),
                costUsd: Option.some(UsdAmount.make(recovery === "resume-twice" ? 0.375 : 0.25)),
                processUsage: Option.some({
                  totalTokens: TokenCount.make(recovery === "resume-twice" ? 900 : 400),
                  costUsd: Option.some(UsdAmount.make(recovery === "resume-twice" ? 0.225 : 0.1)),
                }),
              }),
            );
            assert(Option.isNone(child.request.session.pool));
            assert.strictEqual(child.request.cwd, first.cwd);
            assert.strictEqual(child.request.worker, first.worker);
            assert.include(child.request.prompt, request.spec.task);
            assert.deepStrictEqual(
              child.request.session.gatewayCredential,
              Option.some(
                GatewayCredentialKind.make(
                  recovery === "credential-changed" ? "api-key" : "subscription",
                ),
              ),
            );
            if (
              recovery === "resume-fails" ||
              recovery === "resume-fails-after-infra" ||
              recovery === "resume-crashes-then-replacement"
            )
              yield* child.crash("Saved session unavailable");
            else if (recovery === "block-after-infra")
              yield* child.block("The child's new blocker.");
            else yield* child.reply("The child's final report.");
          }
          if (replaces) {
            const replacement = yield* Context.get(services, StubChildren).next;
            assert.notStrictEqual(replacement.request.session.id, first.session.id);
            assert(Option.isNone(replacement.request.resume));
            yield* replacement.reply("The replacement child's report.");
          }
          const report = yield* Fiber.join(execution).pipe(Effect.result);
          if (harnessChanged) {
            const stopped = yield* Context.get(services, StubChildren).stopped;
            assert.strictEqual(stopped.session.id, first.session.id);
            assert.strictEqual(stopped.session.brain.harness, "codex");
            assert.deepStrictEqual(stopped.resume, Option.some(saved));
            assert.strictEqual(stopped.cwd, request.cwd);
          }
          if (recovery === "resume-with-other-infra" || recovery === "resume-fails-after-infra") {
            assert(Result.isFailure(report));
            assert.deepStrictEqual(
              report.failure,
              InfraFailure.make({
                message: "The pre-restart child blocker.",
                cause: "The pre-restart child blocker.",
              }),
            );
          } else if (recovery === "resume-with-blocker" || recovery === "block-after-infra") {
            assert(Result.isFailure(report));
            assert.deepStrictEqual(
              report.failure,
              BlockedFailure.make({
                message:
                  recovery === "block-after-infra"
                    ? "The child's new blocker."
                    : "The pre-restart child blocker.",
              }),
            );
          } else {
            assert(Result.isSuccess(report));
            assert.strictEqual(report.success.message, "Finished after restart.");
          }
          if (failsRecovery) {
            assert.deepStrictEqual(supervisionAtFinish?.held ?? [], []);
            assert.deepStrictEqual(supervisionAtFinish?.pausedChildren ?? [], []);
            assert(
              recording
                .outbound()
                .some(
                  ({ payload }) =>
                    payload._tag === "SessionEvent" &&
                    payload.event._tag === "SessionFinished" &&
                    payload.event.session.id === first.session.id,
                ),
              "failed recovery must finish the child so its guard Hold ends",
            );
          }
          const children = yield* Context.get(services, DurableHarness).use(
            "read the child budget",
            async (opened, context) =>
              (await opened.snapshot(AttemptRecordDoc, request.spec.attemptId, context))?.children,
          );
          assert.strictEqual(
            children,
            childCount + (replaces ? 1 : 0),
            "recovery must not spend another child-session slot",
          );
        }),
      );
      const finished = recording
        .outbound()
        .flatMap(({ payload }) =>
          payload._tag === "SessionEvent" &&
          payload.event._tag === "ToolFinished" &&
          payload.event.session._tag === "ParentSession"
            ? [payload.event]
            : [],
        );
      assert.lengthOf(finished, replaces ? 2 : 1);
      if (replaces) {
        assert.strictEqual(finished[1]?.isError, false);
        assert.include(jsonKey(finished[1]?.output), "The replacement child's report.");
      }
      const result = finished[0];
      assert(result !== undefined);
      const succeeds =
        recovery === "credential-changed" ||
        recovery === "extra-saved-fields" ||
        recovery === "resume" ||
        recovery === "resume-twice" ||
        recovery === "resume-after-infra" ||
        recovery === "block-after-infra" ||
        recovery === "resume-with-other-infra" ||
        recovery === "resume-with-blocker";
      assert.strictEqual(result.isError, !succeeds);
      assert.include(
        jsonKey(result.output),
        recovery === "block-after-infra"
          ? "The child's new blocker."
          : succeeds
            ? "The child's final report."
            : "Half way there.",
      );
      if (!succeeds) assert.include(jsonKey(result.output), "interrupted");
      if (recovery === "harness-changed")
        assert.include(jsonKey(result.output), "harness mismatch (saved codex, current claude)");
      if (recovery === "harness-changed-stop-fails") {
        assert.include(jsonKey(result.output), "saved child may still be running");
        assert.include(jsonKey(result.output), "SSH connection unavailable");
      }
      if (recovery === "invalid-session")
        assert.include(jsonKey(result.output), "the saved conversation no longer decodes");
      assertAdmitted(request.spec.attemptId, recording.outbound());
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), Effect.timeout("20 seconds")),
  );
}
