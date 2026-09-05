import { Option, Schema, SchemaIssue } from "effect";

const encoder = new TextEncoder();
const SAFE_TAG_VALUES = [
  "Started",
  "SessionEvent",
  "Final",
  "Failed",
  "Interrupted",
  "SessionStarted",
  "TextOutput",
  "ToolStarted",
  "ToolFinished",
  "PoolRateLimitsUpdated",
  "SessionFinished",
] as const;
const SafeFrameTag = Schema.Literals(SAFE_TAG_VALUES);
const FramePreview = Schema.Struct({
  version: Schema.optionalKey(Schema.Int),
  payload: Schema.optionalKey(
    Schema.Struct({
      _tag: Schema.optionalKey(Schema.String),
      event: Schema.optionalKey(Schema.Struct({ _tag: Schema.optionalKey(Schema.String) })),
    }),
  ),
});
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeFramePreviewOption = Schema.decodeUnknownOption(FramePreview);
const decodeSafeFrameTagOption = Schema.decodeUnknownOption(SafeFrameTag);
const SAFE_PATH_SEGMENTS = new Set([
  "version",
  "attemptId",
  "sequence",
  "sentAt",
  "payload",
  "_tag",
  "event",
  "session",
  "id",
  "parentId",
  "agent",
  "brain",
  "harness",
  "model",
  "effort",
  "callId",
  "tool",
  "input",
  "output",
  "isError",
  "text",
  "pool",
  "rateLimits",
  "limitId",
  "limitName",
  "primary",
  "secondary",
  "usedPercent",
  "windowDurationMinutes",
  "resetsAt",
  "parentModel",
  "parentEffort",
  "result",
  "failure",
]);

type FrameSource = "effect-log" | "json" | "non-json";

export interface InvalidFrameDiagnostic {
  readonly byteLength: number;
  readonly eventTag: string | undefined;
  readonly issues: ReadonlyArray<{
    readonly message: string;
    readonly path: string;
  }>;
  readonly payloadTag: string | undefined;
  readonly source: FrameSource;
  readonly version: number | undefined;
}

const formatSchemaIssues = SchemaIssue.makeFormatterStandardSchemaV1();
type FormattedIssuePath = NonNullable<
  ReturnType<typeof formatSchemaIssues>["issues"][number]["path"]
>;

const safeIssuePath = (path: FormattedIssuePath): string =>
  path
    .map((segment) => {
      const value = String(segment);
      return SAFE_PATH_SEGMENTS.has(value) ? value : "<unexpected>";
    })
    .join(".");

/** Describes an invalid frame by shape and schema metadata only, never by its content. */
export const invalidFrameDiagnostic = (line: string, cause: unknown): InvalidFrameDiagnostic => {
  const byteLength = encoder.encode(line).byteLength;
  const parsed = decodeJsonOption(line);
  if (Option.isNone(parsed)) {
    return {
      byteLength,
      eventTag: undefined,
      issues: [],
      payloadTag: undefined,
      source: /^\[\d{2}:\d{2}:\d{2}[.\]]/u.test(line) ? "effect-log" : "non-json",
      version: undefined,
    };
  }
  const preview = decodeFramePreviewOption(parsed.value);
  const issues = Schema.isSchemaError(cause)
    ? formatSchemaIssues(cause.issue).issues.map((issue) => ({
        message: issue.message.slice(0, 200),
        path: safeIssuePath(issue.path ?? []),
      }))
    : [];
  return {
    byteLength,
    eventTag: Option.flatMap(preview, ({ payload }) =>
      decodeSafeFrameTagOption(payload?.event?._tag),
    ).pipe(Option.getOrUndefined),
    issues,
    payloadTag: Option.flatMap(preview, ({ payload }) =>
      decodeSafeFrameTagOption(payload?._tag),
    ).pipe(Option.getOrUndefined),
    source: "json",
    version: Option.map(preview, ({ version }) => version).pipe(Option.getOrUndefined),
  };
};

export const invalidFrameMessage = (diagnostic: InvalidFrameDiagnostic): string => {
  if (diagnostic.source !== "json") {
    return diagnostic.source === "effect-log"
      ? "The run host wrote a log line to its protocol output"
      : "The run host emitted malformed JSON";
  }
  const first = diagnostic.issues[0];
  return first === undefined
    ? "The run host emitted a schema-invalid frame"
    : `The run host emitted a schema-invalid frame at ${first.path || "<root>"}: ${first.message}`;
};
