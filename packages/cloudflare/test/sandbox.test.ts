import { jsonKey } from "@usine/core/json-key";
import { Deferred, DateTime, Duration, Effect, Option, Redacted, Schema, Clock } from "effect";
import { assert, describe, expect, it } from "@effect/vitest";

import { HttpRouter } from "effect/http";
import { TestClock } from "effect/testing";
import { ProcessStatus, SandboxSummary } from "../src/api/api.ts";
import { processFiles, stopCommand } from "../src/sandbox/process.ts";
import { DRAIN_MARKER } from "../src/api/harness.ts";
import { collectBytes, keepAlive, LEASE, restore, sandboxRoutes } from "../src/sandbox/sandbox.ts";
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

  it.live("refuses an image the Worker doesn't have and a body with unknown keys", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      const missing = yield* Effect.promise(() =>
        call(
          "PUT",
          `/v1/sandboxes/${NAME}`,
          createBody().replace('"image":"usine"', '"image":"other"'),
        ),
      );
      const extra = yield* Effect.promise(() =>
        call(
          "PUT",
          `/v1/sandboxes/${NAME}`,
          createBody().replace('"owner"', '"secret":"x","owner"'),
        ),
      );

      expect(missing.status).toBe(422);
      const decodedValue13 = yield* Effect.promise(() => missing.json());
      expect(decodedValue13).toMatchObject({
        _tag: "ImageNotFound",
        images: ["usine"],
      });
      expect(extra.status).toBe(400);
      expect(state.started).toHaveLength(0);
    }),
  );

  it.live("replaces the handlers' credentials on renewal and extends the lease", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      assert(Option.isSome(state.stored));
      const firstLease = state.stored.value.leaseUntil;
      yield* Clock.Clock.defaultValue().sleep(Duration.millis(5));
      const renewed = yield* Effect.promise(() =>
        call("PUT", `/v1/sandboxes/${NAME}/credentials`, renewedBody),
      );

      expect(renewed.status).toBe(200);
      const github = state.interceptions.filter(({ _tag }) => _tag === "GitHub");
      expect(
        github.map(
          (interception) => interception._tag === "GitHub" && Redacted.value(interception.token),
        ),
      ).toEqual(["ghs_first", "ghs_first", "ghs_second", "ghs_second"]);
      assert(Option.isSome(state.stored));
      expect(DateTime.isGreaterThan(state.stored.value.leaseUntil, firstLease)).toBe(true);
    }),
  );

  it.live.each([
    ["a reattachment's credentials", "", createBody()],
    ["renewed credentials", "/credentials", renewedBody],
  ])("keeps a hold that completes while it registers %s", ([, path, body]) =>
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
      const pending = call("PUT", `/v1/sandboxes/${NAME}${path}`, body);
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
      expect(state.interceptions.slice(-5).map(({ _tag, host }) => `${_tag}:${host}`)).toEqual([
        "Denied:github.com",
        "Denied:api.github.com",
        "Denied:anthropic.usine.internal",
        "Denied:openai.usine.internal",
        "Allowed:registry.npmjs.org",
      ]);
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

  it.live("refuses to renew the credentials of a sandbox whose container stopped", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      state.running = false;
      const response = yield* Effect.promise(() =>
        call("PUT", `/v1/sandboxes/${NAME}/credentials`, renewedBody),
      );

      expect(response.status).toBe(503);
      const decodedValue12 = yield* Effect.promise(() => response.json());
      expect(decodedValue12).toMatchObject({
        _tag: "ContainerUnavailable",
      });
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

  it.live("holds a sandbox past its lease until it's destroyed, through a reattachment", () =>
    Effect.gen(function* () {
      const { state, call } = served();
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));
      const held = yield* Effect.promise(() => call("POST", `/v1/sandboxes/${NAME}/hold`));
      yield* Effect.promise(() => call("PUT", `/v1/sandboxes/${NAME}`, createBody()));

      expect(held.status).toBe(200);
      const decodedValue4 = yield* Effect.promise(() => held.json());
      expect((yield* decodeSummary(decodedValue4)).held).toBe(true);
      assert(Option.isSome(state.stored));
      expect(state.stored.value.held).toBe(true);

      yield* Effect.promise(() => call("DELETE", `/v1/sandboxes/${NAME}`));
      const gone = yield* Effect.promise(() => call("POST", `/v1/sandboxes/${NAME}/hold`));
      expect(gone.status).toBe(404);
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

  it.live("reports the protocol and the Worker's image names", () =>
    Effect.gen(function* () {
      const { call } = served();
      const response = yield* Effect.promise(() => call("GET", "/v1/health"));

      const decodedValue1 = yield* Effect.promise(() => response.json());
      expect(decodedValue1).toEqual({
        protocol: 1,
        images: ["usine"],
      });
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

  it.effect(
    "sets the inactivity timeout and handlers again when the Durable Object restarts",
    () => {
      const { state, layer } = fakeSandbox();
      state.running = true;
      state.stored = Option.some(storedSandbox(DateTime.makeUnsafe(Duration.toMillis(LEASE))));
      return Effect.gen(function* () {
        yield* restore();

        expect(state.keepAlives).toBe(1);
        expect(state.interceptions.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(layer));
    },
  );

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

describe("command output", () => {
  it.effect("keeps output bytes that aren't UTF-8 as they are", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([0xac, 0x41, 0xff]);
      const { stdout, exitCode } = yield* collectBytes({
        stdin: null,
        stdout: new Response(bytes).body,
        stderr: new Response("").body,
        exitCode: Promise.resolve(0),
      });

      expect([...stdout]).toEqual([0xac, 0x41, 0xff]);
      expect(exitCode).toBe(0);
    }),
  );
});
