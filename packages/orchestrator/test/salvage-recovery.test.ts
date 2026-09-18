import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { Event, EventId, DedupKey } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { TranscriptAllQuery } from "@usine/engine/transcript";
import { RunEngine, Submission } from "@usine/engine/engine";
import { CredentialProvider, WorkerCredential } from "@usine/executor";
import { DateTime, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { layer as localLayer } from "../src/local.ts";

const agent = new Agent({
  name: AgentName.make("developer"),
  persona: AgentPersona.make("Work"),
  brain: new BrainSpec({
    harness: "claude",
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
});
const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [{ name: "acme/demo" }],
  workers: [{ name: "local", kind: "local", max_concurrent_attempts: 1 }],
});
const credentials = Layer.succeed(CredentialProvider)({
  issue: () =>
    Effect.succeed(
      new WorkerCredential({
        value: Redacted.make("test-token"),
        expiresAt: DateTime.makeUnsafe(Date.now() + 3_600_000),
      }),
    ),
});

it.live(
  "restart publishes retained work and records it before releasing the checkout",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-reconcile-" });
      const git = (args: ReadonlyArray<string>) =>
        spawner.string(ChildProcess.make("git", args)).pipe(Effect.map((s) => s.trim()));
      const seed = `${root}/seed`;
      const remote = `${root}/remote.git`;
      yield* git(["init", "--bare", remote]);
      yield* git(["init", "-b", "main", seed]);
      yield* git([
        "-C",
        seed,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      ]);
      yield* git(["-C", seed, "push", remote, "main"]);
      const hook = `${remote}/hooks/pre-receive`;
      yield* fs.writeFileString(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const runtime = () =>
        localLayer(InstanceDirectory.make(root), config, [], {
          repositoryUrl: () => remote,
          runHost: {
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../../run-host/dist/bin.js", import.meta.url)),
              "--stub-delay-ms",
              "60000",
            ],
          },
          interruptGrace: "100 millis",
        }).pipe(Layer.provide(credentials));
      const saved = yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(
          new Submission({
            loop: LoopName.make("recover"),
            itemKey: ItemKey.make("acme/demo#1"),
            step: StepName.make("work"),
            event: new Event({
              id: EventId.make("recover"),
              dedupKey: DedupKey.make("recover"),
              payload: {},
              receivedAt: DateTime.makeUnsafe(Date.now()),
            }),
            approval: "none",
            cycleLimit: Option.none(),
            repository: RepositoryName.make("acme/demo"),
            revision: RepositoryRevision.make("main"),
            task: AttemptTask.make("Work"),
            agent,
            parentModel: Option.none(),
          }),
        );
        assert(accepted._tag === "Claimed");
        let snapshot = yield* engine.inspect(accepted.runId);
        while (snapshot.attempts.length === 0) {
          yield* Effect.sleep("10 millis");
          snapshot = yield* engine.inspect(accepted.runId);
        }
        const attempt = snapshot.attempts[0];
        assert(attempt !== undefined);
        const worktree = `${root}/.usine/workers/local/attempts/${attempt.id.replaceAll("/", "_")}`;
        while (
          !(yield* engine.transcript(new TranscriptAllQuery({ attemptId: attempt.id }))).some(
            ({ envelope }) => envelope.payload._tag === "Started",
          )
        )
          yield* Effect.sleep("10 millis");
        yield* fs.writeFileString(`${worktree}/progress.txt`, "recover this work\n");
        yield* engine.cancel(accepted.runId);
        do {
          yield* Effect.sleep("10 millis");
          snapshot = yield* engine.inspect(accepted.runId);
        } while (Option.isNone(snapshot.attempts[0]?.salvage ?? Option.none()));
        const salvage = snapshot.attempts[0]?.salvage;
        assert(
          salvage !== undefined && Option.isSome(salvage) && salvage.value._tag === "Retained",
        );
        assert(yield* fs.exists(worktree));
        return { runId: accepted.runId, worktree };
      }).pipe(Effect.provide(runtime()));
      // A second startup during the outage must also retain the only copy.
      yield* Effect.void.pipe(Effect.provide(runtime()));
      assert(yield* fs.exists(saved.worktree));
      yield* fs.remove(hook);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const snapshot = yield* engine.inspect(saved.runId);
        const salvage = snapshot.attempts[0]?.salvage;
        assert(salvage !== undefined && Option.isSome(salvage) && salvage.value._tag === "Pushed");
        assert.strictEqual(
          yield* git(["--git-dir", remote, "show", `${salvage.value.commit}:progress.txt`]),
          "recover this work",
        );
        assert(!(yield* fs.exists(saved.worktree)));
      }).pipe(Effect.provide(runtime()));
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);
