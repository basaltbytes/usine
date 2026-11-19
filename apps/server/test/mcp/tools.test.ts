import { jsonKey } from "@usine/core/json-key";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { operatorOpenApi } from "../../src/openapi.ts";
import { PAGE_BYTES } from "@usine/orchestrator/operator";
import {
  MAX_ERROR_BYTES,
  MAX_RESULT_BYTES,
  operatorRequest,
  operatorTools,
  PublishedApi,
  toolResult,
} from "../../src/mcp/tools.ts";

const tools = Effect.map(
  Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi()),
  (document) => operatorTools(document).tools,
).pipe(Effect.orDie);

// Each level references the next twice, so full inlining of `Level0` would build 2^22 objects.
const LEVELS = 22;
const fanOutSchemas = Object.fromEntries(
  Array.from({ length: LEVELS }, (_, level) => [
    `Level${level}`,
    level === LEVELS - 1
      ? { type: "string" }
      : {
          type: "object",
          properties: {
            left: { $ref: `#/components/schemas/Level${level + 1}` },
            right: { $ref: `#/components/schemas/Level${level + 1}` },
          },
        },
  ]),
);

describe("operator MCP tools", () => {
  it.effect("encodes path and query arguments and refuses unknown ones", () =>
    Effect.gen(function* () {
      const detail = (yield* tools).find(({ name }) => name === "detail");
      assert.isDefined(detail);
      if (detail === undefined) return;
      const request = operatorRequest(detail, { runId: "run/1", after: 3 });
      assert.isTrue(Result.isSuccess(request));
      if (Result.isSuccess(request)) {
        assert.equal(request.success.method, "GET");
        assert.equal(request.success.url, "/api/runs/run%2F1?after=3");
      }
      assert.isTrue(Result.isFailure(operatorRequest(detail, { after: 3 })));
      assert.isTrue(Result.isFailure(operatorRequest(detail, { runId: "run-1", other: 1 })));
    }),
  );

  it.effect(
    "keeps a result at the limit and cuts one just over it, naming how to read the rest",
    () =>
      Effect.gen(function* () {
        const generated = yield* tools;
        const tool = (name: string) => {
          const found = generated.find((tool) => tool.name === name);
          assert(found !== undefined, name);
          return found;
        };
        const texts = (result: ReturnType<typeof toolResult>) =>
          result.content.map((part) => (part.type === "text" ? part.text : ""));
        // Claude Code saves a result over 50,000 characters to a file, and Codex keeps about
        // 10,000 tokens of one; JSON of IDs and timestamps takes about 2.4 bytes per token.
        assert.isAtMost(MAX_RESULT_BYTES, 24_000);
        // A paged read's page fits in one result.
        assert.isAtMost(PAGE_BYTES + 2_000, MAX_RESULT_BYTES);
        const at = jsonKey({ projects: "x".repeat(MAX_RESULT_BYTES - 15) });
        assert.equal(at.length, MAX_RESULT_BYTES);
        assert.deepEqual(texts(toolResult(tool("overview"), { status: 200, text: at })), [at]);
        const over = `${at} `;
        const cases = [
          ["overview", "Read a lane's cards with boardLaneItems and one task with task."],
          ["task", "Read the task's runs with taskRuns and an item's text with item."],
          ["boardLaneItems", "Call boardLaneItems again from a larger offset."],
          ["serverVersion", "No operation reads the rest in smaller parts."],
        ] as const;
        for (const [name, rest] of cases) {
          const result = toolResult(tool(name), { status: 200, text: over });
          assert.isFalse(result.isError);
          assert.deepEqual(texts(result), [
            at,
            `[usine cut this result at ${MAX_RESULT_BYTES} of ${MAX_RESULT_BYTES + 1} bytes, so its JSON is incomplete. ${rest}]`,
          ]);
        }
        const cut = toolResult(tool("overview"), { status: 200, text: "x".repeat(25_000) });
        assert.lengthOf(cut.content, 2);
        const small = toolResult(tool("overview"), {
          status: 403,
          text: '{"error":"AccessDenied"}',
        });
        assert.isTrue(small.isError);
        assert.lengthOf(small.content, 1);
      }),
  );

  it.effect("cuts an error result at the error limit", () =>
    Effect.gen(function* () {
      const overview = (yield* tools).find(({ name }) => name === "overview");
      assert(overview !== undefined);
      const text = "e".repeat(MAX_ERROR_BYTES * 2);
      const result = toolResult(overview, { status: 500, text });
      assert.isTrue(result.isError);
      const [kept, note] = result.content.map((part) => (part.type === "text" ? part.text : ""));
      assert.equal(kept, `HTTP 500\n${text}`.slice(0, MAX_ERROR_BYTES));
      assert.equal(
        note,
        `[usine cut this error at ${MAX_ERROR_BYTES} of ${text.length + 9} bytes.]`,
      );
    }),
  );

  it.effect("shares one inlining budget across every input schema of the document", () =>
    Effect.gen(function* () {
      // Every parameter and body references the chain, so a budget for each schema would build
      // tens of megabytes; the shared budget keeps the whole tool list small.
      const level0 = { $ref: "#/components/schemas/Level0" };
      const parameters = Array.from({ length: 30 }, (_, index) => ({
        name: `p${index}`,
        in: "query",
        schema: level0,
      }));
      const document = yield* Schema.decodeEffect(PublishedApi)({
        paths: Object.fromEntries(
          Array.from({ length: 3 }, (_, index) => [
            `/api/fan-out-${index}`,
            {
              post: {
                operationId: `operator.fanOut${index}`,
                parameters,
                requestBody: { content: { "application/json": { schema: level0 } } },
                responses: { "200": {} },
                "x-usine-permission": "operate",
              },
            },
          ]),
        ),
        components: { schemas: fanOutSchemas },
      });
      const generated = operatorTools(document);
      assert.lengthOf(generated.tools, 3);
      assert.isFalse(generated.complete);
      const size = generated.tools.reduce(
        (total, { descriptor }) => total + jsonKey(descriptor.inputSchema).length,
        0,
      );
      assert.isBelow(size, 1_000_000);
      assert.include(jsonKey(generated.tools[0]?.descriptor.inputSchema ?? {}), '"left"');
    }),
  );

  it.effect("charges the budget for the array entries and strings that inlining copies", () =>
    Effect.gen(function* () {
      // Each component is small, but 1,000 references copy it 1,000 times: about 4 MB of `enum`
      // entries or 2 MB of description if the budget counted only objects.
      const repeated = (component: string) =>
        Schema.decodeEffect(PublishedApi)({
          paths: {
            "/api/large": {
              get: {
                operationId: "operator.large",
                parameters: Array.from({ length: 1_000 }, (_, index) => ({
                  name: `p${index}`,
                  in: "query",
                  schema: { $ref: `#/components/schemas/${component}` },
                })),
                responses: { "200": {} },
                "x-usine-permission": "read",
              },
            },
          },
          components: {
            schemas: {
              Enum: { type: "integer", enum: Array.from({ length: 2_000 }, () => 0) },
              Text: { type: "string", description: "x".repeat(2_000) },
            },
          },
        });
      for (const [component, copied] of [
        ["Enum", '"enum"'],
        ["Text", "x".repeat(2_000)],
      ] as const) {
        const document = yield* repeated(component);
        const generated = operatorTools(document);
        const schema = jsonKey(generated.tools[0]?.descriptor.inputSchema ?? {});
        assert.isFalse(generated.complete, component);
        assert.include(schema, copied, component);
        assert.isBelow(schema.length, 1_000_000, component);
      }
    }),
  );

  it.effect("stops resolving references nested deeper than the depth limit", () =>
    Effect.gen(function* () {
      // `Link0` references `Link1`, and so on; each bare `$ref` costs the budget almost nothing.
      const chain = (length: number) =>
        Schema.decodeEffect(PublishedApi)({
          paths: {
            "/api/chain": {
              get: {
                operationId: "operator.chain",
                parameters: [
                  { name: "link", in: "query", schema: { $ref: "#/components/schemas/Link0" } },
                ],
                responses: { "200": {} },
                "x-usine-permission": "read",
              },
            },
          },
          components: {
            schemas: Object.fromEntries(
              Array.from({ length }, (_, index) => [
                `Link${index}`,
                index === length - 1
                  ? { type: "string" }
                  : { $ref: `#/components/schemas/Link${index + 1}` },
              ]),
            ),
          },
        }).pipe(Effect.map(operatorTools));
      const linkSchema = ({ tools }: ReturnType<typeof operatorTools>) =>
        tools[0]?.descriptor.inputSchema.properties?.["link"];
      const resolved = yield* chain(32);
      assert.isTrue(resolved.complete);
      assert.deepStrictEqual(linkSchema(resolved), { type: "string" });
      const cut = yield* chain(33);
      assert.isFalse(cut.complete);
      assert.deepStrictEqual(linkSchema(cut), {});
      // Without the limit, 5,000 levels overflow the stack.
      const long = yield* chain(5_000);
      assert.isFalse(long.complete);
      assert.lengthOf(long.tools, 1);
    }),
  );

  it.effect("replaces arrays and objects nested deeper than the nesting limit", () =>
    Effect.gen(function* () {
      const decode = (
        schema: Schema.JsonObject,
        schemas: Readonly<Record<string, Schema.JsonObject>> = {},
      ) =>
        Schema.decodeEffect(PublishedApi)({
          paths: {
            "/api/nested": {
              get: {
                operationId: "operator.nested",
                parameters: [{ name: "value", in: "query", schema }],
                responses: { "200": {} },
                "x-usine-permission": "read",
              },
            },
          },
          components: { schemas },
        }).pipe(Effect.map(operatorTools));
      const valueSchema = ({ tools }: ReturnType<typeof operatorTools>) =>
        tools[0]?.descriptor.inputSchema.properties?.["value"];
      // `levels` objects inside one another around `inner`, with no `$ref`.
      const nested = (levels: number, inner: Schema.JsonObject): Schema.JsonObject =>
        Array.from({ length: levels }).reduce<Schema.JsonObject>((items) => ({ items }), inner);
      const fits = yield* decode(nested(63, { type: "string" }));
      assert.isTrue(fits.complete);
      assert.deepStrictEqual(valueSchema(fits), nested(63, { type: "string" }));
      const cut = yield* decode(nested(64, { type: "string" }));
      assert.isFalse(cut.complete);
      assert.deepStrictEqual(valueSchema(cut), nested(64, {}));
      // Without the limit, 5,000 levels overflow the stack.
      const deep = yield* decode(nested(5_000, { type: "string" }));
      assert.isFalse(deep.complete);
      assert.lengthOf(deep.tools, 1);
      // 32 chained components, each 100 levels deep: the reference depth alone allows them all.
      const chained = yield* decode(
        { $ref: "#/components/schemas/Level0" },
        Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [
            `Level${index}`,
            nested(100, index === 31 ? {} : { $ref: `#/components/schemas/Level${index + 1}` }),
          ]),
        ),
      );
      assert.isFalse(chained.complete);
      assert.lengthOf(chained.tools, 1);
      // Each array entry nests one level deeper too: without that, 5,000 arrays overflow the stack.
      const arrays = yield* decode({
        enum: Array.from({ length: 5_000 }).reduce<Schema.Json>((entry) => [entry], 0),
      });
      assert.isFalse(arrays.complete);
      assert.lengthOf(arrays.tools, 1);
      // A resolved `$ref` keeps its level, so the limit counts across references: 32 levels, then
      // a component of 31 levels, fit; one more level is cut.
      const across = (inner: number) =>
        decode(
          { $ref: "#/components/schemas/Outer" },
          {
            Outer: nested(32, { $ref: "#/components/schemas/Inner" }),
            Inner: nested(inner, { type: "string" }),
          },
        );
      const acrossFits = yield* across(31);
      assert.isTrue(acrossFits.complete);
      assert.deepStrictEqual(valueSchema(acrossFits), nested(63, { type: "string" }));
      const acrossCut = yield* across(32);
      assert.isFalse(acrossCut.complete);
      assert.deepStrictEqual(valueSchema(acrossCut), nested(64, {}));
      // 32 chained components that each nest 63 levels before the next `$ref`: the count must not
      // restart at each reference.
      const justUnder = yield* decode(
        { $ref: "#/components/schemas/Level0" },
        Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [
            `Level${index}`,
            nested(63, index === 31 ? {} : { $ref: `#/components/schemas/Level${index + 1}` }),
          ]),
        ),
      );
      assert.isFalse(justUnder.complete);
      assert.lengthOf(justUnder.tools, 1);
      // Inlining checks each object once, not its whole subtree at every level. The document is
      // built already decoded, since decoding walks all 200,000 levels.
      const document = yield* Schema.decodeEffect(PublishedApi)({
        paths: {
          "/api/nested": {
            get: {
              operationId: "operator.nested",
              parameters: [{ name: "value", in: "query", schema: {} }],
              responses: { "200": {} },
              "x-usine-permission": "read",
            },
          },
        },
        components: {},
      });
      const get = document.paths["/api/nested"]?.get;
      assert.isDefined(get);
      const wide: PublishedApi = {
        ...document,
        paths: {
          "/api/nested": {
            get: {
              ...get,
              parameters: [
                { name: "value", in: "query", schema: nested(200_000, { type: "string" }) },
              ],
            },
          },
        },
      };
      const started = performance.now();
      const shallow = operatorTools(wide);
      assert.isBelow(performance.now() - started, 1_000);
      assert.isFalse(shallow.complete);
    }).pipe(Effect.orDie),
  );

  it.effect("inlines the real document completely within the budget", () =>
    Effect.gen(function* () {
      const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi());
      assert.isTrue(operatorTools(document).complete);
    }).pipe(Effect.orDie),
  );
});
