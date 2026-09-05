import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { Clock, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "../src/github-app.ts";
import { AppCredentials, AppId, GitHubCredentials, PrivateKey } from "../src/credentials.ts";
import { CoveredProject, REQUIRED_REPOSITORY_PERMISSIONS } from "../src/access.ts";
import { InstallationId, RepositoryId } from "../src/installation.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const credentials = new AppCredentials({
  appId: AppId.make(12345),
  privateKey: Redacted.make(PrivateKey.make(privatePem)),
});

const permissions = { ...REQUIRED_REPOSITORY_PERMISSIONS };
const TokenRequestBody = Schema.Struct({
  permissions: Schema.Record(Schema.String, Schema.String),
  repository_ids: Schema.OptionFromOptionalKey(Schema.Array(Schema.Int)),
});
const JwtHeader = Schema.Struct({
  alg: Schema.Literal("RS256"),
  typ: Schema.Literal("JWT"),
});
const JwtClaims = Schema.Struct({
  iat: Schema.Int,
  exp: Schema.Int,
  iss: Schema.Int,
});
const installation = {
  id: 77,
  account: { login: "basaltbytes" },
  permissions,
  suspended_at: null,
};

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: Schema.Json,
  status = 200,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const requestJson = (
  request: HttpClientRequest.HttpClientRequest,
): typeof TokenRequestBody.Type => {
  assert.strictEqual(request.body._tag, "Uint8Array");
  if (request.body._tag !== "Uint8Array") return assert.fail("missing body");
  return Schema.decodeUnknownSync(TokenRequestBody)(
    JSON.parse(new TextDecoder().decode(request.body.body)),
  );
};

const jwtJson = (part: string): Schema.Json => {
  const base64 = part.replace(/-/gu, "+").replace(/_/gu, "/");
  return Schema.decodeUnknownSync(Schema.Json)(
    JSON.parse(Buffer.from(base64, "base64").toString("utf8")),
  );
};

const appLayer = (client: HttpClient.HttpClient) =>
  GitHubApp.layer.pipe(
    Layer.provide(Layer.succeed(GitHubCredentials, credentials)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );

describe("GitHubApp", () => {
  it.live(
    "mints installation-wide and exactly-one-repo tokens while isolating registry drift",
    () => {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const expiresAt = new Date(Date.now() + 50 * 60 * 1_000).toISOString();
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request);
          if (request.url.endsWith("/app/installations?per_page=2")) {
            return jsonResponse(request, [installation]);
          }
          if (request.url.endsWith("/installation/repositories?per_page=100&page=1")) {
            return jsonResponse(request, {
              total_count: 1,
              repositories: [{ id: 99, full_name: "basaltbytes/usine" }],
            });
          }
          if (request.url.endsWith("/app/installations/77/access_tokens")) {
            const body = requestJson(request);
            return Option.isNone(body.repository_ids)
              ? jsonResponse(request, {
                  token: "installation-secret",
                  expires_at: expiresAt,
                })
              : jsonResponse(request, {
                  token: "worker-secret",
                  expires_at: expiresAt,
                  repositories: [{ id: 99, full_name: "basaltbytes/usine" }],
                });
          }
          return jsonResponse(request, { message: "unexpected request" }, 500);
        }),
      );

      return Effect.gen(function* () {
        const app = yield* GitHubApp;
        const wide = yield* app.installationToken();
        assert.strictEqual(wide.scope._tag, "InstallationWide");
        assert.strictEqual(Redacted.value(wide.value), "installation-secret");
        assert(!String(wide).includes("installation-secret"));

        const access = yield* app.projectAccess([
          RepositoryName.make("BasaltBytes/Usine"),
          RepositoryName.make("basaltbytes/missing"),
        ]);
        assert.strictEqual(access[0]?._tag, "CoveredProject");
        assert.strictEqual(access[1]?._tag, "ProjectNotInstalledError");
        const covered = access[0];
        assert(covered instanceof CoveredProject);

        const worker = yield* app.workerToken(covered);
        assert.strictEqual(worker.scope._tag, "SingleRepository");
        assert.strictEqual(Redacted.value(worker.value), "worker-secret");
        yield* app.workerToken(covered);

        // One lease serves both orchestrator calls. Each worker call mints afresh.
        const discoveries = requests.filter((request) =>
          request.url.endsWith("/app/installations?per_page=2"),
        );
        assert.strictEqual(discoveries.length, 1);
        const tokenRequests = requests.filter((request) => request.method === "POST");
        const wideRequests = tokenRequests.filter((request) =>
          Option.isNone(requestJson(request).repository_ids),
        );
        assert.strictEqual(wideRequests.length, 1);
        assert.strictEqual(tokenRequests.length, 3);
        for (const request of tokenRequests) {
          const body = requestJson(request);
          assert.deepStrictEqual(body.permissions, REQUIRED_REPOSITORY_PERMISSIONS);
          assert(!("workflows" in body.permissions));
        }
        const workerRequest = tokenRequests.at(-1);
        assert(workerRequest !== undefined);
        const workerBody = requestJson(workerRequest);
        assert.deepStrictEqual(workerBody.permissions, REQUIRED_REPOSITORY_PERMISSIONS);
        assert(Option.isSome(workerBody.repository_ids));
        assert.deepStrictEqual(workerBody.repository_ids.value, [99]);

        const appRequest = discoveries[0];
        assert(appRequest !== undefined);
        assert.strictEqual(appRequest.headers["x-github-api-version"], "2026-03-10");
        const jwt = appRequest.headers.authorization?.slice("Bearer ".length);
        assert(jwt !== undefined);
        const parts = jwt.split(".");
        assert.strictEqual(parts.length, 3);
        const [headerPart, claimsPart, signaturePart] = parts;
        assert(headerPart !== undefined && claimsPart !== undefined && signaturePart !== undefined);
        assert.deepStrictEqual(Schema.decodeUnknownSync(JwtHeader)(jwtJson(headerPart)), {
          alg: "RS256",
          typ: "JWT",
        });
        const claims = Schema.decodeUnknownSync(JwtClaims)(jwtJson(claimsPart));
        assert.strictEqual(claims.iss, 12345);
        assert(claims.exp - claims.iat <= 600);
        assert(
          verify(
            "RSA-SHA256",
            Buffer.from(`${headerPart}.${claimsPart}`),
            createPublicKey(privateKey),
            Buffer.from(signaturePart.replace(/-/gu, "+").replace(/_/gu, "/"), "base64"),
          ),
        );
      }).pipe(Effect.provide(appLayer(client)));
    },
  );

  it.live("renews the shared lease once its token is about to expire", () => {
    const expiresAt = new Date(Date.now() + 3 * 60 * 1_000).toISOString();
    let mints = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.method === "POST") {
          mints += 1;
          return jsonResponse(request, { token: `short-lived-${mints}`, expires_at: expiresAt });
        }
        return jsonResponse(request, [installation]);
      }),
    );

    return Effect.gen(function* () {
      const app = yield* GitHubApp;
      yield* app.installationToken();
      const second = yield* app.installationToken();
      assert.strictEqual(mints, 2);
      assert.strictEqual(Redacted.value(second.value), "short-lived-2");
    }).pipe(Effect.provide(appLayer(client)));
  });

  it.live("rejects a worker token when GitHub does not confirm its single-repo scope", () => {
    const expiresAt = new Date(Date.now() + 50 * 60 * 1_000).toISOString();
    const client = HttpClient.make((request) =>
      Effect.succeed(
        jsonResponse(request, {
          token: "wrong-scope",
          expires_at: expiresAt,
          repositories: [
            { id: 99, full_name: "basaltbytes/usine" },
            { id: 100, full_name: "basaltbytes/other" },
          ],
        }),
      ),
    );

    return Effect.gen(function* () {
      const app = yield* GitHubApp;
      const failure = yield* app
        .workerToken(
          new CoveredProject({
            installationId: InstallationId.make(77),
            repository: RepositoryName.make("basaltbytes/usine"),
            repositoryId: RepositoryId.make(99),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvalidGitHubResponseError");
    }).pipe(Effect.provide(appLayer(client)));
  });

  it.effect("accepts clock skew without extending the worker or shared lease past one hour", () => {
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.method !== "POST") return jsonResponse(request, [installation]);
        return jsonResponse(request, {
          token: "skewed-token",
          expires_at: new Date((yield* Clock.currentTimeMillis) + 62 * 60_000).toISOString(),
          repositories: [{ id: 99, full_name: "basaltbytes/usine" }],
        });
      }),
    );
    return Effect.gen(function* () {
      const app = yield* GitHubApp;
      const now = yield* Clock.currentTimeMillis;
      const worker = yield* app.workerToken(
        new CoveredProject({
          installationId: InstallationId.make(77),
          repository: RepositoryName.make("basaltbytes/usine"),
          repositoryId: RepositoryId.make(99),
        }),
      );
      const shared = yield* app.installationToken();
      assert.strictEqual(DateTime.toEpochMillis(worker.expiresAt), now + 60 * 60_000);
      assert.strictEqual(DateTime.toEpochMillis(shared.expiresAt), now + 60 * 60_000);
    }).pipe(Effect.provide(appLayer(client)));
  });

  it.live.each([-1, 0, 70])("rejects an invalid token with %s minutes left", (minutes) => {
    const expiresAt = new Date(Date.now() + minutes * 60 * 1_000).toISOString();
    const client = HttpClient.make((request) =>
      Effect.succeed(
        jsonResponse(request, {
          token: "long-lived",
          expires_at: expiresAt,
          repositories: [{ id: 99, full_name: "basaltbytes/usine" }],
        }),
      ),
    );

    return Effect.gen(function* () {
      const app = yield* GitHubApp;
      const failure = yield* app
        .workerToken(
          new CoveredProject({
            installationId: InstallationId.make(77),
            repository: RepositoryName.make("basaltbytes/usine"),
            repositoryId: RepositoryId.make(99),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvalidGitHubResponseError");
      if (failure._tag === "InvalidGitHubResponseError") {
        assert.match(failure.message, /one-hour lifetime/u);
      }
    }).pipe(Effect.provide(appLayer(client)));
  });

  it.live("reports installation permission drift before minting a token", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        jsonResponse(request, [
          {
            ...installation,
            permissions: { ...permissions, contents: "read" },
          },
        ]),
      ),
    );

    return Effect.gen(function* () {
      const app = yield* GitHubApp;
      const failure = yield* app.installation().pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AppPermissionError");
      if (failure._tag === "AppPermissionError") {
        assert.deepStrictEqual(failure.missing, ["contents:write"]);
      }
    }).pipe(Effect.provide(appLayer(client)));
  });
});
