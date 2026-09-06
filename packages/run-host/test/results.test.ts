import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { SessionResult } from "@usine/agents/runtime";
import { SessionFinished, SessionStarted, TextOutput } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Commit } from "@usine/core/step/result";
import { Deferred, Effect, Queue } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeCheckout } from "./support/git.ts";
import { controlledSession, spec, start } from "./support/session.ts";
import { startHost } from "./support/stdio.ts";

describe("run-host results", () => {
  it.live("drains session events before Final and excludes commits predating the Attempt", () =>
    Effect.gen(function* () {
      const checkout = yield* makeCheckout();
      const session = yield* controlledSession();
      const host = yield* startHost(session.runtime).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, checkout.hostSpawner),
      );
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
      const host = yield* startHost(session.runtime).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, checkout.hostSpawner),
      );
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
