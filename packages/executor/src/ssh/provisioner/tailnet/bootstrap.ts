import { Harnesses } from "@usine/agents/harness/node";
import { Effect, Option } from "effect";
import { HttpClient } from "effect/http";
import { WorkerCapabilityError } from "../../../executor.ts";
import type { RemoteCommands } from "../../../remote/commands.ts";
import { provisionerTailnetOf, type SshMachine, type SshWorkerAddress } from "../../model.ts";
import { configureTailnetGateway } from "../../gateway/tailnet.ts";
import { tailscaleClientFor } from "./client.ts";

/** Configures provisioned machines before checkout and removes their ephemeral nodes at cleanup. */
export const provisionerTailnetsFor = Effect.fn("SshExecutor.provisionerTailnetsFor")(function* (
  commands: RemoteCommands,
) {
  const { catalog } = yield* Harnesses;
  const http = yield* HttpClient.HttpClient;
  const clientFor = (address: SshWorkerAddress) =>
    Effect.transposeOption(
      Option.map(provisionerTailnetOf(address), (settings) =>
        tailscaleClientFor(address.name, settings).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      ),
    );
  const verify = Effect.fn("SshExecutor.verifyProvisionerTailnet")(function* (
    address: SshWorkerAddress,
  ) {
    yield* Effect.annotateCurrentSpan({ worker: address.name });
    const client = yield* clientFor(address);
    if (Option.isNone(client) || Option.isNone(address.gateway)) return;
    yield* client.value.withKey(() => Effect.void);
    yield* client.value.verifyGateway(address.gateway.value.domain);
  });
  const leave = Effect.fn("SshExecutor.leaveProvisionerTailnet")(function* (machine: SshMachine) {
    if (Option.isNone(provisionerTailnetOf(machine.address))) return;
    const worker = machine.address.name;
    yield* Effect.annotateCurrentSpan({ worker, host: machine.shell.destination });
    yield* commands.run("cleanup", machine.shell, "sudo", ["tailscale", "logout"]).pipe(
      Effect.timeout("15 seconds"),
      Effect.tap(() => Effect.logInfo("Removed the machine's ephemeral tailnet node", { worker })),
      Effect.tapError(() =>
        Effect.logWarning(
          "Could not log the machine out of Tailscale; its ephemeral node expires after machine deletion",
          { worker },
        ),
      ),
      Effect.ignore,
    );
  });
  const join = Effect.fn("SshExecutor.joinProvisionerTailnet")(function* (machine: SshMachine) {
    const settings = provisionerTailnetOf(machine.address);
    if (Option.isNone(settings) || Option.isNone(machine.gateway)) return;
    const worker = machine.address.name;
    const domain = machine.gateway.value.settings.domain;
    yield* Effect.annotateCurrentSpan({ worker, host: machine.shell.destination });
    const client = yield* tailscaleClientFor(worker, settings.value).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    yield* Effect.gen(function* () {
      yield* commands.run("prepare", machine.shell, "sudo", ["systemctl", "start", "tailscaled"]);
      yield* client.withKey((key) =>
        commands.runWithInput(
          "prepare",
          machine.shell,
          "sudo",
          [
            "tailscale",
            "up",
            "--auth-key=file:/dev/stdin",
            "--accept-dns=false",
            "--accept-routes=false",
            "--advertise-tags=tag:usine-attempt",
            "--timeout=60s",
          ],
          key,
        ),
      );
      yield* configureTailnetGateway(catalog, commands, "prepare", machine, settings.value, domain);
      const response = yield* commands.run("prepare", machine.shell, "curl", [
        "--silent",
        "--show-error",
        "--noproxy",
        "*",
        "--max-time",
        "15",
        "-o",
        "/dev/null",
        "-D",
        "-",
        `http://git.${domain}/`,
      ]);
      if (!/^x-usine-gateway-refusal:\s*missing-caller-token\s*$/imu.test(response))
        return yield* WorkerCapabilityError.make({
          worker,
          capability: "gateway",
          message: `Provisioned worker "${worker}" cannot reach the gateway over the tailnet`,
          cause: new Error("missing gateway response"),
        });
      yield* Effect.logInfo("Joined the machine to the tailnet and configured gateway access", {
        worker,
        address: settings.value.gatewayAddress,
      });
    }).pipe(
      Effect.catchTag("ExecutorOperationError", () =>
        Effect.fail(
          WorkerCapabilityError.make({
            worker,
            capability: "gateway",
            message: `Provisioned worker "${worker}" could not join the tailnet or configure the gateway. Check the snapshot's Tailscale service and tailnet policy.`,
            cause: new Error("tailnet bootstrap failed"),
          }),
        ),
      ),
    );
  });
  return { verify, join, leave };
});
