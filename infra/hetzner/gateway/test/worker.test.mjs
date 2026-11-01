import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const render = fileURLToPath(new URL("../../render-cloud-init.sh", import.meta.url));
const overlay = parse(readFileSync(new URL("../worker-cloud-init.yaml", import.meta.url), "utf8"));

for (const runtime of ["podman", "docker"]) {
  test(`renders a ${runtime} worker with its gateway policy intact`, () => {
    const config = parse(
      execFileSync(render, ['["ssh-ed25519 AAAA-test"]'], {
        env: { ...process.env, USINE_CONTAINER_RUNTIME: runtime },
        encoding: "utf8",
      }),
    );
    const files = new Map(config.write_files.map((file) => [file.path, file.content]));
    assert.equal(files.get("/etc/usine/container-runtime").trim(), runtime);
    assert.deepEqual(config.users[0].ssh_authorized_keys, ["ssh-ed25519 AAAA-test"]);
    assert.equal(config.users[0].sudo, undefined);
    const setup = files.get("/usr/local/sbin/usine-worker-setup");
    execFileSync("sh", ["-n"], { input: setup });
    assert.match(setup, /podman crun uidmap dbus-user-session libpam-systemd/u);
    assert.match(setup, /loginctl enable-linger usine/u);
    assert.match(setup, /Delegate=cpu cpuset io memory pids/u);
    assert.match(files.get("/etc/nftables.conf"), /169\.254\.169\.254 meta skuid != 0 drop/u);
    const gatewayFiles = new Map(overlay.write_files.map((file) => [file.path, file.content]));
    assert.match(gatewayFiles.get("/etc/environment"), /HTTPS_PROXY=http:\/\/@@GATEWAY_IP@@:3128/u);
    assert(gatewayFiles.has("/etc/systemd/system/usine-gateway-http.socket"));
    assert(gatewayFiles.has("/etc/nftables.conf"));
    assert(gatewayFiles.has("/etc/cloud/cloud.cfg.d/90-usine-gateway-resolver.cfg"));
    assert(!gatewayFiles.has("/etc/docker/daemon.json"));
    assert(!gatewayFiles.has("/etc/systemd/system/docker.service.d/http-proxy.conf"));
  });
}

test("refuses an unknown runtime before producing user data", () => {
  assert.throws(
    () =>
      execFileSync(render, ["[]"], {
        env: { ...process.env, USINE_CONTAINER_RUNTIME: "other" },
        stdio: "pipe",
      }),
    /USINE_CONTAINER_RUNTIME must be podman or docker/u,
  );
});
