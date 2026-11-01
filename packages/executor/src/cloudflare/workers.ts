import type { AttemptId } from "@usine/core/attempt";
import { attemptConnectionsFor } from "../attempt-connections.ts";
import { RemoteShell, type SshCommand } from "@usine/agents/child-host";
import { type SandboxName, SandboxOwner } from "@usine/cloudflare";
import type { CloudflareLlmProvider, WorkerName } from "@usine/core/worker";
import { Array as Arr, Context, Effect, Equal, Option, Redacted, Schema, Semaphore } from "effect";
import { HttpClient } from "effect/http";
import { type ExecutorOperation, ExecutorOperationError } from "../executor.ts";
import { type SandboxClient, sandboxClientFor } from "./client.ts";
import type { CloudflareExecutorOptions, CloudflareWorkerAddress } from "./model.ts";
import { SHELL_ENVIRONMENT } from "./shell/environment.ts";

/** Registers worker addresses after their credentials resolve. Running attempts keep their client. */
export class CloudflareWorkers extends Context.Service<
  CloudflareWorkers,
  {
    readonly addWorker: (address: CloudflareWorkerAddress) => Effect.Effect<void>;
    /**
     * Unregisters `worker` for new work. Retained attempts keep their connection.
     */
    readonly removeWorker: (worker: WorkerName) => Effect.Effect<void>;
  }
>()("@usine/executor/CloudflareWorkers") {}

export interface CloudflareWorker {
  readonly address: CloudflareWorkerAddress;
  /** This instance's owner of the Worker's sandboxes. */
  readonly owner: SandboxOwner;
  readonly client: SandboxClient;
  readonly providers: ReadonlyArray<CloudflareLlmProvider>;
  /** Returns the shell that runs commands in the sandbox `name`, through the sandbox shell. */
  readonly shellFor: (name: SandboxName) => RemoteShell;
}

export const cloudflareWorkersFor = (options: CloudflareExecutorOptions, shell: SshCommand) =>
  Effect.gen(function* () {
    const workers = new Map<WorkerName, CloudflareWorker>();
    const connections = new Map<CloudflareWorkerAddress, CloudflareWorker>();
    const attempts = yield* attemptConnectionsFor(options.attemptConnections);
    const http = yield* HttpClient.HttpClient;
    const exclusive = yield* Semaphore.make(1);
    const connectionFor = Effect.fn("CloudflareExecutor.connectionFor")(function* (
      address: CloudflareWorkerAddress,
    ) {
      yield* Effect.annotateCurrentSpan({ worker: address.name });
      const existing = [...connections.values()].find((worker) =>
        Equal.equals(worker.address, address),
      );
      if (existing !== undefined) return existing;
      const owner = yield* Option.match(
        Schema.decodeUnknownOption(SandboxOwner)(`${options.instance}.${address.name}`),
        {
          onNone: () =>
            Effect.die(
              new Error(
                `CloudflareExecutorOptions.instance "${options.instance}" isn't in kebab case`,
              ),
            ),
          onSome: Effect.succeed,
        },
      );
      const client = yield* sandboxClientFor(address, owner).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const sshEnvironment = {
        ...Object.fromEntries(
          ["HOME", "PATH", "TMPDIR"].flatMap((name) =>
            Option.toArray(
              Option.map(Option.fromNullishOr(process.env[name]), (value) => [name, value]),
            ),
          ),
        ),
        [SHELL_ENVIRONMENT.workerUrl]: address.workerUrl.origin,
        [SHELL_ENVIRONMENT.accessClientId]: Redacted.value(address.accessClientId),
        [SHELL_ENVIRONMENT.accessClientSecret]: Redacted.value(address.accessClientSecret),
      };
      const worker: CloudflareWorker = {
        address,
        owner,
        client,
        providers: Arr.dedupe(address.providers.map(({ provider }) => provider)),
        shellFor: (name) => new RemoteShell({ ssh: shell, sshEnvironment, destination: name }),
      };
      connections.set(address, worker);
      yield* Effect.logInfo("Cloudflare worker added to the executor", { worker: address.name });
      return worker;
    }, exclusive.withPermit);
    const addWorker = Effect.fn("CloudflareExecutor.addWorker")(function* (
      address: CloudflareWorkerAddress,
    ) {
      const worker = yield* connectionFor(address);
      workers.set(address.name, worker);
    });
    const removeWorker = Effect.fn("CloudflareExecutor.removeWorker")(function* (
      worker: WorkerName,
    ) {
      yield* Effect.annotateCurrentSpan({ worker });
      if (!workers.delete(worker)) {
        yield* Effect.logDebug("Cloudflare worker isn't registered; nothing to remove", { worker });
        return;
      }
      yield* Effect.logInfo("Cloudflare worker removed from the executor", { worker });
    }, exclusive.withPermit);
    if (new Set(options.workers.map(({ name }) => name)).size !== options.workers.length) {
      return yield* Effect.die(
        new Error("CloudflareExecutorOptions.workers contains duplicate names"),
      );
    }
    yield* Effect.forEach(options.workers, addWorker, { discard: true });

    const workerFor = (
      operation: ExecutorOperation,
      name: WorkerName,
    ): Effect.Effect<CloudflareWorker, ExecutorOperationError> =>
      Option.match(Option.fromNullishOr(workers.get(name)), {
        onNone: () =>
          Effect.fail(
            new ExecutorOperationError({
              operation,
              message: `No cloudflare worker named "${name}" is configured`,
              cause: new Error(name),
            }),
          ),
        onSome: Effect.succeed,
      });

    const attemptWorkerFor = (
      operation: ExecutorOperation,
      worker: WorkerName,
      attemptId: AttemptId,
    ) =>
      attempts
        .resolve(
          worker,
          attemptId,
          workerFor(operation, worker).pipe(Effect.map(({ address }) => address)),
        )
        .pipe(Effect.flatMap(connectionFor));
    return {
      workerFor,
      attemptWorkerFor,
      membership: CloudflareWorkers.of({ addWorker, removeWorker }),
    };
  });
