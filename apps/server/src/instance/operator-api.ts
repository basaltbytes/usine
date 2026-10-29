import { InstanceDirectory } from "@usine/core/instance";
import { readAdminToken } from "../auth/local.ts";
import { RunId } from "@usine/core/run";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { type Port, SERVER_HOST } from "../cli.ts";

const OPERATOR_API_TIMEOUT = "5 seconds";

// The CLI decodes only the fields that it reads, so that it reads an instance of another engine
// version.

/** A Run as `GET /api/overview` lists it. */
export class ListedRun extends Schema.Class<ListedRun>("@usine/server/ListedRun")({
  id: RunId,
  state: Schema.String,
}) {}

const Overview = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ runs: Schema.Array(ListedRun) })),
});

const Configuration = Schema.Struct({
  workers: Schema.Array(
    Schema.Struct({
      gateway: Schema.NullOr(Schema.Struct({ adminTokenEnv: Schema.NonEmptyString })),
    }),
  ),
});

/** The running instance's operator API didn't answer, or its answer didn't decode. */
export class OperatorApiError extends Schema.TaggedError<OperatorApiError>(
  "@usine/server/OperatorApiError",
)("OperatorApiError", { url: Schema.String, reason: Schema.String }) {}

const apiUrl = (port: Port, path: string) => `http://${SERVER_HOST}:${port}${path}`;

const getJson = <A, I>(
  port: Port,
  path: string,
  schema: Schema.Codec<A, I>,
  directory: InstanceDirectory,
) => {
  const url = apiUrl(port, path);
  return Effect.gen(function* () {
    const token = yield* readAdminToken(directory);
    const client = yield* HttpClient.HttpClient;
    return yield* HttpClient.filterStatusOk(client).get(url, {
      headers: { authorization: `Bearer ${Redacted.value(token)}` },
    });
  }).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.timeout(OPERATOR_API_TIMEOUT),
    Effect.mapError((error) => new OperatorApiError({ url, reason: error.message })),
  );
};

/** Lists the Runs of the instance that listens on `port`, with one `GET /api/overview`. */
export const listRuns = Effect.fn("Instance.listRuns")(function* (
  port: Port,
  directory: InstanceDirectory = InstanceDirectory.make(process.cwd()),
) {
  const overview = yield* getJson(port, "/api/overview", Overview, directory);
  return overview.projects.flatMap(({ runs }) => runs);
});

/**
 * Returns the environment variables with the gateways' admin tokens, which `usine up` reads at
 * startup, from `GET /api/configuration`.
 */
export const gatewayTokenVariables = Effect.fn("Instance.gatewayTokenVariables")(function* (
  port: Port,
  directory: InstanceDirectory = InstanceDirectory.make(process.cwd()),
) {
  const configuration = yield* getJson(port, "/api/configuration", Configuration, directory);
  return [...new Set(configuration.workers.flatMap(({ gateway }) => gateway?.adminTokenEnv ?? []))];
});

/** Returns whether an HTTP server answers on `port`, with any status. */
export const answers = (port: Port) =>
  Effect.flatMap(HttpClient.HttpClient, (client) => client.get(apiUrl(port, "/api/overview"))).pipe(
    Effect.flatMap((response) => response.text),
    Effect.timeout("2 seconds"),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/** Whether the Run has a live Attempt. */
export const hasLiveAttempt = (run: ListedRun): boolean => run.state === "Running";
