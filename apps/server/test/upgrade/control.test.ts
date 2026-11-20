import { ChangeBus, changeBusLayer } from "@usine/core/changes";
import {
  ReleaseVersion,
  type UpgradeChannel,
  type UpgradeMode,
  UpgradeRecord,
} from "@usine/core/upgrade";
import { UpgradeRequest } from "@usine/orchestrator/operator/http";
import { Deferred, Effect, Logger, Option, Queue, Ref, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "@effect/vitest";
import { makeUpgrades, UpgradeError, type UpgradePlatform } from "../../src/upgrade/control.ts";

const previous = ReleaseVersion.make("1.0.0");
const target = ReleaseVersion.make("1.0.1-next.42.gabcdef0");

const fixture = Effect.gen(function* () {
  const drained = yield* Deferred.make<void>();
  const launched = yield* Deferred.make<ReleaseVersion>();
  const requests = yield* Ref.make<ReadonlyArray<string>>([]);
  const result = yield* Ref.make(Option.none<UpgradeRecord>());
  const platform: UpgradePlatform = {
    lookup: (channel) =>
      Ref.update(requests, (items) => [...items, channel]).pipe(Effect.as(target)),
    preflight: Effect.void,
    checkDependencies: () => Effect.void,
    launch: (version) => Deferred.succeed(launched, version).pipe(Effect.asVoid),
    outcome: Ref.get(result),
  };
  return { drained, launched, requests, result, platform };
});

it.live("rejects unavailable upgrades with the reason", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const message = "App upgrades require a global npm install managed by systemd.";
      const drained = yield* Ref.make(false);
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Effect.succeed({ upgradeChannel: "latest", upgradeMode: "automatic" }),
        platform: Result.fail(UpgradeError.make({ message })),
        drain: () => Ref.set(drained, true),
        resume: Effect.void,
      });
      yield* upgrades.check();
      for (const timing of ["idle", "now"] as const) {
        const error = yield* upgrades
          .request(UpgradeRequest.make({ timing, version: Option.some(target) }))
          .pipe(Effect.flip);
        expect(error.message).toBe(message);
      }
      expect((yield* upgrades.status).supported).toBe(false);
      expect((yield* upgrades.status).phase).toBe("idle");
      const drainedState = yield* Ref.get(drained);
      expect(drainedState).toBe(false);
    }),
  ),
);

it.live("checks the selected channel and waits for all admitted attempts before installing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* ChangeBus;
      const f = yield* fixture;
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: "automatic" }),
        platform: Result.succeed(f.platform),
        drain: () => Deferred.await(f.drained),
        resume: Effect.void,
      });
      yield* upgrades.check();
      const requestsState = yield* Ref.get(f.requests);
      expect(requestsState).toEqual(["next"]);

      expect((yield* upgrades.status).phase).toBe("waiting");
      const launchedDone = yield* Deferred.isDone(f.launched);
      expect(launchedDone).toBe(false);
      const journal = yield* bus.open;
      expect(journal.history).toHaveLength(2);
      expect(
        journal.history.every(
          ({ changes }) => changes.length === 1 && changes[0]?.target.kind === "configuration",
        ),
      ).toBe(true);
      yield* upgrades.check();

      expect((yield* bus.open).revision).toBe(journal.revision);
      yield* Deferred.succeed(f.drained, undefined);
      const launchedResult = yield* Deferred.await(f.launched);
      expect(launchedResult).toBe(target);

      expect((yield* bus.open).revision).toBe(journal.revision + 1);
    }),
  ).pipe(Effect.provide(changeBusLayer)),
);

it.live("proposes without draining, and an immediate request bypasses the idle wait", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Effect.succeed({ upgradeChannel: "latest", upgradeMode: "propose" }),
        platform: Result.succeed(f.platform),
        drain: () => Deferred.await(f.drained),
        resume: Effect.void,
      });
      yield* upgrades.check();

      expect((yield* upgrades.status).available).toBe(target);

      expect((yield* upgrades.status).phase).toBe("idle");
      yield* upgrades.request(UpgradeRequest.make({ timing: "now", version: Option.none() }));
      const launchedResult = yield* Deferred.await(f.launched);
      expect(launchedResult).toBe(target);
      const duplicate = yield* upgrades
        .request(UpgradeRequest.make({ timing: "idle", version: Option.none() }))
        .pipe(Effect.flip);
      expect(duplicate).toBeInstanceOf(UpgradeError);
    }),
  ),
);

it.live("does not check when off, downgrade automatically, or retry a health-check rollback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const settings = yield* Ref.make<{
        readonly upgradeChannel: "next";
        readonly upgradeMode: "off" | "automatic";
      }>({ upgradeChannel: "next", upgradeMode: "off" });
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Ref.get(settings),
        platform: Result.succeed(f.platform),
        drain: () => Effect.void,
        resume: Effect.void,
      });
      yield* upgrades.check();
      const requestsState = yield* Ref.get(f.requests);
      expect(requestsState).toEqual([]);
      yield* Ref.set(
        f.result,
        Option.some(
          UpgradeRecord.make({
            previous,
            target,
            status: "rolled-back",
            reason: "API did not answer",
            failureStage: "health-check",
          }),
        ),
      );
      yield* Ref.set(settings, { upgradeChannel: "next", upgradeMode: "automatic" } as const);
      yield* upgrades.check();

      expect((yield* upgrades.status).outcome?.status).toBe("rolled-back");
      const launchedDone = yield* Deferred.isDone(f.launched);
      expect(launchedDone).toBe(false);
      const current = yield* makeUpgrades({
        running: "2.0.0",
        settings: Ref.get(settings),
        platform: Result.succeed(f.platform),
        drain: () => Effect.void,
        resume: Effect.void,
      });
      yield* current.check();

      expect((yield* current.status).available).toBeNull();
    }),
  ),
);

it.live("rejects a cached candidate from the previous channel", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const channel = yield* Ref.make<UpgradeChannel>("next");
      const stable = ReleaseVersion.make("1.0.1");
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Ref.get(channel).pipe(
          Effect.map((upgradeChannel) => ({ upgradeChannel, upgradeMode: "propose" as const })),
        ),
        platform: Result.succeed({
          ...f.platform,
          lookup: (selected) => Effect.succeed(selected === "next" ? target : stable),
        }),
        drain: () => Deferred.await(f.drained),
        resume: Effect.void,
      });
      yield* upgrades.check();

      expect((yield* upgrades.status).available).toBe(target);
      yield* Ref.set(channel, "latest");
      const error = yield* upgrades
        .request(UpgradeRequest.make({ timing: "idle", version: Option.none() }))
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(UpgradeError);
      const launchedDone = yield* Deferred.isDone(f.launched);
      expect(launchedDone).toBe(false);
      const status = yield* upgrades.status;
      expect(status.channel).toBe("latest");
      expect(status.available).toBeNull();
      expect(status.phase).toBe("idle");

      yield* upgrades.check();

      expect((yield* upgrades.status).available).toBe(stable);
      yield* upgrades.request(UpgradeRequest.make({ timing: "idle", version: Option.none() }));
      yield* Deferred.succeed(f.drained, undefined);
      const launchedResult = yield* Deferred.await(f.launched);
      expect(launchedResult).toBe(stable);
    }),
  ),
);

it.live("rejects an automatic candidate when the channel changes during its lookup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const channel = yield* Ref.make<UpgradeChannel>("next");
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Ref.get(channel).pipe(
          Effect.map((upgradeChannel) => ({
            upgradeChannel,
            upgradeMode: "automatic" as const,
          })),
        ),
        platform: Result.succeed({
          ...f.platform,
          lookup: () => Ref.set(channel, "latest").pipe(Effect.as(target)),
        }),
        drain: () => Effect.void,
        resume: Effect.void,
      });
      const error = yield* upgrades.check().pipe(Effect.flip);
      expect(error).toBeInstanceOf(UpgradeError);
      const status = yield* upgrades.status;
      expect(status.channel).toBe("latest");
      expect(status.available).toBeNull();
      expect(status.phase).toBe("idle");
      const launchedDone = yield* Deferred.isDone(f.launched);
      expect(launchedDone).toBe(false);
    }),
  ),
);

it.live("does not drain or install when automatic mode changes to propose during lookup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const currentMode = yield* Ref.make<UpgradeMode>("automatic");
      const drainStarted = yield* Ref.make(false);
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Ref.get(currentMode).pipe(
          Effect.map((upgradeMode) => ({ upgradeChannel: "next" as const, upgradeMode })),
        ),
        platform: Result.succeed({
          ...f.platform,
          lookup: () => Ref.set(currentMode, "propose").pipe(Effect.as(target)),
        }),
        drain: () => Ref.set(drainStarted, true),
        resume: Effect.void,
      });
      yield* upgrades.check();
      yield* Effect.yieldNow;
      const status = yield* upgrades.status;
      expect(status.mode).toBe("propose");
      expect(status.phase).toBe("idle");
      expect(status.available).toBe(target);
      const drainStartedState = yield* Ref.get(drainStarted);
      expect(drainStartedState).toBe(false);
      const launchedDone = yield* Deferred.isDone(f.launched);
      expect(launchedDone).toBe(false);
    }),
  ),
);

it.live("refuses a missing helper before closing admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const drainStarted = yield* Ref.make(false);
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Effect.succeed({ upgradeChannel: "latest", upgradeMode: "propose" }),
        platform: Result.succeed({
          ...f.platform,
          preflight: Effect.fail(UpgradeError.make({ message: "Missing helper unit" })),
        }),
        drain: () => Ref.set(drainStarted, true),
        resume: Effect.void,
      });
      const error = yield* upgrades
        .request(UpgradeRequest.make({ timing: "idle", version: Option.some(target) }))
        .pipe(Effect.flip);
      expect(error.message).toBe("Missing helper unit");
      const drainStartedState = yield* Ref.get(drainStarted);
      expect(drainStartedState).toBe(false);

      expect((yield* upgrades.status).phase).toBe("idle");
    }),
  ),
);

it.effect("resumes admission when the helper fails while the server runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const launches = yield* Queue.unbounded<ReleaseVersion>();
      const candidate = yield* Ref.make(target);
      const resumed = yield* Ref.make(false);
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: "automatic" }),
        platform: Result.succeed({
          ...f.platform,
          lookup: () => Ref.get(candidate),
          launch: (version) => Queue.offer(launches, version).pipe(Effect.asVoid),
        }),
        drain: () => Effect.void,
        resume: Ref.set(resumed, true),
      });
      yield* upgrades.check();
      const launched = yield* Queue.take(launches);
      expect(launched).toBe(target);
      const failed = UpgradeRecord.make({
        previous,
        target,
        status: "failed",
        reason:
          "Could not download the target version; the server and packages were not changed. Check the upgrade service output.",
      });
      yield* Ref.set(f.result, Option.some(failed));
      yield* TestClock.adjust("5 seconds");

      const resumedState = yield* Ref.get(resumed);
      expect(resumedState).toBe(true);
      const status = yield* upgrades.status;
      expect(status.phase).toBe("idle");
      expect(status.message).toBeNull();
      expect(status.outcome).toEqual(failed);
      yield* upgrades.check();
      expect((yield* upgrades.status).phase).toBe("idle");
      const next = ReleaseVersion.make("1.0.1-next.43.gabcdef1");
      yield* Ref.set(candidate, next);
      yield* upgrades.check();
      const launchedNext = yield* Queue.take(launches);
      expect(launchedNext).toBe(next);
    }),
  ),
);

it.live("waits for registry propagation in automatic mode without closing admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const ready = yield* Ref.make(false);
      const drainStarted = yield* Ref.make(false);
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: "automatic" }),
        platform: Result.succeed({
          ...f.platform,
          checkDependencies: () =>
            Ref.get(ready).pipe(
              Effect.flatMap((value) =>
                value
                  ? Effect.void
                  : Effect.fail(UpgradeError.make({ message: "Package unavailable" })),
              ),
            ),
        }),
        drain: () => Ref.set(drainStarted, true),
        resume: Effect.void,
      });
      yield* upgrades.check().pipe(Effect.flip);

      expect((yield* upgrades.status).available).toBeNull();
      for (const timing of ["idle", "now"] as const) {
        const error = yield* upgrades
          .request(UpgradeRequest.make({ timing, version: Option.some(target) }))
          .pipe(Effect.flip);
        expect(error.message).toBe("Package unavailable");

        expect((yield* upgrades.status).phase).toBe("idle");
      }
      const drainStartedState = yield* Ref.get(drainStarted);
      expect(drainStartedState).toBe(false);
      const launchedDone = yield* Deferred.isDone(f.launched);
      expect(launchedDone).toBe(false);
      yield* Ref.set(ready, true);
      yield* upgrades.check();

      expect((yield* upgrades.status).available).toBe(target);
      const launchedResult = yield* Deferred.await(f.launched);
      expect(launchedResult).toBe(target);
      const currentDrainStartedState = yield* Ref.get(drainStarted);
      expect(currentDrainStartedState).toBe(true);
    }),
  ),
);

it.live("keeps the verified release and install outcome while a newer release is incomplete", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const next = ReleaseVersion.make("1.0.1-next.43.gabcdef1");
      const candidate = yield* Ref.make(target);
      const ready = yield* Ref.make(false);
      const checking = yield* Deferred.make<void>();
      const finishCheck = yield* Deferred.make<void>();
      const logged = yield* Deferred.make<ReadonlyArray<unknown>>();
      const reason = "Waiting for @usine/executor on the registry: E404";
      const outcome = UpgradeRecord.make({
        previous,
        target,
        status: "rolled-back",
        failureStage: "install",
        reason: "Install failed",
      });
      yield* Ref.set(f.result, Option.some(outcome));
      const upgrades = yield* makeUpgrades({
        running: previous,
        settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: "propose" }),
        platform: Result.succeed({
          ...f.platform,
          lookup: () => Ref.get(candidate),
          checkDependencies: (version) =>
            version === target
              ? Effect.void
              : Effect.gen(function* () {
                  yield* Deferred.succeed(checking, undefined);
                  yield* Deferred.await(finishCheck);
                  if (!(yield* Ref.get(ready)))
                    return yield* UpgradeError.make({ message: reason });
                }),
        }),
        drain: () => Deferred.await(f.drained),
        resume: Effect.void,
      });
      yield* upgrades.check();
      yield* Ref.set(candidate, next);
      const logger = Logger.make<unknown, void>(({ message }) => {
        if (Array.isArray(message) && message[0] === "Server upgrade check failed") {
          Deferred.doneUnsafe(logged, Effect.succeed(message));
        }
      });
      yield* upgrades.polling.pipe(Effect.withLogger(logger), Effect.forkScoped);
      yield* Deferred.await(checking);

      expect((yield* upgrades.status).available).toBe(target);
      yield* Deferred.succeed(finishCheck, undefined);
      const loggedMessagesResult = yield* Deferred.await(logged);
      expect(loggedMessagesResult).toEqual(["Server upgrade check failed", { previous, reason }]);
      const status = yield* upgrades.status;
      expect(status.available).toBe(target);
      expect(status.message).toBeNull();
      expect(status.outcome).toEqual(outcome);
      expect(status.phase).toBe("idle");
      const launchedDone = yield* Deferred.isDone(f.launched);
      expect(launchedDone).toBe(false);
      yield* Ref.set(ready, true);
      yield* upgrades.check();

      expect((yield* upgrades.status).available).toBe(next);
    }),
  ),
);

it.live.each([
  ["install", { status: "rolled-back", reason: "Install failed", failureStage: "install" }],
  ["legacy", { status: "rolled-back", reason: "Upgrade failed" }],
  ["failed", { status: "failed", reason: "Rollback failed" }],
  ["installing", { status: "installing" }],
] as const)(
  "decides automatic retry after restart for a persisted %s outcome",
  ([outcome, persisted]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const record = yield* Schema.decodeEffect(UpgradeRecord)(
          { previous, target, ...persisted },
          { onExcessProperty: "error" },
        );
        if (outcome === "legacy") {
          expect(record.status === "rolled-back" && record.failureStage).toBe("unknown");
        }
        yield* Ref.set(f.result, Option.some(record));
        const upgrades = yield* makeUpgrades({
          running: previous,
          settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: "automatic" }),
          platform: Result.succeed(f.platform),
          drain: () => Effect.void,
          resume: Effect.void,
        });
        yield* upgrades.check();
        if (outcome === "install") {
          const launchedResult = yield* Deferred.await(f.launched);
          expect(launchedResult).toBe(target);
        } else {
          const launchedDone = yield* Deferred.isDone(f.launched);
          expect(launchedDone).toBe(false);
        }
      }),
    ),
);

it.live(
  "cancels a pending upgrade, resumes admission, and suppresses automatic re-request of that version",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const resumed = yield* Ref.make(false);
        const upgrades = yield* makeUpgrades({
          running: previous,
          settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: "automatic" }),
          platform: Result.succeed(f.platform),
          drain: () => Deferred.await(f.drained),
          resume: Ref.set(resumed, true),
        });
        yield* upgrades.check();
        const waiting = yield* upgrades.status;
        expect(waiting.target).toBe(target);
        expect(waiting.message).toContain("New attempts are deferred");
        yield* upgrades.cancel;
        const resumedState = yield* Ref.get(resumed);
        expect(resumedState).toBe(true);

        expect((yield* upgrades.status).phase).toBe("idle");
        yield* Deferred.succeed(f.drained, undefined);
        yield* upgrades.check();
        const launchedDone = yield* Deferred.isDone(f.launched);
        expect(launchedDone).toBe(false);
        yield* upgrades.request(
          UpgradeRequest.make({ timing: "now", version: Option.some(target) }),
        );
        yield* Deferred.await(f.launched);
        const error = yield* upgrades.cancel.pipe(Effect.flip);
        expect(error.message).toContain("Only a waiting upgrade");

        expect((yield* upgrades.status).phase).toBe("installing");
      }),
    ),
);
