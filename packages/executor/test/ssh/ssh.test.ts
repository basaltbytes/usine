import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { AttemptId } from "@usine/core/attempt";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { type AttemptSalvage, SalvageRef } from "@usine/core/attempt/salvage";
import { LoopName } from "@usine/core/loop";
import { WorkerName } from "@usine/core/worker";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import { completes, type StubParent, StubStorage } from "@usine/durable/testing";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SSH_ENVIRONMENT_ALLOWLIST } from "../../src/remote/commands.ts";
import { CheckoutRequest, Executor } from "../../src/executor.ts";
import {
  aloneOnItem,
  BOT_COMMITS,
  COMMIT_AUTHOR,
  CREDENTIALS,
  DESTINATION,
  GIT_DIRECTORY,
  KILL_CHILDREN,
  TEST_AGENT,
  TOKEN_PREFIX,
  WORKER,
  WORKER_ROOT,
  WORKTREE,
  capturedLogs,
  fails,
  fakeMachine,
  mintingProvider,
  request,
  runtime,
  writesCredential,
} from "./support.ts";

const allowlisted = new Set<string>(SSH_ENVIRONMENT_ALLOWLIST);

/** Returns a request on the same Worker with its own Attempt and salvage ref. */
const requestFor = (attempt: number) =>
  new CheckoutRequest({
    ...request,
    attemptId: AttemptId.make(`remote-run/execute/${attempt}`),
    salvageRef: SalvageRef.make(`usine/salvage/remote-run/${attempt}`),
  });

const isWorkerNotice = (payload: AttemptChannel.OutboundPayload) =>
  payload._tag === "WorkerUnresponsive" || payload._tag === "WorkerResponsive";

/** Returns parents for `attemptIds` that signal when they start and finish when told, with one transcript per Attempt. */
const workingAttempts = (attemptIds: ReadonlyArray<AttemptId>) =>
  Effect.gen(function* () {
    const outbound = new Map<AttemptId, Array<AttemptChannel.OutboundPayload>>();
    const signals = new Map<
      AttemptId,
      { working: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
    >();
    for (const attemptId of attemptIds) {
      outbound.set(attemptId, []);
      signals.set(attemptId, {
        working: yield* Deferred.make<void>(),
        done: yield* Deferred.make<void>(),
      });
    }
    const signalsOf = (attemptId: AttemptId) => {
      const found = signals.get(attemptId);
      assert(found !== undefined);
      return found;
    };
    const parent: StubParent = (context) =>
      Effect.suspend(() => {
        const { working, done } = signalsOf(context.request.spec.attemptId);
        return Deferred.succeed(working, undefined).pipe(
          Effect.andThen(Deferred.await(done)),
          Effect.andThen(completes(context)),
        );
      });
    return {
      parent,
      signalsOf,
      sinkFor: (attemptId: AttemptId) => ({
        append: (_direction: AttemptChannel.Direction, envelope: AttemptChannel.Envelope) =>
          Effect.sync(() => {
            if (envelope._tag === "OutboundEnvelope")
              outbound.get(attemptId)?.push(envelope.payload);
          }),
        salvage: () => Effect.void,
        comments: () => Effect.void,
        transcript: Effect.succeed([]),
        windows: aloneOnItem(attemptId),
      }),
      noticesOf: (attemptId: AttemptId) => (outbound.get(attemptId) ?? []).filter(isWorkerNotice),
    };
  });

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
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const prepared = yield* executor.prepare(request);
        assert.strictEqual(prepared.workspace.worktree, WORKTREE);
        yield* prepared.launch({
          append: () => Effect.void,
          salvage: () => Effect.void,
          comments: () => Effect.void,
          transcript: Effect.succeed([]),
          windows: aloneOnItem(),
        });

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
        // The App's bot commits, whatever git config the machine's user has.
        assert.deepInclude(given.environment, {
          GIT_AUTHOR_NAME: COMMIT_AUTHOR.login,
          GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.noreplyEmail,
          GIT_COMMITTER_NAME: COMMIT_AUTHOR.login,
          GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.noreplyEmail,
        });
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
      yield* prepared.launch({
        append: () => Effect.void,
        salvage: () => Effect.void,
        comments: () => Effect.void,
        transcript: Effect.succeed([]),
        windows: aloneOnItem(),
      });
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
          comments: () => Effect.void,
          transcript: Effect.succeed([]),
          windows: aloneOnItem(),
          salvage: (salvage) => Effect.sync(() => void recorded.push(salvage)),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InfraFailure");
      assert.strictEqual(recorded[0]?._tag, "Pushed");
      const lines = machine.state.calls.map(({ line }) => line);
      assert.include(lines.find((line) => line.includes("'commit' '--quiet'")) ?? "", BOT_COMMITS);
      const push = lines.findIndex((line) => line.includes("'push' '--force'"));
      assert(lines[push]?.includes(`USINE_GITHUB_TOKEN_FILE='${CREDENTIALS}/token'`));
      assert(lines.indexOf(`exec 'rm' '-rf' '${CREDENTIALS}'`) > push);
    }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, fails)));
  });

  it.effect(
    "gives a read Loop's Attempt a read token and a pre-push hook that explains a refused push, and pushes no salvage",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return fails(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        machine.state.salvage = "dirty";
        const prepared = yield* executor.prepare(
          new CheckoutRequest({
            ...request,
            loop: LoopName.make("review-pr"),
            permissions: "read",
          }),
        );
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
        assert.deepStrictEqual(credentials.permissions, ["read"]);

        const hooks = `${GIT_DIRECTORY}/usine-hooks`;
        const hook = machine.state.calls.find(({ line }) => line.includes(`'${hooks}/pre-push'`));
        assert(hook !== undefined, "the hook is written into the checkout's own git directory");
        assert.include(hook.line, "#!/bin/sh");
        assert.include(hook.line, "the Loop review-pr has permissions: read");
        assert.include(hook.line, "exit 1");
        assert(given !== undefined);
        assert.strictEqual(given.environment.GIT_CONFIG_COUNT, "3");
        assert.strictEqual(given.environment.GIT_CONFIG_KEY_2, "core.hooksPath");
        assert.strictEqual(given.environment.GIT_CONFIG_VALUE_2, hooks);

        const lines = machine.state.calls.map(({ line }) => line);
        assert(!lines.some((line) => line.includes("'push'")), "no salvage is pushed");
        assert(lines.some((line) => line.includes("'worktree' 'remove'")));
        assert.deepStrictEqual(recorded, []);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, parent)));
    },
  );

  it.effect("removes a read Loop's leftover checkout without a credential or salvage", () => {
    const machine = fakeMachine();
    const credentials = mintingProvider();
    machine.state.cacheExists = true;
    machine.state.salvage = "dirty";
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const recorded: Array<AttemptSalvage> = [];
      yield* executor.recover(
        {
          attemptId: request.attemptId,
          repository: request.repository,
          worker: WORKER,
          ref: request.salvageRef,
          permissions: "read",
          succeeded: false,
          open: false,
        },
        {
          salvage: (salvage) => Effect.sync(() => void recorded.push(salvage)),
          comments: () => Effect.void,
          windows: aloneOnItem(),
        },
        Effect.die("A read Loop's Attempt has no salvage to commit"),
      );
      const lines = machine.state.calls.map(({ line }) => line);
      assert(lines.some((line) => line.includes("'worktree' 'remove'")));
      assert(!lines.some((line) => line.includes("'push'")));
      assert.deepStrictEqual(recorded, []);
      assert.deepStrictEqual(credentials.minted, []);
    }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials)));
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
            permissions: "write",
            succeeded: false,
            open: false,
          },
          {
            salvage: (salvage) => Effect.sync(() => void recorded.push(salvage)),
            comments: () => Effect.void,
            windows: aloneOnItem(),
          },
          Effect.succeed(COMMIT_AUTHOR),
        );
        assert.strictEqual(recorded[0]?._tag, "Pushed");
        const lines = machine.state.calls.map(({ line }) => line);
        assert.include(
          lines.find((line) => line.includes("'commit' '--quiet'")) ?? "",
          BOT_COMMITS,
        );
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
      const sink = {
        append: () => Effect.void,
        salvage: () => Effect.void,
        comments: () => Effect.void,
        transcript: Effect.succeed([]),
        windows: aloneOnItem(),
      };
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

  it.effect(
    "reports in the transcript when the Worker stops answering and when it answers again, and the Attempt goes on",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const logs = capturedLogs();
      const outbound: Array<AttemptChannel.OutboundPayload> = [];
      const sink = {
        append: (_direction: AttemptChannel.Direction, envelope: AttemptChannel.Envelope) =>
          Effect.sync(() => {
            if (envelope._tag === "OutboundEnvelope") outbound.push(envelope.payload);
          }),
        salvage: () => Effect.void,
        comments: () => Effect.void,
        transcript: Effect.succeed([]),
        windows: aloneOnItem(),
      };
      const notices = () =>
        outbound.filter(
          (payload) => payload._tag === "WorkerUnresponsive" || payload._tag === "WorkerResponsive",
        );
      const probes = () => machine.state.calls.filter(({ line }) => line === "exec 'true'").length;
      return Effect.gen(function* () {
        const working = yield* Deferred.make<void>();
        const done = yield* Deferred.make<void>();
        const parent: StubParent = (context) =>
          Deferred.succeed(working, undefined).pipe(
            Effect.andThen(Deferred.await(done)),
            Effect.andThen(completes(context)),
          );
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const launch = yield* (yield* executor.prepare(request))
            .launch(sink)
            .pipe(Effect.forkChild);
          yield* Deferred.await(working);
          const launchedAt = DateTime.formatIso(yield* DateTime.now);

          machine.state.stalled = true;
          yield* TestClock.adjust("1 minute");
          yield* TestClock.adjust("45 seconds");
          assert.lengthOf(notices(), 1, "the first probe without an answer reports it");
          const silent = notices()[0];
          assert(silent?._tag === "WorkerUnresponsive");
          assert.strictEqual(silent.worker, WORKER);
          assert.strictEqual(DateTime.formatIso(silent.lastAnsweredAt), launchedAt);
          assert.strictEqual(silent.reason, "No answer within 45 seconds");

          yield* TestClock.adjust("1 minute");
          yield* TestClock.adjust("45 seconds");
          assert.lengthOf(notices(), 1, "a Worker that stays silent is reported once");

          machine.state.stalled = false;
          yield* TestClock.adjust("1 minute");
          assert.lengthOf(notices(), 2);
          const answering = notices()[1];
          assert(answering?._tag === "WorkerResponsive");
          assert.strictEqual(DateTime.formatIso(answering.lastAnsweredAt), launchedAt);

          yield* Deferred.succeed(done, undefined);
          const result = yield* Fiber.join(launch);
          assert.strictEqual(result.message, `Completed: ${request.task}`);
          const probed = probes();
          yield* TestClock.adjust("10 minutes");
          assert.strictEqual(probes(), probed, "probing ends with the Attempt");
        }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, parent)));

        const warnings = logs.lines.filter((line) => line.includes("The Worker"));
        assert.lengthOf(warnings, 3);
        assert.include(warnings[0], "The Worker stopped answering");
        assert.include(warnings[0], `"lastAnsweredAt":"`);
        assert.include(warnings[1], "The Worker still does not answer");
        assert.include(warnings[2], "The Worker answers again");
      }).pipe(Effect.provide(logs.layer));
    },
  );

  it.effect(
    "probes a Worker once per minute however many Attempts run on it, and reports to each of them",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const second = requestFor(2);
      const attempts = [request.attemptId, second.attemptId];
      const probes = () => machine.state.calls.filter(({ line }) => line === "exec 'true'").length;
      return Effect.gen(function* () {
        const { parent, signalsOf, sinkFor, noticesOf } = yield* workingAttempts(attempts);
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const first = yield* (yield* executor.prepare(request))
            .launch(sinkFor(request.attemptId))
            .pipe(Effect.forkChild);
          yield* Deferred.await(signalsOf(request.attemptId).working);
          const other = yield* (yield* executor.prepare(second))
            .launch(sinkFor(second.attemptId))
            .pipe(Effect.forkChild);
          yield* Deferred.await(signalsOf(second.attemptId).working);

          const before = probes();
          yield* TestClock.adjust("1 minute");
          assert.strictEqual(probes(), before + 1, "one probe for both Attempts");
          for (const attemptId of attempts)
            assert.lengthOf(noticesOf(attemptId), 0, "nothing while the Worker answers");

          machine.state.stalled = true;
          yield* TestClock.adjust("1 minute");
          yield* TestClock.adjust("45 seconds");
          assert.strictEqual(probes(), before + 2);
          for (const attemptId of attempts) {
            const notices = noticesOf(attemptId);
            assert.lengthOf(notices, 1, `${attemptId} is told the Worker stopped answering`);
            assert.strictEqual(notices[0]?._tag, "WorkerUnresponsive");
          }

          machine.state.stalled = false;
          yield* TestClock.adjust("1 minute");
          for (const attemptId of attempts)
            assert.strictEqual(noticesOf(attemptId)[1]?._tag, "WorkerResponsive");

          yield* Deferred.succeed(signalsOf(request.attemptId).done, undefined);
          yield* Fiber.join(first);
          const afterFirst = probes();
          yield* TestClock.adjust("1 minute");
          assert.strictEqual(probes(), afterFirst + 1, "the watch goes on for the other Attempt");

          yield* Deferred.succeed(signalsOf(second.attemptId).done, undefined);
          yield* Fiber.join(other);
          const afterBoth = probes();
          yield* TestClock.adjust("10 minutes");
          assert.strictEqual(probes(), afterBoth, "probing ends with the last Attempt");
        }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, parent)));
      });
    },
  );

  it.effect(
    "tells an Attempt that joins while the Worker is silent as it joins, and that the Worker answers again only after that",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const logs = capturedLogs();
      const second = requestFor(2);
      const third = requestFor(3);
      const attempts = [request.attemptId, second.attemptId, third.attemptId];
      const tags = (notices: ReadonlyArray<AttemptChannel.OutboundPayload>) =>
        notices.map(({ _tag }) => _tag);
      return Effect.gen(function* () {
        const { parent, signalsOf, sinkFor, noticesOf } = yield* workingAttempts(attempts);
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const launch = (checkout: CheckoutRequest) =>
            Effect.gen(function* () {
              machine.state.stalled = false;
              const fiber = yield* (yield* executor.prepare(checkout))
                .launch(sinkFor(checkout.attemptId))
                .pipe(Effect.forkChild);
              yield* Deferred.await(signalsOf(checkout.attemptId).working);
              return fiber;
            });
          const silentProbe = Effect.gen(function* () {
            machine.state.stalled = true;
            yield* TestClock.adjust("1 minute");
            yield* TestClock.adjust("45 seconds");
          });

          const first = yield* launch(request);
          const launchedAt = DateTime.formatIso(yield* DateTime.now);
          yield* silentProbe;
          assert.deepStrictEqual(tags(noticesOf(request.attemptId)), ["WorkerUnresponsive"]);

          const late = yield* launch(second);
          const [told] = noticesOf(second.attemptId);
          assert(told?._tag === "WorkerUnresponsive", "joining a silent watch tells the Attempt");
          assert.strictEqual(DateTime.formatIso(told.lastAnsweredAt), launchedAt);
          assert.strictEqual(told.reason, "No answer within 45 seconds");
          assert.lengthOf(noticesOf(request.attemptId), 1, "the first Attempt is not told twice");
          yield* silentProbe;
          for (const attemptId of [request.attemptId, second.attemptId])
            assert.deepStrictEqual(
              tags(noticesOf(attemptId)),
              ["WorkerUnresponsive"],
              "a probe that still gets no answer tells nobody twice",
            );

          machine.state.stalled = false;
          yield* TestClock.adjust("1 minute");
          for (const attemptId of [request.attemptId, second.attemptId])
            assert.deepStrictEqual(tags(noticesOf(attemptId)), [
              "WorkerUnresponsive",
              "WorkerResponsive",
            ]);

          yield* silentProbe;
          const latest = yield* launch(third);
          assert.deepStrictEqual(tags(noticesOf(third.attemptId)), ["WorkerUnresponsive"]);
          yield* TestClock.adjust("1 minute");
          assert.deepStrictEqual(tags(noticesOf(third.attemptId)), [
            "WorkerUnresponsive",
            "WorkerResponsive",
          ]);
          for (const attemptId of [request.attemptId, second.attemptId])
            assert.deepStrictEqual(tags(noticesOf(attemptId)), [
              "WorkerUnresponsive",
              "WorkerResponsive",
              "WorkerUnresponsive",
              "WorkerResponsive",
            ]);

          for (const attemptId of attempts)
            yield* Deferred.succeed(signalsOf(attemptId).done, undefined);
          for (const fiber of [first, late, latest]) yield* Fiber.join(fiber);
        }).pipe(
          // Prevents a failed assertion from leaving cleanup waiting on a stalled machine.
          Effect.ensuring(Effect.sync(() => (machine.state.stalled = false))),
          Effect.scoped,
          Effect.provide(runtime(machine, credentials, parent)),
        );

        const joins = logs.lines.filter((line) =>
          line.includes("liveness watch while the Worker does not answer"),
        );
        assert.lengthOf(joins, 2);
        assert.include(joins[0], second.attemptId);
        assert.include(joins[1], third.attemptId);
      }).pipe(Effect.provide(logs.layer));
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
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      for (const { line } of machine.state.calls)
        for (const mutating of ["mkdir", "rm", "mv", "clone", "find", "read -r token"])
          assert.notInclude(line, mutating, `preflight ran ${mutating}`);

      machine.state.rootWritable = false;
      const unwritable = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
      assert(unwritable._tag === "WorkerCapabilityError");
      assert.strictEqual(unwritable.capability, "machine");
      assert.include(
        unwritable.message,
        'The root /srv/usine of SSH worker "eu-one" isn\'t a writable directory',
      );

      machine.state.reachable = false;
      const unreachable = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
      assert(unreachable._tag === "WorkerCapabilityError");
      assert.strictEqual(
        unreachable.message,
        `Can't connect to SSH worker "eu-one" at ${DESTINATION}`,
      );

      const unknown = yield* executor.preflight(WorkerName.make("eu-two"), [], 1).pipe(Effect.flip);
      assert(unknown._tag === "WorkerCapabilityError");
      assert.strictEqual(unknown.capability, "machine");
      assert.strictEqual(credentials.minted.length, 0);
    }).pipe(Effect.provide(runtime(machine, credentials)));
  });

  it.effect(
    "preflight warns below 3 GiB and refuses below 1.5 GiB per concurrent Attempt, or concurrency without swap",
    () => {
      const machine = fakeMachine();
      const credentials = mintingProvider();
      const logs = capturedLogs();
      const warnings = () =>
        logs.lines.filter((line) => line.includes("Worker memory is below 3.0 GiB"));
      return Effect.gen(function* () {
        const executor = yield* Executor;
        machine.state.memoryGib = 6;
        machine.state.swapGib = 2;

        yield* executor.preflight(WORKER, [], 2);
        assert.lengthOf(warnings(), 0, "3 GiB per Attempt is enough");

        yield* executor.preflight(WORKER, [], 4);
        assert.lengthOf(warnings(), 1, "1.5 GiB per Attempt starts with a warning");
        assert.include(warnings().join("\n"), '"suggestedMaxConcurrentAttempts":2');

        const short = yield* executor.preflight(WORKER, [], 5).pipe(Effect.flip);
        assert(short._tag === "WorkerCapabilityError");
        assert.strictEqual(short.capability, "memory");
        assert.include(
          short.message,
          "6.0 GiB of memory, which is 1.2 GiB per attempt with max_concurrent_attempts set to 5",
        );
        assert.include(short.message, "Set max_concurrent_attempts to 4 or less");

        machine.state.swapGib = 0;
        yield* executor.preflight(WORKER, [], 1);
        const withoutSwap = yield* executor.preflight(WORKER, [], 2).pipe(Effect.flip);
        assert(withoutSwap._tag === "WorkerCapabilityError");
        assert.strictEqual(withoutSwap.capability, "memory");
        assert.include(withoutSwap.message, "has no swap, and max_concurrent_attempts is 2");
        const shortWithoutSwap = yield* executor.preflight(WORKER, [], 5).pipe(Effect.flip);
        assert.include(shortWithoutSwap.message, "Set max_concurrent_attempts to 1 or less");
      }).pipe(Effect.provide(runtime(machine, credentials)), Effect.provide(logs.layer));
    },
  );
});
