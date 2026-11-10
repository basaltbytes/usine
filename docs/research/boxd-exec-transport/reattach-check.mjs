// After the client of reattach-start.mjs died: which processes survive, how fast the others go,
// and whether a new stream reaches the survivor's output. Usage: node reattach-check.mjs <machine id> <tag>
import { now, openExec, rawClient } from "./lib.mjs";

const [vmId, tag] = process.argv.slice(2);
const dir = `/tmp/${tag}`;
const c = rawClient();
const run = async (command) => {
  let text = "";
  const { call, done } = openExec(c, vmId, command, { onData: (x) => (text += new TextDecoder().decode(x.data)) });
  call.end();
  const r = await done;
  return { text: text.trim(), exitCode: r.exitChunk?.exitCode };
};
const status = `for f in fg child nohup detached bg; do p=$(cat ${dir}/$f 2>/dev/null); if [ -n "$p" ] && kill -0 $p 2>/dev/null; then printf "%s=alive " $f; else printf "%s=gone " $f; fi; done; printf "signals=%s" "$(tr '\\n' , < ${dir}/fg-signals 2>/dev/null)"`;
const t = now();
let last = "";
while (now() - t < 30_000) {
  const r = await run(status);
  if (r.text !== last) console.log(JSON.stringify({ sinceCheckStartMs: Math.round(now() - t), status: r.text }));
  last = r.text;
  if (r.text.startsWith("fg=gone child=gone")) break;
  await new Promise((res) => setTimeout(res, 250));
}
const tail = await run(`timeout 3 tail -n 2 -f ${dir}/out; true`);
console.log(JSON.stringify({ event: "new-stream-tail", lines: tail.text.split("\n").slice(-3) }));
const final = await run(status);
console.log(JSON.stringify({ event: "final", status: final.text }));
await run(`for f in bg nohup detached child fg; do kill $(cat ${dir}/$f) 2>/dev/null; done; true`);
c.close();
