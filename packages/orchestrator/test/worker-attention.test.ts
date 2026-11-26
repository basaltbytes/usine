import { assert, it } from "@effect/vitest";
import { WorkerName } from "@usine/core/worker";
import { Effect, Option } from "effect";
import { ReadyOverview } from "../src/operator/overview/view.ts";
import { workerAttentionFor } from "../src/operator/worker-attention.ts";
import { unchecked } from "../src/worker-status.ts";

const behind = WorkerName.make("behind");
const removed = WorkerName.make("removed");
const upgrade = "Gateway usine-gateway is older than this orchestrator";

it.effect("asks for a gateway upgrade once for each declared worker whose gateway is older", () =>
  Effect.gen(function* () {
    const refresh = workerAttentionFor(
      { transcript: () => Effect.die("unused") },
      { list: Effect.succeed([]) },
      {
        unavailable: Effect.succeed([]),
        provisioning: Effect.succeed([]),
        preflights: Effect.succeed([
          { ...unchecked(behind), gatewayUpgrade: Option.some(upgrade) },
          { ...unchecked(removed), gatewayUpgrade: Option.some(upgrade) },
          unchecked(WorkerName.make("current")),
        ]),
      },
    );
    const { needsYou } = yield* refresh(
      ReadyOverview.make({ projects: [], loops: [], needsYou: [] }),
      [],
      [
        { name: behind, paused: false },
        { name: WorkerName.make("current"), paused: false },
      ],
    );
    assert.deepStrictEqual(
      needsYou.map((need) =>
        need._tag === "WorkerGatewayNeed" ? [need.id, need.worker, need.message] : need._tag,
      ),
      [["worker-gateway:behind", behind, upgrade]],
    );
  }),
);
