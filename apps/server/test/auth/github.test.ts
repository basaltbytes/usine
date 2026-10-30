import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { assert, it } from "vitest";
import { GitHubSignIn, githubSignInLayer } from "../../src/auth/github.ts";
import { alice } from "./fixture.ts";

for (const flow of ["web", "device"] as const)
  for (const identityStatus of [200, 503])
    for (const revokeStatus of [204, 503])
      it(`${flow} preserves identity status ${identityStatus} after revocation status ${revokeStatus}`, async () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const requests: Array<string> = [];
            const client = HttpClient.make((request) => {
              requests.push(`${request.method} ${request.url}`);
              if (request.url.endsWith("/login/oauth/access_token"))
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json({ access_token: "temporary-user-token" }),
                  ),
                );
              if (request.url.endsWith("/user"))
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json(alice, { status: identityStatus }),
                  ),
                );
              assert.equal(request.method, "DELETE");
              assert.equal(request.url, "https://api.github.com/applications/Iv1.test/token");
              assert.equal(
                request.headers.authorization,
                `Basic ${Buffer.from("Iv1.test:app-secret").toString("base64")}`,
              );
              assert.equal(request.body._tag, "Uint8Array");
              if (request.body._tag === "Uint8Array")
                assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body.body)), {
                  access_token: "temporary-user-token",
                });
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: revokeStatus })),
              );
            });
            const result = yield* Effect.flatMap(GitHubSignIn, (github) =>
              flow === "web"
                ? github.web("code", "https://usine.example/callback").pipe(Effect.asVoid)
                : github.poll(Redacted.make("device-code")).pipe(Effect.asVoid),
            ).pipe(
              Effect.provide(
                githubSignInLayer.pipe(
                  Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
                  Layer.provide(
                    Layer.succeed(
                      ConfigProvider.ConfigProvider,
                      ConfigProvider.fromUnknown({
                        USINE_GITHUB_CLIENT_ID: "Iv1.test",
                        USINE_GITHUB_CLIENT_SECRET: "app-secret",
                      }),
                    ),
                  ),
                ),
              ),
              Effect.result,
            );
            assert.equal(result._tag, identityStatus === 200 ? "Success" : "Failure");
            assert.deepEqual(requests, [
              "POST https://github.com/login/oauth/access_token",
              "GET https://api.github.com/user",
              "DELETE https://api.github.com/applications/Iv1.test/token",
            ]);
          }),
        ));
