import { ModelProviderCatalog, openai } from "@usine/core/agent/provider";
import { jsonKey } from "@usine/core/json-key";
import { Deferred, DateTime, Duration, Effect, Option, Redacted, Schema } from "effect";
import { assert, describe, expect, it } from "@effect/vitest";

import { HttpRouter } from "effect/http";
import { TestClock } from "effect/testing";
import { ProcessStatus, SandboxSummary } from "../src/api/api.ts";
import { processFiles, stopCommand } from "../src/sandbox/process.ts";
import { DRAIN_MARKER } from "../src/api/harness.ts";
import { keepAlive, LEASE, sandboxRoutes } from "../src/sandbox/sandbox.ts";
import {
  ATTEMPT,
  fakeSandbox,
  finishedProcess,
  IMAGE,
  ISSUED_AT,
  NAME,
  OWNER,
  storedSandbox,
  text,
} from "./support.ts";

/** Returns the time usine issued credentials, `minutes` after the first. */
const issuedAt = (minutes: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(ISSUED_AT), { minutes }));

const encodeCredentials = (token: string, issued = issuedAt(0)) => ({
  issuedAt: issued,
  github: token,
  providers: [{ provider: "anthropic", credential: { _tag: "ApiKey", key: "sk-ant-key" } }],
});

const renewedBody = jsonKey(encodeCredentials("ghs_second", issuedAt(1)));

const revocation = (issued: string) => jsonKey({ issuedAt: issued, providers: [] });

const createBody = (attempt: string = ATTEMPT, issued = issuedAt(0)) =>
  jsonKey({
    owner: OWNER,
    attempt,
    image: IMAGE,
    instanceType: "standard-3",
    credentials: encodeCredentials("ghs_first", issued),
  });

const served = (allowedHosts?: ReadonlyArray<string>) => {
  const sandbox = fakeSandbox(allowedHosts);
  const web = HttpRouter.toWebHandler(
    sandboxRoutes.pipe(HttpRouter.provideRequest(sandbox.layer)),
    {
      disableLogger: true,
    },
  );
  const call = (method: string, path: string, body: string | null = null) =>
    web.handler(
      new Request(`https://sandboxes.test${path}`, {
        method,
        body,
        headers: { "content-type": "application/json" },
      }),
    );
  return { ...sandbox, call };
};

const decodeSummary = Schema.decodeUnknownEffect(Schema.toCodecJson(SandboxSummary));

describe("sandbox routes", () => {
  it.live("starts the container without internet and routes its traffic through the handlers", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      const response = yield* Effect.promise(() =>
        call("PUT", `/v1/sandboxes/${NAME}`, createBody()),
      );

      expect(response.status).toBe(200);
      const decodedValue15 = yield* Effect.promise(() => response.json());
      const summary = yield* decodeSummary(decodedValue15);
      expect(summary.running).toBe(true);
      expect(state.started).toEqual([
        { image: "registry.cloudflare.com/acme/usine@sha256:abc", instanceType: "standard-3" },
      ]);
      expect(state.interceptions.map(({ _tag, host }) => `${_tag}:${host}`)).toEqual([
        "GitHub:github.com",
        "GitHub:api.github.com",
        "Provider:anthropic.usine.internal",
        "Denied:openai.usine.internal",
        "Allowed:registry.npmjs.org",
      ]);
      expect(state.recorded.map(({ name }) => name)).toEqual([NAME]);
      expect(Option.isSome(state.alarm) && state.keepAlives).toBe(1);
      assert(Option.isSome(state.stored));
      expect(Option.map(state.stored.value.credentials.github, Redacted.value)).toEqual(
        Option.some("ghs_first"),
      );
    }),
  );

  it.live(
    "returns the running sandbox when the same Attempt asks again, and refuses another Attempt",
    () =>
      Effect.gen(function* () {
        const { state, call } = served();
        yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
        const again = yield* Effect.promise(() =>
          call("PUT", `/v1/sandboxes/${NAME}`, createBody()),
        );
        const other = yield* Effect.promise(() =>
          call("PUT", `/v1/sandboxes/${NAME}`, createBody("run-2/execute/1")),
        );

        expect(again.status).toBe(200);
        expect(state.started).toHaveLength(1);
        expect(other.status).toBe(409);
        const decodedValue14 = yield* Effect.promise(() => other.json());
        expect(decodedValue14).toMatchObject({
          _tag: "SandboxConflict",
          attempt: ATTEMPT,
        });
      }),
  );

  it.live("keeps a hold that completes while it registers a reattachment's credentials", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      const reached = yield* Deferred.make<void>();
      const registered = yield* Deferred.make<void>();
      state.beforeIntercept = () => {
        state.beforeIntercept = () => Effect.void;
        return Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(registered)),
        );
      };
      const pending = call("PUT", `/v1/sandboxes/${NAME}`, createBody());
      yield* Deferred.await(reached);
      const held = yield* Effect.promise(() => call("POST", `/v1/sandboxes/${NAME}/hold`));
      yield* Deferred.succeed(registered, undefined);
      const response = yield* Effect.promise(() => pending);

      expect([held.status, response.status]).toEqual([200, 200]);
      assert(Option.isSome(state.stored));
      expect(state.stored.value.held).toBe(true);
    }),
  );

  it.live("keeps a revocation that arrives while an earlier renewal registers its handlers", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      assert(Option.isSome(state.stored));
      const firstLease = state.stored.value.leaseUntil;
      const reached = yield* Deferred.make<void>();
      const registered = yield* Deferred.make<void>();
      state.beforeIntercept = () => {
        state.beforeIntercept = () => Effect.void;
        return Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(registered)),
        );
      };
      const decodedValue16 = jsonKey(encodeCredentials("ghs_second", issuedAt(1)));
      const renewal = call("PUT", `/v1/sandboxes/${NAME}/credentials`, decodedValue16);
      yield* Deferred.await(reached);
      // The executor stopped waiting for the renewal and revokes the credentials.
      const revoked = call("PUT", `/v1/sandboxes/${NAME}/credentials`, revocation(issuedAt(2)));
      yield* Effect.promise(() => revoked).pipe(Effect.timeoutOption(50));
      yield* Deferred.succeed(registered, undefined);
      const statuses = (yield* Effect.promise(() => Promise.all([renewal, revoked]))).map(
        ({ status }) => status,
      );

      expect(statuses).toEqual([200, 200]);
      assert(Option.isSome(state.stored));
      expect(Option.isNone(state.stored.value.credentials.github)).toBe(true);
      expect(state.stored.value.credentials.providers).toEqual([]);
      expect(DateTime.isGreaterThan(state.stored.value.leaseUntil, firstLease)).toBe(true);
      expect(state.interceptions.slice(-5).map(({ _tag, host }) => `${_tag}:${host}`)).toEqual([
        "Denied:github.com",
        "Denied:api.github.com",
        "Denied:anthropic.usine.internal",
        "Denied:openai.usine.internal",
        "Allowed:registry.npmjs.org",
      ]);
    }),
  );

  it.live(
    "denies a provider host on a running container after the Worker's catalog drops its provider",
    () =>
      Effect.gen(function* () {
        const { state, call } = served();
        yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
        // A Worker deployed without the Anthropic provider renews the running sandbox's credentials.
        state.catalog = ModelProviderCatalog.make({ providers: [openai] });
        const hosts = (from: number) =>
          state.interceptions.slice(from).map(({ _tag, host }) => `${_tag}:${host}`);
        const renewals = [issuedAt(1), issuedAt(2)];
        const registered: Array<ReadonlyArray<string>> = [];
        for (const issued of renewals) {
          const from = state.interceptions.length;
          const renewed = yield* Effect.promise(() =>
            call("PUT", `/v1/sandboxes/${NAME}/credentials`, revocation(issued)),
          );
          expect(renewed.status).toBe(200);
          registered.push(hosts(from));
        }

        expect(registered).toEqual(
          renewals.map(() => [
            "Denied:github.com",
            "Denied:api.github.com",
            "Denied:openai.usine.internal",
            "Denied:anthropic.usine.internal",
            "Allowed:registry.npmjs.org",
          ]),
        );
      }),
  );

  it.live.each([
    ["renewal", "/credentials", renewedBody],
    ["reattachment", "", createBody(ATTEMPT, issuedAt(1))],
  ])("refuses a %s issued before a revocation that reached the sandbox first", ([, path, body]) =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      const revoked = yield* Effect.promise(() =>
        call("PUT", `/v1/sandboxes/${NAME}/credentials`, revocation(issuedAt(2))),
      );
      const registered = state.interceptions.length;
      const stale = yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}${path}`, body));

      expect(revoked.status).toBe(200);
      expect(stale.status).toBe(409);
      const actual1 = yield* Effect.promise(() => stale.json());
      expect(actual1).toMatchObject({
        _tag: "StaleCredentials",
        issuedAt: issuedAt(1),
        current: issuedAt(2),
      });
      expect(state.interceptions).toHaveLength(registered);
      assert(Option.isSome(state.stored));
      expect(Option.isNone(state.stored.value.credentials.github)).toBe(true);
      expect(DateTime.formatIso(state.stored.value.credentials.issuedAt)).toBe(issuedAt(2));
    }),
  );

  it.live("stops the sandbox's commands through the process files", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      state.run = () => finishedProcess("2\n");
      const response = yield* Effect.promise(() => call("POST", `/v1/sandboxes/${NAME}/stop`));

      const decodedValue11 = yield* Effect.promise(() => response.json());
      expect(decodedValue11).toEqual({ stopped: 2 });
      expect(state.execs).toEqual([stopCommand]);
    }),
  );

  it.live("fails the stop when a process survives the stop script", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      state.run = () => finishedProcess("", 1);
      const response = yield* Effect.promise(() => call("POST", `/v1/sandboxes/${NAME}/stop`));

      expect(response.status).toBe(503);
      const decodedValue10 = yield* Effect.promise(() => response.json());
      expect(decodedValue10).toMatchObject({
        _tag: "ContainerUnavailable",
      });
    }),
  );

  it.live("destroys the container, its storage, and its registry entry", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      const destroyed = yield* Effect.promise(() => call("DELETE", `/v1/sandboxes/${NAME}`));
      const again = yield* Effect.promise(() => call("DELETE", `/v1/sandboxes/${NAME}`));
      const missing = yield* Effect.promise(() => call("GET", `/v1/sandboxes/${NAME}`));

      const decodedValue9 = yield* Effect.promise(() => destroyed.json());
      expect(decodedValue9).toEqual({ destroyed: true });
      const decodedValue8 = yield* Effect.promise(() => again.json());
      expect(decodedValue8).toEqual({ destroyed: false });
      expect(state.destroyed).toBe(1);
      expect(Option.isNone(state.stored) && Option.isNone(state.alarm)).toBe(true);
      expect(state.forgotten).toEqual([NAME, NAME]);
      expect(missing.status).toBe(404);
    }),
  );

  it.live("reads a command's state and output size from its process files", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      const process = "0123456789abcdef0123456789abcdef";
      const decodedValue7 = yield* Schema.decodeEffect(ProcessStatus.fields.process)(process);
      const files = processFiles(decodedValue7);
      state.files.set(files.pid, text("4242"));
      state.files.set(files.stdout, text("hello\n"));
      const running = yield* Effect.promise(() =>
        call("GET", `/v1/sandboxes/${NAME}/processes/${process}`),
      );
      state.files.set(files.exit, text("7"));
      const exited = yield* Effect.promise(() =>
        call("GET", `/v1/sandboxes/${NAME}/processes/${process}`),
      );
      const unknown = yield* Effect.promise(() =>
        call("GET", `/v1/sandboxes/${NAME}/processes/${"f".repeat(32)}`),
      );

      const decodedValue6 = yield* Effect.promise(() => running.json());
      expect(decodedValue6).toEqual({
        process,
        pid: 4242,
        state: { _tag: "Running" },
        stdoutBytes: 6,
        stderrBytes: 0,
      });
      const decodedValue5 = yield* Effect.promise(() => exited.json());
      expect(decodedValue5).toMatchObject({
        state: { _tag: "Exited", exitCode: 7 },
      });
      expect(unknown.status).toBe(404);
    }),
  );

  it.live(
    "reports that the platform is draining the container once its init wrote the marker",
    () =>
      Effect.gen(function* () {
        const { state, call } = served();
        yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
        const beforeResponse = yield* Effect.promise(() => call("GET", `/v1/sandboxes/${NAME}`));
        const decodedValue3 = yield* Effect.promise(() => beforeResponse.json());
        const before = yield* decodeSummary(decodedValue3);
        state.files.set(DRAIN_MARKER, text("2026-10-25T20:00:00Z\n"));
        const afterResponse = yield* Effect.promise(() => call("GET", `/v1/sandboxes/${NAME}`));
        const decodedValue2 = yield* Effect.promise(() => afterResponse.json());
        const after = yield* decodeSummary(decodedValue2);

        expect(before.draining).toBe(false);
        expect(after.draining).toBe(true);
      }),
  );
});

describe("sandbox keepalive alarm", () => {
  it.effect("keeps a leased container running and sets the next alarm", () => {
    const { state, layer } = fakeSandbox();
    state.running = true;
    state.stored = Option.some(storedSandbox(DateTime.makeUnsafe(Duration.toMillis(LEASE))));
    return Effect.gen(function* () {
      yield* TestClock.adjust("1 hour");
      yield* keepAlive();

      expect(state.keepAlives).toBe(1);
      expect(Option.map(state.alarm, DateTime.toEpochMillis)).toEqual(
        Option.some(Duration.toMillis(Duration.sum(Duration.hours(1), Duration.minutes(4)))),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a held container running after its lease expired", () => {
    const { state, layer } = fakeSandbox();
    state.running = true;
    state.stored = Option.some(storedSandbox(DateTime.makeUnsafe(Duration.toMillis(LEASE)), true));
    return Effect.gen(function* () {
      yield* TestClock.adjust("3 days");
      yield* keepAlive();

      expect(state.keepAlives).toBe(1);
      expect(Option.isSome(state.alarm)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets the container stop once usine stopped renewing its lease", () => {
    const { state, layer } = fakeSandbox();
    state.running = true;
    state.stored = Option.some(storedSandbox(DateTime.makeUnsafe(Duration.toMillis(LEASE))));
    return Effect.gen(function* () {
      yield* TestClock.adjust("3 hours");
      yield* keepAlive();

      expect(state.keepAlives).toBe(0);
      expect(Option.isNone(state.alarm)).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
