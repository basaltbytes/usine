import { NodeHttpServer } from "@effect/platform-node";
import { Effect, FileSystem, Queue, Schema } from "effect";
import { NetAddress } from "effect/net";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
// NodeHttpServer takes a Node server factory.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const Request = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Json })),
});

/** Runs the real CLI contract against a provider that requests the contract's waiting command. */
export const openCodeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-opencode-provider-" });
  const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 });
  const requests = yield* Queue.make<{ readonly path: string; readonly body: Schema.Json }>();
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      );
      yield* Queue.offer(requests, { path: request.url, body });
      if (request.url.endsWith("/responses")) {
        const item = {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "gateway-ok", annotations: [] }],
        };
        const response = {
          id: "resp_fixture",
          object: "response",
          created_at: 1,
          model: "gpt-6-astra",
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        };
        const events = [
          {
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            delta: "gateway-ok",
          },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ];
        const encoded = yield* Effect.forEach(events, (event) =>
          encode(event).pipe(Effect.map((json) => `data: ${json}\n\n`)),
        );
        return HttpServerResponse.text(encoded.join(""), { contentType: "text/event-stream" });
      }
      const { messages } = yield* Schema.decodeUnknownEffect(Request)(body);
      const completed = messages.some((message) => message.role === "tool");
      const marker = (yield* encode(messages)).match(/STEER_[a-f0-9]+/gu)?.at(-1);
      const chunk = (delta: Schema.Json, finish: string | null = null) =>
        encode({
          id: "chatcmpl_fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [{ index: 0, delta, finish_reason: finish }],
        }).pipe(Effect.map((json) => `data: ${json}\n\n`));
      return HttpServerResponse.text(
        (yield* chunk({
          role: "assistant",
          ...(completed
            ? { content: marker ?? "ORIGINAL_INSTRUCTION" }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_wait",
                    type: "function",
                    function: {
                      name: "shell",
                      arguments: yield* encode({
                        command: "node ./wait-for-release.mjs",
                        timeout: 120000,
                      }),
                    },
                  },
                ],
              }),
        })) +
          (yield* chunk({}, completed ? "stop" : "tool_calls")) +
          "data: [DONE]\n\n",
        { contentType: "text/event-stream" },
      );
    }),
  );
  if (!NetAddress.isInetAddress(server.address))
    return yield* Effect.die("Expected a TCP provider");
  const baseUrl = `http://127.0.0.1:${server.address.port}/v1`;
  return {
    requests,
    baseUrl,
    environment: {
      XDG_DATA_HOME: `${directory}/data`,
      XDG_STATE_HOME: `${directory}/state`,
      XDG_CONFIG_HOME: `${directory}/config`,
      XDG_CACHE_HOME: `${directory}/cache`,
      OPENCODE_CONFIG_CONTENT: yield* encode({
        providers: {
          fixture: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { apiKey: "fixture", baseURL: baseUrl },
            models: { test: { limit: { context: 20000, output: 2000 } } },
          },
        },
      }),
    },
  };
});
