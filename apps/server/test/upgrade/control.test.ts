import {
  ReleaseVersion,
  type UpgradeChannel,
  type UpgradeMode,
  UpgradeRecord,
} from "@usine/core/upgrade";
import { UpgradeRequest } from "@usine/orchestrator/operator/http";
import { Deferred, Effect, Logger, Option, Ref, Schema } from "effect";
import { expect, it } from "vitest";
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

it("checks the selected channel and waits for all admitted attempts before installing", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const upgrades = yield* makeUpgrades({
          running: previous,
          settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: "automatic" }),
          platform: Option.some(f.platform),
          drain: () => Deferred.await(f.drained),
          resume: Effect.void,
        });
        yield* upgrades.check();
        expect(yield* Ref.get(f.requests)).toEqual(["next"]);
        expect((yield* upgrades.status).phase).toBe("waiting");
        expect(yield* Deferred.isDone(f.launched)).toBe(false);
        yield* Deferred.succeed(f.drained, undefined);
        expect(yield* Deferred.await(f.launched)).toBe(target);
      }),
    ),
  );
});

it("proposes without draining, and an immediate request bypasses the idle wait", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const upgrades = yield* makeUpgrades({
          running: previous,
          settings: Effect.succeed({ upgradeChannel: "latest", upgradeMode: "propose" }),
          platform: Option.some(f.platform),
          drain: () => Deferred.await(f.drained),
          resume: Effect.void,
        });
        yield* upgrades.check();
        expect((yield* upgrades.status).available).toBe(target);
        expect((yield* upgrades.status).phase).toBe("idle");
        yield* upgrades.request(new UpgradeRequest({ timing: "now", version: Option.none() }));
        expect(yield* Deferred.await(f.launched)).toBe(target);
        const duplicate = yield* upgrades
          .request(new UpgradeRequest({ timing: "idle", version: Option.none() }))
          .pipe(Effect.flip);
        expect(duplicate).toBeInstanceOf(UpgradeError);
      }),
    ),
  );
});

it("does not check when off, downgrade automatically, or retry a health-check rollback", async () => {
  await Effect.runPromise(
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
          platform: Option.some(f.platform),
          drain: () => Effect.void,
          resume: Effect.void,
        });
        yield* upgrades.check();
        expect(yield* Ref.get(f.requests)).toEqual([]);
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
        expect(yield* Deferred.isDone(f.launched)).toBe(false);
        const current = yield* makeUpgrades({
          running: "2.0.0",
          settings: Ref.get(settings),
          platform: Option.some(f.platform),
          drain: () => Effect.void,
          resume: Effect.void,
        });
        yield* current.check();
        expect((yield* current.status).available).toBeNull();
      }),
    ),
  );
});

it.each(["idle", "now"] as const)(
  "rejects a cached candidate from the previous channel for %s upgrades",
  async (timing) => {
    await Effect.runPromise(
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
            platform: Option.some({
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
            .request(new UpgradeRequest({ timing, version: Option.none() }))
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(UpgradeError);
          expect(yield* Deferred.isDone(f.launched)).toBe(false);
          const status = yield* upgrades.status;
          expect(status.channel).toBe("latest");
          expect(status.available).toBeNull();
          expect(status.phase).toBe("idle");

          yield* upgrades.check();
          expect((yield* upgrades.status).available).toBe(stable);
          yield* upgrades.request(new UpgradeRequest({ timing, version: Option.none() }));
          yield* Deferred.succeed(f.drained, undefined);
          expect(yield* Deferred.await(f.launched)).toBe(stable);
        }),
      ),
    );
  },
);

it("rejects an automatic candidate when the channel changes during its lookup", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const channel = yield* Ref.make<UpgradeChannel>("next");
        const upgrades = yield* makeUpgrades({
          running: previous,
          settings: Ref.get(channel).pipe(
            Effect.map((upgradeChannel) => ({ upgradeChannel, upgradeMode: "automatic" as const })),
          ),
          platform: Option.some({
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
        expect(yield* Deferred.isDone(f.launched)).toBe(false);
      }),
    ),
  );
});

it.each(["off", "propose"] as const)(
  "does not drain or install when automatic mode changes to %s during lookup",
  async (mode) => {
    await Effect.runPromise(
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
            platform: Option.some({
              ...f.platform,
              lookup: () => Ref.set(currentMode, mode).pipe(Effect.as(target)),
            }),
            drain: () => Ref.set(drainStarted, true),
            resume: Effect.void,
          });
          yield* upgrades.check();
          yield* Effect.yieldNow;
          const status = yield* upgrades.status;
          expect(status.mode).toBe(mode);
          expect(status.phase).toBe("idle");
          expect(status.available).toBe(mode === "off" ? null : target);
          expect(yield* Ref.get(drainStarted)).toBe(false);
          expect(yield* Deferred.isDone(f.launched)).toBe(false);
        }),
      ),
    );
  },
);

it("refuses a missing helper before closing admission", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const drainStarted = yield* Ref.make(false);
        const upgrades = yield* makeUpgrades({
          running: previous,
          settings: Effect.succeed({ upgradeChannel: "latest", upgradeMode: "propose" }),
          platform: Option.some({
            ...f.platform,
            preflight: Effect.fail(new UpgradeError({ message: "Missing helper unit" })),
          }),
          drain: () => Ref.set(drainStarted, true),
          resume: Effect.void,
        });
        const error = yield* upgrades
          .request(new UpgradeRequest({ timing: "idle", version: Option.some(target) }))
          .pipe(Effect.flip);
        expect(error.message).toBe("Missing helper unit");
        expect(yield* Ref.get(drainStarted)).toBe(false);
        expect((yield* upgrades.status).phase).toBe("idle");
      }),
    ),
  );
});

it("reports helper failure instead of waiting for a restart that will not happen", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const upgrades = yield* makeUpgrades({
          running: previous,
          settings: Effect.succeed({ upgradeChannel: "latest", upgradeMode: "propose" }),
          platform: Option.some(f.platform),
          drain: () => Effect.void,
          resume: Effect.void,
        });
        yield* upgrades.request(
          new UpgradeRequest({ timing: "idle", version: Option.some(target) }),
        );
        yield* Deferred.await(f.launched);
        yield* Ref.set(
          f.result,
          Option.some(
            UpgradeRecord.make({
              previous,
              target,
              status: "failed",
              reason: "Could not stop the service.",
            }),
          ),
        );
        const status = yield* upgrades.status;
        expect(status.phase).toBe("failed");
        expect(status.message).toContain("Restart the service");
      }),
    ),
  );
});

it.each(["propose", "automatic"] as const)(
  "waits for registry propagation in %s mode without closing admission",
  async (mode) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const ready = yield* Ref.make(false);
          const drainStarted = yield* Ref.make(false);
          const upgrades = yield* makeUpgrades({
            running: previous,
            settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: mode }),
            platform: Option.some({
              ...f.platform,
              checkDependencies: () =>
                Ref.get(ready).pipe(
                  Effect.flatMap((value) =>
                    value
                      ? Effect.void
                      : Effect.fail(new UpgradeError({ message: "Package unavailable" })),
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
              .request(new UpgradeRequest({ timing, version: Option.some(target) }))
              .pipe(Effect.flip);
            expect(error.message).toBe("Package unavailable");
            expect((yield* upgrades.status).phase).toBe("idle");
          }
          expect(yield* Ref.get(drainStarted)).toBe(false);
          expect(yield* Deferred.isDone(f.launched)).toBe(false);
          yield* Ref.set(ready, true);
          yield* upgrades.check();
          expect((yield* upgrades.status).available).toBe(target);
          if (mode === "automatic") {
            expect(yield* Deferred.await(f.launched)).toBe(target);
            expect(yield* Ref.get(drainStarted)).toBe(true);
          } else {
            yield* Ref.set(ready, false);
            yield* upgrades.check().pipe(Effect.flip);
            expect((yield* upgrades.status).available).toBe(target);
            expect(yield* Ref.get(drainStarted)).toBe(false);
          }
        }),
      ),
    );
  },
);

it("keeps the verified release and install outcome while a newer release is incomplete", async () => {
  await Effect.runPromise(
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
          platform: Option.some({
            ...f.platform,
            lookup: () => Ref.get(candidate),
            checkDependencies: (version) =>
              version === target
                ? Effect.void
                : Effect.gen(function* () {
                    yield* Deferred.succeed(checking, undefined);
                    yield* Deferred.await(finishCheck);
                    if (!(yield* Ref.get(ready)))
                      return yield* new UpgradeError({ message: reason });
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
        expect(yield* Deferred.await(logged)).toEqual([
          "Server upgrade check failed",
          { previous, reason },
        ]);
        const status = yield* upgrades.status;
        expect(status.available).toBe(target);
        expect(status.message).toBeNull();
        expect(status.outcome).toEqual(outcome);
        expect(status.phase).toBe("idle");
        expect(yield* Deferred.isDone(f.launched)).toBe(false);
        yield* Ref.set(ready, true);
        yield* upgrades.check();
        expect((yield* upgrades.status).available).toBe(next);
      }),
    ),
  );
});

it.each([
  ["install", { status: "rolled-back", reason: "Install failed", failureStage: "install" }],
  ["health-check", { status: "rolled-back", reason: "API failed", failureStage: "health-check" }],
  ["legacy", { status: "rolled-back", reason: "Upgrade failed" }],
  ["failed", { status: "failed", reason: "Rollback failed" }],
  ["installing", { status: "installing" }],
] as const)(
  "decides automatic retry after restart for a persisted %s outcome",
  async (outcome, persisted) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const record = Schema.decodeUnknownSync(UpgradeRecord)(
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
            platform: Option.some(f.platform),
            drain: () => Effect.void,
            resume: Effect.void,
          });
          yield* upgrades.check();
          if (outcome === "install") {
            expect(yield* Deferred.await(f.launched)).toBe(target);
          } else {
            expect(yield* Deferred.isDone(f.launched)).toBe(false);
          }
        }),
      ),
    );
  },
);

it("cancels a pending upgrade, resumes admission, and suppresses automatic re-request of that version", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const resumed = yield* Ref.make(false);
        const upgrades = yield* makeUpgrades({
          running: previous,
          settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: "automatic" }),
          platform: Option.some(f.platform),
          drain: () => Deferred.await(f.drained),
          resume: Ref.set(resumed, true),
        });
        yield* upgrades.check();
        const waiting = yield* upgrades.status;
        expect(waiting.target).toBe(target);
        expect(waiting.message).toContain("New attempts are deferred");
        yield* upgrades.cancel;
        expect(yield* Ref.get(resumed)).toBe(true);
        expect((yield* upgrades.status).phase).toBe("idle");
        yield* Deferred.succeed(f.drained, undefined);
        yield* upgrades.check();
        expect(yield* Deferred.isDone(f.launched)).toBe(false);
        yield* upgrades.request(
          new UpgradeRequest({ timing: "now", version: Option.some(target) }),
        );
        yield* Deferred.await(f.launched);
        const error = yield* upgrades.cancel.pipe(Effect.flip);
        expect(error.message).toContain("Only a waiting upgrade");
        expect((yield* upgrades.status).phase).toBe("installing");
      }),
    ),
  );
});
