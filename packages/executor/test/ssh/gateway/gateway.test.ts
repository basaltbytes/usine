import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { HarnessReady, HarnessUnavailableError } from "@usine/core/agent/capability";
import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import { completes, type StubParent, StubStorage } from "@usine/durable/testing";
import {
  AnthropicProvider,
  AnthropicSubscriptionToken,
  Attachment,
  AttachmentId,
  Attachments,
  InstallationCredential,
  SettingsInForce,
  UpstreamBase,
} from "@usine/gateway";
import { DateTime, Deferred, Effect, Fiber, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { CheckoutRequest, Executor } from "../../../src/executor.ts";
import { SSH_ENVIRONMENT_ALLOWLIST } from "../../../src/remote/commands.ts";
import {
  aloneOnItem,
  COMMIT_AUTHOR,
  GIT_DIRECTORY,
  TEST_AGENT,
  TOKEN_PREFIX,
  WORKER,
  WORKER_ROOT,
  capturedLogs,
  executorLayer,
  fails,
  fakeMachine,
  mintingProvider,
  request,
  sentVariables,
  writesCredential,
} from "../support.ts";
import {
  attachmentsInForce,
  advance,
  claimsOf,
  eventually,
  fakeGateway,
  gatewayAddress,
  gatewayRuntime,
} from "./support.ts";

const allowlisted = new Set<string>(SSH_ENVIRONMENT_ALLOWLIST);
const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

/** Returns the caller token that a child host sends to the machine. */
const callerTokenOf = (request: AttemptRequest | undefined): string => {
  assert(request !== undefined && request.host instanceof RemoteShell);
  const token = request.host.sshEnvironment.GH_ENTERPRISE_TOKEN;
  assert(token !== undefined, "the child host sends the caller token");
  return token;
};

/** An attachment left by an earlier orchestrator process. */
const leftover = (id: string, worker: string) =>
  Effect.gen(function* () {
    const store = yield* Attachments;
    yield* store.attach(
      new Attachment({
        id: AttachmentId.make(id),
        worker: WorkerName.make(worker),
        repository: RepositoryName.make("acme/demo"),
        credential: new InstallationCredential({ token: Redacted.make("ghs_left-by-a-crash") }),
        expiresAt: DateTime.add(yield* DateTime.now, { minutes: 50 }),
      }),
    );
  });

describe("SSH Worker behind a Gateway", () => {
  it.effect(
    "attaches the Attempt's token to the Gateway and gives the machine only a caller token, outside every command line",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const gateway = fakeGateway(machine);
      const logs = capturedLogs();
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const [attached] = yield* attachmentsInForce;
        assert(attached !== undefined, "the token is attached while the Attempt runs");
        assert.strictEqual(attached.worker, WORKER);
        assert.strictEqual(attached.repository, "acme/demo");
        const [listing, attach] = gateway.calls;
        assert.deepStrictEqual([listing?.method, listing?.path], ["GET", "/v1/attachments"]);
        assert.deepStrictEqual([attach?.method, attach?.path], ["POST", "/v1/attachments"]);
        assert.deepStrictEqual(
          attach?.body,
          Option.some({
            worker: "eu-one",
            repository: "acme/demo",
            credential: { _tag: "InstallationCredential" as const, token: `${TOKEN_PREFIX}1` },
            expiresAt: "1970-01-01T01:00:00.000Z",
          }),
        );
        yield* prepared.launch(sink);

        const callerToken = callerTokenOf(given);
        const claims = yield* claimsOf(callerToken);
        assert.strictEqual(claims.attachment, attached.id);
        assert(given?.host instanceof RemoteShell);
        assert.include(
          given.host.ssh.args,
          "SendEnv=GIT_CONFIG_VALUE_0 GH_ENTERPRISE_TOKEN GH_TOKEN ANTHROPIC_AUTH_TOKEN",
        );
        assert.strictEqual(given.host.sshEnvironment.GH_TOKEN, callerToken);
        assert.strictEqual(given.host.sshEnvironment.ANTHROPIC_AUTH_TOKEN, callerToken);
        assert.strictEqual(given.environment.GH_HOST, "git.gw.test");
        assert.strictEqual(given.environment.GH_CONFIG_DIR, `${WORKER_ROOT}/gh`);
        assert.strictEqual(given.environment.ANTHROPIC_BASE_URL, "http://llm.gw.test/anthropic");
        assert.notInclude(JSON.stringify(given.environment), callerToken);
        assert.notInclude(JSON.stringify(given.environment), TOKEN_PREFIX);

        const clone = machine.state.calls.find(({ line }) => line.includes("'clone'"));
        assert(clone !== undefined);
        assert.include(clone.line, "'http://git.gw.test/acme/demo.git'");
        assert.include(clone.line, "GIT_CONFIG_KEY_0='http.http://git.gw.test/.extraHeader'");
        assert.strictEqual(
          clone.command.options.env?.GIT_CONFIG_VALUE_0,
          `x-usine-gateway-token: ${callerToken}`,
        );
        assert.include(machine.state.files.get(`${WORKER_ROOT}/gh/config.yml`) ?? "", "http.sock");
        assert.include(machine.state.files.get(`${WORKER_ROOT}/gh/hosts.yml`) ?? "", "git.gw.test");

        for (const { command, line, input } of machine.state.calls) {
          assert(!writesCredential(line), "no token is written on the machine");
          assert.strictEqual(input, "", "no command reads a secret from its input");
          assert.notInclude(command.args.join(" "), TOKEN_PREFIX);
          assert.notInclude(command.args.join(" "), callerToken);
          assert.notInclude(JSON.stringify(command.options.env), TOKEN_PREFIX);
          const sent = new Set(sentVariables(command));
          for (const name of Object.keys(command.options.env ?? {}))
            assert(
              allowlisted.has(name) || sent.has(name),
              `unexpected SSH environment key: ${name}`,
            );
        }
        for (const contents of machine.state.files.values()) {
          assert.notInclude(contents, TOKEN_PREFIX);
          assert.notInclude(contents, callerToken);
        }
        const detach = gateway.calls.at(-1);
        assert.deepStrictEqual(
          [detach?.method, detach?.path],
          ["DELETE", `/v1/attachments/${attached.id}`],
        );
        const removeWorktree = machine.state.calls.findIndex(({ line }) =>
          line.includes("'worktree' 'remove'"),
        );
        assert(
          removeWorktree >= 0 && (detach?.machineCalls ?? 0) > removeWorktree,
          "the token stays attached until the checkout is cleaned up",
        );
        assert.deepStrictEqual(yield* attachmentsInForce, []);
        assert.notInclude(logs.lines.join("\n"), TOKEN_PREFIX);
        assert.notInclude(logs.lines.join("\n"), callerToken);
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, credentials, gateway, { parent })),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect(
    "opens its own forward to the Gateway's admin API before the first attach, and closes it with the executor",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const gateway = fakeGateway(machine);
      const logs = capturedLogs();
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* (yield* executor.prepare(request)).launch(sink);
          const [forward, ...others] = machine.state.forwards;
          assert(forward !== undefined, "the executor opened a forward");
          assert.strictEqual(others.length, 0, "one forward serves every request");
          const { command, args, options } = forward.command;
          assert.strictEqual(command, "ssh");
          assert.deepStrictEqual(
            args.slice(0, 6),
            ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"],
            "the SSH options of the executor's other clients",
          );
          assert.strictEqual(args.at(-1), "usine-gateway");
          assert.include(args, `127.0.0.1:${String(forward.port)}:127.0.0.1:7070`);
          assert.include(args, "ExitOnForwardFailure=yes");
          assert.notInclude(args, "-p", "the Worker's port is not the Gateway's");
          assert.notInclude(args, "~/.ssh/usine_worker", "nor is its key");
          for (const name of Object.keys(options.env ?? {}))
            assert(allowlisted.has(name), `unexpected SSH environment key: ${name}`);

          const spawned = machine.state.calls.findIndex((call) => call.command === forward.command);
          const attach = gateway.calls.find(({ method }) => method === "POST");
          assert(attach !== undefined && attach.port === forward.port);
          assert(attach.machineCalls > spawned, "the forward opens before the first attach");
          assert(
            gateway.calls.every(({ delivered }) => delivered),
            "no request met a closed forward",
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayRuntime(machine, credentials, gateway)));
        assert(
          machine.state.forwards.every(({ live }) => !live),
          "the forward's SSH client ends with the executor",
        );
        const opened = logs.lines.find((line) =>
          line.includes("Opened the forward to the Gateway's admin API"),
        );
        assert.include(opened ?? "", '"gateway":"usine-gateway"');
      }).pipe(Effect.provide(logs.layer));
    },
  );

  it.effect(
    "reopens a forward whose SSH client exited after a pause, and the next Attempt attaches through it",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const gateway = fakeGateway(machine);
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [], 1);
        const [first] = machine.state.forwards;
        assert(first !== undefined);
        yield* first.drop;
        yield* eventually(() => machine.state.forwards.length === 2, "1 second");
        const second = machine.state.forwards[1];
        assert(second?.live === true);

        yield* (yield* executor.prepare(request)).launch(sink);
        const attach = gateway.calls.find(({ method }) => method === "POST");
        assert(attach?.delivered === true && attach.port === second.port);
        assert(
          gateway.calls.every(({ delivered }) => delivered),
          "the forward was open again before the Attempt needed it",
        );
        const logged = logs.lines.join("\n");
        for (const line of [
          "The forward to the Gateway's admin API exited; reopening it after a pause",
          "Connection to 203.0.113.30 closed by remote host.",
          "Reopening the forward to the Gateway's admin API",
          "Reopened the forward to the Gateway's admin API",
        ])
          assert.include(logged, line);
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, credentials, gateway)),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect("an attach while the forward is closed reopens it at once instead of waiting", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    const gateway = fakeGateway(machine);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [], 1);
      const [first] = machine.state.forwards;
      assert(first !== undefined);
      yield* first.drop;
      yield* (yield* executor.prepare(request)).launch(sink);
      assert.strictEqual(machine.state.forwards.length, 2, "one reopen, without the clock moving");
      const attach = gateway.calls.find(({ method }) => method === "POST");
      assert(attach?.delivered === true && attach.port === machine.state.forwards[1]?.port);
    }).pipe(Effect.scoped, Effect.provide(gatewayRuntime(machine, credentials, gateway)));
  });

  it.effect(
    "sends a renewal once more through a reopened forward when the forward died without its SSH client noticing",
    () => {
      const machine = fakeMachine();
      // Fifteen-minute tokens are renewed ten minutes in.
      const credentials = mintingProvider(15 * 60_000);
      const gateway = fakeGateway(machine);
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const [attached] = yield* attachmentsInForce;
        assert(attached !== undefined);
        yield* advance(gateway, 9);
        const [first] = machine.state.forwards;
        assert(first !== undefined);
        first.carries = false;
        yield* advance(gateway, 1);
        const renewedThroughSecond = () =>
          gateway.calls.some(
            ({ method, port, delivered, body }) =>
              method === "PUT" &&
              delivered &&
              port === machine.state.forwards[1]?.port &&
              Option.exists(body, ({ credential }) => credential.token === `${TOKEN_PREFIX}2`),
          );
        yield* eventually(renewedThroughSecond);
        assert.strictEqual(machine.state.forwards.length, 2, "one reopen");
        assert(
          gateway.calls.some(
            ({ method, port, delivered }) => method === "PUT" && port === first.port && !delivered,
          ),
          "the first try met the dead forward",
        );
        const [renewed] = yield* attachmentsInForce;
        assert.strictEqual(renewed?.id, attached.id);
        assert(
          renewed !== undefined && DateTime.isGreaterThan(renewed.expiresAt, attached.expiresAt),
        );
        const logged = logs.lines.join("\n");
        assert.include(
          logged,
          "A Gateway admin request did not get through; reopening the forward and sending it once more",
        );
        assert.include(
          logged,
          "Replacing the forward to the Gateway's admin API, which a request found unanswered",
        );
        assert.notInclude(logged, "Attempt credential renewal failed");
        yield* prepared.launch(sink);
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, credentials, gateway)),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect(
    "fails the attach with the time the Gateway became unreachable while its forward stays closed, and keeps trying to open it",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const gateway = fakeGateway(machine);
      const logs = capturedLogs();
      machine.state.gatewayAcceptsSsh = false;
      const tries = () =>
        machine.state.calls.filter(({ command }) => command.args.includes("-N")).length;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const failure = yield* executor.prepare(request).pipe(Effect.flip);
        assert(failure._tag === "CredentialUnavailableError", failure._tag);
        assert.include(
          failure.message,
          'Can\'t attach a token on the admin API of gateway usine-gateway for worker "eu-one": the forward through usine-gateway has been closed since 1970-01-01T00:00:00.000Z: ssh: connect to host 203.0.113.30 port 22: Connection refused',
        );
        assert.deepStrictEqual(gateway.calls, [], "no request without a forward");
        assert.include(logs.lines.join("\n"), '"closedSince":"1970-01-01T00:00:00.000Z"');
        const before = tries();
        yield* eventually(() => tries() >= before + 5, "1 minute");
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, credentials, gateway)),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect(
    "says since when the admin API has not answered while its forward is open, until it answers again",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const gateway = fakeGateway(machine);
      const logs = capturedLogs();
      const unanswered = (since: string) =>
        `Can't attach a token on the admin API of gateway usine-gateway for worker "eu-one": the admin API through usine-gateway hasn't responded since ${since}: no response (TransportError)`;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        gateway.switches.answering = false;
        const first = yield* executor.prepare(request).pipe(Effect.flip);
        assert.include(first.message, unanswered("1970-01-01T00:00:00.000Z"));

        yield* TestClock.adjust("1 minute");
        const second = yield* executor.prepare(request).pipe(Effect.flip);
        assert.include(second.message, unanswered("1970-01-01T00:00:00.000Z"));
        const retry = logs.lines
          .filter((line) => line.includes("A Gateway admin request did not get through"))
          .at(-1);
        assert.include(retry, '"unansweredSince":"1970-01-01T00:00:00.000Z"');

        gateway.switches.answering = true;
        yield* (yield* executor.prepare(request)).launch(sink);
        yield* TestClock.adjust("1 minute");
        gateway.switches.answering = false;
        const third = yield* executor.prepare(request).pipe(Effect.flip);
        assert.include(third.message, unanswered("1970-01-01T00:02:00.000Z"));
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, credentials, gateway)),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect("renews the same attachment with a fresh token before it expires", () => {
    const machine = fakeMachine();
    // Fifteen-minute tokens are renewed every ten minutes.
    const credentials = mintingProvider(15 * 60_000);
    const gateway = fakeGateway(machine);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      const [attached] = yield* attachmentsInForce;
      assert(attached !== undefined);
      yield* advance(gateway, 45);
      const renewals = gateway.calls.slice(
        gateway.calls.findIndex(({ method }) => method === "POST") + 1,
      );
      assert(renewals.length >= 3, `expected renewals, saw ${renewals.length}`);
      for (const renewal of renewals) {
        assert.strictEqual(renewal.method, "PUT");
        assert.strictEqual(renewal.path, `/v1/attachments/${attached.id}`);
      }
      const tokens = renewals.map(({ body }) =>
        Option.getOrNull(Option.map(body, (sent) => sent.credential.token)),
      );
      assert.deepStrictEqual(
        tokens.filter((token, index) => token !== tokens[index - 1]),
        credentials.minted,
        "every PUT carries the token minted last, never an older one",
      );
      const [renewed] = yield* attachmentsInForce;
      assert.strictEqual(renewed?.id, attached.id);
      assert(
        renewed !== undefined && DateTime.isGreaterThan(renewed.expiresAt, attached.expiresAt),
      );
      yield* prepared.launch(sink);
      const released = gateway.calls.length;
      yield* TestClock.adjust("2 hours");
      assert.strictEqual(gateway.calls.length, released, "renewal stops with the Attempt");
      assert.deepStrictEqual(yield* attachmentsInForce, []);
    }).pipe(Effect.scoped, Effect.provide(gatewayRuntime(machine, credentials, gateway)));
  });

  it.effect("gives a restarted Gateway the Attempt's attachment back within two minutes", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    const gateway = fakeGateway(machine);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.prepare(request);
      const [attached] = yield* attachmentsInForce;
      assert(attached !== undefined);
      // A restart empties the Gateway's store.
      const store = yield* Attachments;
      yield* store.detach(attached.id);
      assert.deepStrictEqual(yield* attachmentsInForce, []);
      yield* advance(gateway, 2);
      const [restored] = yield* attachmentsInForce;
      assert.strictEqual(
        restored?.id,
        attached.id,
        "the same attachment, so the caller token holds",
      );
    }).pipe(Effect.scoped, Effect.provide(gatewayRuntime(machine, credentials, gateway)));
  });

  it.effect("pushes a failed Attempt's salvage through the Gateway before detaching", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    const gateway = fakeGateway(machine);
    machine.state.salvage = "dirty";
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      const recorded: Array<AttemptSalvage> = [];
      yield* prepared
        .launch({
          append: () => Effect.void,
          comments: () => Effect.void,
          transcript: Effect.succeed([]),
          windows: aloneOnItem(),
          salvage: (salvage) => Effect.sync(() => void recorded.push(salvage)),
        })
        .pipe(Effect.flip);
      assert.strictEqual(recorded[0]?._tag, "Pushed");
      const push = machine.state.calls.findIndex(({ line }) => line.includes("'push' '--force'"));
      const pushed = machine.state.calls[push];
      assert(pushed !== undefined);
      assert.include(sentVariables(pushed.command), "GIT_CONFIG_VALUE_0");
      const detach = gateway.calls.find(({ method }) => method === "DELETE");
      assert((detach?.machineCalls ?? 0) > push, "the salvage push still has the attachment");
    }).pipe(
      Effect.scoped,
      Effect.provide(gatewayRuntime(machine, credentials, gateway, { parent: fails })),
    );
  });

  it.effect(
    "attaches a read token for a read Loop and points the children's git at its pre-push hook",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const gateway = fakeGateway(machine);
      machine.state.salvage = "dirty";
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return fails(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(
          new CheckoutRequest({
            ...request,
            loop: LoopName.make("review-pr"),
            permissions: "read",
          }),
        );
        const [attached] = yield* attachmentsInForce;
        assert(attached !== undefined);
        assert.deepStrictEqual(credentials.permissions, ["read"]);
        yield* prepared.launch(sink).pipe(Effect.flip);
        assert(given !== undefined);
        // The Gateway's own entries come first, and the token's header stays in entry 0.
        assert.strictEqual(given.environment.GIT_CONFIG_COUNT, "4");
        assert.strictEqual(given.environment.GIT_CONFIG_KEY_3, "core.hooksPath");
        assert.strictEqual(given.environment.GIT_CONFIG_VALUE_3, `${GIT_DIRECTORY}/usine-hooks`);
        assert(
          machine.state.calls.some(({ line }) =>
            line.includes(`'${GIT_DIRECTORY}/usine-hooks/pre-push'`),
          ),
        );
        assert(!machine.state.calls.some(({ line }) => line.includes("'push'")));
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, credentials, gateway, { parent })),
      );
    },
  );

  it.effect("detaches what an earlier process left for the Worker before recovering it", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    const gateway = fakeGateway(machine);
    gateway.switches.refusedDetaches.add("refused-by-gateway-001");
    return Effect.gen(function* () {
      yield* leftover("refused-by-gateway-001", "eu-one");
      yield* leftover("left-by-crash-00000001", "eu-one");
      yield* leftover("another-worker-0000001", "eu-two");
      const executor = yield* Executor;
      yield* executor.recover(
        {
          attemptId: request.attemptId,
          repository: request.repository,
          worker: WORKER,
          ref: request.salvageRef,
          permissions: "write",
          succeeded: false,
          open: false,
        },
        {
          salvage: () => Effect.void,
          comments: () => Effect.void,
          windows: aloneOnItem(),
        },
        Effect.succeed(COMMIT_AUTHOR),
      );
      assert.deepStrictEqual(
        (yield* attachmentsInForce).map(({ id }) => id).sort(),
        ["another-worker-0000001", "refused-by-gateway-001"],
        "only the Worker's own leftovers are detached, and a refusal stops no other",
      );
      assert.deepStrictEqual(gateway.calls.map(({ method, path }) => `${method} ${path}`).sort(), [
        "DELETE /v1/attachments/left-by-crash-00000001",
        "DELETE /v1/attachments/refused-by-gateway-001",
        "GET /v1/attachments",
      ]);
    }).pipe(Effect.provide(gatewayRuntime(machine, credentials, gateway)));
  });

  it.effect(
    "attaches again with a fresh attachment when an Attempt is reattached after a restart",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const gateway = fakeGateway(machine);
      const storage = new StubStorage();
      return Effect.gen(function* () {
        let first: AttemptRequest | undefined;
        const started = yield* Deferred.make<void>();
        const working: StubParent = (context) => {
          first = context.request;
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        };
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const launch = yield* (yield* executor.prepare(request))
            .launch(sink)
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(launch);
        }).pipe(
          Effect.scoped,
          Effect.provide(executorLayer(machine, credentials, gatewayAddress(), working, storage)),
        );
        const before = (yield* claimsOf(callerTokenOf(first))).attachment;
        // A process that crashed instead would have left its attachment behind.
        yield* leftover(before, "eu-one");

        let second: AttemptRequest | undefined;
        const resumed: StubParent = (context) => {
          second = context.request;
          return completes(context);
        };
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const prepared = yield* executor.prepare(
            new CheckoutRequest({ ...request, reattach: true }),
          );
          const attached = yield* attachmentsInForce;
          assert.strictEqual(attached.length, 1, "the earlier attachment is detached");
          assert.notStrictEqual(attached[0]?.id, before);
          yield* prepared.launch(sink);
        }).pipe(
          Effect.scoped,
          Effect.provide(executorLayer(machine, credentials, gatewayAddress(), resumed, storage)),
        );
        const after = yield* claimsOf(callerTokenOf(second));
        assert.notStrictEqual(
          after.attachment,
          before,
          "the children get the new attachment's token",
        );
        assert.deepStrictEqual(yield* attachmentsInForce, []);
      }).pipe(Effect.provide(gateway.layer));
    },
  );

  it.effect("warns when the Gateway refuses a detach, and the Attempt still succeeds", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    const gateway = fakeGateway(machine);
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      for (const { id } of yield* attachmentsInForce) gateway.switches.refusedDetaches.add(id);
      yield* prepared.launch(sink);
      assert.include(
        logs.lines.join("\n"),
        "Could not detach the Attempt's token from the Gateway; the attachment expires with the token",
      );
      assert.strictEqual((yield* attachmentsInForce).length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(gatewayRuntime(machine, credentials, gateway)),
      Effect.provide(logs.layer),
    );
  });

  it.effect(
    "preflight checks the admin API, the machine's sshd, and git.<domain>, changing nothing",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const gateway = fakeGateway(machine);
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        assert.deepStrictEqual(
          gateway.calls.map(({ method, path }) => `${method} ${path}`),
          ["GET /v1/attachments", "GET /v1/providers"],
        );
        const lines = machine.state.calls.map(({ line }) => line);
        assert(
          lines.some(
            (line) => line.startsWith("exec 'curl'") && line.includes("'http://git.gw.test/'"),
          ),
        );
        for (const line of lines)
          for (const mutating of ["mkdir", "rm", "mv", "clone", "find", "http_unix_socket"])
            assert.notInclude(line, mutating, `preflight ran ${mutating}`);

        machine.state.droppedSentVariables.add("GH_TOKEN");
        const missingGitHubToken = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
        assert(missingGitHubToken._tag === "WorkerCapabilityError");
        assert.include(missingGitHubToken.message, "doesn't accept GH_TOKEN.");
        machine.state.droppedSentVariables.clear();

        machine.state.acceptsSentVariables = false;
        const dropped = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
        assert(dropped._tag === "WorkerCapabilityError");
        assert.strictEqual(dropped.capability, "gateway");
        assert.include(
          dropped.message,
          "AcceptEnv GIT_CONFIG_VALUE_0 GH_ENTERPRISE_TOKEN GH_TOKEN ANTHROPIC_AUTH_TOKEN",
        );

        machine.state.acceptsSentVariables = true;
        machine.state.gatewayReachable = false;
        const unreachable = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
        assert(unreachable._tag === "WorkerCapabilityError");
        assert.strictEqual(
          unreachable.message,
          'SSH worker "eu-one" can\'t reach its gateway at git.gw.test',
        );
        assert.strictEqual(credentials.minted.length, 0);
      }).pipe(Effect.provide(gatewayRuntime(machine, credentials, gateway)));
    },
  );

  it.effect(
    "preflight reports a forward that does not open with the command to run, and passes once it opens",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      machine.state.gatewayAcceptsSsh = false;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const closed = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
        assert(closed._tag === "WorkerCapabilityError", closed._tag);
        assert.strictEqual(closed.capability, "gateway");
        assert.strictEqual(
          closed.message,
          'Can\'t open the forward to the gateway admin API of SSH worker "eu-one" through usine-gateway: ssh: connect to host 203.0.113.30 port 22: Connection refused. Run ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -N -o ExitOnForwardFailure=yes -L 127.0.0.1:7070:127.0.0.1:7070 usine-gateway to see the SSH error.',
        );
        assert.deepStrictEqual(gateway.calls, [], "the admin token is not sent without a forward");

        machine.state.gatewayAcceptsSsh = true;
        yield* executor.preflight(WORKER, [], 1);
        assert.deepStrictEqual(
          gateway.calls.map(
            ({ method, path, delivered }) => `${method} ${path} ${String(delivered)}`,
          ),
          ["GET /v1/attachments true", "GET /v1/providers true"],
        );
      }).pipe(Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway)));
    },
  );

  it.effect("preflight reports a Gateway that refuses the admin token", () => {
    const machine = fakeMachine();
    const gateway = fakeGateway(machine);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const refused = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
      assert(refused._tag === "WorkerCapabilityError");
      assert.strictEqual(refused.capability, "gateway");
      assert.include(refused.message, "the gateway rejected the admin token");
      assert.notInclude(refused.message, "wrong-admin-token");
    }).pipe(
      Effect.provide(
        gatewayRuntime(machine, mintingProvider(), gateway, {
          address: gatewayAddress({ adminToken: "wrong-admin-token-0123456789-0123456789" }),
        }),
      ),
    );
  });

  it.effect(
    "checks only Claude Code's binary when its login is the Gateway's Anthropic credential",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      machine.state.claudeLoggedIn = false;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const lines = machine.state.calls.map(({ line }) => line);
        assert.include(lines, "exec 'claude' '--version'");
        assert(!lines.some((line) => line.includes("'auth' 'status'")));
        assert(!lines.some((line) => line.includes("http_connect")), "no provider host is checked");
      }).pipe(Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway)));
    },
  );

  it.effect(
    "records the kind of the Gateway's Anthropic credential at each preflight, and a running Attempt's next Claude Code child reads the latest",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      const started = Deferred.makeUnsafe<AttemptRequest>();
      const finish = Deferred.makeUnsafe<void>();
      // The parent keeps running, as between two children, until the test lets it finish.
      const parent: StubParent = (context) =>
        Deferred.succeed(started, context.request).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.andThen(completes(context)),
        );
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const prepared = yield* executor.prepare(request);
        const launch = yield* prepared.launch(sink).pipe(Effect.forkChild);
        const given = yield* Deferred.await(started);
        assert.deepStrictEqual(yield* given.gatewayCredential, Option.some("api-key"));

        // While the Attempt runs, a Gateway reload replaces its API key with a subscription token.
        const inForce = yield* SettingsInForce;
        yield* inForce.replace({
          ...(yield* inForce.current),
          providers: {
            anthropic: Option.some(
              new AnthropicProvider({
                upstream: UpstreamBase.make("https://api.anthropic.com"),
                credential: new AnthropicSubscriptionToken({
                  token: Redacted.make("sk-ant-oat01-for-executor-tests"),
                }),
              }),
            ),
            openai: Option.none(),
          },
        });
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        // The same Attempt's next child records the kind this preflight found.
        assert.deepStrictEqual(yield* given.gatewayCredential, Option.some("subscription"));
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(launch);
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway, { parent })),
      );
    },
  );

  it.effect(
    "keeps a Gateway too old to report its credentials in the Claude plan pool, with a warning once per Worker",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      gateway.switches.reportsProviders = false;
      const logs = capturedLogs();
      const warnings = () =>
        logs.lines.filter((line) =>
          line.includes(
            "does not report the kind of its Anthropic credential; its Claude Code children count in the Claude plan pool",
          ),
        );
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const [warning] = warnings();
        assert(warning !== undefined, "the preflight warns that the plan pool is kept");
        assert.include(warning, '"worker":"eu-one"');
        const prepared = yield* executor.prepare(request);
        yield* prepared.launch(sink);
        assert(given !== undefined, "the Attempt's parent ran");
        assert.deepStrictEqual(yield* given.gatewayCredential, Option.none());

        // A reload that gives the Worker another slot preflights it again.
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 2);
        assert.strictEqual(warnings().length, 1, "the Worker is warned once");
        assert.deepStrictEqual(yield* given.gatewayCredential, Option.none());

        // Once the Gateway is upgraded, the next preflight still reads and records the kind.
        gateway.switches.reportsProviders = true;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 2);
        assert.deepStrictEqual(yield* given.gatewayCredential, Option.some("api-key"));
        assert.strictEqual(warnings().length, 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway, { parent })),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect(
    "preflight reports a Gateway that holds no Anthropic credential while the Worker's llm_providers lists it",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine, { anthropic: Option.none(), openai: Option.none() });
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const refused = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1).pipe(Effect.flip);
        assert(refused._tag === "WorkerCapabilityError");
        assert.strictEqual(refused.capability, "gateway");
        assert.strictEqual(
          refused.message,
          'The gateway of SSH worker "eu-one" has no Anthropic credential, but the worker\'s llm_providers includes anthropic. Set ANTHROPIC_API_KEY or USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN on the gateway, or remove anthropic from llm_providers.',
        );
      }).pipe(Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway)));
    },
  );

  it.effect(
    "checks Claude Code's login on the machine, then its hosts through the forward proxy, when the Gateway holds no Anthropic credential",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const lines = machine.state.calls.map(({ line }) => line);
        assert.include(lines, "exec 'claude' 'auth' 'status' '--json'");
        const hostCheck = lines.find((line) => line.includes("http_connect"));
        assert(
          hostCheck?.endsWith(
            "'sh' 'http://gw.test:3128' 'api.anthropic.com' 'platform.claude.com'",
          ),
          "the login's hosts are checked through the proxy the children use",
        );

        machine.state.refusedHosts.add("platform.claude.com");
        const refused = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1).pipe(Effect.flip);
        assert(refused._tag === "WorkerCapabilityError");
        assert.strictEqual(refused.capability, "gateway");
        assert.strictEqual(
          refused.message,
          "Claude Code uses its login on SSH worker \"eu-one\", and the gateway's forward proxy blocks platform.claude.com. Add platform.claude.com to the gateway's egress allowlist.",
        );
        machine.state.refusedHosts.clear();

        machine.state.forwardProxyReachable = false;
        const unreachable = yield* executor
          .preflight(WORKER, [TEST_AGENT.brain], 1)
          .pipe(Effect.flip);
        assert(unreachable._tag === "WorkerCapabilityError");
        assert.strictEqual(unreachable.capability, "gateway");
        assert.strictEqual(
          unreachable.message,
          "Claude Code uses its login on SSH worker \"eu-one\", which can't reach api.anthropic.com through the gateway's forward proxy at http://gw.test:3128",
        );
        machine.state.forwardProxyReachable = true;

        machine.state.claudeLoggedIn = false;
        const checked = machine.state.calls.length;
        const loggedOut = yield* executor
          .preflight(WORKER, [TEST_AGENT.brain], 1)
          .pipe(Effect.flip);
        assert(loggedOut._tag === "WorkerCapabilityError");
        assert.strictEqual(loggedOut.capability, "harness-login");
        assert.include(loggedOut.message, "Run claude auth login on the worker");
        assert(
          !machine.state.calls.slice(checked).some(({ line }) => line.includes("http_connect")),
          "a missing login is reported before any host is checked",
        );
      }).pipe(
        Effect.provide(
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: [] }),
          }),
        ),
      );
    },
  );

  it.effect(
    "checks Codex's login on the machine, then the ChatGPT hosts through the forward proxy",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      const codex = new BrainSpec({
        harness: "codex",
        model: ModelId.make("gpt-5.6-sol"),
        effort: "low",
      });
      // The fake machine cannot run Codex's app server, so the login check is scripted.
      const login = { present: true, probes: 0 };
      const harnessReadiness = () => (brain: BrainSpec) =>
        Effect.sync(() => {
          login.probes += 1;
          return login.present
            ? new HarnessReady({ harness: brain.harness })
            : new HarnessUnavailableError({
                harness: brain.harness,
                capability: "login",
                message: "Codex children need a ChatGPT login. Run codex login on the worker.",
              });
        });
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [codex], 1);
        assert.strictEqual(login.probes, 1, "the login on the machine is checked");
        const hostCheck = machine.state.calls
          .map(({ line }) => line)
          .find((line) => line.includes("http_connect"));
        assert(hostCheck?.endsWith("'sh' 'http://gw.test:3128' 'chatgpt.com' 'auth.openai.com'"));

        machine.state.refusedHosts.add("chatgpt.com");
        const refused = yield* executor.preflight(WORKER, [codex], 1).pipe(Effect.flip);
        assert(refused._tag === "WorkerCapabilityError");
        assert.strictEqual(refused.capability, "gateway");
        assert.strictEqual(
          refused.message,
          "Codex uses its login on SSH worker \"eu-one\", and the gateway's forward proxy blocks chatgpt.com. Add chatgpt.com to the gateway's egress allowlist.",
        );

        login.present = false;
        const loggedOut = yield* executor.preflight(WORKER, [codex], 1).pipe(Effect.flip);
        assert(loggedOut._tag === "WorkerCapabilityError");
        assert.strictEqual(loggedOut.capability, "harness-login");
        assert.include(loggedOut.message, "Run codex login on the worker");
      }).pipe(
        Effect.provide(
          gatewayRuntime(machine, mintingProvider(), gateway, { probes: { harnessReadiness } }),
        ),
      );
    },
  );
});
