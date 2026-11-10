// Exec on an isolated machine with the egress allowlist set to "none". Usage: node egress.mjs <suffix>
import { scrub, assertMine, client, now, PREFIX, openExec, rawClient } from "./lib.mjs";

const name = `${PREFIX}${process.argv[2]}`;
assertMine(name);
const boxd = client();
const out = (o) => console.log(JSON.stringify(o));
const probe = "curl -sS -m 5 -o /dev/null -w '%{http_code}' https://example.com; echo \" rc=$?\"";
const raw = rawClient();
const rawRun = async (command) => {
  let text = "";
  const t = now();
  const { call, done } = openExec(raw, m.id, command, { onData: (x) => (text += new TextDecoder().decode(x.data)) });
  call.end();
  const r = await done;
  return { ms: Math.round(now() - t), text: scrub(text).trim(), exitCode: r.exitChunk?.exitCode };
};
const m = await boxd.machines.get(name);
try {
  out({ label: "machine", isolated: m.isolated, egress: m.egressAllow });
  out({ label: "before", ...(await rawRun(probe)) });
  await boxd.machines.setEgressAllow(m.id, ["none"]);
  await new Promise((r) => setTimeout(r, 2000));
  out({ label: "egress", egress: (await boxd.machines.get(name)).egressAllow });
  out({ label: "with-none-curl", ...(await rawRun(probe)) });
  out({ label: "with-none-exec-true", ...(await rawRun("true")) });
  out({ label: "with-none-stdin-echo", ...(await rawRun("echo ok")) });
  const s = boxd.machines.streamExec(m.id, { command: "cat" });
  s.write("streamed\n");
  s.end();
  let text = "";
  for await (const x of s) text += new TextDecoder().decode(x);
  out({ label: "with-none-sdk-streamExec", text: text.trim(), exitCode: await s.wait() });
} catch (e) {
  out({ error: scrub(`${e?.constructor?.name}: ${e?.message}`) });
} finally {
  await boxd.machines.setEgressAllow(m.id, []);
  out({ label: "cleared", egress: (await boxd.machines.get(name)).egressAllow });
  raw.close();
  process.exit();
}
