import { assert, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { Agent } from "@usine/core/agent";
import { BrainSpec } from "@usine/core/agent/brain";
import { jsonKey } from "@usine/core/json-key";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import { completes, type StubParent } from "@usine/durable/testing";
import { OpenAiApiKey, OpenAiProvider, UpstreamBase } from "@usine/gateway";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { CheckoutRequest, Executor } from "../../../src/executor.ts";
import { sharedHarness, sharedHarnesses } from "../harnesses.ts";
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

it.effect(
  "a registered harness shares an OpenAI slot with its own home and secret-free configuration",
  () => {
    const machine = fakeMachine();
    const gateway = fakeGateway(machine, {
      "anthropic-messages": Option.none(),
      "openai-responses": Option.some(
        OpenAiProvider.make({
          upstream: UpstreamBase.make("https://api.openai.com"),
          credential: OpenAiApiKey.make({ key: Redacted.make("sk-shared-slot-test") }),
        }),
      ),
    });
    const logs = capturedLogs();
    let given: AttemptRequest | undefined;
    const parent: StubParent = (context) => {
      given = context.request;
      return completes(context);
    };
    const brain = BrainSpec.make({ ...TEST_AGENT.brain, harness: sharedHarness.id });
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [brain], 1);
      yield* (yield* executor.prepare(
        CheckoutRequest.make({
          ...request,
          agent: Agent.make({ ...TEST_AGENT, brain }),
        }),
      )).launch({
        append: () => Effect.void,
        salvage: () => Effect.void,
        comments: () => Effect.void,
        outOfMemory: () => Effect.void,
        transcript: Effect.succeed([]),
        windows: aloneOnItem(),
      });
      assert(given !== undefined && Schema.is(RemoteShell)(given.host));
      const token = given.host.sshEnvironment.SHARED_GATEWAY_TOKEN;
      assert(token !== undefined);
      assert.strictEqual(token, given.host.sshEnvironment.USINE_GATEWAY_TOKEN);
      assert.include(given.host.ssh.args.join(" "), "SHARED_GATEWAY_TOKEN");
      const home = `${WORKER_ROOT}/shared-client/remote-run_execute_1`;
      assert.strictEqual(given.environment.SHARED_HOME, home);
      assert.strictEqual(given.environment.CODEX_HOME, `${WORKER_ROOT}/codex/remote-run_execute_1`);
      const config = machine.state.files.get(`${home}/client.json`);
      assert(config !== undefined);
      assert.include(config, '"base_url":"http://llm.gw.test/openai-responses/v1"');
      assert.include(config, '"env_key":"SHARED_GATEWAY_TOKEN"');
      const credential = yield* given.gatewayCredential;
      assert.deepStrictEqual(credential, Option.some("api-key"));
      for (const text of [
        config,
        jsonKey(given.environment),
        given.host.ssh.args.join(" "),
        logs.lines.join("\n"),
      ])
        assert.notInclude(text, token);
      for (const { command } of machine.state.calls)
        assert.notInclude(command.args.join(" "), token);
      assert(machine.state.calls.some(({ line }) => line === `exec 'rm' '-rf' '${home}'`));
    }).pipe(
      Effect.provide(
        Layer.merge(
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: ["openai-responses"] }),
            parent,
            harnesses: sharedHarnesses,
          }),
          logs.layer,
        ),
      ),
    );
  },
);
