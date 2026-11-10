// Exit codes, stderr separation, signals, cwd, environment visibility, and stdin EOF over raw Exec.
// Usage: node basics.mjs <machine id>
import { scrub, now, openExec, rawClient, writeStdin } from "./lib.mjs";

const vmId = process.argv[2];
const client = rawClient();
const decoder = new TextDecoder();
const run = async (label, command, { stdin, end = true } = {}) => {
  const t = now();
  let out = "";
  let err = "";
  const { call, done } = openExec(client, vmId, command, {
    onData: (c) => {
      if (c.isStderr) err += decoder.decode(c.data);
      else out += decoder.decode(c.data);
    },
  });
  if (stdin !== undefined) writeStdin(call, stdin);
  if (end) call.end();
  const r = await done;
  console.log(JSON.stringify({
    label,
    ms: Math.round(now() - t),
    out: scrub(out).slice(0, 400),
    err: scrub(err).slice(0, 400),
    error: r.error ? { code: r.error.code, details: scrub(r.error.details) } : undefined,
    chunks: r.received.length,
    lastChunk: r.received.at(-1),
  }));
};

await run("exit7-stderr", "echo out; echo err >&2; exit 7");
await run("sigterm-self", "kill -TERM $$");
await run("sigkill-self", "kill -KILL $$");
await run("exit0-no-output", "true");
await run("cwd-missing", "cd /nonexistent && pwd");
await run("stdin-eof", "wc -c", { stdin: new TextEncoder().encode("hello\n") });
await run("no-eof-timeout", "timeout 3 cat; echo rc=$?", { stdin: new TextEncoder().encode("x\n"), end: false });
await run("shell-and-groups", "echo $0; ps -o pid,ppid,pgid,sid,args -p $$; readlink /proc/$$/exe; cat /proc/$$/status | grep -E 'NSpid|Uid'");
await run("env-visibility", "SECRET_PROBE=s3cr3t-value sh -c 'sleep 2' & sleep 0.5; ps -eo args | grep -c s3cr3t-value; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/environ 2>/dev/null | grep -q s3cr3t-value && echo environ-has-it; done; wait");
await run("tty-off-isatty", "test -t 0 && echo stdin-tty || echo stdin-pipe; test -t 1 && echo stdout-tty || echo stdout-pipe");
await run("exec-agent-procs", "ps -eo pid,ppid,pgid,user,args | grep -v ' \\[' | head -40");
client.close();
