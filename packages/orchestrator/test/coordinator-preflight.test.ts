import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { WorkerName } from "@usine/core/worker";
import { layer as durableTestingLayer } from "@usine/durable/testing";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { coordinatorPreflight } from "../src/coordinator-preflight.ts";
import { fixedInstanceLayer } from "./support/current-instance.ts";

it.live(
  "preflights the instance parent and agent override against gateway credentials without a host login",
  () =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const config = yield* Schema.decodeEffect(UsineConfig)({
        version: 1,
        repos: [],
        settings: { parent_model: "openai-codex/gpt-5" },
      });
      const agent = AgentFile.make({
        name: AgentName.make("developer"),
        harness: Harness.make("codex"),
        model: ModelId.make("gpt-5"),
        effort: "high",
        parentModel: Option.none(),
        parentEffort: Option.none(),
        persona: AgentPersona.make("Implement the task."),
      });
      const instance = (override: Option.Option<ModelId>) =>
        LoadedInstance.make({
          config,
          agents: [AgentFile.make({ ...agent, parentModel: override })],
          loops: [],
          invalidAgents: [],
          quarantinedLoops: [],
          warnings: [],
        });
      const check = (override: Option.Option<ModelId>) =>
        coordinatorPreflight.pipe(
          Effect.provide(
            Layer.merge(
              fixedInstanceLayer(instance(override)),
              durableTestingLayer({ database: `${directory}/test.sqlite`, parent: [] }),
            ),
          ),
        );
      const worker = WorkerName.make("gateway-worker");
      const credentials = {
        "anthropic-messages": Option.none(),
        "openai-responses": Option.some("subscription" as const),
      };
      const configured = yield* check(Option.none());
      yield* configured(worker, credentials);
      const missing = yield* configured(worker, {
        ...credentials,
        "openai-responses": Option.none(),
      }).pipe(Effect.flip);
      assert.strictEqual(missing.capability, "gateway");
      assert.include(missing.message, 'provider "openai-codex"');
      const overridden = yield* check(Option.some(ModelId.make("anthropic/claude-sonnet-4-6")));
      const rejected = yield* overridden(worker, credentials).pipe(Effect.flip);
      assert.include(rejected.message, 'provider "anthropic"');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
