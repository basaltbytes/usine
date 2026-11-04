import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { ProvisionerReuse, MachineAttemptLimit, MachineMaxAge } from "@usine/core/worker";
import { Effect, Option } from "effect";
import { CheckoutRequest, Executor, WorkerMachines } from "../../../src/executor.ts";
import type { SshWorkerAddress } from "../../../src/ssh/model.ts";
import { fakeMachine, request, TEST_AGENT, WORKER } from "../support.ts";
import { hetznerSettings } from "./support.ts";
import { attachmentsInForce, fakeGateway, gatewayAddress } from "../gateway/support.ts";
import { fakeProviders } from "./fake-providers.ts";
import { MACHINE_RUN, ROOT, sink, gatewayRuntimeOf } from "./fixtures.ts";

describe("Provisioned machine reuse behind a gateway", () => {
  for (const detachFails of [false, true]) {
    it.live(
      detachFails
        ? "retires the machine when the previous gateway attachment could not be revoked"
        : "revokes the previous attachment before the next attempt attaches on the reused machine",
      () => {
        const machine = fakeMachine();
        machine.state.docker = "running";
        const providers = fakeProviders();
        const gateway = fakeGateway(machine);
        const address: SshWorkerAddress = {
          ...gatewayAddress(),
          port: Option.none(),
          root: ROOT,
          machine: {
            _tag: "Provisioned",
            provisioner: hetznerSettings({
              reuse: Option.some(
                ProvisionerReuse.make({
                  attempts: MachineAttemptLimit.make(5),
                  maxAge: MachineMaxAge.make("2h"),
                }),
              ),
            }),
          },
        };
        return Effect.gen(function* () {
          const executor = yield* Executor;
          const machines = yield* WorkerMachines;
          const first = yield* machines.create(WORKER, MACHINE_RUN, request.attemptId, [
            TEST_AGENT.brain,
          ]);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const prepared = yield* executor.prepare(request);
              const attached = yield* attachmentsInForce;
              assert.lengthOf(attached, 1);
              if (detachFails)
                for (const attachment of attached)
                  gateway.switches.refusedDetaches.add(attachment.id);
              yield* prepared.launch(sink);
            }),
          );
          gateway.switches.refusedDetaches.clear();
          if (!detachFails) {
            const attachments = yield* attachmentsInForce;
            assert.lengthOf(attachments, 0);
          }
          yield* machines.release(first.hold);
          const nextRequest = CheckoutRequest.make({
            ...request,
            attemptId: AttemptId.make("remote-run/execute/2"),
          });
          const second = yield* machines.create(WORKER, MACHINE_RUN, nextRequest.attemptId, [
            TEST_AGENT.brain,
          ]);
          if (detachFails) assert.notEqual(second.id, first.id);
          else assert.strictEqual(second.id, first.id);
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* (yield* executor.prepare(nextRequest)).launch(sink);
            }),
          );
          const changes = gateway.calls.filter(
            ({ method }) => method === "POST" || method === "DELETE",
          );
          assert.deepStrictEqual(
            changes.map(({ method }) => method),
            ["POST", "DELETE", "POST", "DELETE"],
          );
          yield* machines.release(second.hold);
        }).pipe(
          Effect.scoped,
          Effect.provide(gatewayRuntimeOf(machine, providers, gateway, address)),
        );
      },
    );
  }
});
