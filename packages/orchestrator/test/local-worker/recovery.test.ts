import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { SalvageRef } from "@usine/core/attempt/salvage";
import { InstanceDirectory } from "@usine/core/instance";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Effect, FileSystem, Layer, Result } from "effect";
import { CredentialProvider, Executor } from "@usine/executor";
import { layer } from "@usine/executor/local";

const attempt = (worker: string, number: number) => ({
  attemptId: AttemptId.make(`closed/run/${number}`),
  worker: WorkerName.make(worker),
  repository: RepositoryName.make("acme/demo"),
  ref: SalvageRef.make(`usine/salvage/closed/${number}`),
  succeeded: number % 2 === 0,
});

const credentials = Layer.succeed(CredentialProvider)({
  issue: () => Effect.die("Absent checkouts must not acquire credentials"),
});

const executorLayer = (root: string, fileSystem: FileSystem.FileSystem) =>
  layer({
    instanceDirectory: InstanceDirectory.make(root),
    runHost: { command: "unused", args: [] },
  }).pipe(
    Layer.provide(credentials),
    Layer.provide(Layer.succeed(FileSystem.FileSystem)(fileSystem)),
  );

describe("local checkout reconciliation", () => {
  it.live("lists a Worker's attempts once without probing its historical checkouts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-history-" });
      const attempts = `${root}/.usine/workers/local/attempts`;
      yield* fs.makeDirectory(attempts, { recursive: true });
      // Unknown crash leftovers must remain available for durable recovery.
      yield* fs.makeDirectory(`${attempts}/unknown`);
      const reads: string[] = [];
      const probes: string[] = [];
      const observed = FileSystem.FileSystem.of({
        ...fs,
        readDirectory: (path) =>
          Effect.suspend(() => {
            reads.push(path);
            return fs.readDirectory(path);
          }),
        exists: (path) =>
          Effect.suspend(() => {
            probes.push(path);
            return fs.exists(path);
          }),
      });
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        yield* Effect.forEach(
          Array.from({ length: 1000 }, (_, index) => index),
          (index) =>
            executor.recover(attempt("local", index), () => Effect.die("Unexpected salvage")),
          { concurrency: 8, discard: true },
        );
      }).pipe(Effect.provide(executorLayer(root, observed)));
      assert.strictEqual(reads.filter((path) => path === attempts).length, 1);
      assert.strictEqual(probes.filter((path) => path.startsWith(`${attempts}/`)).length, 0);
      assert(yield* fs.exists(`${attempts}/unknown`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("remembers a failed listing, isolates Workers, and lists again after restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-list-failure-" });
      const worker = `${root}/.usine/workers/broken`;
      const attempts = `${worker}/attempts`;
      yield* fs.makeDirectory(worker, { recursive: true });
      yield* fs.writeFileString(attempts, "not a directory");
      let reads = 0;
      const observed = FileSystem.FileSystem.of({
        ...fs,
        readDirectory: (path) =>
          Effect.suspend(() => {
            if (path === attempts) reads += 1;
            return fs.readDirectory(path);
          }),
      });
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        const first = yield* Effect.result(
          executor.recover(attempt("broken", 1), () => Effect.void),
        );
        assert(Result.isFailure(first));
        assert.strictEqual(first.failure._tag, "ExecutorOperationError");
        yield* fs.remove(attempts);
        yield* fs.makeDirectory(attempts);
        const second = yield* Effect.result(
          executor.recover(attempt("broken", 2), () => Effect.void),
        );
        assert(Result.isFailure(second));
        yield* executor.recover(attempt("healthy", 3), () => Effect.void);
        assert.strictEqual(reads, 1);
      }).pipe(Effect.provide(executorLayer(root, observed)));
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.recover(attempt("broken", 1), () => Effect.void);
      }).pipe(Effect.provide(executorLayer(root, observed)));
      assert.strictEqual(reads, 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
