import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  AgentResultError,
  AgentRuntime,
  SessionOperationError,
  SessionResult,
} from "@usine/agents/runtime";
import { SessionFinished, SessionStarted, TextOutput } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Commit } from "@usine/core/step/result";
import { Deferred, Effect, Option, Path, Queue } from "effect";
import { makeCheckout } from "./support/git.ts";
import { command, controlledSession, spec, start } from "./support/session.ts";
import { startHost } from "./support/stdio.ts";

describe("run-host results", () => {
  it.effect("acknowledges Interrupt when the SDK immediately fails its result while stopping", () =>
    Effect.gen(function* () {
      const session = yield* controlledSession();
      const runtime = AgentRuntime.of({
        launch: (request) =>
          session.runtime.launch(request).pipe(
            Effect.map((running) => ({
              ...running,
              interrupt: Deferred.fail(
                session.result,
                new AgentResultError({
                  sessionId: Option.some(session.session.id),
                  message: "The SDK stopped its current turn.",
                }),
              ).pipe(Effect.asVoid),
            })),
          ),
      });
      const host = yield* startHost(runtime);
      yield* host.send(start());
      yield* host.next;
      yield* host.send(command(new AttemptChannel.Interrupt()));
      yield* host.result;
      expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started", "Interrupted"]);
      expect(yield* Deferred.isDone(session.released)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Path.layer)),
  );

  it.effect("emits Failed when the session result fails while its event stream is still open", () =>
    Effect.gen(function* () {
      const session = yield* controlledSession();
      const host = yield* startHost(session.runtime);
      yield* host.send(start());
      yield* host.next;
      yield* Deferred.fail(
        session.result,
        new AgentResultError({
          sessionId: Option.some(session.session.id),
          message: "The agent could not complete the task.",
        }),
      );
      yield* host.result;
      expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started", "Failed"]);
      const failed = host.frames.at(-1)?.payload;
      assert(failed?._tag === "Failed");
      expect(failed.failure._tag).toBe("AgentFailure");
      expect(failed.failure.message).toBe("The agent could not complete the task.");
      expect(yield* Deferred.isDone(session.released)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Path.layer)),
  );

  it.effect(
    "emits retryable Failed when the event stream fails while the session result is pending",
    () =>
      Effect.gen(function* () {
        const session = yield* controlledSession();
        const host = yield* startHost(session.runtime);
        yield* host.send(start());
        yield* host.next;
        yield* Queue.fail(
          session.events,
          new SessionOperationError({
            operation: "stream",
            sessionId: Option.some(session.session.id),
            message: "The SDK event stream disconnected.",
            cause: new Error("Connection closed"),
          }),
        );
        yield* host.result;
        expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started", "Failed"]);
        const failed = host.frames.at(-1)?.payload;
        assert(failed?._tag === "Failed");
        expect(failed.failure._tag).toBe("InfraFailure");
        expect(failed.failure.message).toBe("The SDK event stream disconnected.");
        expect(yield* Deferred.isDone(session.released)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(Path.layer)),
  );

  it.live(
    "reports a Git error instead of waiting for Interrupt when a new commit has no subject",
    () =>
      Effect.gen(function* () {
        const checkout = yield* makeCheckout();
        const session = yield* controlledSession();
        const host = yield* startHost(session.runtime, checkout.hostSpawner);
        yield* host.send(
          start(new AttemptChannel.RunSpec({ ...spec, baseCommit: checkout.baseCommit })),
        );
        yield* host.next;
        const sha = yield* checkout.commit("");
        yield* Queue.end(session.events);
        yield* Deferred.succeed(
          session.result,
          new SessionResult({ message: "Committed the change." }),
        );
        const error = yield* host.result.pipe(Effect.flip);
        assert(error._tag === "RunHostError");
        expect(error.stage).toBe("git");
        expect(error.message).toBe(`Commit ${sha} has no summary`);
        expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started"]);
        expect(yield* Deferred.isDone(session.released)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("drains session events before Final and excludes commits predating the Attempt", () =>
    Effect.gen(function* () {
      const checkout = yield* makeCheckout();
      const session = yield* controlledSession();
      const host = yield* startHost(session.runtime, checkout.hostSpawner);
      yield* host.send(
        start(new AttemptChannel.RunSpec({ ...spec, baseCommit: checkout.baseCommit })),
      );
      expect((yield* host.next).payload._tag).toBe("Started");
      // SDK result readiness alone does not mean all buffered activity was forwarded.
      yield* Deferred.succeed(session.result, new SessionResult({ message: "No changes needed." }));
      const events = [
        new SessionStarted({ session: session.session }),
        new TextOutput({ session: session.session, text: "Checked café rendering." }),
        new SessionFinished({ session: session.session }),
      ];
      yield* Queue.offerAll(session.events, events);
      yield* Queue.end(session.events);
      yield* host.result;

      expect(host.frames.map((frame) => frame.payload._tag)).toEqual([
        "Started",
        "SessionEvent",
        "SessionEvent",
        "SessionEvent",
        "Final",
      ]);
      expect(host.frames.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(host.frames.map((frame) => frame.attemptId)).toEqual(Array(5).fill(spec.attemptId));
      expect(host.frames.slice(1, 4).map((frame) => frame.payload)).toEqual(
        events.map((event) => new AttemptChannel.SessionEvent({ event })),
      );
      const final = host.frames.at(-1)?.payload;
      assert(final?._tag === "Final");
      expect(final.result.message).toBe("No changes needed.");
      expect(final.result.facts).toEqual([]);
      expect(yield* Deferred.isDone(session.released)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("harvests only new commits in oldest-first order with their full SHA and subject", () =>
    Effect.gen(function* () {
      const checkout = yield* makeCheckout();
      const session = yield* controlledSession();
      const host = yield* startHost(session.runtime, checkout.hostSpawner);
      yield* host.send(
        start(new AttemptChannel.RunSpec({ ...spec, baseCommit: checkout.baseCommit })),
      );
      yield* host.next;
      const first = yield* checkout.commit("Fix café rendering\n\nA body that is not the subject.");
      const second = yield* checkout.commit("Cover tabs | spaces and punctuation");
      yield* Queue.end(session.events);
      yield* Deferred.succeed(session.result, new SessionResult({ message: "Fixed and tested." }));
      yield* host.result;
      expect(host.frames.map((frame) => frame.payload._tag)).toEqual(["Started", "Final"]);
      const final = host.frames.at(-1)?.payload;
      assert(final?._tag === "Final");
      expect(final.result.message).toBe("Fixed and tested.");
      expect(final.result.facts).toEqual([
        new Commit({ sha: first, summary: "Fix café rendering" }),
        new Commit({ sha: second, summary: "Cover tabs | spaces and punctuation" }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
