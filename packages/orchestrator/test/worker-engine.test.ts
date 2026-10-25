import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { InstanceDirectory } from "@usine/core/instance";
import { stubAttemptRuntime, StubStorage } from "@usine/durable/testing";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { workerEngineLayer } from "../src/worker-engine.ts";
import { credentialLayer } from "./local-worker/support.ts";
import { fixedConfigLayer } from "./support/current-instance.ts";
import { testAppLayer, testCredentialsLayer } from "./support/github-app.ts";
import { alwaysHoldsLayer } from "./support/polling.ts";
import { claudeLoginLockLayer } from "@usine/executor";

// Nothing listens on port 1, so the SSH executor's preflight fails at once.
const unreachable = {
  name: "eu-one",
  kind: "ssh",
  destination: "usine@127.0.0.1",
  port: 1,
  root: "/srv/usine",
} as const;

// Nothing listens on port 1, so the Cloudflare executor's health check fails at once.
const unreachableCloudflare = {
  name: "cf-one",
  kind: "cloudflare",
  worker_url: "https://127.0.0.1:1",
  access_client_id_env: "PATH",
  access_client_secret_env: "PATH",
  image: "usine",
} as const;

const startupFailure = (workers: (typeof UsineConfig.Encoded)["workers"]) =>
  Effect.gen(function* () {
    const directory = InstanceDirectory.make(
      yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "usine-engine-" }),
    );
    const config = Schema.decodeUnknownSync(UsineConfig)({ version: 1, repos: [], workers });
    return yield* Layer.build(
      workerEngineLayer(directory, config, []).pipe(
        Layer.provide(credentialLayer),
        Layer.provide(stubAttemptRuntime(new StubStorage())),
        Layer.provide(claudeLoginLockLayer),
        Layer.provide(alwaysHoldsLayer),
        Layer.provide(fixedConfigLayer(config)),
        Layer.provide(testAppLayer),
        Layer.provide(testCredentialsLayer),
      ),
    ).pipe(Effect.flip);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Worker engine selection", () => {
  it.live("runs SSH Workers on the SSH executor, which preflights their machines", () =>
    Effect.gen(function* () {
      const failure = yield* startupFailure([unreachable]);
      assert(failure._tag === "WorkerCapabilityError", failure._tag);
      assert.strictEqual(
        failure.message,
        'Can\'t connect to SSH worker "eu-one" at usine@127.0.0.1',
      );
    }),
  );

  it.live("names the variable when a Gateway's admin token is not set", () =>
    Effect.gen(function* () {
      const failure = yield* startupFailure([
        {
          ...unreachable,
          gateway: {
            domain: "gw.internal",
            destination: "usine@127.0.0.1",
            admin_token_env: "USINE_TEST_UNSET_GATEWAY_ADMIN_TOKEN",
          },
        },
      ]);
      assert(failure._tag === "WorkerCapabilityError", failure._tag);
      assert.strictEqual(failure.capability, "gateway");
      assert.strictEqual(
        failure.message,
        'The gateway admin token for SSH worker "eu-one" is missing. Set USINE_TEST_UNSET_GATEWAY_ADMIN_TOKEN in the orchestrator\'s environment.',
      );
    }),
  );

  it.live(
    "runs Cloudflare Workers on the Cloudflare executor, which checks the Worker's health",
    () =>
      Effect.gen(function* () {
        const failure = yield* startupFailure([unreachableCloudflare]);
        assert(failure._tag === "ExecutorOperationError", failure._tag);
        assert.strictEqual(failure.operation, "preflight");
        assert.include(
          failure.message,
          "Can't check the Worker's health for cloudflare worker \"cf-one\"",
        );
      }),
  );

  it.live("names the variable when a Cloudflare Worker's Access token is not set", () =>
    Effect.gen(function* () {
      const failure = yield* startupFailure([
        { ...unreachableCloudflare, access_client_secret_env: "USINE_TEST_UNSET_ACCESS_SECRET" },
      ]);
      assert(failure._tag === "WorkerCapabilityError", failure._tag);
      assert.strictEqual(failure.capability, "credentials");
      assert.strictEqual(
        failure.message,
        'The orchestrator\'s environment has no USINE_TEST_UNSET_ACCESS_SECRET, which cloudflare worker "cf-one" names in usine.yaml. Set it and restart usine up.',
      );
    }),
  );

  it.live("refuses a mix of SSH and Cloudflare Workers at startup", () =>
    Effect.gen(function* () {
      const failure = yield* startupFailure([unreachable, unreachableCloudflare]);
      assert(failure._tag === "UnsupportedWorkerError", failure._tag);
      assert.strictEqual(failure.kind, "ssh");
    }),
  );

  it.live("refuses a mix of local and SSH Workers at startup", () =>
    Effect.gen(function* () {
      const failure = yield* startupFailure([{ name: "local", kind: "local" }, unreachable]);
      assert(failure._tag === "UnsupportedWorkerError", failure._tag);
      assert.strictEqual(failure.kind, "ssh");
    }),
  );
});
