import {
  Cause,
  Effect,
  Hash,
  type JsonSchema,
  Option,
  Predicate,
  Result,
  Schema,
  Stream,
} from "effect";
import { AiError, Tool, type Toolkit } from "effect/ai";

/** The services that serving `Tools` to a session needs: each tool's handler and its services. */
export type HostToolServices<Tools extends Record<string, Tool.Any>> =
  | Tool.HandlersFor<Tools>
  | Tool.HandlerServices<Tools[keyof Tools]>;

/** What a usine tool call returns to the model. A failed call is a result, not an error. */
export interface HostToolResult {
  readonly isError: boolean;
  /** The encoded result, or the failure, as the model reads it. */
  readonly text: string;
}

/** One usine tool, with its handler bound to the context of the role that opened the session. */
interface HostTool {
  /** The toolkit's name for the tool, which session events carry. */
  readonly name: string;
  readonly description: string;
  /** The JSON Schema of the parameters, with an object root. */
  readonly parameters: JsonSchema.JsonSchema;
  /**
   * Decodes `input` and runs the handler. A parameter, handler, or result failure, or a handler
   * defect, returns an error result; only interruption ends the effect without a result.
   */
  readonly call: (
    input: Schema.Json,
    callId: Option.Option<string>,
  ) => Effect.Effect<HostToolResult>;
}

/** The usine tools of one session, in toolkit order. */
export interface HostToolSet {
  readonly tools: ReadonlyArray<HostTool>;
}

/** A session without usine tools. */
export const noHostTools: HostToolSet = { tools: [] };

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Returns a JSON value as the model reads it: a string as is, anything else as JSON. */
const jsonText = (json: Schema.Json | undefined) =>
  Predicate.isString(json)
    ? Effect.succeed(json)
    : encodeJson(json ?? null).pipe(Effect.orElseSucceed(() => String(json)));

/**
 * A typed failure of a tool call: an `AiError` for invalid parameters or results, or a value of
 * the tool's failure schema, which is an error or a JSON-shaped value.
 */
type ToolFailure = AiError.AiError | Error | Schema.Json;

/** What a handler returns, or a typed failure of the call. */
type ToolOutcome = Tool.HandlerResult<Tool.Any>["result"] | ToolFailure;

/** The `callId` log and span field of a call that the harness identified. */
const callIdField = (callId: Option.Option<string>) =>
  Option.match(callId, { onNone: () => ({}), onSome: (id) => ({ callId: id }) });

/** Encodes a value of one of a tool's schemas as JSON. */
type JsonEncoder = (value: ToolOutcome) => Effect.Effect<Schema.Json, Schema.SchemaError>;

/**
 * Binds every tool of `toolkit` to the handlers and services of the calling context, so the role
 * that opens a session decides what each call can reach.
 */
export const hostToolSet = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Effect.Effect<HostToolSet, never, HostToolServices<Tools>> =>
  Effect.gen(function* () {
    const built = yield* toolkit;
    const context = yield* Effect.context<Tool.HandlerServices<Tools[keyof Tools]>>();
    // SAFETY: `handle` decodes the parameters itself, and `call` passes it the encoded form of
    // parameters that the tool's JSON codec decoded.
    const handle = built.handle as (
      name: string,
      params: Tool.Parameters<Tool.Any>,
      toolCallId?: string,
    ) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>, ToolFailure>, AiError.AiError>;
    const bind = (tool: Tool.Any): HostTool => {
      // The model reads and writes JSON, while `handle` decodes the parameters and encodes the
      // result with the tool's own schemas, whose encoded side may not be JSON. Each call
      // crosses between the two through the schemas' JSON codecs.
      // SAFETY: the schemas' encoding and decoding services are handler services, which
      // `context` provides.
      const decodeParameters = Schema.decodeUnknownEffect(
        Schema.toCodecJson(tool.parametersSchema),
      ) as (input: Schema.Json) => Effect.Effect<Tool.Parameters<Tool.Any>, Schema.SchemaError>;
      // SAFETY: as above.
      const encodeParameters = Schema.encodeUnknownEffect(tool.parametersSchema) as (
        params: Tool.Parameters<Tool.Any>,
      ) => Effect.Effect<Tool.Parameters<Tool.Any>, Schema.SchemaError>;
      // SAFETY: as above.
      const encodeSuccess = Schema.encodeUnknownEffect(
        Schema.toCodecJson(tool.successSchema),
      ) as JsonEncoder;
      // SAFETY: as above.
      const encodeFailure = Schema.encodeUnknownEffect(
        Schema.toCodecJson(Tool.failureResultSchema(tool)),
      ) as JsonEncoder;
      /**
       * The text of a failure. A tool that returns its failures returns their encoded value; any
       * other tool returns an error's own message, else its encoded value.
       */
      const failureText = (failure: ToolOutcome) =>
        tool.failureMode === "error" && Predicate.isError(failure) && failure.message !== ""
          ? Effect.succeed(failure.message)
          : encodeFailure(failure).pipe(
              Effect.flatMap(jsonText),
              Effect.orElseSucceed(() => String(failure)),
            );
      const failed = Effect.fnUntraced(function* (failure: ToolOutcome) {
        const text = yield* failureText(failure);
        yield* Effect.logInfo("Usine tool call failed", { tool: tool.name, message: text });
        return { isError: true, text } satisfies HostToolResult;
      });
      return {
        name: tool.name,
        description: Tool.getDescription(tool) ?? tool.name,
        parameters: Tool.getJsonSchema(tool),
        call: Effect.fn("HostTools.call")(
          function* (input: Schema.Json, callId: Option.Option<string>) {
            yield* Effect.annotateCurrentSpan({ tool: tool.name, ...callIdField(callId) });
            const params = yield* decodeParameters(input).pipe(
              Effect.flatMap(encodeParameters),
              Effect.result,
            );
            if (Result.isFailure(params))
              return yield* failed(
                AiError.make({
                  module: "Toolkit",
                  method: `${tool.name}.handle`,
                  reason: AiError.ToolParameterValidationError.make({
                    toolName: tool.name,
                    description: params.failure.message,
                  }),
                }),
              );
            const last = yield* handle(
              tool.name,
              params.success,
              Option.getOrUndefined(callId),
            ).pipe(Stream.unwrap, Stream.runLast, Effect.result);
            if (Result.isFailure(last)) return yield* failed(last.failure);
            if (Option.isNone(last.success))
              return yield* failed(new Error(`The ${tool.name} tool returned no result`));
            const outcome = last.success.value;
            if (outcome.isFailure) return yield* failed(outcome.result);
            const encoded = yield* Effect.result(encodeSuccess(outcome.result));
            if (Result.isFailure(encoded)) {
              yield* Effect.logError("Usine tool returned a result that is not JSON", {
                tool: tool.name,
                message: encoded.failure.message,
              });
              return {
                isError: true,
                text: `The ${tool.name} tool returned a result that is not JSON`,
              };
            }
            return { isError: false, text: yield* jsonText(encoded.success) };
          },
          (effect, _input, callId) =>
            effect.pipe(
              Effect.onInterrupt(() =>
                Effect.logInfo("Usine tool call was cancelled", {
                  tool: tool.name,
                  ...callIdField(callId),
                }),
              ),
              Effect.catchDefect((defect) =>
                Effect.logError("Usine tool handler died", {
                  tool: tool.name,
                  cause: Cause.pretty(Cause.die(defect)),
                }).pipe(
                  Effect.as({ isError: true, text: `The ${tool.name} tool failed internally` }),
                ),
              ),
              Effect.provideContext(context),
            ),
        ),
      };
    };
    const tools = Object.values(built.tools).map(bind);
    yield* Effect.logDebug("Bound usine tools to the session", {
      tools: tools.map(({ name }) => name).join(","),
    });
    return { tools };
  }).pipe(Effect.withSpan("HostTools.make"));

/** What names a harness accepts for a tool. */
export interface ToolNameRule {
  /** The longest name that the harness accepts, after any prefix it adds. */
  readonly maxLength: number;
  /** Names that the harness's own tools take. */
  readonly reserved: ReadonlySet<string>;
}

/** Maps toolkit names to the names that a harness carries, and back. */
export interface HostToolNames {
  /** The name that the harness carries for the toolkit name `name`. */
  readonly alias: (name: string) => string;
  /** The toolkit name of the harness name `alias`, or `None` for a tool outside the toolkit. */
  readonly name: (alias: string) => Option.Option<string>;
}

const CARRIED = /^[A-Za-z0-9_-]+$/;

/**
 * Names `tools` for a harness. A name that the harness accepts is kept; any other name gets a
 * stable alias: its accepted characters, cut to fit, and a hash of the full name. Dies when two
 * names share an alias or an alias takes a reserved name, which only a toolkit definition causes.
 */
export const hostToolNames = Effect.fn("HostTools.names")(function* (
  tools: HostToolSet,
  rule: ToolNameRule,
) {
  const aliases = new Map<string, string>();
  const names = new Map<string, string>();
  for (const { name } of tools.tools) {
    const kept = CARRIED.test(name) && name.length <= rule.maxLength && !rule.reserved.has(name);
    const suffix = `_${(Hash.string(name) >>> 0).toString(36)}`;
    const alias = kept
      ? name
      : `${name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, rule.maxLength - suffix.length)}${suffix}`;
    const taken = names.get(alias);
    if (taken !== undefined || rule.reserved.has(alias))
      return yield* Effect.die(
        new Error(`The tool names "${taken ?? alias}" and "${name}" share the alias "${alias}"`),
      );
    if (!kept) yield* Effect.logInfo("Aliased a usine tool name", { tool: name, alias });
    aliases.set(name, alias);
    names.set(alias, name);
  }
  return {
    alias: (name: string) => aliases.get(name) ?? name,
    name: (alias: string) => Option.fromUndefinedOr(names.get(alias)),
  } satisfies HostToolNames;
});

/**
 * Parses the arguments of a harness's tool call. Returns `None` for a value that isn't JSON, such
 * as a number out of range, which `JSON.parse` reads as `Infinity`.
 */
export const decodeHostToolInput = Schema.decodeUnknownOption(Schema.Json);

/**
 * Runs the call of the tool that the harness names `alias`. A name outside the toolkit, or an
 * input that `decodeHostToolInput` refused, returns an error result, so the model can correct
 * the call.
 */
export const callHostTool = (tools: HostToolSet, names: HostToolNames) => {
  const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  return (alias: string, input: Option.Option<Schema.Json>, callId: Option.Option<string>) =>
    Option.match(
      Option.flatMap(names.name(alias), (name) => Option.fromUndefinedOr(byName.get(name))),
      {
        onNone: () =>
          Effect.logWarning("Session called a tool outside its usine tool set", {
            tool: alias,
          }).pipe(
            Effect.as<HostToolResult>({ isError: true, text: `No usine tool is named ${alias}` }),
          ),
        onSome: (tool) =>
          Option.match(input, {
            onNone: () =>
              Effect.logWarning("Session called a usine tool with an input that is not JSON", {
                tool: tool.name,
              }).pipe(
                Effect.as<HostToolResult>({ isError: true, text: "The tool input is not JSON" }),
              ),
            onSome: (json) => tool.call(json, callId),
          }),
      },
    );
};
