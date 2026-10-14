import { assert, describe, it } from "@effect/vitest";
import { Effect, Encoding, Option, Redacted, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import {
  CallerClaims,
  CallerTokens,
  presentedToken,
  withoutCallerCredentials,
} from "../src/caller/caller.ts";
import {
  ATTACHMENT,
  NO_PROVIDERS,
  OTHER_ATTACHMENT,
  OTHER_REPOSITORY,
  OTHER_WORKER,
  REPOSITORY,
  WORKER,
  secret,
  settingsLayer,
} from "./fixtures.ts";

const tokens = <A, E>(effect: Effect.Effect<A, E, CallerTokens>) =>
  effect.pipe(Effect.provide(CallerTokens.layer), Effect.provide(settingsLayer(NO_PROVIDERS)));

const claims = new CallerClaims({ attachment: ATTACHMENT, worker: WORKER, repository: REPOSITORY });

describe("CallerTokens", () => {
  it.effect("a token issued for an attachment verifies to the same Worker and repository", () =>
    tokens(
      Effect.gen(function* () {
        const callers = yield* CallerTokens;
        const token = yield* callers.issue(claims);
        assert.deepStrictEqual(yield* callers.verify(token), claims);
        assert.strictEqual(
          Redacted.value(yield* callers.issue(claims)),
          Redacted.value(token),
          "a renewal must not change the token children already hold",
        );
      }),
    ),
  );

  it.effect(
    "a VM cannot rewrite its token to claim another attachment, Worker, or repository",
    () =>
      tokens(
        Effect.gen(function* () {
          const callers = yield* CallerTokens;
          const mac = Redacted.value(yield* callers.issue(claims)).split(".")[2];
          for (const forged of [
            new CallerClaims({
              attachment: OTHER_ATTACHMENT,
              worker: WORKER,
              repository: REPOSITORY,
            }),
            new CallerClaims({
              attachment: ATTACHMENT,
              worker: OTHER_WORKER,
              repository: REPOSITORY,
            }),
            new CallerClaims({
              attachment: ATTACHMENT,
              worker: WORKER,
              repository: OTHER_REPOSITORY,
            }),
          ]) {
            const payload = Encoding.encodeBase64Url(
              Schema.encodeSync(Schema.fromJsonString(CallerClaims))(forged),
            );
            const error = yield* Effect.flip(callers.verify(secret(`ugw1.${payload}.${mac}`)));
            assert.strictEqual(error.reason, "bad-signature");
          }
          const garbage = yield* Effect.flip(callers.verify(secret("ghp_notOurs")));
          assert.strictEqual(garbage.reason, "malformed");
        }),
      ),
  );

  it.effect("a token signed with another gateway's key is rejected", () =>
    Effect.gen(function* () {
      const foreign = yield* Effect.flatMap(CallerTokens, (callers) => callers.issue(claims)).pipe(
        Effect.provide(CallerTokens.layer),
        Effect.provide(settingsLayer(NO_PROVIDERS, "another-gateway-key-0123456789abcdef")),
      );
      const error = yield* tokens(
        Effect.flatMap(CallerTokens, (callers) => Effect.flip(callers.verify(foreign))),
      );
      assert.strictEqual(error.reason, "bad-signature");
    }),
  );

  it.effect(
    "a request to a host outside the gateway loses caller tokens but keeps other credentials",
    () =>
      tokens(
        Effect.gen(function* () {
          const callers = yield* CallerTokens;
          const caller = Redacted.value(yield* callers.issue(claims));
          const strip = (input: Record<string, string>) =>
            Effect.map(callers.withoutCallerTokens(Headers.fromInput(input)), (headers) =>
              Object.fromEntries(Object.entries(headers)),
            );
          assert.deepStrictEqual(
            yield* strip({
              "x-usine-gateway-token": caller,
              authorization: `Bearer ${caller}`,
              "x-api-key": "registry-key",
              accept: "*/*",
            }),
            { "x-api-key": "registry-key", accept: "*/*" },
          );
          assert.deepStrictEqual(
            yield* strip({
              authorization: `Basic ${Encoding.encodeBase64(`x-access-token:${caller}`)}`,
              "x-api-key": caller,
            }),
            {},
          );
          assert.deepStrictEqual(yield* strip({ authorization: "Bearer npm_registryToken" }), {
            authorization: "Bearer npm_registryToken",
          });
        }),
      ),
  );
});

describe("presentedToken", () => {
  const token = "ugw1.abc.def";
  const read = (input: Record<string, string>) =>
    Option.map(presentedToken(Headers.fromInput(input)), Redacted.value);

  it("finds the token wherever git, gh, Claude Code, and Codex put their credential", () => {
    assert.deepStrictEqual(read({ "x-usine-gateway-token": token }), Option.some(token));
    assert.deepStrictEqual(read({ authorization: `token ${token}` }), Option.some(token));
    assert.deepStrictEqual(read({ authorization: `Bearer ${token}` }), Option.some(token));
    assert.deepStrictEqual(
      read({ authorization: `Basic ${Encoding.encodeBase64(`x-access-token:${token}`)}` }),
      Option.some(token),
    );
    assert.deepStrictEqual(read({ "x-api-key": token }), Option.some(token));
    assert.deepStrictEqual(read({ authorization: "Negotiate abc" }), Option.none());
    assert.deepStrictEqual(read({}), Option.none());
  });

  it("removes every caller credential before a request is forwarded", () => {
    const remaining = withoutCallerCredentials(
      Headers.fromInput({
        "x-usine-gateway-token": token,
        authorization: `Bearer ${token}`,
        "x-api-key": token,
        "proxy-authorization": `Basic ${token}`,
        accept: "application/json",
      }),
    );
    assert.deepStrictEqual({ ...remaining }, { accept: "application/json" });
  });
});
