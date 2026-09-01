import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Agent } from "@usine/core";
import { Effect, Stream } from "effect";
import { ChildRequest, PiChildBackend, WorkingDirectory } from "../../src/index.ts";
import { piChildBackendLayer, piSdkLive } from "../../src/pi/pi.ts";

const model = process.env.USINE_PI_INTEGRATION_MODEL;
if (model === undefined || model.trim().length === 0) {
  throw new Error("USINE_PI_INTEGRATION_MODEL must use Pi's provider/model syntax");
}

// A full-access headless agent must never run in the developer's checkout.
const workspace = mkdtempSync(join(tmpdir(), "usine-pi-live-"));

describe("Pi child live contract", () => {
  it.live(
    "runs one child through the Pi SDK",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* PiChildBackend;
          const running = yield* backend.launch(
            new ChildRequest({
              session: new Agent.ChildSession({
                id: Agent.SessionId.make("pi-live-child"),
                parentId: Agent.SessionId.make("pi-live-parent"),
                agent: Agent.Name.make("contract-tester"),
                brain: new Agent.BrainSpec({
                  harness: "pi",
                  model: Agent.ModelId.make(model),
                  effort: "low",
                }),
              }),
              cwd: WorkingDirectory.make(workspace),
              prompt: "Reply with exactly PI_CONTRACT_OK. Do not call tools.",
            }),
          );
          const [events, result] = yield* Effect.all([
            Stream.runCollect(running.events),
            running.result,
          ]);
          assert.match(result.message, /PI_CONTRACT_OK/u);
          assert(events.some((event) => event._tag === "TextOutput"));
          assert.strictEqual(events.at(0)?._tag, "SessionStarted");
          assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
        }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(piSdkLive)),
      ),
    180_000,
  );
});
