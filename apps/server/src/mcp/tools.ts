import { InstanceScope, type PermissionGrant, permits } from "@usine/core/access";
import { Option, Result, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { ceilingAdmits, type OperationId } from "../auth/model.ts";
import { OperationPermission, PERMISSION_EXTENSION } from "../openapi.ts";

/** The OpenAPI group whose operations become tools. */
const TOOL_GROUP = "operator";
/** The largest tool result, in UTF-8 bytes, before it is truncated. */
export const MAX_RESULT_BYTES = 100_000;

const JsonSchema = Schema.JsonObject;
type JsonSchema = typeof JsonSchema.Type;
const Parameter = Schema.Struct({
  name: Schema.String,
  in: Schema.String,
  required: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  schema: Schema.optionalKey(JsonSchema),
});
const MediaType = Schema.Struct({ schema: Schema.optionalKey(JsonSchema) });
const Operation = Schema.Struct({
  operationId: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(Schema.Array(Parameter)),
  requestBody: Schema.optionalKey(
    Schema.Struct({
      required: Schema.optionalKey(Schema.Boolean),
      content: Schema.Record(Schema.String, MediaType),
    }),
  ),
  responses: Schema.Record(
    Schema.String,
    Schema.Struct({ content: Schema.optionalKey(Schema.Record(Schema.String, MediaType)) }),
  ),
  [PERMISSION_EXTENSION]: OperationPermission,
});
type Operation = typeof Operation.Type;
const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Method = (typeof METHODS)[number];
const HTTP_METHODS = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
} as const satisfies Record<Method, string>;

/** The parts of a published OpenAPI document that tool generation reads. */
export const PublishedApi = Schema.Struct({
  paths: Schema.Record(
    Schema.String,
    Schema.Struct(
      Object.fromEntries(METHODS.map((method) => [method, Schema.optionalKey(Operation)])),
    ),
  ),
  components: Schema.Struct({
    schemas: Schema.optionalKey(Schema.Record(Schema.String, JsonSchema)),
  }),
});
export type PublishedApi = typeof PublishedApi.Type;

/** One operator operation exposed as an MCP tool. */
export interface OperatorTool {
  readonly name: string;
  readonly operationId: OperationId | string;
  readonly method: (typeof HTTP_METHODS)[Method];
  /** The path template, such as `/api/runs/{runId}/approve`. */
  readonly path: string;
  readonly pathParameters: ReadonlyArray<string>;
  readonly queryParameters: ReadonlyArray<string>;
  readonly hasBody: boolean;
  readonly permission: OperationPermission;
  readonly descriptor: McpSchema.Tool;
}

const COMPONENT_PREFIX = "#/components/schemas/";

const isJsonObject = Schema.is(JsonSchema);
const isObject = (value: Schema.Json): value is JsonSchema => isJsonObject(value);
const componentName = (reference: Schema.Json | undefined) =>
  Schema.decodeUnknownOption(Schema.String)(reference).pipe(
    Option.filter((value) => value.startsWith(COMPONENT_PREFIX)),
    Option.map((value) => value.slice(COMPONENT_PREFIX.length)),
  );

/** The most objects and arrays that inlining builds for one input schema. */
const MAX_INLINED_NODES = 10_000;

/**
 * Returns `schema` with every component `$ref` replaced by its definition. Once `budget` runs out,
 * a `$ref` is left unresolved and accepts any value, so a document whose references fan out can't
 * make the expansion grow without bound.
 */
const inline = (
  schema: Schema.Json,
  components: Readonly<Record<string, JsonSchema>>,
  resolving: ReadonlySet<string>,
  budget: { remaining: number },
): Schema.Json => {
  if (Array.isArray(schema)) {
    budget.remaining -= 1;
    return schema.map((entry) => inline(entry, components, resolving, budget));
  }
  if (!isObject(schema)) return schema;
  budget.remaining -= 1;
  const { $ref, ...rest } = schema;
  const siblings = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [key, inline(value, components, resolving, budget)]),
  );
  const reference = componentName($ref);
  if (Option.isNone(reference)) return siblings;
  const name = reference.value;
  const target = components[name];
  // A recursive schema accepts any value at the point where it repeats.
  if (target === undefined || resolving.has(name) || budget.remaining <= 0) return siblings;
  const resolved = inline(target, components, new Set([...resolving, name]), budget);
  return isObject(resolved) ? { ...resolved, ...siblings } : siblings;
};

const inlineObject = (
  schema: JsonSchema | undefined,
  components: Readonly<Record<string, JsonSchema>>,
): JsonSchema => {
  if (schema === undefined) return {};
  const inlined = inline(schema, components, new Set(), { remaining: MAX_INLINED_NODES });
  return isObject(inlined) ? inlined : {};
};

const streams = (operation: Operation) =>
  Object.values(operation.responses).some(
    ({ content }) => content !== undefined && "text/event-stream" in content,
  );

const describe = (operation: Operation) =>
  [
    operation.summary,
    operation.description,
    `Requires ${operation[PERMISSION_EXTENSION]} permission.`,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .map((part) => (part.endsWith(".") ? part : `${part}.`))
    .join(" ");

/** Writes that discard, overwrite, or restart something without the DELETE or PUT method. */
const DESTRUCTIVE_WRITES: ReadonlySet<string> = new Set([
  "discardLeftovers",
  "requestUpgrade",
  "revertConfigurationRevision",
]);

const destructive = (method: Method, name: string) =>
  method === "delete" ||
  method === "put" ||
  name.startsWith("cancel") ||
  DESTRUCTIVE_WRITES.has(name);

const tool = (
  path: string,
  method: Method,
  operation: Operation,
  components: Readonly<Record<string, JsonSchema>>,
): OperatorTool => {
  const name = operation.operationId.slice(TOOL_GROUP.length + 1);
  const parameters = operation.parameters ?? [];
  const pathParameters = parameters.filter((parameter) => parameter.in === "path");
  const queryParameters = parameters.filter((parameter) => parameter.in === "query");
  const body = operation.requestBody?.content["application/json"];
  const properties: Record<string, JsonSchema> = {};
  for (const parameter of [...pathParameters, ...queryParameters]) {
    const inlined = inlineObject(parameter.schema, components);
    properties[parameter.name] =
      parameter.description === undefined
        ? inlined
        : { ...inlined, description: parameter.description };
  }
  if (body !== undefined)
    properties.body = {
      ...inlineObject(body.schema, components),
      description: "The JSON request body.",
    };
  const required = [
    ...pathParameters.map(({ name }) => name),
    ...queryParameters.filter(({ required }) => required === true).map(({ name }) => name),
  ];
  if (body !== undefined && operation.requestBody?.required === true) required.push("body");
  const readOnly = method === "get";
  return {
    name,
    operationId: operation.operationId,
    method: HTTP_METHODS[method],
    path,
    pathParameters: pathParameters.map(({ name }) => name),
    queryParameters: queryParameters.map(({ name }) => name),
    hasBody: body !== undefined,
    permission: operation[PERMISSION_EXTENSION],
    descriptor: McpSchema.Tool.make({
      name,
      title: operation.summary,
      description: describe(operation),
      inputSchema: {
        type: "object",
        properties,
        required: required.length === 0 ? undefined : required,
        additionalProperties: false,
      },
      annotations: {
        title: operation.summary,
        readOnlyHint: readOnly,
        destructiveHint: !readOnly && destructive(method, name),
        idempotentHint: readOnly || method === "put" || method === "delete",
        openWorldHint: false,
      },
    }),
  };
};

/**
 * Returns one tool for each operation of the operator group, named by its endpoint identifier.
 * Event streams are left out: a tool call needs a response that ends.
 */
export const operatorTools = (document: PublishedApi): ReadonlyArray<OperatorTool> =>
  Object.entries(document.paths)
    .flatMap(([path, item]) =>
      METHODS.flatMap((method) => {
        const operation = item[method];
        return operation !== undefined &&
          operation.operationId.startsWith(`${TOOL_GROUP}.`) &&
          !streams(operation)
          ? [tool(path, method, operation, document.components.schemas ?? {})]
          : [];
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

/**
 * Returns the tools that the grants and the operation ceiling permit. The server checks every call
 * again, including the project in its path.
 */
export const visibleTools = (
  tools: ReadonlyArray<OperatorTool>,
  grants: ReadonlyArray<PermissionGrant>,
  ceiling: Option.Option<ReadonlyArray<OperationId>>,
): ReadonlyArray<OperatorTool> =>
  tools.filter(
    ({ permission, operationId }) =>
      ceilingAdmits(ceiling, operationId) &&
      (permission === "public" ||
        permits(grants, "admin", InstanceScope.make()) ||
        ((permission === "read" || permission === "operate" || permission === "maintain") &&
          grants.some((grant) => grant.permission === permission))),
  );

/** An HTTP request that a tool call makes to the operator API. */
export interface OperatorRequest {
  readonly method: OperatorTool["method"];
  /** The path with its encoded parameters and query string. */
  readonly url: string;
  readonly body: Option.Option<Schema.Json>;
}

/** The status and body text of an operator API response. */
export interface OperatorResponse {
  readonly status: number;
  readonly text: string;
}

const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);

/** The arguments of a tool call. */
export const ToolArguments = Schema.Record(Schema.String, Schema.Json);
export type ToolArguments = typeof ToolArguments.Type;

/** Builds the request for a tool call, or fails with what is wrong with the arguments. */
export const operatorRequest = (
  tool: OperatorTool,
  args: ToolArguments,
): Result.Result<OperatorRequest, string> => {
  const known = new Set([
    ...tool.pathParameters,
    ...tool.queryParameters,
    ...(tool.hasBody ? ["body"] : []),
  ]);
  const unknown = Object.keys(args).filter((key) => !known.has(key));
  if (unknown.length > 0) return Result.fail(`Unknown arguments: ${unknown.join(", ")}.`);
  const scalar = (value: Schema.Json) =>
    Schema.decodeUnknownOption(Scalar)(value).pipe(Option.map(String));
  let path = tool.path;
  for (const name of tool.pathParameters) {
    const value = Option.flatMap(Option.fromUndefinedOr(args[name]), scalar);
    if (Option.isNone(value)) return Result.fail(`Pass ${name} as a string.`);
    path = path.replace(`{${name}}`, encodeURIComponent(value.value));
  }
  const query = new URLSearchParams();
  for (const name of tool.queryParameters) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      const text = scalar(entry);
      if (Option.isNone(text)) return Result.fail(`Pass ${name} as a string, number, or boolean.`);
      query.append(name, text.value);
    }
  }
  const search = query.toString();
  return Result.succeed({
    method: tool.method,
    url: search === "" ? path : `${path}?${search}`,
    body: tool.hasBody ? Option.fromUndefinedOr(args.body) : Option.none(),
  });
};

/** Operations that read part of what a large result holds, by the tool that returned it. */
const narrower = new Map([
  ["overview", "desk, project, or task"],
  ["project", "boardLaneItems"],
  ["projectTask", "taskRuns"],
  ["task", "taskRuns"],
  ["detail", "detail with the before and attempt cursors, or githubChanges"],
  ["configuration", "configurationEntity"],
  ["configurationRevisions", "configurationRevision"],
  ["statistics", "statistics with a shorter window"],
  ["runStatistics", "runStatistics with a shorter window"],
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Returns the tool result for a response: its JSON text, cut at the result limit. */
export const toolResult = (
  tool: OperatorTool,
  response: OperatorResponse,
): McpSchema.CallToolResult => {
  const isError = response.status < 200 || response.status >= 300;
  const text = isError ? `HTTP ${response.status}\n${response.text}` : response.text;
  const bytes = encoder.encode(text);
  if (bytes.length <= MAX_RESULT_BYTES)
    return McpSchema.CallToolResult.make({ isError, content: [{ type: "text", text }] });
  // The decoder replaces a code point split at the cut; the hint below says the text is incomplete.
  const kept = decoder.decode(bytes.subarray(0, MAX_RESULT_BYTES));
  const hint = `[usine truncated this result at ${MAX_RESULT_BYTES} of ${bytes.length} bytes. Call ${narrower.get(tool.name) ?? "an operation that reads a single project, task, or run"} to read less.]`;
  return McpSchema.CallToolResult.make({
    isError,
    content: [
      { type: "text", text: kept },
      { type: "text", text: hint },
    ],
  });
};
