import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { AgentSessionEvent } from "@usine/core/agent/session";
import { Release } from "@usine/core/attempt/channel";
import { childPidFile } from "../../src/child-host/child-host.ts";
import { Cause, Effect, Exit, FileSystem, Option, Queue, Ref, Schema, Scope, Stream } from "effect";
import { openFixture, providers, scenarios, recordingPid } from "./fixture.ts";
import { ChildProcessLost } from "../../src/child-host/process.ts";
import { ChildBackend, ChildRequest, ChildSessionLifecycle } from "../../src/runtime.ts";
import { Tape } from "./transcript.ts";
import { decodeWire, encodeWire } from "./process.ts";
import { Base64 } from "effect/encoding";
import { runScenario } from "./scenarios.ts";

describe("recorded harness transports", () => {
  for (const provider of providers)
    for (const scenario of scenarios) {
      it.live(
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

for (const state of ["working", "idle"] as const)
  it.live(
    `Claude resumes its ${state} session by reattaching one owned process`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* openFixture("claude", "transport-loss", "replay");
          const fs = yield* FileSystem.FileSystem;
          const scope = yield* Scope.make();
          const stopping = yield* Ref.make(false);
          const events = yield* Queue.unbounded<AgentSessionEvent>();
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
          }
          const pidFile = childPidFile(fixture.cwd, fixture.request.session.id);
          const pid = yield* fs.readFileString(pidFile);
          yield* Ref.set(stopping, true);
          yield* Scope.close(scope, Exit.void);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const resumed = yield* (yield* ChildBackend).launch(
                ChildRequest.make({
                  ...fixture.request,
                  held: true,
                  resume: started.harnessSession,
                  idle: state === "idle" ? Option.some("REPLAY_DONE") : Option.none(),
                }),
              );
              const currentPid = yield* fs.readFileString(pidFile);
              assert.strictEqual(currentPid, pid);
              if (state === "working") yield* fixture.controls.releaseCommand;
              yield* resumed.intervene(Release.make(), () => Effect.void);
              const result = yield* resumed.result;
              assert.include(result.message, "REPLAY_DONE");
            }).pipe(Effect.provide(fixture.backend)),
          );
          yield* fixture.save;
          assert.strictEqual(first.session.id, fixture.request.session.id);
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
    20_000,
  );
