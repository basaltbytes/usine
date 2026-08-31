import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Agent } from "@usine/core";
import { Effect, Stream } from "effect";
import { ChildRequest, CodexChildBackend, WorkingDirectory } from "../../src/index.ts";
import { codexAppServerLive, codexChildBackendLayer } from "../../src/pi/codex.ts";

const model = process.env.USINE_CODEX_INTEGRATION_MODEL;
if (model === undefined || model.trim().length === 0) {
  throw new Error("USINE_CODEX_INTEGRATION_MODEL must name a model exposed by codex app-server");
}

describe("Codex child live contract", () => {
  it.live(
    "runs one headless child through app-server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* CodexChildBackend;
          const running = yield* backend.launch(
            new ChildRequest({
              session: new Agent.ChildSession({
                id: Agent.SessionId.make("codex-live-child"),
                parentId: Agent.SessionId.make("codex-live-parent"),
                agent: Agent.Name.make("contract-tester"),
                brain: new Agent.BrainSpec({
                  harness: "codex",
                  model: Agent.ModelId.make(model),
                  effort: "low",
                }),
              }),
              cwd: WorkingDirectory.make(process.cwd()),
              prompt: "Reply with exactly CODEX_CONTRACT_OK. Do not call tools.",
            }),
          );
          const [events, result] = yield* Effect.all([
            Stream.runCollect(running.events),
            running.result,
          ]);
          assert.match(result.message, /CODEX_CONTRACT_OK/u);
          assert(events.some((event) => event._tag === "TextOutput"));
          assert.strictEqual(events.at(0)?._tag, "SessionStarted");
          assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
        }).pipe(
          Effect.provide(codexChildBackendLayer),
          Effect.provide(codexAppServerLive),
          Effect.provide(NodeServices.layer),
        ),
      ),
    180_000,
  );
});
