// Vendor request callbacks use promises and async iterators.
// @effect-diagnostics asyncFunction:off
import type {
  Api,
  AssistantMessage,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openaiStream } from "@earendil-works/pi-ai/api/openai-responses";
import { getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { PiGateway, PiGatewayConnectionError } from "@usine/agents/pi/gateway";
import { HttpClientRequest } from "effect/http";
import { ModelId } from "@usine/core/agent/brain";
import { AttemptId } from "@usine/core/attempt";
import { Clock, Effect, Redacted, Schema, Stream } from "effect";

export type ParentGateway = Omit<PiGateway, "baseUrl"> & { readonly baseUrl: string };

const PREFIX = "usine-attempt:";

export const parentProviderSession = (attemptId: AttemptId) => `${PREFIX}${attemptId}`;

const ChatGptPayload = Schema.Struct({
  input: Schema.Array(Schema.Unknown),
});

const gatewayStream = (
  model: Model<Api>,
  gateway: ParentGateway,
  context: Parameters<Models["streamSimple"]>[1],
  options: ModelsSimpleStreamOptions | undefined,
  run: <A, E>(program: Effect.Effect<A, E>, signal?: AbortSignal) => Promise<A>,
) => {
  const { compat: _compat, headers: _headers, ...catalogModel } = model;
  const transcript = normalizeContext(context);
  const headers = new Headers({ host: gateway.host, "accept-encoding": "identity" });
  if (model.provider === "openai-codex") {
    headers.set("originator", "pi");
    headers.set("OpenAI-Beta", "responses=experimental");
    if (options?.sessionId !== undefined) headers.set("session-id", options.sessionId);
  }
  const sent = {
    ...options,
    apiKey: Redacted.value(gateway.callerToken),
    headers: Object.fromEntries(headers.entries()),
    // Fetch removes Host; the gateway's virtual host must survive the loopback SSH forward.
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return run(
        Effect.gen(function* () {
          const body = yield* Effect.tryPromise({
            try: () => request.arrayBuffer(),
            catch: () =>
              PiGatewayConnectionError.make({
                message: "Cannot read the coordinator request body",
              }),
          });
          const response = yield* gateway.httpClient
            .execute(
              HttpClientRequest.fromWeb(request).pipe(
                HttpClientRequest.bodyUint8Array(
                  new Uint8Array(body),
                  request.headers.get("content-type") ?? undefined,
                ),
              ),
            )
            .pipe(
              Effect.mapError(() =>
                PiGatewayConnectionError.make({
                  message: "Cannot send the coordinator request through the gateway",
                }),
              ),
            );
          const services = yield* Effect.context<never>();
          const stream = Stream.toReadableStreamWith(response.stream, services, {
            signal: request.signal,
          });
          return new Response(stream, { status: response.status, headers: response.headers });
        }),
        request.signal,
      );
    },
  };
  if (model.provider === "anthropic") {
    return anthropicStream(
      {
        ...catalogModel,
        api: "anthropic-messages",
        baseUrl: `${gateway.baseUrl}/anthropic-messages`,
      },
      transcript,
      sent,
    );
  }
  return openaiStream(
    { ...catalogModel, api: "openai-responses", baseUrl: `${gateway.baseUrl}/openai-responses/v1` },
    transcript,
    {
      ...sent,
      onPayload: async (payload, selected) => {
        const changed = (await options?.onPayload?.(payload, selected)) ?? payload;
        if (model.provider !== "openai-codex") return changed;
        const decoded = await run(Schema.decodeUnknownEffect(ChatGptPayload)(changed));
        // ChatGPT accepts instructions separately and rejects an output-token limit.
        const { max_output_tokens: _, ...rest } = await run(
          Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(changed),
        );
        return {
          ...rest,
          input: decoded.input.filter(
            (item) =>
              !Schema.is(Schema.Struct({ role: Schema.Literals(["system", "developer"]) }))(item),
          ),
          instructions:
            getCurrentSystemPrompt(transcript.messages) || "You are a helpful assistant.",
        };
      },
    },
  );
};

/** Routes generation and compaction through the live attachment, including after reattachment. */
export const parentModels = (
  models: Models,
  route: (
    attemptId: AttemptId,
    model: ModelId,
    signal: AbortSignal | undefined,
  ) => Promise<ParentGateway>,
  failed: (attemptId: AttemptId, cause: unknown) => Promise<void>,
  run: <A, E>(program: Effect.Effect<A, E>, signal?: AbortSignal) => Promise<A>,
): Models => {
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const sessionId = options?.sessionId;
    if (sessionId === undefined || !sessionId.startsWith(PREFIX))
      return models.streamSimple(model, context, options);
    const attemptId = AttemptId.make(sessionId.slice(PREFIX.length));
    const stream = createAssistantMessageEventStream();
    const forward = async () => {
      try {
        const gateway = await route(
          attemptId,
          ModelId.make(`${model.provider}/${model.id}`),
          options?.signal,
        );
        const events = gatewayStream(model, gateway, context, options, run);
        for await (const event of events) stream.push(event);
        stream.end(await events.result());
      } catch (cause) {
        const reason = options?.signal?.aborted === true ? "aborted" : "error";
        if (reason === "error") await failed(attemptId, cause);
        const error: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: reason,
          errorMessage:
            "The coordinator's model route could not be opened. Check the orchestrator's gateway logs.",
          timestamp: await run(Clock.currentTimeMillis),
        };
        stream.push({ type: "error", reason, error });
        stream.end(error);
      }
    };
    void forward();
    return stream;
  };
  const completeSimple: Models["completeSimple"] = (model, context, options) =>
    streamSimple(model, context, options).result();
  return {
    getProviders: models.getProviders.bind(models),
    getProvider: models.getProvider.bind(models),
    getModels: models.getModels.bind(models),
    getModel: models.getModel.bind(models),
    getModelsOfType: models.getModelsOfType.bind(models),
    getModelOfType: models.getModelOfType.bind(models),
    getAllModels: models.getAllModels.bind(models),
    refresh: models.refresh.bind(models),
    checkAuth: models.checkAuth.bind(models),
    getAvailable: models.getAvailable.bind(models),
    getAvailableOfType: models.getAvailableOfType.bind(models),
    getAllAvailable: models.getAllAvailable.bind(models),
    getAuth: models.getAuth.bind(models),
    login: models.login.bind(models),
    logout: models.logout.bind(models),
    stream: models.stream.bind(models),
    complete: models.complete.bind(models),
    streamDeferred: models.streamDeferred.bind(models),
    fetchDeferred: models.fetchDeferred.bind(models),
    cancelDeferred: models.cancelDeferred.bind(models),
    generateImages: models.generateImages.bind(models),
    classify: models.classify.bind(models),
    streamSimple,
    completeSimple,
  };
};
