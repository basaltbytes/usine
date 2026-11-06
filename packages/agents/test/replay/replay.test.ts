import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { AgentSessionEvent } from "@usine/core/agent/session";
import { Interrupt, Release, Steer } from "@usine/core/attempt/channel";
import { childPidFile } from "../../src/child-host/child-host.ts";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
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
import { ChildBackend, ChildRequest, ChildSessionLifecycle } from "../../src/runtime.ts";
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
          ).pipe(Effect.provide(NodeServices.layer)),
        180_000,
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
  "hook",
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
                if (event._tag === tag) return event;
              }
            });
          const started = yield* until("SessionStarted");
          assert(started._tag === "SessionStarted");
          yield* until("ToolStarted");
          if (state === "idle") {
            yield* fixture.controls.releaseCommand;
            yield* until("SessionIdle");
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
                  idle: state === "idle" ? Option.some("REPLAY_DONE") : Option.none(),
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
              // This message is a FIFO barrier after any input from the retained launch.
              const guidance = "Continue after reattachment";
              yield* resumed.steer(guidance);
              const count = state === "environment-changed" || state === "fresh" ? 3 : 2;
              const inputs = yield* fileWithLines(`${fixture.cwd}/user-messages`, count);
              assert.lengthOf(inputs, count, "reattachment sends no task or continuation prompt");
              assert.include(inputs[0] ?? "", fixture.request.prompt);
              assert.include(inputs[count - 1] ?? "", guidance);
              if (state !== "idle") yield* fixture.controls.releaseCommand;
              yield* resumed.intervene(Release.make(), () => Effect.void);
              const result = yield* resumed.result;
              assert.include(result.message, "REPLAY_DONE");
            }).pipe(Effect.provide(fixture.backend)),
          );
          if (state !== "fresh" && state !== "environment-changed") yield* fixture.save;
          assert.strictEqual(first.session.id, fixture.request.session.id);
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
    20_000,
  );

for (const outcome of ["completed", "second-exit", "idle", "two-outages"] as const)
  it.live.skipIf(process.platform !== "linux")(
    `Claude recovers after lease expiry: ${outcome}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* openFixture("claude", "transport-loss", "replay");
          const fs = yield* FileSystem.FileSystem;
          yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({ ...fixture.request, held: true }),
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
            if (outcome === "idle") {
              yield* fixture.controls.releaseCommand;
              for (;;) {
                if ((yield* Queue.take(events))._tag === "SessionIdle") break;
              }
            }
            const pidFile = childPidFile(fixture.cwd, fixture.request.session.id);
            const originalPid = yield* fs.readFileString(pidFile);
            // Simulate a heartbeat gap longer than the real two-minute lease.
            if (outcome === "second-exit")
              yield* fs.writeFileString(`${fixture.cwd}/exit-resume`, "ready");
            yield* fs.utimes(`${pidFile}.transport/heartbeat`, 0, 0);
            const launches = yield* fileWithLines(`${fixture.cwd}/launch-arguments`, 2);
            assert.lengthOf(launches, 2);
            assert.include(launches[1] ?? "", `"--resume=${saved.value}"`);
            if (outcome === "second-exit") {
              const failure = yield* running.result.pipe(Effect.flip);
              assert.strictEqual(failure._tag, "SessionOperationError");
              if (failure._tag === "SessionOperationError")
                assert(Schema.is(ChildProcessLost)(failure.cause));
              const processes = yield* fileWithLines(`${fixture.cwd}/launches`, 2);
              assert.lengthOf(processes, 2);
              return;
            }
            const replacementPid = yield* fs.readFileString(pidFile);
            assert.notStrictEqual(replacementPid, originalPid);
            if (outcome === "idle") {
              // A deliberate steer proves the idle replacement has consumed all earlier input.
              yield* running
                .steer("Continue after idle recovery")
                .pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }));
            }
            const inputs = yield* fileWithLines(`${fixture.cwd}/user-messages`, 2);
            assert.lengthOf(inputs, 2);
            assert.include(
              inputs[1] ?? "",
              outcome === "idle" ? "Continue after idle recovery" : "check the worktree",
            );
            if (outcome === "two-outages") {
              for (;;) {
                if ((yield* Queue.take(events))._tag === "ToolStarted") break;
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
            assert.strictEqual(running.session.id, fixture.request.session.id);
          }).pipe(Effect.provide(fixture.backend), Effect.scoped);
          const retained = yield* fs.exists(childPidFile(fixture.cwd, fixture.request.session.id));
          assert.isFalse(retained);
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
    20_000,
  );
