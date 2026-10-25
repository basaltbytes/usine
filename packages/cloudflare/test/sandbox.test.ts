import { assert, describe, expect, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Option, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { TestClock } from "effect/testing";
import { ProcessStatus, SandboxSummary } from "../src/api/api.ts";
import { processFiles, stopCommand } from "../src/sandbox/process.ts";
import { keepAlive, LEASE, sandboxRoutes } from "../src/sandbox/sandbox.ts";
import {
  ATTEMPT,
  fakeSandbox,
  finishedProcess,
  IMAGE,
  NAME,
  OWNER,
  storedSandbox,
  text,
} from "./support.ts";

const encodeCredentials = (token: string) => ({
  github: token,
  providers: [{ provider: "anthropic", credential: { _tag: "ApiKey", key: "sk-ant-key" } }],
});

const createBody = (attempt: string = ATTEMPT) =>
  JSON.stringify({
    owner: OWNER,
    attempt,
    image: IMAGE,
    instanceType: "standard-3",
    credentials: encodeCredentials("ghs_first"),
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
      JSON.stringify(encodeCredentials("ghs_second")),
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

  it("refuses to renew the credentials of a sandbox whose container stopped", async () => {
    const { state, call } = served();
    await call("PUT", `/v1/sandboxes/${NAME}`, createBody());
    state.running = false;
    const response = await call(
      "PUT",
      `/v1/sandboxes/${NAME}/credentials`,
      JSON.stringify(encodeCredentials("ghs_second")),
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
