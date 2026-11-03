import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { WorkerRoot } from "@usine/core/worker";
import { Effect, Option } from "effect";
import { Executor, ExecutorOperationError, WorkerMachines } from "../../../src/executor.ts";
import { attemptTag } from "../../../src/ssh/provisioner/model.ts";
import { SshWorkers } from "../../../src/ssh/ssh.ts";
import { ADDRESS, fakeMachine, INSTANCE, request, WORKER } from "../support.ts";
import { hetznerAddress, RUN, runtimeOf, sink, pinnedEarlier } from "./fixtures.ts";
import { fakeProviders } from "./fake-providers.ts";

for (const connection of ["unchanged", "replaced", "restarted", "unreadable"] as const) {
  it.live(
    `recovers an earlier process's attempt before deleting its machine (connection: ${connection})`,
    () => {
      const machine = fakeMachine();
      machine.state.cacheExists = true;
      const providers = fakeProviders();
      let unreadable = connection === "unreadable";
      return Effect.gen(function* () {
        const executor = yield* Executor;
        pinnedEarlier(machine, 21);
        providers.hetzner.servers.set(21, {
          id: 21,
          name: "usine-eu-one-21",
          status: "running",
          created: new Date().toISOString(),
          labels: {
            "usine-instance": INSTANCE,
            "usine-worker": WORKER,
            "usine-run": RUN,
            "usine-process": "earlier00000",
            "usine-attempt": attemptTag(request.attemptId),
          },
          privateIp: undefined,
          publicIp: "203.0.113.91",
          startingReads: 0,
        });
        const machines = yield* WorkerMachines;
        if (unreadable) {
          assert.isTrue(Option.isNone(yield* machines.adopt(WORKER, request.attemptId)));
          yield* machines.sweep;
          assert.isTrue(
            providers.hetzner.servers.has(21),
            "an unreadable connection protects its retained machine",
          );
          unreadable = false;
        }
        const hold =
          connection === "replaced"
            ? yield* machines.adopt(WORKER, request.attemptId)
            : Option.none();
        if (connection === "replaced") {
          assert.isTrue(Option.isSome(hold));
          yield* (yield* SshWorkers).addWorker({
            ...ADDRESS,
            root: WorkerRoot.make("/srv/replacement"),
          });
        }
        machine.state.salvage = "dirty";
        let salvages = 0;
        const attempt: AttemptRecovery = {
          attemptId: request.attemptId,
          worker: WORKER,
          repository: request.repository,
          ref: request.salvageRef,
          permissions: "write",
          succeeded: false,
          open: false,
          rejected: Option.none(),
        };
        yield* executor.recover(
          attempt,
          {
            ...sink,
            salvage: () =>
              Effect.sync(() => {
                salvages += 1;
              }),
          },
          Effect.succeed(request.commitAuthor),
        );
        assert.strictEqual(salvages, 1, "the original checkout is salvaged before deletion");
        if (Option.isSome(hold)) {
          assert.isTrue(providers.hetzner.servers.has(21), "the occupied slot retains its machine");
          yield* machines.release(hold.value);
        }
        assert.isTrue(
          machine.state.calls.some(({ command }) => command.args.includes("usine@203.0.113.91")),
          "the recovery ran on the Attempt's machine",
        );
        assert.strictEqual(providers.hetzner.servers.size, 0, "the machine is deleted after");
        machine.state.cacheExists = false;
        // An Attempt whose machine is gone has nothing to reconcile.
        yield* executor.recover(
          {
            ...attempt,
            attemptId: AttemptId.make("remote-run/execute/2"),
          },
          sink,
          Effect.succeed(request.commitAuthor),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runtimeOf(
            machine,
            providers,
            connection === "restarted"
              ? { ...ADDRESS, root: WorkerRoot.make("/srv/replacement") }
              : hetznerAddress,
            {
              attemptConnections: {
                read: (attemptId) =>
                  unreadable
                    ? Effect.fail(
                        ExecutorOperationError.make({
                          operation: "prepare",
                          message: "Corrupt connection record",
                          cause: new Error("invalid JSON"),
                        }),
                      )
                    : Effect.succeed(
                        attemptId === request.attemptId
                          ? Option.some(hetznerAddress)
                          : Option.none(),
                      ),
                write: () => Effect.void,
                remove: () => Effect.void,
              },
            },
          ),
        ),
      );
    },
  );
}
