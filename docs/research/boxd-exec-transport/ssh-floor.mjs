// Lower bound of an SSH session through the boxd proxy without any key: TCP, banner, key exchange,
// and the refused "none" authentication. Also TCP connect time to the proxy and the gRPC endpoint.
// Usage: node ssh-floor.mjs <host> <port> [runs]
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { now, stats } from "./lib.mjs";

const [host, port, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 10);
const tcp = (h, p) =>
  new Promise((resolve, reject) => {
    const t = now();
    const s = connect({ host: h, port: Number(p) }, () => {
      resolve(now() - t);
      s.destroy();
    });
    s.on("error", reject);
  });
const sshTimes = [];
const proxyTcp = [];
const grpcTcp = [];
let lastStderr = "";
for (let i = 0; i < runs; i++) {
  proxyTcp.push(await tcp(host, port));
  grpcTcp.push(await tcp("fra.boxd.sh", 9443));
  const t = now();
  const r = spawnSync("ssh", [
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "PreferredAuthentications=none",
    "-o", "PubkeyAuthentication=no",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-p", port,
    `boxd@${host}`,
    "true",
  ], { encoding: "utf8" });
  sshTimes.push(now() - t);
  lastStderr = r.stderr.trim();
}
console.log(JSON.stringify({ sshNoneAuthRefused: stats(sshTimes), proxyTcpConnect: stats(proxyTcp), grpcTcpConnect: stats(grpcTcp), lastStderr }));
