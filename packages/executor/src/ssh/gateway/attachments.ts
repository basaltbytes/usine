import type { AttemptId } from "@usine/core/attempt";
import type { LoopPermissions } from "@usine/core/loop";
import type { RepositoryName } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import { AttachRequest, type AttachmentId, InstallationCredential } from "@usine/gateway/admin";
import { Cache, DateTime, Effect, Option, Redacted, Ref, Semaphore } from "effect";
import {
  CredentialProvider,
  CredentialUnavailableError,
  type ExecutorError,
  type ExecutorOperation,
  type WorkerCredential,
} from "../../executor.ts";
import { type RemoteCommands, sendingShell } from "../../remote/commands.ts";
import type { RemoteAccess } from "../../remote/machine.ts";
import { renewableCredential } from "../../renewable-credential.ts";
import type { MachineGateway, SshMachine } from "../model.ts";
import { gatewayEnvironment, ghGatewayConfig } from "./environment.ts";

/**
 * Writes gh's configuration for the Gateway into the directory `$1`: `$2`
 * becomes `config.yml` and `$3` becomes `hosts.yml`. Each file is written
 * under a name of its own and renamed, so concurrent Attempts never read a
 * partial file.
 */
const WRITE_GH_CONFIG_SCRIPT = String.raw`
set -e
mkdir -p "$1"
printf '%s' "$2" > "$1/config.yml.$$"
printf '%s' "$3" > "$1/hosts.yml.$$"
mv "$1/config.yml.$$" "$1/config.yml"
mv "$1/hosts.yml.$$" "$1/hosts.yml"
`.trim();

/** How often a live Attempt stores its attachment again, which bounds the outage a Gateway restart causes. */
const RESTORE_INTERVAL = "2 minutes";

/** An Attempt's attachment, and the token it carries now. */
interface CurrentAttachment {
  readonly id: AttachmentId;
  readonly credential: WorkerCredential;
}

/** Where a Worker behind a Gateway keeps gh's configuration; it contains no token. */
const ghConfigDirectory = (machine: SshMachine): string => `${machine.workerDirectory}/gh`;

/**
 * Gives each Attempt on a Worker behind a Gateway access to its repository
 * without a token on the machine (ADR 0027): the orchestrator mints the
 * single-repository token, attaches it to the Gateway for the Worker and the
 * repository, renews the same attachment before the token expires, stores
 * it again every two minutes in case the Gateway restarted, and detaches it
 * when the Attempt's scope closes. The Attempt's children
 * present the caller token the Gateway answered with, which reaches the
 * machine through the SSH connection only. The first use of each Worker in
 * this process detaches whatever attachments an earlier process left for it:
 * no Attempt can still use one, because a reattached Attempt attaches again.
 */
export const gatewayAttachmentsFor = Effect.fn("SshExecutor.gatewayAttachmentsFor")(function* (
  commands: RemoteCommands,
  machineFor: (worker: WorkerName) => Effect.Effect<SshMachine, ExecutorError>,
) {
  const provider = yield* CredentialProvider;

  const detachLeftovers = Effect.fn("SshExecutor.detachLeftoverAttachments")(function* (
    worker: WorkerName,
  ) {
    const machine = yield* machineFor(worker);
    yield* Effect.annotateCurrentSpan({ worker });
    if (Option.isNone(machine.gateway))
      return yield* Effect.logDebug("The Worker has no Gateway to detach leftovers from", {
        worker,
      });
    const { admin, settings } = machine.gateway.value;
    yield* Effect.annotateCurrentSpan({ domain: settings.domain });
    const { attachments } = yield* admin.list;
    const leftovers = attachments.filter((attachment) => attachment.worker === worker);
    if (leftovers.length === 0)
      return yield* Effect.logDebug("No earlier process left a Gateway attachment for the Worker", {
        worker,
        domain: settings.domain,
      });
    // Each leftover is detached on its own, so one refusal leaves the others detached.
    yield* Effect.forEach(
      leftovers,
      ({ id, repository }) =>
        admin.detach(id).pipe(
          Effect.tap(({ detached }) =>
            Effect.logInfo("Detached a Gateway attachment an earlier process left", {
              worker,
              repository,
              attachment: id,
              detached,
            }),
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              "Could not detach a Gateway attachment an earlier process left; it expires with its token",
              { worker, repository, attachment: id, message: error.message },
            ),
          ),
          Effect.ignore,
        ),
      { discard: true },
    );
  });
  // A failed listing is logged and remembered: the attachments it leaves
  // expire with their tokens within the hour.
  const reclaimed = yield* Cache.make({
    capacity: Number.POSITIVE_INFINITY,
    lookup: (worker: WorkerName) =>
      detachLeftovers(worker).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not list the Gateway attachments an earlier process left; they expire with their tokens",
            { worker, message: error.message },
          ),
        ),
        Effect.ignore,
      ),
  });
  const reclaim = (worker: WorkerName) => Cache.get(reclaimed, worker);

  const acquire = Effect.fn("SshExecutor.attachToGateway")(function* (
    attemptId: AttemptId,
    worker: WorkerName,
    repository: RepositoryName,
    permissions: LoopPermissions,
    machine: SshMachine,
    gateway: MachineGateway,
    operation: ExecutorOperation,
  ) {
    const { admin, settings } = gateway;
    const fields = { attemptId, worker, repository, permissions, domain: settings.domain };
    yield* Effect.annotateCurrentSpan(fields);
    const config = ghGatewayConfig(settings.domain);
    yield* commands.run(operation, machine.shell, "sh", [
      "-c",
      WRITE_GH_CONFIG_SCRIPT,
      "sh",
      ghConfigDirectory(machine),
      config["config.yml"],
      config["hosts.yml"],
    ]);

    const attached = yield* Ref.make(Option.none<CurrentAttachment>());
    // Publishing and re-storing take turns, so the Gateway never ends up with an older token.
    const turn = yield* Semaphore.make(1);
    yield* Effect.addFinalizer(() =>
      Ref.get(attached).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.logDebug("The Attempt has no Gateway attachment to detach", fields),
            onSome: ({ id }) =>
              admin.detach(id).pipe(
                Effect.tap(({ detached }) =>
                  Effect.logInfo("Detached the Attempt's token from the Gateway", {
                    ...fields,
                    attachment: id,
                    detached,
                  }),
                ),
                Effect.tapError((error) =>
                  Effect.logWarning(
                    "Could not detach the Attempt's token from the Gateway; the attachment expires with the token",
                    { ...fields, attachment: id, message: error.message },
                  ),
                ),
                Effect.ignore,
              ),
          }),
        ),
      ),
    );

    const requestFor = (credential: WorkerCredential) =>
      new AttachRequest({
        worker,
        repository,
        credential: new InstallationCredential({ token: credential.value }),
        expiresAt: credential.expiresAt,
      });

    const publish = Effect.fn("SshExecutor.publishAttachment")(
      function* (credential: WorkerCredential) {
        yield* Effect.annotateCurrentSpan(fields);
        const current = yield* Ref.get(attached);
        const answer = yield* Option.match(current, {
          onNone: () => admin.attach(requestFor(credential)),
          onSome: ({ id }) => admin.renew(id, requestFor(credential)),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CredentialUnavailableError({ repository, message: cause.message, cause }),
          ),
        );
        yield* Ref.set(attached, Option.some({ id: answer.attachment.id, credential }));
        yield* Effect.annotateCurrentSpan({ attachment: answer.attachment.id });
        yield* Effect.logInfo(
          Option.isNone(current)
            ? "Attached the Attempt's token to the Gateway"
            : "Renewed the Attempt's attachment on the Gateway",
          {
            ...fields,
            attachment: answer.attachment.id,
            expiresAt: DateTime.formatIso(answer.attachment.expiresAt),
          },
        );
        return answer.callerToken;
      },
      // Scope closure waits for an attach in flight, so the detach that
      // follows it knows the attachment's id.
      turn.withPermits(1),
      Effect.uninterruptible,
    );

    // The Gateway keeps attachments in memory: after it restarts, this puts
    // the Attempt's attachment back under the same id with the current token.
    const restore = Effect.fn("SshExecutor.restoreAttachment")(
      function* () {
        yield* Effect.annotateCurrentSpan(fields);
        const current = yield* Ref.get(attached);
        if (Option.isNone(current)) return;
        const { id, credential } = current.value;
        yield* Effect.annotateCurrentSpan({ attachment: id });
        yield* admin.renew(id, requestFor(credential));
        yield* Effect.logDebug("Confirmed the Attempt's attachment on the Gateway", {
          ...fields,
          attachment: id,
        });
      },
      turn.withPermits(1),
      Effect.uninterruptible,
    );

    const credential = yield* renewableCredential(
      provider.issue,
      repository,
      attemptId,
      permissions,
      publish,
    );
    const callerToken = credential.published;
    // Forked after renewal, so scope closure stops it before the token is
    // wiped and before the detach.
    yield* Effect.forever(
      Effect.sleep(RESTORE_INTERVAL).pipe(
        Effect.andThen(restore()),
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not confirm the Attempt's attachment on the Gateway; will retry",
            {
              ...fields,
              message: error.message,
            },
          ),
        ),
        Effect.ignore,
      ),
    ).pipe(Effect.forkScoped);
    const { exported, sent } = gatewayEnvironment({
      domain: settings.domain,
      llmProviders: settings.llmProviders,
      ghConfigDirectory: ghConfigDirectory(machine),
      callerToken,
    });
    return {
      shell: sendingShell(machine.shell, sent),
      environment: exported,
      gitEnvironment: exported,
      refresh: credential.refresh(),
      scrub: (text) => credential.scrub(text).replaceAll(Redacted.value(callerToken), "[REDACTED]"),
    } satisfies RemoteAccess;
  });

  return { acquire, reclaim };
});
