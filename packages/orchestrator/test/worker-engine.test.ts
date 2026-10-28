import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { InstanceDirectory, InstanceId } from "@usine/core/instance";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { stubAttemptRuntime, StubStorage } from "@usine/durable/testing";
import { StepExecutor } from "@usine/engine/step-executor";
import { claudeLoginLockLayer } from "@usine/executor";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { ConfigProvider, Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { idleTriggersLayer } from "../src/idle-triggers.ts";
import { OperatorObservation } from "../src/operator/operator.ts";
import { workerEngineLayer } from "../src/worker-engine.ts";
import { WorkerStatus } from "../src/worker-status.ts";
import { credentialLayer, submission } from "./local-worker/support.ts";
import { fixedConfigLayer } from "./support/current-instance.ts";
import { testAppLayer, testCredentialsLayer } from "./support/github-app.ts";
import { alwaysHoldsLayer } from "./support/polling.ts";

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
      workerEngineLayer(
        directory,
        InstanceId.make("0b4e7f3c-5a2d-4c1e-9f6b-8d7a2e1c3b4f"),
        config,
        [],
      ).pipe(
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
      assert.include(failure.message, 'The gateway admin token for SSH worker "eu-one" is missing');
      assert.include(failure.message, "USINE_TEST_UNSET_GATEWAY_ADMIN_TOKEN");
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

const healthy = WorkerName.make("healthy");
const failed = WorkerName.make("failed");
const instanceId = InstanceId.make("0b4e7f3c-5a2d-4c1e-9f6b-8d7a2e1c3b4f");

const productionObservation = (
  directory: InstanceDirectory,
  config: UsineConfig,
  environment: Record<string, string>,
) => {
  const engine = workerEngineLayer(directory, instanceId, config, []).pipe(
    Layer.provide(credentialLayer),
    Layer.provide(stubAttemptRuntime(new StubStorage())),
    Layer.provide(claudeLoginLockLayer),
    Layer.provide(alwaysHoldsLayer),
    Layer.provide(testAppLayer),
    Layer.provide(testCredentialsLayer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: environment }))),
  );
  return OperatorObservation.layer.pipe(
    Layer.provide(Layer.merge(idleTriggersLayer, MarcbachmannCelLayer)),
    Layer.provideMerge(engine),
    Layer.provideMerge(fixedConfigLayer(config)),
  );
};

const assertCredentialIsolation = (variable: string) =>
  Effect.gen(function* () {
    const status = yield* WorkerStatus;
    const steps = yield* StepExecutor;
    const reads = yield* OperatorObservation;
    const unavailable = yield* status.unavailable;
    assert.strictEqual(unavailable.length, 1);
    assert.strictEqual(unavailable[0]?.worker, failed);
    assert.include(unavailable[0]?.message ?? "", variable);
    const need = (yield* reads.overview(yield* (yield* CurrentInstance).get)).needsYou.find(
      (need) => need._tag === "WorkerPreflightNeed",
    );
    assert(need?._tag === "WorkerPreflightNeed");
    assert.strictEqual(need.worker, failed);
    assert.include(need.message, variable);
    const lease = yield* steps.reserve(RunId.make("healthy-run"), submission(1), Option.none());
    assert.strictEqual(lease.worker, healthy);
    yield* lease.release;
    assert.deepStrictEqual(yield* steps.workers, [failed, healthy]);
  });

it.effect(
  "starts the production SSH engine with a missing gateway token and schedules the healthy worker",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "usine-ssh-startup-" }),
      );
      // Only the SSH transport is scripted; address resolution, executor, scheduler, and storage are real.
      yield* fs.writeFileString(
        `${directory}/ssh`,
        `#!/bin/sh
case "$*" in
  *'/proc/meminfo'*) printf 'MemTotal: 33554432 kB\nSwapTotal: 0 kB\n' ;;
  *"'git' '--version'"*) printf 'git version 2.50.0\n' ;;
  *docker*) exit 3 ;;
esac
`,
      );
      yield* fs.chmod(`${directory}/ssh`, 0o755);
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [],
        workers: [
          {
            ...unreachable,
            name: failed,
            gateway: {
              domain: "gw.internal",
              destination: "gateway",
              admin_token_env: "MISSING_GATEWAY_TOKEN",
            },
          },
          { ...unreachable, name: healthy },
        ],
      });
      yield* assertCredentialIsolation("MISSING_GATEWAY_TOKEN").pipe(
        Effect.provide(productionObservation(directory, config, { PATH: directory })),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "retries Cloudflare credential initialization through production composition and restores scheduling and attention",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "usine-cf-startup-" }),
      );
      const healthRequests: Array<string> = [];
      const fetch: typeof globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        assert.strictEqual(url.pathname, "/v1/health");
        healthRequests.push(url.hostname);
        return Response.json({ protocol: 1, images: ["usine"] });
      };
      const environment = {
        ACCESS_ID: "id",
        HEALTHY_SECRET: "healthy-secret",
      };
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [],
        workers: [
          {
            ...unreachableCloudflare,
            name: failed,
            worker_url: "https://failed.test",
            access_client_id_env: "ACCESS_ID",
            access_client_secret_env: "MISSING_SECRET",
          },
          {
            ...unreachableCloudflare,
            name: healthy,
            worker_url: "https://healthy.test",
            access_client_id_env: "ACCESS_ID",
            access_client_secret_env: "HEALTHY_SECRET",
          },
        ],
      });
      yield* Effect.gen(function* () {
        yield* assertCredentialIsolation("MISSING_SECRET");
        assert.deepStrictEqual(healthRequests, ["healthy.test"]);
        const steps = yield* StepExecutor;
        const status = yield* WorkerStatus;
        const reads = yield* OperatorObservation;
        const waiting = yield* steps
          .reserve(RunId.make("failed-run"), submission(2), Option.some(failed))
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("59 seconds");
        assert.isUndefined(waiting.pollUnsafe());
        Object.assign(environment, { MISSING_SECRET: "repaired-secret" });
        yield* TestClock.adjust("1 second");
        const lease = yield* Fiber.join(waiting);
        assert.strictEqual(lease.worker, failed);
        assert.deepStrictEqual(healthRequests, ["healthy.test", "failed.test"]);
        assert.deepStrictEqual(yield* status.unavailable, []);
        assert.isFalse(
          (yield* reads.overview(yield* (yield* CurrentInstance).get)).needsYou.some(
            (need) => need._tag === "WorkerPreflightNeed",
          ),
        );
        yield* lease.release;
      }).pipe(
        Effect.provide(productionObservation(directory, config, environment)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
