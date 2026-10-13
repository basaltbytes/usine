import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import { WorkerName } from "@usine/core/worker";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import { completes, type StubParent, StubStorage } from "@usine/durable/testing";
import { Cause, Deferred, Effect, Exit, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { SSH_ENVIRONMENT_ALLOWLIST } from "../../src/remote/commands.ts";
import { CheckoutRequest, Executor } from "../../src/executor.ts";
import {
  CREDENTIALS,
  DESTINATION,
  KILL_CHILDREN,
  TEST_AGENT,
  TOKEN_PREFIX,
  WORKER,
  WORKER_ROOT,
  WORKTREE,
  fails,
  fakeMachine,
  mintingProvider,
  request,
  runtime,
} from "./support.ts";

const allowlisted = new Set<string>(SSH_ENVIRONMENT_ALLOWLIST);
const writesCredential = (line: string) => line.includes("IFS= read -r token");

/** Collects every log message and its fields as text. */
const capturedLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    lines.push(JSON.stringify(message));
  });
  return { lines, layer: Logger.layer([logger]) };
};

describe("SSH Worker", () => {
  it.effect(
    "runs children on the machine with the token only in a private file, removed after the Attempt",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const logs = capturedLogs();
      let given: AttemptRequest | undefined;
      let credentialDuringLaunch: string | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        credentialDuringLaunch = machine.state.credentials.get(CREDENTIALS);
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        assert.strictEqual(executor.kind, "ssh");
        yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
        const prepared = yield* executor.prepare(request);
        assert.strictEqual(prepared.workspace.worktree, WORKTREE);
        yield* prepared.launch({ append: () => Effect.void, salvage: () => Effect.void });

        assert(given !== undefined && given.host instanceof RemoteShell);
        assert.strictEqual(given.host.destination, DESTINATION);
        assert.deepStrictEqual(given.host.ssh.args.slice(-6), [
          "-p",
          "2222",
          "-i",
          "~/.ssh/usine_worker",
          "-o",
          "IdentitiesOnly=yes",
        ]);
        assert.include(given.host.ssh.args, "BatchMode=yes");
        assert.strictEqual(given.environment.GH_CONFIG_DIR, CREDENTIALS);
        assert.strictEqual(given.environment.USINE_GITHUB_TOKEN_FILE, `${CREDENTIALS}/token`);
        assert.strictEqual(given.environment.GIT_CONFIG_KEY_1, "credential.helper");
        assert.strictEqual(credentialDuringLaunch, `${TOKEN_PREFIX}1`);

        const lines = machine.state.calls.map(({ line }) => line);
        const stale = lines.indexOf(`exec 'rm' '-rf' '${WORKER_ROOT}/credentials'`);
        const write = lines.findIndex(writesCredential);
        const clone = lines.findIndex((line) => line.includes("'clone'"));
        const removeWorktree = lines.findIndex((line) => line.includes("'worktree' 'remove'"));
        const removeCredential = lines.indexOf(`exec 'rm' '-rf' '${CREDENTIALS}'`);
        assert(stale >= 0 && stale < write, "stale credentials go before the first write");
        assert(write < clone, "the credential exists before git needs it");
        assert(lines[clone]?.includes("'https://github.com/acme/demo.git'"));
        assert(lines[clone]?.includes(`GH_CONFIG_DIR='${CREDENTIALS}'`));
        assert(removeWorktree > lines.indexOf(KILL_CHILDREN));
        assert(removeCredential > removeWorktree, "the credential outlives checkout cleanup");
        assert.strictEqual(machine.state.credentials.size, 0);

        const [written] = machine.state.calls.filter(({ line }) => writesCredential(line));
        assert(written !== undefined);
        assert(written.input.startsWith(`${TOKEN_PREFIX}1\ngithub.com:\n`));
        assert.include(written.input, `oauth_token: "${TOKEN_PREFIX}1"`);
        for (const { command, line, input } of machine.state.calls) {
          assert.notInclude(command.args.join(" "), TOKEN_PREFIX);
          assert.notInclude(JSON.stringify(command.options.env), TOKEN_PREFIX);
          assert.strictEqual(command.options.extendEnv, false);
          for (const name of Object.keys(command.options.env ?? {}))
            assert(allowlisted.has(name), `unexpected SSH environment key: ${name}`);
          if (input !== "") assert(writesCredential(line), "only the credential write reads stdin");
        }
        assert.notInclude(JSON.stringify(given.environment), TOKEN_PREFIX);
        assert.notInclude(logs.lines.join("\n"), TOKEN_PREFIX);
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, credentials, parent)),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect("renews the token on the machine before it expires and stops after release", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    const written = () =>
      machine.state.calls.filter(({ line }) => writesCredential(line)).map(({ input }) => input);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      yield* TestClock.adjust("3 hours");
      const renewed = written();
      assert(renewed.length >= 3, `expected renewals, saw ${renewed.length} writes`);
      assert.strictEqual(
        new Set(renewed.map((input) => input.split("\n")[0])).size,
        renewed.length,
      );
      assert.strictEqual(
        machine.state.credentials.get(CREDENTIALS),
        credentials.minted.at(-1),
        "the machine has the token minted last",
      );
      yield* prepared.launch({ append: () => Effect.void, salvage: () => Effect.void });
      const released = machine.state.calls.length;
      yield* TestClock.adjust("2 hours");
      assert.strictEqual(machine.state.calls.length, released);
      assert.strictEqual(machine.state.credentials.size, 0);
    }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials)));
  });

  it.effect("renews a token about to expire before git uses it", () => {
    const machine = fakeMachine();
    // Every token expires within the renewal window, so each git command must renew first.
    const credentials = mintingProvider(60_000);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.prepare(request);
      const lines = machine.state.calls.map(({ line }) => line);
      const clone = lines.findIndex((line) => line.includes("'clone'"));
      assert(lines.slice(0, clone).filter(writesCredential).length >= 2);
      assert.strictEqual(
        machine.state.credentials.get(CREDENTIALS),
        credentials.minted.at(-1),
        "git authenticates with the token minted last",
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials)));
  });

  it.effect("salvages a failed Attempt with its credential, then removes the credential", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      machine.state.salvage = "dirty";
      const prepared = yield* executor.prepare(request);
      const recorded: Array<AttemptSalvage> = [];
      const failure = yield* prepared
        .launch({
          append: () => Effect.void,
          salvage: (salvage) => Effect.sync(() => void recorded.push(salvage)),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InfraFailure");
      assert.strictEqual(recorded[0]?._tag, "Pushed");
      const lines = machine.state.calls.map(({ line }) => line);
      const push = lines.findIndex((line) => line.includes("'push' '--force'"));
      assert(lines[push]?.includes(`USINE_GITHUB_TOKEN_FILE='${CREDENTIALS}/token'`));
      assert(lines.indexOf(`exec 'rm' '-rf' '${CREDENTIALS}'`) > push);
    }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, fails)));
  });

  it.effect(
    "recovers a crashed Attempt's checkout with a fresh credential and removes stale ones first",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      machine.state.cacheExists = true;
      machine.state.salvage = "dirty";
      // A token an earlier process wrote before it crashed.
      machine.state.credentials.set(CREDENTIALS, "ghs_left-by-a-crash");
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const recorded: Array<AttemptSalvage> = [];
        yield* executor.recover(
          {
            attemptId: request.attemptId,
            repository: request.repository,
            worker: WORKER,
            ref: request.salvageRef,
            succeeded: false,
            open: false,
          },
          (salvage) => Effect.sync(() => void recorded.push(salvage)),
        );
        assert.strictEqual(recorded[0]?._tag, "Pushed");
        const lines = machine.state.calls.map(({ line }) => line);
        const stale = lines.indexOf(`exec 'rm' '-rf' '${WORKER_ROOT}/credentials'`);
        const listing = lines.findIndex((line) => line.startsWith("exec 'find' "));
        const write = lines.findIndex(writesCredential);
        const push = lines.findIndex((line) => line.includes("'push' '--force'"));
        const remove = lines.findIndex((line) => line.includes("'worktree' 'remove'"));
        assert(stale >= 0 && stale < listing, "stale credentials go when leftovers are listed");
        assert(write > stale && write < push, "salvage pushes with a fresh credential");
        assert(lines.indexOf(`exec 'rm' '-rf' '${CREDENTIALS}'`) > remove);
        assert.strictEqual(machine.state.credentials.size, 0);
        assert.strictEqual(credentials.minted.length, 1);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials)));
    },
  );

  it.effect(
    "reattaches after a restart with a fresh credential, removing the earlier one first",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const storage = new StubStorage();
      const sink = { append: () => Effect.void, salvage: () => Effect.void };
      return Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const working: StubParent = () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const launch = yield* (yield* executor.prepare(request))
            .launch(sink)
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(launch);
        }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, working, storage)));
        assert.strictEqual(
          machine.state.credentials.size,
          0,
          "a stopping process keeps the checkout but removes the credential",
        );
        // A process that crashed instead would have left its token behind.
        machine.state.credentials.set(CREDENTIALS, credentials.minted[0] ?? "");

        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          assert.isTrue(yield* executor.isLive(request.attemptId));
          const before = machine.state.calls.length;
          const prepared = yield* executor.prepare(
            new CheckoutRequest({ ...request, reattach: true }),
          );
          const lines = machine.state.calls.slice(before).map(({ line }) => line);
          const stale = lines.indexOf(`exec 'rm' '-rf' '${WORKER_ROOT}/credentials'`);
          assert(stale >= 0 && stale < lines.findIndex(writesCredential));
          assert(
            !lines.some((line) => line.includes("'clone'") || line.includes("'worktree' 'add'")),
          );
          assert.strictEqual(machine.state.credentials.get(CREDENTIALS), `${TOKEN_PREFIX}2`);
          yield* prepared.launch(sink);
        }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, completes, storage)));
        assert.strictEqual(machine.state.credentials.size, 0);
      });
    },
  );

  it.effect("scrubs the token from a failed git command before reporting it", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    const logs = capturedLogs();
    machine.state.cloneEchoesToken = true;
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const exit = yield* executor.prepare(request).pipe(Effect.scoped, Effect.exit);
      assert(Exit.isFailure(exit));
      const reported = Cause.pretty(exit.cause);
      assert.include(reported, "x-access-token:[REDACTED]@github.com");
      assert.notInclude(reported, TOKEN_PREFIX);
      assert.notInclude(logs.lines.join("\n"), TOKEN_PREFIX);
      assert.strictEqual(machine.state.credentials.size, 0);
    }).pipe(Effect.provide(runtime(machine, credentials)), Effect.provide(logs.layer));
  });

  it.effect("preflight reports an unreachable machine or root without changing either", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      for (const { line } of machine.state.calls)
        for (const mutating of ["mkdir", "rm", "mv", "clone", "find", "read -r token"])
          assert.notInclude(line, mutating, `preflight ran ${mutating}`);

      machine.state.rootWritable = false;
      const unwritable = yield* executor.preflight(WORKER, []).pipe(Effect.flip);
      assert(unwritable._tag === "WorkerCapabilityError");
      assert.strictEqual(unwritable.capability, "machine");
      assert.include(unwritable.message, "/srv/usine is not a writable directory");

      machine.state.reachable = false;
      const unreachable = yield* executor.preflight(WORKER, []).pipe(Effect.flip);
      assert(unreachable._tag === "WorkerCapabilityError");
      assert.strictEqual(
        unreachable.message,
        `Could not reach SSH Worker eu-one at ${DESTINATION}`,
      );

      const unknown = yield* executor.preflight(WorkerName.make("eu-two"), []).pipe(Effect.flip);
      assert(unknown._tag === "WorkerCapabilityError");
      assert.strictEqual(unknown.capability, "machine");
      assert.strictEqual(credentials.minted.length, 0);
    }).pipe(Effect.provide(runtime(machine, credentials)));
  });
});
