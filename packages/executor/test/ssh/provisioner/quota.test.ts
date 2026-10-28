import { assert, it } from "@effect/vitest";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Effect, Option } from "effect";
import { boatDriverFor } from "../../../src/ssh/provisioner/boat.ts";
import { BOAT_TEST_API, fakeProviders } from "./fake-providers.ts";
import { boatSettings } from "./support.ts";

it.effect(
  "distinguishes Boat plan limits from temporary failures and preserves provider messages",
  () => {
    const providers = fakeProviders();
    return Effect.gen(function* () {
      const worker = WorkerName.make("boat-pool");
      const driver = yield* boatDriverFor(
        worker,
        boatSettings(),
        "ssh-ed25519 AAAATest",
        BOAT_TEST_API,
      );
      for (const [status, code, reason] of [
        [429, "limit_reached", "quota"],
        [429, "member_limit_reached", "quota"],
        [429, "trial_compute_limit_reached", "quota"],
        [402, "billing_required", "quota"],
        [402, "team_member_cap_reached", "quota"],
        [403, "trial_machine_class_not_allowed", "quota"],
        [429, "rate_limited", "provider"],
        [429, "IP_RATE_LIMIT_EXCEEDED", "provider"],
        [503, "out_of_capacity", "capacity"],
        [500, "http_500", "provider"],
        [401, "unauthorized", "refused"],
        [403, "forbidden", "refused"],
      ] as const) {
        providers.boat.createFails = { status, code, message: `Provider detail for ${code}` };
        const failure = yield* driver
          .create("quota-test", {
            instance: "test",
            worker,
            run: RunId.make("run"),
            process: "test",
            attempt: Option.none(),
          })
          .pipe(Effect.flip);
        assert(failure._tag === "MachineUnavailableError");
        assert.strictEqual(failure.reason, reason, code);
        assert.include(failure.message, `Provider detail for ${code}`);
        assert.strictEqual(providers.boat.sandboxes.size, 0);
      }
    }).pipe(Effect.provide(providers.layer));
  },
);
