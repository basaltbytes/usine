import { RemoteShell, type SshCommand } from "@usine/agents/child-host";
import { type SandboxName, sandboxName, SandboxOwner } from "@usine/cloudflare";
import type { AttemptId } from "@usine/core/attempt";
import type { CloudflareLlmProvider, WorkerName } from "@usine/core/worker";
import { Array as Arr, Context, Effect, Equal, Option, Redacted, Schema, Semaphore } from "effect";
import { HttpClient } from "effect/http";
import { type ExecutorOperation, ExecutorOperationError } from "../executor.ts";
import { type SandboxClient, sandboxClientFor } from "./client.ts";
import type { CloudflareExecutorOptions, CloudflareWorkerAddress } from "./model.ts";
import { SHELL_ENVIRONMENT } from "./shell/environment.ts";

/** Registers worker addresses after their credentials resolve. Running attempts keep their existing client. */
export class CloudflareWorkers extends Context.Service<
  CloudflareWorkers,
  {
    readonly addWorker: (address: CloudflareWorkerAddress) => Effect.Effect<void>;
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
    // Startup recovery can defer reattachment before this executor sees the attempt.
    const firstConnections = new Map<WorkerName, CloudflareWorker>();
    const sandboxes = new Map<SandboxName, CloudflareWorker>();
    const http = yield* HttpClient.HttpClient;
    const exclusive = yield* Semaphore.make(1);
    const addWorker = Effect.fn("CloudflareExecutor.addWorker")(function* (
      address: CloudflareWorkerAddress,
    ) {
      yield* Effect.annotateCurrentSpan({ worker: address.name });
      if (Equal.equals(workers.get(address.name)?.address, address)) {
        yield* Effect.logDebug("Cloudflare worker is already registered", { worker: address.name });
        return;
      }
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
      workers.set(address.name, worker);
      if (!firstConnections.has(address.name)) firstConnections.set(address.name, worker);
      yield* Effect.logInfo("Cloudflare worker client registered", { worker: address.name });
    }, exclusive.withPermit);
    if (new Set(options.workers.map(({ name }) => name)).size !== options.workers.length) {
      return yield* Effect.die(
        new Error("CloudflareExecutorOptions.workers contains duplicate names"),
      );
    }
    yield* Effect.forEach(options.workers, addWorker, { discard: true });

    const workerFor = (operation: ExecutorOperation, name: WorkerName) =>
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

    const retainedWorkerFor = Effect.fn("CloudflareExecutor.retainedWorkerFor")(function* (
      operation: ExecutorOperation,
      name: WorkerName,
      attemptId: AttemptId,
    ) {
      yield* Effect.annotateCurrentSpan({ worker: name, attemptId });
      const current = yield* workerFor(operation, name);
      const worker =
        sandboxes.get(sandboxName(current.owner, attemptId)) ??
        firstConnections.get(name) ??
        current;
      yield* Effect.logDebug("Resolved the retained sandbox connection", {
        worker: name,
        attemptId,
        currentConnection: worker === current,
      });
      return worker;
    });

    return {
      workerFor,
      retainedWorkerFor,
      retain: (name: SandboxName, worker: CloudflareWorker) =>
        Effect.sync(() => {
          sandboxes.set(name, worker);
        }),
      forget: (name: SandboxName) =>
        Effect.sync(() => {
          sandboxes.delete(name);
        }),
      membership: CloudflareWorkers.of({ addWorker }),
    };
  });
