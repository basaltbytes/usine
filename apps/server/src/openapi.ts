import { ProviderApi } from "./providers/api.ts";
import { SetupApi, setupPermissions } from "./setup/api.ts";
import { CrossSiteRequestError } from "./security.ts";
import { OperatorApi, operatorPermissions } from "@usine/orchestrator/operator/http";
import { Option, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AuthApi, AuthenticationError, authPermissions, publicAuthPaths } from "./auth/api.ts";

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

/** The credential or permission that an operation requires. */
export const OperationPermission = Schema.Literals([
  "public",
  "read",
  "operate",
  "maintain",
  "admin",
  "session",
  "tokens",
  "local",
  "setup",
]);
export type OperationPermission = typeof OperationPermission.Type;

/** The OpenAPI extension that names the permission of an operation. */
export const PERMISSION_EXTENSION = "x-usine-permission";

/** Reads the permission extension of a published operation. */
export const operationPermission = (operation: OpenApi.OpenAPISpecOperation) =>
  Schema.decodeUnknownOption(Schema.Struct({ [PERMISSION_EXTENSION]: OperationPermission }))(
    operation,
  ).pipe(Option.map((marked) => marked[PERMISSION_EXTENSION]));

const groupPermissions = {
  [OperatorApi.groups.operator.identifier]: operatorPermissions,
  [AuthApi.identifier]: authPermissions,
  [SetupApi.identifier]: setupPermissions,
  [ProviderApi.identifier]: Object.fromEntries(
    Object.keys(ProviderApi.endpoints).map((identifier) => [identifier, "setup" as const]),
  ),
  [DocumentationApi.identifier]: { openapi: "public" },
} satisfies Record<string, Readonly<Record<string, OperationPermission>>>;

/** The permission of every published operation, keyed by OpenAPI operation ID (`operator.approve`). */
export const operationPermissions: ReadonlyMap<string, OperationPermission> = new Map(
  Object.entries(groupPermissions).flatMap(([group, permissions]) =>
    Object.entries(permissions).map(([identifier, permission]) => [
      `${group}.${identifier}`,
      permission,
    ]),
  ),
);

export const publicOperatorPaths = new Set<string>([
  OperatorApi.groups.operator.endpoints.serverVersion.path,
  OperatorApi.groups.operator.endpoints.serverReady.path,
  DocumentationApi.endpoints.openapi.path,
  SetupApi.endpoints.callback.path,
]);

const addForbiddenResponse = (
  operation: OpenApi.OpenAPISpecOperation,
  schema: Schema.Top,
  description: string,
) => {
  const forbidden = operation.responses["403"];
  const existingSchema = forbidden?.content?.["application/json"]?.schema;
  const additionalSchema = Schema.toJsonSchemaDocument(schema).schema;
  operation.responses["403"] = {
    ...forbidden,
    description: `${forbidden?.description ?? "Forbidden."} ${description}`,
    content: {
      ...forbidden?.content,
      "application/json": {
        schema:
          existingSchema !== undefined
            ? { anyOf: [existingSchema, additionalSchema] }
            : additionalSchema,
      },
    },
  };
};

export const operatorOpenApi = () => {
  const document = OpenApi.fromApi(
    OperatorApi.add(AuthApi, SetupApi, ProviderApi, DocumentationApi),
  );
  const authenticationError = Schema.toJsonSchemaDocument(AuthenticationError).schema;
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
      const permission = operationPermissions.get(operation.operationId);
      if (permission !== undefined)
        Object.assign(operation, { [PERMISSION_EXTENSION]: permission });
      addForbiddenResponse(
        operation,
        CrossSiteRequestError,
        "Requests with an Origin header require an allowed origin. Unknown origins receive no CORS headers.",
      );
      if (publicAuthPaths.has(path) || (method === "get" && publicOperatorPaths.has(path)))
        continue;
      operation.security = [{ bearer: [] }, { session: [] }];
      operation.responses["401"] = {
        description: "A valid instance token or browser session is required.",
        content: {
          "application/json": {
            schema: authenticationError,
          },
        },
      };
      if (method !== "get") {
        addForbiddenResponse(
          operation,
          AuthenticationError,
          "Browser session writes require a valid X-Usine-CSRF header.",
        );
      }
    }
  }
  return document;
};
