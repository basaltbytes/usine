import { jsonKey } from "@usine/core/json-key";
import { OperatorApi, operatorPermissions } from "@usine/orchestrator/operator/http";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { AuthApi } from "../../src/auth/api.ts";
import { operatorOpenApi } from "../../src/openapi.ts";
import { SetupApi } from "../../src/setup/api.ts";
import {
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
  it.effect("names one tool per operator operation, leaves out streams, and inlines schemas", () =>
    Effect.gen(function* () {
      const generated = yield* tools;
      const names = generated.map(({ name }) => name);
      assert.sameMembers(
        names,
        Object.keys(OperatorApi.groups.operator.endpoints).filter((name) => name !== "changes"),
      );
      for (const name of [...Object.keys(AuthApi.endpoints), ...Object.keys(SetupApi.endpoints)])
        if (!(name in OperatorApi.groups.operator.endpoints))
          assert.notInclude(names, name, `${name} is not an operator operation`);
      assert.notInclude(names, "openapi");
      const permissions = new Map(Object.entries(operatorPermissions));
      for (const tool of generated) {
        assert.notInclude(jsonKey(tool.descriptor.inputSchema), "$ref", tool.name);
        assert.equal(tool.permission, permissions.get(tool.name));
      }
      const approve = generated.find(({ name }) => name === "approve");
      assert.deepEqual(approve?.descriptor.inputSchema.required, ["runId"]);
      assert.isFalse(approve?.descriptor.annotations?.readOnlyHint);
      assert.isFalse(approve?.descriptor.annotations?.destructiveHint);
      const cancel = generated.find(({ name }) => name === "cancel");
      assert.isTrue(cancel?.descriptor.annotations?.destructiveHint);
      for (const name of [
        "deleteConfigurationEntity",
        "discardLeftovers",
        "replaceConfigurationEntity",
        "revertConfigurationRevision",
        "requestUpgrade",
      ]) {
        const write = generated.find((tool) => tool.name === name);
        assert.isTrue(write?.descriptor.annotations?.destructiveHint, name);
      }
      const overview = generated.find(({ name }) => name === "overview");
      assert.isTrue(overview?.descriptor.annotations?.readOnlyHint);
      const editAndRetry = generated.find(({ name }) => name === "editAndRetry");
      const body = editAndRetry?.descriptor.inputSchema.properties?.body;
      assert.isObject(body);
      assert.include(jsonKey(body), '"properties"');
    }),
  );

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

  it.effect("truncates an overview result over the cap and names a narrower operation", () =>
    Effect.gen(function* () {
      const overview = (yield* tools).find(({ name }) => name === "overview");
      assert.isDefined(overview);
      if (overview === undefined) return;
      const text = jsonKey({ projects: "x".repeat(MAX_RESULT_BYTES * 2) });
      const result = toolResult(overview, { status: 200, text });
      assert.isFalse(result.isError);
      const [kept, hint] = result.content;
      assert.equal(kept?.type, "text");
      assert.equal(kept?.type === "text" ? kept.text : "", text.slice(0, MAX_RESULT_BYTES));
      assert.include(hint?.type === "text" ? hint.text : "", "Call desk, project, or task");
      const small = toolResult(overview, { status: 403, text: '{"error":"AccessDenied"}' });
      assert.isTrue(small.isError);
      assert.lengthOf(small.content, 1);
    }),
  );

  it.effect("bounds the inlined schema of references that fan out", () =>
    Effect.gen(function* () {
      const document = yield* Schema.decodeEffect(PublishedApi)({
        paths: {
          "/api/fan-out": {
            post: {
              operationId: "operator.fanOut",
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Level0" } },
                },
              },
              responses: { "200": {} },
              "x-usine-permission": "operate",
            },
          },
        },
        components: { schemas: fanOutSchemas },
      });
      const generated = operatorTools(document);
      const [fanOut] = generated.tools;
      const size = jsonKey(fanOut?.descriptor.inputSchema ?? {}).length;
      assert.isBelow(size, 2_000_000);
      assert.include(jsonKey(fanOut?.descriptor.inputSchema ?? {}), '"left"');
      assert.isFalse(generated.complete);
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
    }),
  );

  it.effect("inlines the real document completely within the budget", () =>
    Effect.gen(function* () {
      const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi());
      assert.isTrue(operatorTools(document).complete);
    }).pipe(Effect.orDie),
  );
});
