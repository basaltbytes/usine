import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import { completes, type StubParent, StubStorage } from "@usine/durable/testing";
import { Attachment, AttachmentId, Attachments, InstallationCredential } from "@usine/gateway";
import { DateTime, Deferred, Effect, Fiber, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { CheckoutRequest, Executor } from "../../../src/executor.ts";
import { SSH_ENVIRONMENT_ALLOWLIST } from "../../../src/remote/commands.ts";
import {
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
  fakeGateway,
  gatewayAddress,
  gatewayRuntime,
} from "./support.ts";

const allowlisted = new Set<string>(SSH_ENVIRONMENT_ALLOWLIST);
const sink = { append: () => Effect.void, salvage: () => Effect.void };

/** The caller token a child host sends to the machine. */
const callerTokenOf = (request: AttemptRequest | undefined): string => {
  assert(request !== undefined && request.host instanceof RemoteShell);
  const token = request.host.sshEnvironment.GH_ENTERPRISE_TOKEN;
  assert(token !== undefined, "the child host sends the caller token");
  return token;
};

/** An attachment an earlier orchestrator process made and never detached. */
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
      yield* advance(45);
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
      yield* advance(2);
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
          succeeded: false,
          open: false,
        },
        () => Effect.void,
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
        yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
        assert.deepStrictEqual(
          gateway.calls.map(({ method, path }) => `${method} ${path}`),
          ["GET /v1/attachments"],
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
        const missingGitHubToken = yield* executor.preflight(WORKER, []).pipe(Effect.flip);
        assert(missingGitHubToken._tag === "WorkerCapabilityError");
        assert.include(missingGitHubToken.message, "sshd drops GH_TOKEN;");
        machine.state.droppedSentVariables.clear();

        machine.state.acceptsSentVariables = false;
        const dropped = yield* executor.preflight(WORKER, []).pipe(Effect.flip);
        assert(dropped._tag === "WorkerCapabilityError");
        assert.strictEqual(dropped.capability, "gateway");
        assert.include(
          dropped.message,
          "AcceptEnv GIT_CONFIG_VALUE_0 GH_ENTERPRISE_TOKEN GH_TOKEN ANTHROPIC_AUTH_TOKEN",
        );

        machine.state.acceptsSentVariables = true;
        machine.state.gatewayReachable = false;
        const unreachable = yield* executor.preflight(WORKER, []).pipe(Effect.flip);
        assert(unreachable._tag === "WorkerCapabilityError");
        assert.strictEqual(
          unreachable.message,
          "SSH Worker eu-one cannot reach its Gateway at git.gw.test",
        );
        assert.strictEqual(credentials.minted.length, 0);
      }).pipe(Effect.provide(gatewayRuntime(machine, credentials, gateway)));
    },
  );

  it.effect("preflight reports a Gateway that refuses the admin token", () => {
    const machine = fakeMachine();
    const gateway = fakeGateway(machine);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const refused = yield* executor.preflight(WORKER, []).pipe(Effect.flip);
      assert(refused._tag === "WorkerCapabilityError");
      assert.strictEqual(refused.capability, "gateway");
      assert.include(refused.message, "the Gateway refused the admin token");
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
        yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
        const lines = machine.state.calls.map(({ line }) => line);
        assert.include(lines, "exec 'claude' '--version'");
        assert(!lines.some((line) => line.includes("'auth' 'status'")));
      }).pipe(Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway)));
    },
  );

  it.effect(
    "refuses Claude Code without the Gateway's Anthropic credential, and Codex behind any Gateway",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      const codex = new BrainSpec({
        harness: "codex",
        model: ModelId.make("gpt-5.6-sol"),
        effort: "low",
      });
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const claude = yield* executor.preflight(WORKER, [TEST_AGENT.brain]).pipe(Effect.flip);
        assert(claude._tag === "WorkerCapabilityError");
        assert.strictEqual(claude.capability, "harness-login");
        assert.include(claude.message, "llm_providers");
        const refused = yield* executor.preflight(WORKER, [codex]).pipe(Effect.flip);
        assert(refused._tag === "WorkerCapabilityError");
        assert.strictEqual(refused.capability, "harness-login");
        assert.include(refused.message, "issues/244");
      }).pipe(
        Effect.provide(
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: [] }),
          }),
        ),
      );
    },
  );
});
