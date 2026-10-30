import { OperatorApi } from "@usine/orchestrator/operator/http";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AuthApi, publicAuthPaths } from "./auth/api.ts";

export const DocumentationApi = HttpApiGroup.make("documentation").add(
  HttpApiEndpoint.get("openapi", "/api/openapi.json", {
    success: Schema.Record(Schema.String, Schema.Unknown).annotate({
      title: "OpenAPI document",
      description: "OpenAPI 3.1 description of the instance HTTP API.",
    }),
  })
    .annotate(OpenApi.Summary, "Read the API schema")
    .annotate(
      OpenApi.Description,
      "Public OpenAPI 3.1 document generated from the registered API contracts.",
    ),
);

export const publicOperatorPaths = new Set<string>([
  OperatorApi.groups.operator.endpoints.serverVersion.path,
  DocumentationApi.endpoints.openapi.path,
]);

export const operatorOpenApi = () => {
  const document = OpenApi.fromApi(OperatorApi.add(AuthApi, DocumentationApi));
  document.components.securitySchemes = {
    bearer: {
      type: "http",
      scheme: "bearer",
      description: "Instance-issued token or local admin token.",
    },
    session: {
      type: "apiKey",
      in: "cookie",
      name: "usine_session",
      description: "Browser session. Writes also require X-Usine-CSRF.",
    },
  };
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!("responses" in operation)) continue;
      if (publicAuthPaths.has(path) || (method === "get" && publicOperatorPaths.has(path)))
        continue;
      operation.security = [{ bearer: [] }, { session: [] }];
      operation.responses["401"] = {
        description: "A valid instance token or browser session is required.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error", "message"],
              properties: { error: { const: "AuthenticationError" }, message: { type: "string" } },
            },
          },
        },
      };
    }
  }
  return document;
};
