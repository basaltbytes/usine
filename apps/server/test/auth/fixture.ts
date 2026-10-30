import { UiOrigin } from "@usine/config/factory";
import { OperatorLogin } from "@usine/core/operator";
import { ConfigProvider, Context, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Authentication, authenticationLayer } from "../../src/auth/authentication.ts";
import { GitHubSignIn, githubSignInLayer } from "../../src/auth/github.ts";
import { memoryAuthLayer } from "../../src/auth/memory.ts";
import { GitHubUserId, Member } from "../../src/auth/model.ts";
import { AuthStore } from "../../src/auth/store.ts";

export const localSecret = "l".repeat(43);
export const alice = new Member({
  id: GitHubUserId.make(1),
  login: OperatorLogin.make("alice"),
  addedAt: 1,
  addedBy: OperatorLogin.make("alice"),
});
export const bob = new Member({
  id: GitHubUserId.make(2),
  login: OperatorLogin.make("bob"),
  addedAt: 2,
  addedBy: alice.login,
});
export const authFixture = (initial: ReadonlyArray<Member> = [alice], identity = alice) =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    const client = HttpClient.make((request) => {
      seen.push(request.url);
      const payload = request.url.endsWith("/login/device/code")
        ? {
            device_code: "github-device-secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }
        : request.url.endsWith("/login/oauth/access_token")
          ? { access_token: "github-user-secret" }
          : identity;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(payload)));
    });
    const storeContext = yield* Layer.build(memoryAuthLayer);
    const store = Context.get(storeContext, AuthStore);
    yield* Effect.forEach(initial, (member) => store.add(member, false));
    const githubContext = yield* Layer.build(
      githubSignInLayer().pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              USINE_GITHUB_CLIENT_ID: "Iv1.fake",
              USINE_GITHUB_CLIENT_SECRET: "app-secret",
            }),
          ),
        ),
      ),
    );
    const github = Context.get(githubContext, GitHubSignIn);
    const context = yield* Layer.build(
      authenticationLayer({
        origin: UiOrigin.make("https://usine.example"),
        origins: [UiOrigin.make("https://client.example")],
        localToken: Redacted.make(localSecret),
      }).pipe(
        Layer.provide(Layer.succeed(AuthStore, store)),
        Layer.provide(Layer.succeed(GitHubSignIn, github)),
      ),
    );
    return { store, github, authentication: Context.get(context, Authentication), seen };
  });
