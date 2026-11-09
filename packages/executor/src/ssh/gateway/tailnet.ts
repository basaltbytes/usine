import type { HarnessCatalog } from "@usine/agents/harness";
import type { GatewayDomain } from "@usine/core/worker";
import { Effect } from "effect";
import { WorkerCapabilityError } from "../../executor.ts";
import type { RemoteCommands } from "../../remote/commands.ts";
import type { SshMachine, SshTailnet } from "../model.ts";
import { gatewaySentVariables } from "./environment.ts";

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
if pgrep -x sshd >/dev/null; then
  mkdir -p /etc/ssh/sshd_config.d
  printf 'AcceptEnv %s\n' "$variables" > /etc/ssh/sshd_config.d/40-usine-gateway.conf
  sshd -t
  systemctl reload ssh
fi
cat > /etc/systemd/system/usine-gateway-http.socket <<UNIT
[Socket]
ListenStream=/run/usine-gateway/http.sock
SocketMode=0666
DirectoryMode=0755
[Install]
WantedBy=sockets.target
UNIT
proxy_unit=/etc/systemd/system/usine-gateway-http.service
previous_proxy_unit=''
if [ -f "$proxy_unit" ]; then
  previous_proxy_unit=$(cat "$proxy_unit")
fi
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
if [ "$previous_proxy_unit" != "$(cat "$proxy_unit")" ]; then
  systemctl try-restart usine-gateway-http.service
fi
`.trim();

export const configureTailnetGateway = Effect.fn("SshExecutor.configureTailnetGateway")(function* (
  catalog: HarnessCatalog,
  commands: RemoteCommands,
  operation: "preflight" | "prepare",
  machine: SshMachine,
  tailnet: SshTailnet,
  domain: GatewayDomain,
) {
  const worker = machine.address.name;
  const fields = {
    worker,
    host: machine.shell.destination,
    address: tailnet.gatewayAddress,
    domain,
  };
  yield* Effect.annotateCurrentSpan(fields);
  yield* commands
    .run(operation, machine.shell, "sudo", [
      "-n",
      "sh",
      "-c",
      CONFIGURE,
      "sh",
      tailnet.gatewayAddress,
      domain,
      gatewaySentVariables(catalog).join(" "),
    ])
    .pipe(
      Effect.mapError((cause) =>
        WorkerCapabilityError.make({
          worker,
          capability: "gateway",
          message: `SSH worker "${worker}" could not configure its tailnet gateway. Check passwordless sudo and systemd on the worker.`,
          cause,
        }),
      ),
      Effect.tapError((error) => Effect.logWarning(error.message, fields)),
    );
  yield* Effect.logInfo("Configured tailnet gateway access on the SSH worker", fields);
});
