// Provider SDKs require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import {
  createModels,
  createProvider,
  getSystemMessageText,
  type Models,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { CredentialRoute } from "@usine/agents/harness";
import { type PiAuthentication } from "@usine/agents/pi/authentication";
import type { GatewayCredentialKind, GatewayLlmProtocol } from "@usine/core/worker";
import { jsonKey } from "@usine/core/json-key";
import { Effect, Option, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";

/** A provider credential check or model request that failed without exposing credentials. */
export class ParentCredentialError extends Schema.TaggedError<
  ParentCredentialError,
  { readonly brand: unique symbol }
>("@usine/durable/ParentCredentialError")("ParentCredentialError", {
  message: Schema.NonEmptyString,
}) {}

export type ParentCredentials =
  | { readonly route: Extract<CredentialRoute, "host-login"> }
  | {
      readonly route: Extract<CredentialRoute, "gateway">;
      readonly authentication: (
        provider: string,
      ) => Effect.Effect<PiAuthentication | undefined, ParentCredentialError>;
    };

/** Model and credential access used by the durable coordinator. */
export interface ParentModelAccess {
  readonly models: Models;
  readonly credentials: ParentCredentials;
}

/** A gateway transport with no provider credential on the orchestrator. */
export interface GatewayModelTransport {
  readonly credential: (
    protocol: GatewayLlmProtocol,
  ) => Effect.Effect<Option.Option<GatewayCredentialKind>, ParentCredentialError>;
  readonly request: (
    protocol: GatewayLlmProtocol,
    body: string,
    headers: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) => Effect.Effect<Response, ParentCredentialError>;
}

const Payload = Schema.Record(Schema.String, Schema.Unknown);

const Items = Schema.Array(Schema.Unknown);

const isInstructionItem = Schema.is(
  Schema.Struct({
    role: Schema.Literals(["system", "developer"]),
    content: Schema.String,
  }),
);

const codexResponse = (response: Response): Response => {
  const body = response.body;
  if (!response.ok || body === null) return response;
  const normalized = Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => cause,
  }).pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.mapEffect((event) =>
      event.data === "[DONE]"
        ? Effect.succeed(event)
        : Schema.decodeEffect(Schema.fromJsonString(Payload))(event.data).pipe(
            Effect.map((payload) =>
              payload.type === "response.done"
                ? {
                    ...event,
                    event: "response.completed",
                    data: jsonKey({ ...payload, type: "response.completed" }),
                  }
                : event,
            ),
            Effect.catchTag("SchemaError", () => Effect.succeed(event)),
          ),
    ),
    Stream.map(Sse.encoder.write),
    Stream.encodeText,
    Stream.toReadableStream,
  );
  return new Response(normalized, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** Builds Pi providers that only send model requests through the gateway transport. */
export const gatewayModelAccess: (
  transport: GatewayModelTransport,
) => Effect.Effect<ParentModelAccess> = Effect.fn("GatewayModelAccess.make")(function* (
  transport: GatewayModelTransport,
) {
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const models = createModels();
  const protocolFor = (provider: string): GatewayLlmProtocol | undefined =>
    provider === "anthropic"
      ? "anthropic-messages"
      : provider === "openai" || provider === "openai-codex"
        ? "openai-responses"
        : undefined;
  const authentication = Effect.fn("GatewayModelAccess.authentication")(function* (
    provider: string,
  ) {
    yield* Effect.annotateCurrentSpan({ provider });
    const protocol = protocolFor(provider);
    if (protocol === undefined) return undefined;
    const credential = yield* transport
      .credential(protocol)
      .pipe(Effect.map(Option.getOrUndefined));
    if (credential === "api-key") return { _tag: "ApiKey" } as const;
    if (credential === "subscription" && provider === "openai-codex")
      return { _tag: "OAuth", subscription: true } as const;
    return undefined;
  });
  for (const provider of [anthropicProvider(), openaiProvider(), openaiCodexProvider()]) {
    const protocol = protocolFor(provider.id);
    if (protocol === undefined) continue;
    const baseUrl = `http://llm.gateway/${protocol}/v1`;
    const api = protocol === "openai-responses" ? openAIResponsesApi() : anthropicMessagesApi();
    const optionsFor = (context: TranscriptContext, options?: StreamOptions): StreamOptions => {
      const prepared: StreamOptions = {
        ...options,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const response = await run(
            transport.request(
              protocol,
              await request.text(),
              Object.fromEntries(request.headers),
              request.signal,
            ),
            { signal: request.signal },
          );
          return provider.id === "openai-codex" ? codexResponse(response) : response;
        },
      };
      if (provider.id === "openai-codex") {
        prepared.onPayload = async (payload) => {
          const decoded = await Schema.decodeUnknownPromise(Payload)(payload);
          const leading = context.messages[0];
          const instructions = leading?.role === "system" ? getSystemMessageText(leading) : "";
          // pi-ai places the `additional_tools` items that declare tools before the system prompt item.
          const input = Option.match(Schema.decodeUnknownOption(Items)(decoded.input), {
            onNone: () => decoded.input,
            onSome: (items) => {
              const prompt = instructions === "" ? -1 : items.findIndex(isInstructionItem);
              return items.filter((_, index) => index !== prompt);
            },
          });
          return {
            ...decoded,
            input,
            instructions: instructions === "" ? "You are a helpful assistant." : instructions,
            max_output_tokens: undefined,
            temperature: undefined,
            prompt_cache_retention: undefined,
            prompt_cache_options: undefined,
          };
        };
      }
      return prepared;
    };
    models.setProvider(
      createProvider({
        id: provider.id,
        baseUrl,
        models: provider
          .getModels()
          .filter(
            (model) =>
              protocol !== "openai-responses" ||
              model.api === "openai-responses" ||
              model.api === "openai-codex-responses",
          )
          .map((model) => ({
            ...model,
            baseUrl,
            api: protocol === "openai-responses" ? "openai-responses" : "anthropic-messages",
            compat: { ...model.compat, supportsMidConvoEffort: false },
          })),
        auth: {
          apiKey: {
            name: "Gateway caller token",
            resolve: () => Promise.resolve({ auth: { apiKey: "gateway-caller", baseUrl } }),
          },
        },
        api: {
          stream: (model, context, options) =>
            api.stream(model, context, optionsFor(context, options)),
          streamSimple: (model, context, options) =>
            api.streamSimple(model, context, optionsFor(context, options)),
        },
      }),
    );
  }
  return { models, credentials: { route: "gateway", authentication } } satisfies ParentModelAccess;
});
