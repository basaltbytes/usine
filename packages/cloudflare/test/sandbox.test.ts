import { assert, describe, expect, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Option, Redacted, Schema } from "effect";
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

const revocation = (issued: string) => JSON.stringify({ issuedAt: issued, providers: [] });

const createBody = (attempt: string = ATTEMPT, issued = issuedAt(0)) =>
  JSON.stringify({
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

const decodeSummary = Schema.decodeUnknownSync(Schema.toCodecJson(SandboxSummary));

describe("sandbox routes", () => {
  it("starts the container without internet and routes its traffic through the handlers", async () => {
    const { state, call } = served();
    const response = await call("PUT", `/v1/sandboxes/${NAME}`, createBody());

    expect(response.status).toBe(200);
    const summary = decodeSummary(await response.json());
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
  });

  it("returns the running sandbox when the same Attempt asks again, and refuses another Attempt", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    const again = await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    const other = await call("PUT", `/v1/sandboxes/${NAME}`, createBody("run-2/execute/1"));

    expect(again.status).toBe(200);
    expect(state.started).toHaveLength(1);
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ _tag: "SandboxConflict", attempt: ATTEMPT });
  });

  it("refuses an image the Worker doesn't have and a body with unknown keys", async () => {
    const { state, call } = served();
    const missing = await call(
      "PUT",
      `/v1/sandboxes/${NAME}`,
      createBody().replace('"image":"usine"', '"image":"other"'),
    );
    const extra = await call(
      "PUT",
      `/v1/sandboxes/${NAME}`,
      createBody().replace('"owner"', '"secret":"x","owner"'),
    );

    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ _tag: "ImageNotFound", images: ["usine"] });
    expect(extra.status).toBe(400);
    expect(state.started).toHaveLength(0);
  });

  it("replaces the handlers' credentials on renewal and extends the lease", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    assert(Option.isSome(state.stored));
    const firstLease = state.stored.value.leaseUntil;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const renewed = await call(
      "PUT",
      `/v1/sandboxes/${NAME}/credentials`,
      JSON.stringify(encodeCredentials("ghs_second", issuedAt(1))),
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
  });

  it.each([
    ["a reattachment's credentials", "", createBody()],
    [
      "renewed credentials",
      "/credentials",
      JSON.stringify(encodeCredentials("ghs_second", issuedAt(1))),
    ],
  ])("keeps a hold that completes while it registers %s", async (_, path, body) => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    let registering: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (registering = resolve));
    let register: () => void = () => undefined;
    const registered = new Promise<void>((resolve) => (register = resolve));
    state.beforeIntercept = () => {
      state.beforeIntercept = () => Effect.void;
      registering();
      return Effect.promise(() => registered);
    };
    const pending = call("PUT", `/v1/sandboxes/${NAME}${path}`, body);
    await reached;
    const held = await call("POST", `/v1/sandboxes/${NAME}/hold`);
    register();
    const response = await pending;

    expect([held.status, response.status]).toEqual([200, 200]);
    assert(Option.isSome(state.stored));
    expect(state.stored.value.held).toBe(true);
  });

  it("keeps a revocation that arrives while an earlier renewal registers its handlers", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    let registering: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (registering = resolve));
    let register: () => void = () => undefined;
    const registered = new Promise<void>((resolve) => (register = resolve));
    state.beforeIntercept = () => {
      state.beforeIntercept = () => Effect.void;
      registering();
      return Effect.promise(() => registered);
    };
    const renewal = call(
      "PUT",
      `/v1/sandboxes/${NAME}/credentials`,
      JSON.stringify(encodeCredentials("ghs_second", issuedAt(1))),
    );
    await reached;
    // The executor stopped waiting for the renewal and revokes the credentials.
    const revoked = call("PUT", `/v1/sandboxes/${NAME}/credentials`, revocation(issuedAt(2)));
    await Promise.race([revoked, new Promise((resolve) => setTimeout(resolve, 50))]);
    register();
    const statuses = (await Promise.all([renewal, revoked])).map(({ status }) => status);

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
  });

  it.each([
    ["renewal", "/credentials", JSON.stringify(encodeCredentials("ghs_second", issuedAt(1)))],
    ["reattachment", "", createBody(ATTEMPT, issuedAt(1))],
  ])(
    "refuses a %s issued before a revocation that reached the sandbox first",
    async (_, path, body) => {
      const { state, call } = served();
      await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
      const revoked = await call(
        "PUT",
        `/v1/sandboxes/${NAME}/credentials`,
        revocation(issuedAt(2)),
      );
      const registered = state.interceptions.length;
      const stale = await call("PUT", `/v1/sandboxes/${NAME}${path}`, body);

      expect(revoked.status).toBe(200);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        _tag: "StaleCredentials",
        issuedAt: issuedAt(1),
        current: issuedAt(2),
      });
      expect(state.interceptions).toHaveLength(registered);
      assert(Option.isSome(state.stored));
      expect(Option.isNone(state.stored.value.credentials.github)).toBe(true);
      expect(DateTime.formatIso(state.stored.value.credentials.issuedAt)).toBe(issuedAt(2));
    },
  );

  it("refuses to renew the credentials of a sandbox whose container stopped", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    state.running = false;
    const response = await call(
      "PUT",
      `/v1/sandboxes/${NAME}/credentials`,
      JSON.stringify(encodeCredentials("ghs_second", issuedAt(1))),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ _tag: "ContainerUnavailable" });
  });

  it("stops the sandbox's commands through the process files", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    state.run = () => finishedProcess("2\n");
    const response = await call("POST", `/v1/sandboxes/${NAME}/stop`);

    expect(await response.json()).toEqual({ stopped: 2 });
    expect(state.execs).toEqual([stopCommand]);
  });

  it("fails the stop when a process survives the stop script", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    state.run = () => finishedProcess("", 1);
    const response = await call("POST", `/v1/sandboxes/${NAME}/stop`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ _tag: "ContainerUnavailable" });
  });

  it("destroys the container, its storage, and its registry entry", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    const destroyed = await call("DELETE", `/v1/sandboxes/${NAME}`);
    const again = await call("DELETE", `/v1/sandboxes/${NAME}`);
    const missing = await call("GET", `/v1/sandboxes/${NAME}`);

    expect(await destroyed.json()).toEqual({ destroyed: true });
    expect(await again.json()).toEqual({ destroyed: false });
    expect(state.destroyed).toBe(1);
    expect(Option.isNone(state.stored) && Option.isNone(state.alarm)).toBe(true);
    expect(state.forgotten).toEqual([NAME, NAME]);
    expect(missing.status).toBe(404);
  });

  it("reads a command's state and output size from its process files", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    const process = "0123456789abcdef0123456789abcdef";
    const files = processFiles(Schema.decodeUnknownSync(ProcessStatus.fields.process)(process));
    state.files.set(files.pid, text("4242"));
    state.files.set(files.stdout, text("hello\n"));
    const running = await call("GET", `/v1/sandboxes/${NAME}/processes/${process}`);
    state.files.set(files.exit, text("7"));
    const exited = await call("GET", `/v1/sandboxes/${NAME}/processes/${process}`);
    const unknown = await call("GET", `/v1/sandboxes/${NAME}/processes/${"f".repeat(32)}`);

    expect(await running.json()).toEqual({
      process,
      pid: 4242,
      state: { _tag: "Running" },
      stdoutBytes: 6,
      stderrBytes: 0,
    });
    expect(await exited.json()).toMatchObject({ state: { _tag: "Exited", exitCode: 7 } });
    expect(unknown.status).toBe(404);
  });

  it("holds a sandbox past its lease until it's destroyed, through a reattachment", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    const held = await call("POST", `/v1/sandboxes/${NAME}/hold`);
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());

    expect(held.status).toBe(200);
    expect(decodeSummary(await held.json()).held).toBe(true);
    assert(Option.isSome(state.stored));
    expect(state.stored.value.held).toBe(true);

    await call("DELETE", `/v1/sandboxes/${NAME}`);
    const gone = await call("POST", `/v1/sandboxes/${NAME}/hold`);
    expect(gone.status).toBe(404);
  });

  it("reports that the platform is draining the container once its init wrote the marker", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    const before = decodeSummary(await (await call("GET", `/v1/sandboxes/${NAME}`)).json());
    state.files.set(DRAIN_MARKER, text("2026-10-25T20:00:00Z\n"));
    const after = decodeSummary(await (await call("GET", `/v1/sandboxes/${NAME}`)).json());

    expect(before.draining).toBe(false);
    expect(after.draining).toBe(true);
  });

  it("reports the protocol and the Worker's image names", async () => {
    const { call } = served();
    const response = await call("GET", "/v1/health");

    expect(await response.json()).toEqual({ protocol: 1, images: ["usine"] });
  });
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
