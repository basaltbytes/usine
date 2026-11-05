import { Schema } from "effect";
import { UsageCount } from "../../protocol/count.ts";

const base = { sessionID: Schema.NonEmptyString };
const tool = { ...base, assistantMessageID: Schema.NonEmptyString, id: Schema.String };
const event = <const T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), data: Schema.Struct(fields) });
const ErrorInfo = Schema.Struct({ type: Schema.String, message: Schema.String });
const Usage = {
  ...base,
  assistantMessageID: Schema.NonEmptyString,
  cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  tokens: Schema.Struct({
    input: UsageCount,
    output: UsageCount,
    reasoning: UsageCount,
    cache: Schema.Struct({ read: UsageCount, write: UsageCount }),
  }),
};

export const OpenCodeEvent = Schema.Union([
  event("server.connected", {}),
  event("session.text.ended", {
    ...base,
    assistantMessageID: Schema.NonEmptyString,
    text: Schema.String,
  }),
  event("session.tool.input.started", { ...tool, name: Schema.NonEmptyString }),
  event("session.tool.called", { ...tool, input: Schema.Json }),
  event("session.tool.success", { ...tool, content: Schema.Json }),
  event("session.tool.failed", { ...tool, error: ErrorInfo }),
  event("session.step.ended", Usage),
  event("session.step.failed", {
    ...base,
    error: ErrorInfo,
    cost: Schema.optionalKey(Usage.cost),
    tokens: Schema.optionalKey(Usage.tokens),
    assistantMessageID: Schema.NonEmptyString,
  }),
  event("session.retry.scheduled", { ...base, attempt: UsageCount, error: ErrorInfo }),
  event("session.execution.succeeded", base),
  event("session.execution.failed", { ...base, error: ErrorInfo }),
  event("session.execution.interrupted", base),
  event("session.inbox.delivered", { ...base, inboxID: Schema.String }),
  event("permission.asked", { ...base, id: Schema.String }),
]);
export type OpenCodeEvent = typeof OpenCodeEvent.Type;
export const EventHeader = Schema.Struct({ type: Schema.String });

export const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      providerID: Schema.String,
      enabled: Schema.Boolean,
      variants: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

export const Integrations = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      connections: Schema.Array(
        Schema.Union([
          Schema.Struct({ type: Schema.Literal("env") }),
          Schema.Struct({
            type: Schema.Literal("credential"),
            method: Schema.Literals(["key", "oauth", "external"]),
          }),
        ]),
      ),
    }),
  ),
});

export const SessionCreated = Schema.Struct({ data: Schema.Struct({ id: Schema.NonEmptyString }) });
