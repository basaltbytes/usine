// Durable storage transactions use Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import {
  HarnessSession,
  HarnessSessionId,
  SessionStarted,
  TextOutput,
} from "@usine/core/agent/session";
import { jsonKey } from "@usine/core/json-key";
import { MachineId, WorkerName } from "@usine/core/worker";
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect";
import { AttemptRequest, AttemptRuntime } from "../src/attempt-runtime.ts";
import { AttemptRecordDoc } from "../src/attempt/documents.ts";
import { DurableHarness } from "../src/harness.ts";
import { answer, delegate, layer, StubChildren } from "../src/testing.ts";
import { assertAdmitted, attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

for (const recovery of [
  "resume",
  "resume-twice",
  "missing-session",
  "worker-gone",
  "machine-gone",
  "checkout-gone",
  "resume-fails",
] as const) {
  it.live(`recovers a durable child call after restart (${recovery})`, () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = attemptRequest(`recovery/${recovery}`, 1);
      const recording = recordingSink();
      const saved = HarnessSession.make({
        id: HarnessSessionId.make("saved-child"),
        cwd: request.cwd,
        home: Option.some("/workspace/usine/.usine/sessions"),
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
            }
            if (recovery !== "missing-session")
              yield* child.emit(
                SessionStarted.make({
                  session: child.request.session,
                  harnessSession: Option.some(saved),
                }),
              );
            yield* child.emit(TextOutput.make({ session: child.request.session, text }));
            yield* output.committed;
            yield* Fiber.interrupt(execution);
            return child.request;
          }),
        );
      const first = yield* stop([delegate("Continue the task")], "Half way there.");
      if (recovery === "resume-twice") {
        const second = yield* stop([], "Still working.");
        assert.strictEqual(second.session.id, first.session.id);
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(
            layer({ database, parent: [answer("Finished after restart.")] }),
          );
          const runtime = Context.get(services, AttemptRuntime);
          const attached =
            recovery === "worker-gone"
              ? AttemptRequest.make({ ...request, worker: WorkerName.make("replacement") })
              : recovery === "machine-gone"
                ? AttemptRequest.make({
                    ...request,
                    machine: Option.some(MachineId.make("replacement")),
                  })
                : recovery === "checkout-gone"
                  ? AttemptRequest.make({ ...request, cwd: "/replacement-checkout" })
                  : request;
          const execution = yield* Effect.forkChild(runtime.execute(attached, recording.sink));
          if (
            !["missing-session", "worker-gone", "machine-gone", "checkout-gone"].includes(recovery)
          ) {
            const child = yield* Context.get(services, StubChildren).next;
            assert.strictEqual(child.request.session.id, first.session.id);
            assert.deepStrictEqual(child.request.resume, Option.some(saved));
            assert.strictEqual(child.request.cwd, first.cwd);
            assert.strictEqual(child.request.worker, first.worker);
            assert.include(child.request.prompt, request.spec.task);
            if (recovery === "resume-fails") yield* child.crash("Saved session unavailable");
            else yield* child.reply("The child's final report.");
          }
          const report = yield* Fiber.join(execution);
          assert.strictEqual(report.message, "Finished after restart.");
          const children = yield* Context.get(services, DurableHarness).use(
            "read the child budget",
            async (opened, context) =>
              (await opened.snapshot(AttemptRecordDoc, request.spec.attemptId, context))?.children,
          );
          assert.strictEqual(children, 1, "recovery must not spend another child-session slot");
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
      assert.lengthOf(finished, 1);
      const result = finished[0];
      assert(result !== undefined);
      const succeeds = recovery === "resume" || recovery === "resume-twice";
      assert.strictEqual(result.isError, !succeeds);
      assert.include(
        jsonKey(result.output),
        succeeds ? "The child's final report." : "Half way there.",
      );
      if (!succeeds) assert.include(jsonKey(result.output), "interrupted");
      assertAdmitted(request.spec.attemptId, recording.outbound());
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  );
}
