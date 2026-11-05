import { harnessesLive } from "@usine/agents/harness/node";
import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import { SshDestination, WorkerRoot } from "@usine/core/worker";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { type StubParent, StubStorage, stubAttemptRuntime } from "@usine/durable/testing";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { CheckoutRequest, Executor, hostLoginLockLayer } from "../../src/executor.ts";
import { keptCheckoutRecovery } from "../../src/provision.ts";
import { layer as sshLayer, SshWorkers, type SshWorkerAddress } from "../../src/ssh/ssh.ts";
import {
  ADDRESS,
  COMMIT_AUTHOR,
  DESTINATION,
  INSTANCE,
  INSTANCE_ID,
  WORKER,
  WORKTREE,
  aloneOnItem,
  fakeMachine,
  mintingProvider,
  noGateway,
  request,
} from "./support.ts";

for (const transition of ["unchanged", "live", "restart"] as const) {
  for (const operation of ["reattach", "recover"] as const) {
    for (const parentStatus of ["live", "unreadable"] as const) {
      it.effect(
        `uses the retained fixed SSH host for ${operation} with a ${parentStatus} parent and ${transition} connection`,
        () => {
          const original = fakeMachine();
          const replacement = fakeMachine();
          const credentials = mintingProvider();
          const storage = new StubStorage();
          const records = new Map<AttemptId, SshWorkerAddress>();
          const revised: SshWorkerAddress = {
            ...ADDRESS,
            root: WorkerRoot.make("/srv/new"),
            machine: { _tag: "Fixed", destination: SshDestination.make("new-host") },
          };
          const destination = transition === "unchanged" ? DESTINATION : "new-host";
          const remoteHosts = Layer.effect(
            ChildProcessSpawner.ChildProcessSpawner,
            Effect.gen(function* () {
              const before = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
                Effect.provide(original.layer),
              );
              const after = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
                Effect.provide(replacement.layer),
              );
              return ChildProcessSpawner.make((command) => {
                assert(command._tag === "StandardCommand");
                const host = command.args[command.args.indexOf("--") - 1];
                assert(host === DESTINATION || host === "new-host", `Unknown host: ${host}`);
                return (host === DESTINATION ? before : after).spawn(command);
              });
            }),
          );
          const sink = {
            append: () => Effect.void,
            salvage: () => Effect.void,
            comments: () => Effect.void,
            outOfMemory: () => Effect.void,
            transcript: Effect.succeed([]),
            windows: aloneOnItem(),
          };
          let unreadable = false;
          const runtime = (address: SshWorkerAddress, parent: StubParent) =>
            sshLayer({
              workers: [address],
              instance: INSTANCE,
              instanceId: INSTANCE_ID,
              interruptGrace: "2 seconds",
              attemptConnections: {
                read: (id) => Effect.sync(() => Option.fromNullishOr(records.get(id))),
                write: (id, connection) => Effect.sync(() => void records.set(id, connection)),
                remove: (id) => Effect.sync(() => void records.delete(id)),
              },
            }).pipe(
              Layer.provide(harnessesLive),
              Layer.provide(Layer.merge(original.layer, remoteHosts)),
              Layer.provide(credentials.layer),
              Layer.provide(
                Layer.effect(
                  AttemptRuntime,
                  Effect.gen(function* () {
                    const service = yield* AttemptRuntime;
                    return AttemptRuntime.of({
                      ...service,
                      isLive: (id) =>
                        Effect.suspend(() =>
                          unreadable
                            ? Effect.fail(
                                InfraFailure.make({
                                  message: "Parent storage unavailable",
                                  cause: new Error("storage unavailable"),
                                }),
                              )
                            : service.isLive(id),
                        ),
                    });
                  }),
                ).pipe(Layer.provide(stubAttemptRuntime(storage, parent))),
              ),
              Layer.provide(hostLoginLockLayer),
              Layer.provide(noGateway),
            );
          return Effect.gen(function* () {
            let started = yield* Deferred.make<void>();
            const parent: StubParent = () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
            const start = Effect.gen(function* () {
              const executor = yield* Executor;
              const launched = yield* (yield* executor.prepare(request))
                .launch(sink)
                .pipe(Effect.forkChild);
              yield* Deferred.await(started);
              yield* Fiber.interrupt(launched);
            }).pipe(Effect.scoped);
            const check = Effect.gen(function* () {
              const executor = yield* Executor;
              const startupCalls = original.state.calls.length;
              unreadable = parentStatus === "unreadable";
              const liveness = yield* executor.isLive(request.attemptId).pipe(Effect.result);
              if (parentStatus === "unreadable") assert.strictEqual(liveness._tag, "Failure");
              else {
                assert(liveness._tag === "Success");
                assert.isTrue(liveness.success);
              }
              yield* (yield* SshWorkers).addWorker(transition === "unchanged" ? ADDRESS : revised);
              yield* executor.preflight(WORKER, [], 1);
              assert.isFalse(
                [...original.state.calls.slice(startupCalls), ...replacement.state.calls].some(
                  ({ line }) => line.startsWith("exec 'find' ") && line.includes("/attempts'"),
                ),
                "startup keeps the attempt before listing checkouts",
              );
              assert.isTrue(original.state.cacheExists, "revision preserves the original checkout");
              assert.isFalse(replacement.state.cacheExists, "the replacement has no old checkout");
              unreadable = false;
              original.state.salvage = "dirty";
              const before = original.state.calls.length;
              const after = replacement.state.calls.length;
              const salvages: Array<AttemptSalvage> = [];
              if (operation === "reattach") {
                started = yield* Deferred.make<void>();
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const prepared = yield* executor.prepare(
                      CheckoutRequest.make({ ...request, reattach: true }),
                    );
                    const launched = yield* prepared.launch(sink).pipe(Effect.forkChild);
                    yield* Deferred.await(started);
                    yield* Fiber.interrupt(launched);
                  }),
                );
                assert.isTrue(original.state.cacheExists, "reattachment keeps the original work");
              }
              yield* executor.recover(
                keptCheckoutRecovery(request),
                { ...sink, salvage: (value) => Effect.sync(() => void salvages.push(value)) },
                Effect.succeed(COMMIT_AUTHOR),
              );
              assert.deepStrictEqual(
                salvages.map(({ _tag }) => _tag),
                ["Pushed"],
              );
              assert.isAbove(original.state.calls.length, before);
              assert.strictEqual(replacement.state.calls.length, after);
              assert.isTrue(original.state.salvageCommitted, "preserves the original host's work");
              assert.isTrue(
                original.state.calls
                  .slice(before)
                  .some(({ line }) => line.includes("'push'") && line.includes(request.salvageRef)),
              );
              assert.isFalse(
                original.state.calls
                  .slice(before)
                  .some(({ line }) => line.includes("'clone'") && line.includes(WORKTREE)),
              );
              const next = CheckoutRequest.make({ ...request, attemptId: AttemptId.make("next") });
              const target = transition === "unchanged" ? original : replacement;
              const offset = target.state.calls.length;
              yield* Effect.scoped(executor.prepare(next));
              assert.isTrue(
                target.state.calls
                  .slice(offset)
                  .some(({ command }) => command.args.includes(destination)),
              );
            }).pipe(Effect.scoped);
            if (transition === "restart") {
              yield* start.pipe(Effect.provide(runtime(ADDRESS, parent)));
              yield* check.pipe(Effect.provide(runtime(revised, parent)));
            } else {
              yield* start.pipe(Effect.andThen(check), Effect.provide(runtime(ADDRESS, parent)));
            }
          });
        },
      );
    }
  }
}
