import { Effect, Option } from "effect";
import { HttpClient } from "effect/http";
import { WorkerCapabilityError } from "../../../executor.ts";
import type { RemoteCommands } from "../../../remote/commands.ts";
import { boatTailnetOf, type SshMachine, type SshWorkerAddress } from "../../model.ts";
import { GATEWAY_SENT_VARIABLES } from "../../gateway/environment.ts";
import { tailscaleClientFor } from "./client.ts";

const CONFIGURE = String.raw`
set -eu
address=$1
domain=$2
variables=$3
work=$(mktemp)
trap 'rm -f "$work"' EXIT
grep -v '# usine-tailnet$' /etc/hosts > "$work" || true
printf '%s git.%s llm.%s # usine-tailnet\n' "$address" "$domain" "$domain" >> "$work"
cat "$work" > /etc/hosts
mkdir -p /etc/ssh/sshd_config.d
printf 'AcceptEnv %s\n' "$variables" > /etc/ssh/sshd_config.d/40-usine-gateway.conf
sshd -t
systemctl reload ssh
cat > /etc/systemd/system/usine-gateway-http.socket <<UNIT
[Socket]
ListenStream=/run/usine-gateway/http.sock
SocketMode=0666
DirectoryMode=0755
[Install]
WantedBy=sockets.target
UNIT
cat > /etc/systemd/system/usine-gateway-http.service <<UNIT
[Unit]
Requires=usine-gateway-http.socket
After=usine-gateway-http.socket
[Service]
ExecStart=/usr/lib/systemd/systemd-socket-proxyd $address:80
DynamicUser=yes
PrivateTmp=yes
UNIT
systemctl daemon-reload
systemctl enable --now usine-gateway-http.socket
`.trim();

/** Configures Boat machines before checkout and removes their ephemeral nodes at cleanup. */
export const boatTailnetsFor = Effect.fn("SshExecutor.boatTailnetsFor")(function* (
  commands: RemoteCommands,
) {
  const http = yield* HttpClient.HttpClient;
  const clientFor = (address: SshWorkerAddress) =>
    Effect.transposeOption(
      Option.map(boatTailnetOf(address), (settings) =>
        tailscaleClientFor(address.name, settings).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      ),
    );
  const verify = Effect.fn("SshExecutor.verifyBoatTailnet")(function* (address: SshWorkerAddress) {
    yield* Effect.annotateCurrentSpan({ worker: address.name });
    const client = yield* clientFor(address);
    if (Option.isNone(client) || Option.isNone(address.gateway)) return;
    yield* client.value.withKey(() => Effect.void);
    yield* client.value.verifyGateway(address.gateway.value.domain);
  });
  const leave = Effect.fn("SshExecutor.leaveBoatTailnet")(function* (machine: SshMachine) {
    if (Option.isNone(boatTailnetOf(machine.address))) return;
    const worker = machine.address.name;
    yield* Effect.annotateCurrentSpan({ worker, host: machine.shell.destination });
    yield* commands.run("cleanup", machine.shell, "sudo", ["tailscale", "logout"]).pipe(
      Effect.timeout("15 seconds"),
      Effect.tap(() => Effect.logInfo("Removed the sandbox's ephemeral tailnet node", { worker })),
      Effect.tapError(() =>
        Effect.logWarning(
          "Could not log the sandbox out of Tailscale; its ephemeral node expires after sandbox deletion",
          { worker },
        ),
      ),
      Effect.ignore,
    );
  });
  const join = Effect.fn("SshExecutor.joinBoatTailnet")(function* (machine: SshMachine) {
    const settings = boatTailnetOf(machine.address);
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
      yield* commands.run("prepare", machine.shell, "sudo", [
        "sh",
        "-c",
        CONFIGURE,
        "sh",
        settings.value.gatewayAddress,
        domain,
        GATEWAY_SENT_VARIABLES.join(" "),
      ]);
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
        return yield* new WorkerCapabilityError({
          worker,
          capability: "gateway",
          message: `Boat worker "${worker}" cannot reach the gateway over the tailnet`,
          cause: new Error("missing gateway response"),
        });
      yield* Effect.logInfo("Joined the sandbox to the tailnet and configured gateway access", {
        worker,
        address: settings.value.gatewayAddress,
      });
    }).pipe(
      Effect.catchTag("ExecutorOperationError", () =>
        Effect.fail(
          new WorkerCapabilityError({
            worker,
            capability: "gateway",
            message: `Boat worker "${worker}" could not join the tailnet or configure the gateway. Check the snapshot's Tailscale service and tailnet policy.`,
            cause: new Error("tailnet bootstrap failed"),
          }),
        ),
      ),
    );
  });
  return { verify, join, leave };
});
