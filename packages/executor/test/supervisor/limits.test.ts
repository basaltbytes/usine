import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { SandboxRequest, SupervisorSandbox } from "@usine/agents/supervisor";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import { ContainerImage, MessageSizeMib, SupervisorLimits } from "@usine/core/worker";
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { containerSandboxLayer } from "../../src/supervisor/container.ts";
import { podman } from "./runtime-fixture.ts";

it.live("passes configured message limits to the supervisor seat and its model relay", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const calls: Array<ReadonlyArray<string>> = [];
    const forwarded: Array<string> = [];
    const context = yield* Layer.build(
      containerSandboxLayer({
        root,
        image: ContainerImage.make("docker.io/library/node:22-slim"),
        runtime: Option.some("podman"),
        limits: SupervisorLimits.make({
          protocolFrameMib: MessageSizeMib.make(9),
          modelRequestMib: MessageSizeMib.make(1),
        }),
        route: Option.some(
          Effect.succeed({
            credential: () => Effect.succeedNone,
            request: (_protocol, body) =>
              Effect.sync(() => {
                forwarded.push(body);
                return new Response("ok");
              }),
          }),
        ),
      }).pipe(Layer.provide(podman(calls))),
    );
    const seat = yield* Context.get(context, SupervisorSandbox).open(
      SandboxRequest.make({
        model: ModelId.make("m"),
        conversation: AgentSessionId.make("configured-limits"),
        harness: Harness.make("codex"),
        sources: [],
      }),
    );
    assert.strictEqual(seat.protocolFrameMib, 9);
    const started = calls.find(([, command]) => command === "run");
    const mount = started?.find((arg) => arg.includes('"destination=/run/usine"'));
    const relayDirectory = mount?.match(/"source=([^"]+)"/u)?.[1];
    assert.isDefined(relayDirectory);
    const body = '{"model":"m"}';
    const oversized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
      model: "m",
      input: "x".repeat(2 * 1024 ** 2),
    });
    const statuses = yield* Effect.forEach([body, oversized], (body) =>
      HttpClientRequest.post("http://relay/openai-responses/v1/responses").pipe(
        HttpClientRequest.bodyText(body, "application/json"),
        HttpClient.execute,
        Effect.flatMap((response) => response.text.pipe(Effect.as(response.status))),
      ),
    ).pipe(
      Effect.provide(
        NodeHttpClient.layerNodeHttpOptions({ socketPath: `${relayDirectory}/model.sock` }),
      ),
    );
    assert.deepStrictEqual(statuses, [200, 413]);
    assert.deepStrictEqual(forwarded, [body]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
