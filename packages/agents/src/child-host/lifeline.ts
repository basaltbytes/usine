/** The fourth pipe belongs only to the orchestrator; EOF also detects SIGKILL and crashes. */
export const CHILD_LIFELINE = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const [pidFile, exitFile, command, ...args] = process.argv.slice(1);
const child = spawn(command, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
if (pidFile) fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
let timer;
let stderrTail = Buffer.alloc(0);
const diagnostic = data => { stderrTail = Buffer.concat([stderrTail, data]).subarray(-8192); };
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const signal = name => {
  if (!child.pid) return;
  try { process.kill(-child.pid, name); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const stop = () => {
  signal('SIGTERM');
  timer ??= setTimeout(() => signal('SIGKILL'), 5000);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
const lifeline = new net.Socket({ fd: 3, readable: true, writable: false });
lifeline.on('end', stop);
lifeline.resume();
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.stdout.pipe(process.stdout);
child.stderr.on("data", diagnostic);
child.stderr.pipe(process.stderr);
child.on('error', error => { diagnostic(Buffer.from(error.message)); process.stderr.write(error.message); });
child.on('exit', () => signal('SIGKILL'));
child.on('close', (code, sig) => {
  clearTimeout(timer);
  const exitCode = code === null ? (sig ? 128 + (require('node:os').constants.signals[sig] || 0) : 1) : code;
  if (exitFile) fs.writeFileSync(exitFile, JSON.stringify({ exitCode, stderrTail: stderrTail.toString() }), { mode: 0o600 });
  if (pidFile) fs.rmSync(pidFile, { force: true });
  process.exit(exitCode);
});
`;
