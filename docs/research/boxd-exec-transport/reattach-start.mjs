// Starts a command tree over one Exec stream, then the client dies in the way `mode` says.
// Usage: node reattach-start.mjs <machine id> <tag> <mode: sigkill|cancel|close-connection>
import { openExec, rawClient } from "./lib.mjs";

const [vmId, tag, mode] = process.argv.slice(2);
const dir = `/tmp/${tag}`;
const script = [
  `mkdir -p ${dir}`,
  `echo $$ > ${dir}/fg`,
  `setsid sh -c 'echo $$ > ${dir}/bg; i=0; while true; do i=$((i+1)); echo "line $i" >> ${dir}/out; sleep 1; done' </dev/null >/dev/null 2>&1 &`,
  `nohup sleep 1001 </dev/null >/dev/null 2>&1 & echo $! > ${dir}/nohup`,
  `node -e "const c=require('child_process').spawn('sleep',['1002'],{detached:true,stdio:'ignore'});require('fs').writeFileSync('${dir}/detached',String(c.pid));c.unref()"`,
  `sleep 1003 & echo $! > ${dir}/child`,
  `trap 'echo TERM >> ${dir}/fg-signals' TERM`,
  `trap 'echo HUP >> ${dir}/fg-signals' HUP`,
  `echo started`,
  `i=0; while true; do i=$((i+1)); echo fg $i; sleep 1; done`,
].join("\n");
const c = rawClient();
const { call } = openExec(c, vmId, script, {
  onData: (x) => {
    const text = new TextDecoder().decode(x.data);
    if (text.includes("started")) {
      console.log(JSON.stringify({ event: "started", at: Date.now() }));
      setTimeout(() => {
        console.log(JSON.stringify({ event: "dying", mode, at: Date.now() }));
        if (mode === "sigkill") process.kill(process.pid, "SIGKILL");
        if (mode === "cancel") { call.cancel(); setTimeout(() => process.exit(0), 500); }
        if (mode === "close-connection") { c.close(); setTimeout(() => process.exit(0), 500); }
      }, 3000);
    }
  },
});
