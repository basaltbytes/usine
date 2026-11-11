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
  operatorTools,
).pipe(Effect.orDie);

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
      const deleteEntity = generated.find(({ name }) => name === "deleteConfigurationEntity");
      assert.isTrue(deleteEntity?.descriptor.annotations?.destructiveHint);
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
});
