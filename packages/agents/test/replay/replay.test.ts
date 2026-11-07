import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { AgentSessionEvent, HarnessSession } from "@usine/core/agent/session";
import { SessionTokensUpdated } from "@usine/core/agent/session";
import { Interrupt, OperatorMessageId, Release, Steer } from "@usine/core/attempt/channel";
import { childPidFile } from "../../src/child-host/child-host.ts";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { openFixture, providers, scenarios, recordingPid } from "./fixture.ts";
import { ChildProcessLost } from "../../src/child-host/process.ts";
import {
  ChildBackend,
  ChildRequest,
  ChildSessionJournal,
  ChildSessionLifecycle,
} from "../../src/runtime.ts";
import { Tape } from "./transcript.ts";
import { decodeWire, encodeWire } from "./process.ts";
import { Base64 } from "effect/encoding";
import { runScenario } from "./scenarios.ts";

const fileWithLines = (file: string, count: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (;;) {
      if (!(yield* fs.exists(file))) {
        yield* Effect.sleep("10 millis");
        continue;
      }
      const text = yield* fs.readFileString(file);
      const lines = text.trim().split("\n");
      if (lines.length >= count) return lines;
      yield* Effect.sleep("10 millis");
    }
  });

describe("recorded harness transports", () => {
  for (const provider of providers)
    for (const scenario of scenarios) {
      it.live.skipIf(
        process.platform !== "linux" && provider === "claude" && scenario === "transport-loss",
      )(
        `${provider}: ${scenario}`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const fixture = yield* openFixture(provider, scenario, "replay");
              yield* runScenario(scenario, fixture.request, fixture.controls).pipe(
                Effect.provide(fixture.backend),
                fixture.tape.guard,
              );
              yield* fixture.save;
            }),
          ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
        20_000,
      );
    }
});

for (const provider of providers) {
  it.live(
    `${provider}: early process exit preserves its code and stderr`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* openFixture(provider, "early-exit", "replay");
          const failure = yield* Effect.gen(function* () {
            return yield* (yield* ChildBackend).launch(fixture.request).pipe(Effect.flip);
          }).pipe(Effect.provide(fixture.backend));
          assert.strictEqual(failure._tag, "SessionOperationError");
          if (failure._tag !== "SessionOperationError") return;
          assert(Schema.is(ChildProcessLost)(failure.cause));
          assert.strictEqual(failure.cause.exitCode, 7);
          assert.include(failure.cause.stderrTail, "replayed early exit");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    10_000,
  );
}

it.live("rejects a changed outbound request through the real adapter", () =>
  Effect.gen(function* () {
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* openFixture("claude", "simple", "replay");
        yield* runScenario(
          "simple",
          ChildRequest.make({
            ...fixture.request,
            prompt: "This request differs from the recording.",
          }),
        ).pipe(Effect.provide(fixture.backend), fixture.tape.guard);
      }),
    ).pipe(Effect.exit);
    assert(Exit.isFailure(outcome));
    assert.include(Cause.pretty(outcome.cause), "outbound request differs");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("redacts credential values before JSON escaping", () => {
  const tape = new Tape("record");
  const credential = 'token"with\\escapes';
  tape.bind(credential, "$TOKEN");
  assert.deepStrictEqual(
    tape.normalize({ environment: { token: credential }, args: [credential] }),
    {
      environment: { token: "$TOKEN" },
      args: ["$TOKEN"],
    },
  );
});

it("rejects empty and malformed recorder PID files before signaling a process", () => {
  for (const invalid of ["", " ", "0", "-1", "-123", "123partial", "NaN", "1.5"])
    assert.throws(() => recordingPid(invalid));
  assert.strictEqual(recordingPid("123\n"), 123);
});

it.effect("preserves UTF-8 characters split across supervisor frames", () =>
  Effect.gen(function* () {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("a€𐍈z");
    for (const key of ["data", "stdout", "stderr"]) {
      for (let split = 1; split < bytes.length; split++) {
        for (const chunk of [bytes.slice(0, split), bytes.slice(split)]) {
          const frame = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            [key]: Base64.encode(chunk),
          });
          const decoded = yield* decodeWire(frame);
          const encoded = yield* encodeWire(decoded);
          assert.strictEqual(encoded, frame);
        }
      }
    }
    const tape = new Tape("record");
    tape.bind("secret", "$TOKEN");
    const partial = Uint8Array.from([...encoder.encode("secret"), 0xe2]);
    const frame = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      stdout: Base64.encode(partial),
    });
    const decoded = yield* decodeWire(frame);
    const redacted = yield* encodeWire(tape.normalize(decoded));
    const expected = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      stdout: Base64.encode(Uint8Array.from([...encoder.encode("$TOKEN"), 0xe2])),
    });
    assert.strictEqual(redacted, expected);
  }),
);

it.live(
  "reports outbound mismatches from background transports without waiting for a timeout",
  () =>
    Effect.gen(function* () {
      for (const provider of providers) {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const scenario = "simple";
            const fixture = yield* openFixture(provider, scenario, "replay");
            fixture.tape.bind(
              provider === "codex" ? "0.0.1" : "supportedModels",
              "$CHANGED_REQUEST",
            );
            yield* runScenario(scenario, fixture.request, fixture.controls).pipe(
              Effect.provide(fixture.backend),
              fixture.tape.guard,
            );
          }),
        ).pipe(Effect.timeout("10 seconds"), Effect.exit);
        assert(Exit.isFailure(outcome));
        const failure = Cause.pretty(outcome.cause);
        assert.include(failure, "outbound request differs at transcript entry");
        assert.include(failure, "$CHANGED_REQUEST");
        assert.notInclude(failure, "TimeoutError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  15_000,
);

it.live(
  "replays independent connections in either order and preserves order within a connection",
  () =>
    Effect.gen(function* () {
      const tape = new Tape({
        protocol: "claude-sdk",
        harnessVersion: "2.1.311",
        model: "recorded-model",
        scenario: "simple",
        environment: {},
        entries: [
          { type: "expect_outbound", port: "claude:1", payload: { method: "open" } },
          { type: "expect_outbound", port: "process:1", payload: { method: "spawn" } },
          { type: "emit_inbound", port: "claude:1/output", payload: "first output" },
          { type: "expect_outbound", port: "claude:1/input", payload: "guidance" },
          { type: "runtime_exit", port: "process:1/exit", code: 0, error: null },
          { type: "runtime_exit", port: "claude:1/output", code: 0, error: null },
        ],
      });
      tape.outbound("claude:1", { method: "open" });
      const output = yield* Effect.promise(() => tape.read("claude:1/output"));
      assert.deepStrictEqual(output, {
        type: "emit_inbound",
        port: "claude:1/output",
        payload: "first output",
      });
      tape.outbound("claude:1/input", "guidance");
      yield* Effect.promise(() => tape.read("claude:1/output"));
      tape.outbound("process:1", { method: "spawn" });
      yield* Effect.promise(() => tape.read("process:1/exit"));
      tape.assertComplete();

      assert(tape.source !== "record");
      const reordered = new Tape(tape.source);
      assert.throws(() => reordered.outbound("claude:1/input", "guidance"), /transcript entry 0/);
    }).pipe(Effect.timeout("2 seconds")),
);

for (const state of [
  "working",
  "idle",
  "idle-unread",
  "usage",
  "usage-after-recovery",
  "hook",
  "answered-hook",
  "buffered-result",
  "environment-changed",
  "fresh",
] as const)
  it.live.skipIf(process.platform !== "linux")(
    state === "fresh"
      ? "Claude replaces the old owner on a launch without a saved session"
      : state === "environment-changed"
        ? "Claude resumes its environment-changed session through a replacement owner"
        : `Claude resumes its ${state} session by reattaching one owned process`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* openFixture("claude", "transport-loss", "replay");
          const fs = yield* FileSystem.FileSystem;
          const scope = yield* Scope.make();
          const stopping = yield* Ref.make(false);
          const events = yield* Queue.unbounded<AgentSessionEvent>();
          let committedUsage = Option.none<SessionTokensUpdated>();
          const tracksUsage = state === "usage" || state === "usage-after-recovery";
          const idle = state === "idle" || state === "idle-unread";
          // Guidance that reached the retained process before the restart, without a receipt.
          const restored = {
            id: OperatorMessageId.make("6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b"),
            message: "Restored guidance",
          };
          if (tracksUsage) yield* fs.writeFileString(`${fixture.cwd}/cumulative-usage`, "ready");
          if (state === "buffered-result")
            yield* fs.writeFileString(`${fixture.cwd}/block-result`, "ready");
          const first = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({ ...fixture.request, held: true }),
            );
            yield* running.events.pipe(
              Stream.runForEach((event) => Queue.offer(events, event)),
              Effect.forkScoped,
            );
            return running;
          }).pipe(
            Effect.provide(fixture.backend),
            Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
            Scope.provide(scope),
          );
          const until = (tag: AgentSessionEvent["_tag"]) =>
            Effect.gen(function* () {
              for (;;) {
                const event = yield* Queue.take(events);
                if (event._tag === "SessionTokensUpdated") committedUsage = Option.some(event);
                if (event._tag === tag) return event;
              }
            });
          const started = yield* until("SessionStarted");
          assert(started._tag === "SessionStarted");
          yield* until("ToolStarted");
          if (idle || tracksUsage) {
            yield* fixture.controls.releaseCommand;
            yield* until("SessionIdle");
            if (state === "usage-after-recovery") {
              assert(Option.isSome(committedUsage));
              const beforeRecovery = committedUsage.value;
              const pidFile = childPidFile(fixture.cwd, fixture.request.session.id);
              const originalPid = yield* fs.readFileString(pidFile);
              yield* fs.utimes(`${pidFile}.transport/heartbeat`, 0, 0);
              const reset = yield* until("SessionTokensUpdated");
              assert(reset._tag === "SessionTokensUpdated");
              assert.strictEqual(reset.totalTokens, beforeRecovery.totalTokens);
              assert.deepStrictEqual(reset.costUsd, beforeRecovery.costUsd);
              assert(Option.isSome(reset.processUsage));
              assert.strictEqual(reset.processUsage.value.totalTokens, 0);
              assert.deepStrictEqual(reset.processUsage.value.costUsd, Option.none());
              const launches = yield* fileWithLines(`${fixture.cwd}/launches`, 2);
              assert.lengthOf(launches, 2);
              const replacementPid = yield* fs.readFileString(pidFile);
              assert.notStrictEqual(replacementPid, originalPid);
            }
            // SDK-only output arriving after the result must advance without another adapter event.
            yield* fs.writeFileString(`${fixture.cwd}/request-sdk-tail`, "ready");
            yield* fileWithLines(`${fixture.cwd}/sdk-tail-sent`, 1);
            yield* Effect.sleep("1100 millis");
          }
          if (state === "hook") {
            yield* first.intervene(Interrupt.make(), () => Effect.void);
            yield* fs.writeFileString(`${fixture.cwd}/request-hook`, "ready");
            while (!(yield* fs.exists(`${fixture.cwd}/hook-sent`)))
              yield* Effect.sleep("10 millis");
            yield* Effect.sleep("1100 millis");
          }
          if (state === "answered-hook") {
            yield* fs.writeFileString(`${fixture.cwd}/request-hook`, "ready");
            yield* fileWithLines(`${fixture.cwd}/hook-responses`, 1);
            yield* fs.writeFileString(`${fixture.cwd}/finish-tool`, "ready");
            yield* until("ToolFinished");
          }
          const pidFile = childPidFile(fixture.cwd, fixture.request.session.id);
          const pid = yield* fs.readFileString(pidFile);
          if (state === "buffered-result") {
            yield* fixture.controls.releaseCommand;
            while (!(yield* fs.exists(`${fixture.cwd}/result-buffered`)))
              yield* Effect.sleep("10 millis");
          }
          yield* Ref.set(stopping, true);
          if (state === "buffered-result") yield* fs.remove(`${fixture.cwd}/block-result`);
          yield* Scope.close(scope, Exit.void);
          const checkpointBefore = yield* fs.readFileString(`${pidFile}.transport/delivered`);
          assert.notStrictEqual(
            checkpointBefore,
            '{"offset":0,"skip":0}',
            "handled output is checkpointed before detach",
          );
          if (state !== "hook" && state !== "buffered-result") {
            const checkpoint = yield* Schema.decodeEffect(
              Schema.fromJsonString(Schema.Struct({ offset: Schema.Int, skip: Schema.Int })),
            )(checkpointBefore);
            const journal = yield* fs.stat(`${pidFile}.transport/output`);
            assert.deepStrictEqual(
              checkpoint,
              { offset: Number(journal.size), skip: 0 },
              "all handled output, including SDK-only frames, is checkpointed before detach",
            );
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const resumed = yield* (yield* ChildBackend).launch(
                ChildRequest.make({
                  ...fixture.request,
                  held: true,
                  resume: state === "fresh" ? Option.none() : started.harnessSession,
                  environment:
                    state === "environment-changed"
                      ? { ...fixture.request.environment, REPLAY_ENVIRONMENT: "changed" }
                      : fixture.request.environment,
                  paused: state === "hook",
                  idle: idle || tracksUsage ? Option.some("REPLAY_DONE") : Option.none(),
                  unread: state === "idle-unread" ? [restored] : [],
                  usage: tracksUsage ? committedUsage : Option.none(),
                }),
              );
              const currentPid = yield* fs.readFileString(pidFile);
              if (state === "environment-changed" || state === "fresh") {
                assert.notStrictEqual(currentPid, pid);
                const processes = yield* fileWithLines(`${fixture.cwd}/launches`, 2);
                assert.lengthOf(processes, 2);
              } else {
                assert.strictEqual(currentPid, pid);
                const checkpointAfter = yield* fs.readFileString(`${pidFile}.transport/delivered`);
                assert.notStrictEqual(
                  checkpointAfter,
                  '{"offset":0,"skip":0}',
                  "the first heartbeat preserves the resume checkpoint",
                );
              }
              if (state === "buffered-result") {
                yield* resumed.intervene(Release.make(), () => Effect.void);
                assert.include((yield* resumed.result).message, "REPLAY_DONE");
                return;
              }
              if (state === "hook") {
                const answered = yield* fs.exists(`${fixture.cwd}/hook-responses`);
                assert.isFalse(answered);
                yield* resumed.intervene(Release.make(), () => Effect.void);
                yield* resumed.intervene(
                  Steer.make({ message: "Continue after the paused hook" }),
                  () => Effect.void,
                );
                yield* fileWithLines(`${fixture.cwd}/hook-responses`, 1);
                yield* fixture.controls.releaseCommand;
                assert.include((yield* resumed.result).message, "REPLAY_DONE");
                return;
              }
              if (state === "answered-hook") {
                const replayed = yield* Queue.unbounded<AgentSessionEvent>();
                yield* resumed.events.pipe(
                  Stream.runForEach((event) => Queue.offer(replayed, event)),
                  Effect.forkScoped,
                );
                yield* fixture.controls.releaseCommand;
                for (;;) {
                  const event = yield* Queue.take(replayed);
                  assert.notStrictEqual(
                    event._tag,
                    "ToolFinished",
                    "the handled tool result is not replayed",
                  );
                  if (event._tag === "SessionIdle") break;
                }
                const responses = yield* fileWithLines(`${fixture.cwd}/hook-responses`, 1);
                assert.lengthOf(responses, 1);
                yield* resumed.intervene(Release.make(), () => Effect.void);
                assert.include((yield* resumed.result).message, "REPLAY_DONE");
                return;
              }
              // This message is a FIFO barrier after any input from the retained launch.
              const guidance = "Continue after reattachment";
              const resumedEvents = yield* Queue.unbounded<AgentSessionEvent>();
              if (tracksUsage) {
                yield* resumed.events.pipe(
                  Stream.runForEach((event) => Queue.offer(resumedEvents, event)),
                  Effect.forkScoped,
                );
                for (;;) {
                  if ((yield* Queue.take(resumedEvents))._tag === "SessionIdle") break;
                }
              }
              yield* resumed.intervene(Steer.make({ message: guidance }), () => Effect.void);
              const count = state === "fresh" ? 3 : 2;
              const inputs = yield* fileWithLines(`${fixture.cwd}/user-messages`, count);
              assert.lengthOf(inputs, count, "reattachment sends no task or continuation prompt");
              assert.include(inputs[0] ?? "", fixture.request.prompt);
              assert.include(inputs[count - 1] ?? "", guidance);
              if (!idle && !tracksUsage) yield* fixture.controls.releaseCommand;
              if (tracksUsage) {
                let latest = Option.none<SessionTokensUpdated>();
                for (;;) {
                  const event = yield* Queue.take(resumedEvents);
                  if (event._tag === "SessionTokensUpdated") latest = Option.some(event);
                  if (event._tag === "SessionIdle") break;
                }
                assert(Option.isSome(committedUsage));
                assert(Option.isSome(latest));
                assert.strictEqual(latest.value.totalTokens, committedUsage.value.totalTokens * 2);
                assert.deepStrictEqual(
                  latest.value.costUsd,
                  Option.map(committedUsage.value.costUsd, (cost) => cost * 2),
                );
              }
              yield* resumed.intervene(Release.make(), () => Effect.void);
              const result = yield* resumed.result;
              assert.include(result.message, "REPLAY_DONE");
            }).pipe(Effect.provide(fixture.backend)),
          );
          if (
            state !== "fresh" &&
            state !== "environment-changed" &&
            state !== "usage-after-recovery"
          )
            yield* fixture.save;
          if (state === "usage-after-recovery") {
            const launches = yield* fileWithLines(`${fixture.cwd}/launches`, 2);
            assert.lengthOf(launches, 2, "reattachment retains the recovered process");
            const retained = yield* fs.exists(pidFile);
            assert.isFalse(retained);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
    20_000,
  );

for (const checkpointState of ["caught-up", "pending-hook"] as const)
  it.live.skipIf(process.platform !== "linux")(
    checkpointState === "caught-up"
      ? "Claude restores serialized usage before interleaved retained message blocks recur"
      : "Claude keeps superseded usage while a pending hook holds back the detach checkpoint",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* openFixture("claude", "transport-loss", "replay");
          const fs = yield* FileSystem.FileSystem;
          const stopping = yield* Ref.make(false);
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const events = yield* Queue.unbounded<AgentSessionEvent>();
          const until = (tag: AgentSessionEvent["_tag"]) =>
            Effect.gen(function* () {
              for (;;) {
                const event = yield* Queue.take(events);
                if (event._tag === tag) return event;
              }
            });
          const first = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({ ...fixture.request, held: true }),
            );
            yield* running.events.pipe(
              Stream.runForEach((event) => Queue.offer(events, event)),
              Effect.forkScoped,
            );
            return running;
          }).pipe(
            Effect.provide(fixture.backend),
            Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
            Scope.provide(scope),
          );
          const started = yield* until("SessionStarted");
          assert(started._tag === "SessionStarted");
          yield* until("ToolStarted");
          if (checkpointState === "pending-hook") {
            yield* first.intervene(Interrupt.make(), () => Effect.void);
            yield* fs.writeFileString(`${fixture.cwd}/request-hook`, "ready");
            yield* fileWithLines(`${fixture.cwd}/hook-sent`, 1);
          }
          yield* fs.writeFileString(`${fixture.cwd}/request-usage-prefix`, "ready");
          // Save y's second block after old-x has been superseded by x.
          for (let i = 0; i < 3; i++) yield* until("SessionTokensUpdated");
          const saved = yield* until("SessionTokensUpdated");
          assert(saved._tag === "SessionTokensUpdated");
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SessionTokensUpdated))(
            saved,
          );
          const committed = yield* Schema.decodeEffect(Schema.fromJsonString(SessionTokensUpdated))(
            encoded,
          );
          assert(Option.isSome(committed.processUsage));
          assert.strictEqual(committed.processUsage.value.messages?.x, 1010);
          assert.strictEqual(committed.processUsage.value.messages?.y, 1010);
          if (checkpointState === "caught-up")
            assert.isUndefined(
              committed.processUsage.value.messages?.["old-x"],
              "the checkpoint discards superseded IDs while retaining active interleaved IDs",
            );
          const pidFile = childPidFile(fixture.cwd, fixture.request.session.id);
          const pid = yield* fs.readFileString(pidFile);
          yield* Ref.set(stopping, true);
          yield* Scope.close(scope, Exit.void);
          const delivered = yield* fs.readFileString(`${pidFile}.transport/delivered`);
          const checkpoint = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ offset: Schema.Int, skip: Schema.Int })),
          )(delivered);
          const journal = yield* fs.stat(`${pidFile}.transport/output`);
          if (checkpointState === "pending-hook") {
            assert.isBelow(checkpoint.offset, Number(journal.size));
            const answered = yield* fs.exists(`${fixture.cwd}/hook-responses`);
            assert.isFalse(answered);
          } else assert.deepStrictEqual(checkpoint, { offset: Number(journal.size), skip: 0 });
          const usageSchema = Schema.fromJsonString(ChildRequest.fields.usage);
          const serialized = yield* Schema.encodeEffect(usageSchema)(Option.some(committed));
          const restored = yield* Schema.decodeEffect(usageSchema)(serialized);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const resumed = yield* (yield* ChildBackend).launch(
                ChildRequest.make({
                  ...fixture.request,
                  held: true,
                  paused: checkpointState === "pending-hook",
                  resume: started.harnessSession,
                  usage: restored,
                }),
              );
              const retainedPid = yield* fs.readFileString(pidFile);
              assert.strictEqual(retainedPid, pid);
              yield* resumed.events.pipe(
                Stream.runForEach((event) => Queue.offer(events, event)),
                Effect.forkScoped,
              );
              if (checkpointState === "pending-hook") {
                for (let i = 0; i < 4; i++) {
                  const replayed = yield* until("SessionTokensUpdated");
                  assert(replayed._tag === "SessionTokensUpdated");
                  assert.strictEqual(replayed.totalTokens, committed.totalTokens);
                }
              }
              yield* fs.writeFileString(`${fixture.cwd}/request-usage-replay`, "ready");
              const repeated = yield* until("SessionTokensUpdated");
              assert(repeated._tag === "SessionTokensUpdated");
              assert.strictEqual(repeated.totalTokens, committed.totalTokens);
              const increased = yield* until("SessionTokensUpdated");
              assert(increased._tag === "SessionTokensUpdated");
              assert.strictEqual(increased.totalTokens, committed.totalTokens + 5);
              if (checkpointState === "pending-hook") {
                yield* resumed.intervene(
                  Steer.make({ message: "Continue after the pending hook replay" }),
                  () => Effect.void,
                );
                yield* fileWithLines(`${fixture.cwd}/hook-responses`, 1);
              }
              yield* fixture.controls.releaseCommand;
              yield* resumed.intervene(Release.make(), () => Effect.void);
              assert.include((yield* resumed.result).message, "REPLAY_DONE");
            }),
          ).pipe(Effect.provide(fixture.backend));
          yield* fixture.save;
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
    20_000,
  );

it.live.skipIf(process.platform !== "linux")(
  "Claude keeps a replaced process's usage after a stop during the replacement launch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* openFixture("claude", "transport-loss", "replay");
        const fs = yield* FileSystem.FileSystem;
        const stopping = yield* Ref.make(false);
        const events = yield* Queue.unbounded<AgentSessionEvent>();
        yield* fs.writeFileString(`${fixture.cwd}/cumulative-usage`, "ready");
        const scope = yield* Scope.make();
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            ChildRequest.make({ ...fixture.request, held: true }),
          );
          yield* running.events.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
        }).pipe(
          Effect.provide(fixture.backend),
          Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
          Scope.provide(scope),
        );
        let committed = Option.none<SessionTokensUpdated>();
        const until = (tag: AgentSessionEvent["_tag"]) =>
          Effect.gen(function* () {
            for (;;) {
              const event = yield* Queue.take(events);
              if (event._tag === "SessionTokensUpdated") committed = Option.some(event);
              if (event._tag === tag) return event;
            }
          });
        const started = yield* until("SessionStarted");
        assert(started._tag === "SessionStarted");
        yield* until("ToolStarted");
        yield* fixture.controls.releaseCommand;
        yield* until("SessionIdle");
        assert(Option.isSome(committed));
        const firstProcess = committed.value;
        // The replacement process waits for its launch handshake until the orchestrator stops.
        yield* fs.writeFileString(`${fixture.cwd}/hold-control`, "ready");
        const pidFile = childPidFile(fixture.cwd, fixture.request.session.id);
        const originalPid = yield* fs.readFileString(pidFile);
        yield* fs.utimes(`${pidFile}.transport/heartbeat`, 0, 0);
        yield* fileWithLines(`${fixture.cwd}/held-controls`, 1);
        const replacementPid = yield* fs.readFileString(pidFile);
        assert.notStrictEqual(replacementPid, originalPid);
        yield* Ref.set(stopping, true);
        yield* Scope.close(scope, Exit.void);
        for (const event of yield* Queue.clear(events))
          if (event._tag === "SessionTokensUpdated") committed = Option.some(event);
        yield* fs.remove(`${fixture.cwd}/hold-control`);

        yield* Effect.gen(function* () {
          const resumed = yield* (yield* ChildBackend).launch(
            ChildRequest.make({
              ...fixture.request,
              held: true,
              resume: started.harnessSession,
              idle: Option.some("REPLAY_DONE"),
              usage: committed,
            }),
          );
          const currentPid = yield* fs.readFileString(pidFile);
          assert.strictEqual(currentPid, replacementPid, "the replacement process is retained");
          const resumedEvents = yield* Queue.unbounded<AgentSessionEvent>();
          yield* resumed.events.pipe(
            Stream.runForEach((event) => Queue.offer(resumedEvents, event)),
            Effect.forkScoped,
          );
          for (;;) {
            if ((yield* Queue.take(resumedEvents))._tag === "SessionIdle") break;
          }
          yield* resumed.intervene(
            Steer.make({ message: "Continue after reattachment" }),
            () => Effect.void,
          );
          let latest = Option.none<SessionTokensUpdated>();
          for (;;) {
            const event = yield* Queue.take(resumedEvents);
            if (event._tag === "SessionTokensUpdated") latest = Option.some(event);
            if (event._tag === "SessionIdle") break;
          }
          assert(Option.isSome(latest));
          assert.strictEqual(
            latest.value.totalTokens,
            firstProcess.totalTokens * 2,
            "the session total includes the replaced process's usage",
          );
          assert.deepStrictEqual(
            latest.value.costUsd,
            Option.map(firstProcess.costUsd, (cost) => cost * 2),
          );
          yield* resumed.intervene(Release.make(), () => Effect.void);
          assert.include((yield* resumed.result).message, "REPLAY_DONE");
        }).pipe(Effect.provide(fixture.backend), Effect.scoped);
        const launches = yield* fileWithLines(`${fixture.cwd}/launches`, 2);
        assert.lengthOf(launches, 2, "reattachment retains the replacement process");
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
  20_000,
);

it.live.skipIf(process.platform !== "linux")(
  "Claude sends the task to a retained process that stopped before its prompt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* openFixture("claude", "transport-loss", "replay");
        const fs = yield* FileSystem.FileSystem;
        const stopping = yield* Ref.make(false);
        const references = yield* Ref.make<ReadonlyArray<HarnessSession>>([]);
        const prompted = yield* Ref.make(0);
        const journal = Layer.succeed(ChildSessionJournal)({
          started: (reference) => Ref.update(references, (saved) => [...saved, reference]),
          prompted: Ref.update(prompted, (count) => count + 1),
          continued: () => Effect.void,
          delivered: () => Effect.void,
        });
        yield* fs.writeFileString(`${fixture.cwd}/hold-control`, "ready");
        const scope = yield* Scope.make();
        yield* Effect.gen(function* () {
          yield* (yield* ChildBackend).launch(fixture.request);
        }).pipe(
          Effect.provide([fixture.backend, journal]),
          Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
          Effect.forkIn(scope),
        );
        yield* fileWithLines(`${fixture.cwd}/held-controls`, 1);
        const pidFile = childPidFile(fixture.cwd, fixture.request.session.id);
        const pid = yield* fs.readFileString(pidFile);
        const [reference] = yield* Ref.get(references);
        assert(reference !== undefined, "the reference is saved before the prompt");
        const receiptsBeforeStop = yield* Ref.get(prompted);
        assert.strictEqual(receiptsBeforeStop, 0);
        yield* Ref.set(stopping, true);
        yield* Scope.close(scope, Exit.void);
        const promptSent = yield* fs.exists(`${fixture.cwd}/user-messages`);
        assert.isFalse(promptSent);
        yield* fs.remove(`${fixture.cwd}/hold-control`);

        yield* Effect.gen(function* () {
          const resumed = yield* (yield* ChildBackend).launch(
            ChildRequest.make({
              ...fixture.request,
              resume: Option.some(reference),
              prompted: false,
            }),
          );
          const currentPid = yield* fs.readFileString(pidFile);
          assert.strictEqual(currentPid, pid);
          const inputs = yield* fileWithLines(`${fixture.cwd}/user-messages`, 1);
          assert.lengthOf(inputs, 1);
          assert.include(inputs[0] ?? "", fixture.request.prompt);
          yield* fixture.controls.releaseCommand;
          const result = yield* resumed.result;
          assert.include(result.message, "REPLAY_DONE");
          const receipts = yield* Ref.get(prompted);
          assert.strictEqual(receipts, 1);
          const launches = yield* fileWithLines(`${fixture.cwd}/launches`, 1);
          assert.lengthOf(launches, 1, "the retained process receives the task");
        }).pipe(Effect.provide([fixture.backend, journal]), Effect.scoped);
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
  20_000,
);

for (const outcome of [
  "completed",
  "second-exit",
  "second-exit-after-init",
  "second-exit-after-tool-start",
  "idle-handshake-exit",
  "idle",
  "paused",
  "paused-after-working-resume",
  "two-outages",
] as const)
  it.live.skipIf(process.platform !== "linux")(
    `Claude recovers after lease expiry: ${outcome}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* openFixture("claude", "transport-loss", "replay");
          const fs = yield* FileSystem.FileSystem;
          const recoveries = yield* Queue.unbounded<void>();
          const logger = Logger.make<unknown, void>(({ message }) => {
            if (Array.isArray(message) && message.includes("Resumed the Claude child's session"))
              Queue.offerUnsafe(recoveries, undefined);
          });
          yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...fixture.request,
                held: outcome === "idle" || outcome === "idle-handshake-exit",
              }),
            );
            const events = yield* Queue.unbounded<AgentSessionEvent>();
            yield* running.events.pipe(
              Stream.runForEach((event) => Queue.offer(events, event)),
              Effect.forkScoped,
            );
            let saved = Option.none<string>();
            for (;;) {
              const event = yield* Queue.take(events);
              if (event._tag === "SessionStarted")
                saved = Option.map(event.harnessSession, (session) => session.id);
              if (event._tag === "ToolStarted") break;
            }
            assert(Option.isSome(saved));
            const waitingForGuidance =
              outcome === "idle" ||
              outcome === "paused" ||
              outcome === "paused-after-working-resume";
            if (outcome === "idle" || outcome === "idle-handshake-exit") {
              yield* fixture.controls.releaseCommand;
              for (;;) {
                if ((yield* Queue.take(events))._tag === "SessionIdle") break;
              }
              yield* fs.remove(`${fixture.cwd}/release`);
            }
            if (outcome === "paused") yield* running.intervene(Interrupt.make(), () => Effect.void);
            const pidFile = childPidFile(fixture.cwd, fixture.request.session.id);
            const originalPid = yield* fs.readFileString(pidFile);
            // Simulate a heartbeat gap longer than the real two-minute lease.
            const exitsAgain =
              outcome.startsWith("second-exit") || outcome === "idle-handshake-exit";
            if (exitsAgain) yield* fs.writeFileString(`${fixture.cwd}/exit-resume`, outcome);
            yield* fs.utimes(`${pidFile}.transport/heartbeat`, 0, 0);
            const launches = yield* fileWithLines(`${fixture.cwd}/launch-arguments`, 2);
            assert.lengthOf(launches, 2);
            assert.include(launches[1] ?? "", `"--resume=${saved.value}"`);
            if (exitsAgain) {
              const failure = yield* running.result.pipe(Effect.flip);
              assert.strictEqual(
                failure._tag,
                outcome === "idle-handshake-exit"
                  ? "SessionInterruptedError"
                  : "ContinuationLimitError",
              );
              if (failure._tag === "SessionInterruptedError") {
                assert(Option.isSome(failure.cause));
                assert(Schema.is(ChildProcessLost)(failure.cause.value.cause));
              } else {
                const messages = yield* fileWithLines(`${fixture.cwd}/user-messages`, 4);
                assert.lengthOf(messages, 4, "the fourth continuation sends no input");
              }
              const processes = yield* fileWithLines(
                `${fixture.cwd}/launches`,
                outcome === "idle-handshake-exit" ? 2 : 5,
              );
              assert.lengthOf(processes, outcome === "idle-handshake-exit" ? 2 : 5);
              return;
            }
            const replacementPid = yield* fs.readFileString(pidFile);
            assert.notStrictEqual(replacementPid, originalPid);
            if (waitingForGuidance) {
              yield* Queue.take(recoveries);
              if (outcome === "paused-after-working-resume") {
                for (;;) {
                  if ((yield* Queue.take(events))._tag === "ToolStarted") break;
                }
                yield* running.intervene(Interrupt.make(), () => Effect.void);
              }
              yield* fs.utimes(`${pidFile}.transport/heartbeat`, 0, 0);
              const argumentsAfterRecovery = yield* fileWithLines(
                `${fixture.cwd}/launch-arguments`,
                3,
              );
              assert.lengthOf(argumentsAfterRecovery, 3);
              assert.include(argumentsAfterRecovery[2] ?? "", `"--resume=${saved.value}"`);
              const recoveredPid = yield* fs.readFileString(pidFile);
              assert.notStrictEqual(recoveredPid, replacementPid);
              const inputsBeforeGuidance = yield* fileWithLines(`${fixture.cwd}/user-messages`, 1);
              assert.lengthOf(
                inputsBeforeGuidance,
                outcome === "paused-after-working-resume" ? 2 : 1,
              );
              yield* Queue.take(recoveries);
              yield* running
                .intervene(
                  Steer.make({ message: "Continue after waiting for guidance" }),
                  () => Effect.void,
                )
                .pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }));
            }
            const inputCount = outcome === "paused-after-working-resume" ? 3 : 2;
            const inputs = yield* fileWithLines(`${fixture.cwd}/user-messages`, inputCount);
            assert.lengthOf(inputs, inputCount);
            assert.include(
              inputs[inputCount - 1] ?? "",
              waitingForGuidance ? "Continue after waiting for guidance" : "Check the checkout",
            );
            if (outcome === "two-outages") {
              for (;;) {
                if ((yield* Queue.take(events))._tag === "ToolStarted") break;
              }
              yield* fs.writeFileString(`${fixture.cwd}/finish-tool`, "ready");
              for (;;) {
                const event = yield* Queue.take(events);
                if (event._tag === "ToolFinished" && !event.isError) break;
              }
              yield* fs.utimes(`${pidFile}.transport/heartbeat`, 0, 0);
              const argumentsAfterRecovery = yield* fileWithLines(
                `${fixture.cwd}/launch-arguments`,
                3,
              );
              assert.lengthOf(argumentsAfterRecovery, 3);
              yield* fileWithLines(`${fixture.cwd}/user-messages`, 3);
              const recoveredPid = yield* fs.readFileString(pidFile);
              assert.notStrictEqual(recoveredPid, replacementPid);
            }
            yield* fixture.controls.releaseCommand;
            yield* running.intervene(Release.make(), () => Effect.void);
            assert.include((yield* running.result).message, "REPLAY_DONE");
          }).pipe(
            Effect.provide([fixture.backend, Logger.layer([logger], { mergeWithExisting: true })]),
            Effect.scoped,
          );
          const retained = yield* fs.exists(childPidFile(fixture.cwd, fixture.request.session.id));
          assert.isFalse(retained);
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
    20_000,
  );
