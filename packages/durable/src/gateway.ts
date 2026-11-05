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
import { type PiAuthentication } from "@usine/agents/pi/authentication";
import type { GatewayCredentialKind, GatewayLlmProtocol } from "@usine/core/worker";
import { Schema } from "effect";

/** Model and credential access used by the durable coordinator. */
export interface ParentModelAccess {
  readonly models: Models;
  /** Checks the upstream credential, independently of the caller token used for transport. */
  readonly authentication: (
    provider: string,
    signal: AbortSignal,
  ) => Promise<PiAuthentication | undefined>;
}

/** A gateway transport with no provider credential on the orchestrator. */
export interface GatewayModelTransport {
  readonly credential: (
    protocol: GatewayLlmProtocol,
    signal?: AbortSignal,
  ) => Promise<GatewayCredentialKind | undefined>;
  readonly request: (
    protocol: GatewayLlmProtocol,
    body: string,
    headers: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) => Promise<Response>;
}

const Payload = Schema.Record(Schema.String, Schema.Unknown);

/** Builds Pi providers that only send model requests through the gateway transport. */
export const gatewayModelAccess = (transport: GatewayModelTransport): ParentModelAccess => {
  const models = createModels();
  const protocolFor = (provider: string): GatewayLlmProtocol | undefined =>
    provider === "anthropic"
      ? "anthropic-messages"
      : provider === "openai" || provider === "openai-codex"
        ? "openai-responses"
        : undefined;
  const authentication = async (
    provider: string,
    signal: AbortSignal,
  ): Promise<PiAuthentication | undefined> => {
    const protocol = protocolFor(provider);
    if (protocol === undefined) return undefined;
    const credential = await transport.credential(protocol, signal);
    if (credential === "api-key") return { _tag: "ApiKey" };
    if (credential === "subscription" && provider === "openai-codex")
      return { _tag: "OAuth", subscription: true };
    return undefined;
  };
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
          return transport.request(
            protocol,
            await request.text(),
            Object.fromEntries(request.headers),
            request.signal,
          );
        },
      };
      if (provider.id === "openai-codex") {
        prepared.onPayload = async (payload) => ({
          ...(await Schema.decodeUnknownPromise(Payload)(payload)),
          instructions:
            context.messages[0]?.role === "system"
              ? getSystemMessageText(context.messages[0])
              : "You are a helpful assistant.",
          max_output_tokens: undefined,
          temperature: undefined,
          prompt_cache_retention: undefined,
          prompt_cache_options: undefined,
        });
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
            resolve: async ({ signal }) =>
              (await authentication(provider.id, signal)) === undefined
                ? undefined
                : { auth: { apiKey: "gateway-caller", baseUrl } },
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
  return { models, authentication };
};
