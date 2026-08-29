import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { assert, describe, expect, it } from "@effect/vitest";
import { Repository } from "@usine/core";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  AppCredentials,
  AppId,
  CoveredProject,
  GitHubApp,
  GitHubCredentials,
  InstallationId,
  PrivateKey,
  REQUIRED_REPOSITORY_PERMISSIONS,
  RepositoryId,
  revealInstallationToken,
} from "../src/index.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const credentials = new AppCredentials({
  appId: AppId.make(12345),
  privateKey: Redacted.make(PrivateKey.make(privatePem), { label: "GitHub App private key" }),
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
        assert.strictEqual(revealInstallationToken(wide), "installation-secret");
        assert(!String(wide).includes("installation-secret"));

        const access = yield* app.projectAccess([
          Repository.Name.make("BasaltBytes/Usine"),
          Repository.Name.make("basaltbytes/missing"),
        ]);
        assert.strictEqual(access[0]?._tag, "CoveredProject");
        assert.strictEqual(access[1]?._tag, "UncoveredProject");
        if (access[1]?._tag === "UncoveredProject") {
          assert.strictEqual(access[1].error._tag, "ProjectNotInstalledError");
        }
        const covered = access[0];
        assert(covered instanceof CoveredProject);

        const worker = yield* app.workerToken(covered);
        assert.strictEqual(worker.scope._tag, "SingleRepository");
        assert.strictEqual(revealInstallationToken(worker), "worker-secret");

        const tokenRequests = requests.filter((request) => request.method === "POST");
        assert(tokenRequests.length >= 3);
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

        const appRequest = requests.find((request) =>
          request.url.endsWith("/app/installations?per_page=2"),
        );
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
            repository: Repository.Name.make("basaltbytes/usine"),
            repositoryId: RepositoryId.make(99),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvalidGitHubResponseError");
    }).pipe(Effect.provide(appLayer(client)));
  });

  it.live("translates an HTTP adapter defect into the GitHub error channel", () => {
    const client = HttpClient.make(() => Effect.die("transport crashed"));
    return Effect.gen(function* () {
      const app = yield* GitHubApp;
      const failure = yield* app.installation().pipe(Effect.flip);
      expect(failure._tag).toBe("GitHubApiError");
      if (failure._tag === "GitHubApiError") expect(failure.message).not.toContain("crashed");
    }).pipe(Effect.provide(appLayer(client)));
  });
});
