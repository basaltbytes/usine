import { assert, it } from "@effect/vitest";
import { Agent } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { OpenAiApiKey, OpenAiProvider, UpstreamBase } from "@usine/gateway";
import { Effect, Layer, Option, Redacted } from "effect";
import { CheckoutRequest, Executor } from "../../../src/executor.ts";
import {
  aloneOnItem,
  capturedLogs,
  fakeMachine,
  mintingProvider,
  request,
  TEST_AGENT,
  WORKER,
  WORKER_ROOT,
} from "../support.ts";
import { fakeGateway, gatewayAddress, gatewayRuntime } from "./support.ts";

const CODEX_BRAIN = BrainSpec.make({
  harness: Harness.make("codex"),
  model: ModelId.make("gpt-5.6-sol"),
  effort: "low",
});

const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

const OLDER_GATEWAY = "Gateway usine-gateway is older than this orchestrator";

it.effect(
  "keeps Codex on the provider prefixes of an older Gateway, reports the upgrade, and switches once the Gateway is upgraded",
  () => {
    const machine = fakeMachine();
    const gateway = fakeGateway(machine, {
      "anthropic-messages": Option.none(),
      "openai-responses": Option.some(
        OpenAiProvider.make({
          upstream: UpstreamBase.make("https://api.openai.com"),
          credential: OpenAiApiKey.make({ key: Redacted.make("sk-older-gateway-test") }),
        }),
      ),
    });
    gateway.switches.beforeProtocolSlots = true;
    const logs = capturedLogs();
    const config = `${WORKER_ROOT}/codex/remote-run_execute_1/config.toml`;
    /** Runs a Codex Attempt and returns the Codex configuration written for it. */
    const attempt = Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(
        CheckoutRequest.make({
          ...request,
          agent: Agent.make({ ...TEST_AGENT, brain: CODEX_BRAIN }),
        }),
      );
      yield* prepared.launch(sink);
      return machine.state.files.get(config) ?? "";
    });
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const older = yield* executor.preflight(WORKER, [CODEX_BRAIN], 1);
      assert(Option.isSome(older.gatewayUpgrade));
      assert.strictEqual(
        older.gatewayUpgrade.value,
        `${OLDER_GATEWAY}: it serves model requests only at /anthropic and /openai, which attempts call instead of /anthropic-messages and /openai-responses; it has no provider-credentials admin API, so Settings can't manage its provider logins. Upgrade @usine/gateway on it to the release that matches the orchestrator.`,
      );
      yield* executor.preflight(WORKER, [CODEX_BRAIN], 1);
      assert.lengthOf(
        logs.lines.filter((line) => line.includes("The Gateway predates protocol path prefixes")),
        1,
        "the older Gateway is logged once for the Worker",
      );
      const olderConfig = yield* attempt;
      assert.include(olderConfig, 'base_url = "http://llm.gw.test/openai/v1"');

      gateway.switches.beforeProtocolSlots = false;
      const upgraded = yield* executor.preflight(WORKER, [CODEX_BRAIN], 1);
      assert.deepStrictEqual(upgraded.gatewayUpgrade, Option.none());
      assert(logs.lines.some((line) => line.includes("The Gateway serves protocol path prefixes")));
      const upgradedConfig = yield* attempt;
      assert.include(upgradedConfig, 'base_url = "http://llm.gw.test/openai-responses/v1"');
    }).pipe(
      Effect.provide(
        Layer.merge(
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: ["openai-responses"] }),
          }),
          logs.layer,
        ),
      ),
    );
  },
);
