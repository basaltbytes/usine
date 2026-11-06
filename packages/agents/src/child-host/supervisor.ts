import { CHILD_LIFELINE } from "./lifeline.ts";
import { Schema } from "effect";

// The worker program embeds its source in a synchronous replacement callback.
// @effect-diagnostics-next-line schemaSync:off
const quoteSource = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** Detached worker process owner and replaceable, newline-framed relay. */
const source = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [mode, pidFile, cursor, lease, command, ...args] = process.argv.slice(1);
const root = pidFile + '.transport';
const input = path.join(root, 'input');
const output = path.join(root, 'output');
const ready = path.join(root, 'ready');
const heartbeat = path.join(root, 'heartbeat');
const acknowledged = path.join(root, 'sequence');
const delivered = path.join(root, 'delivered');
const lifelinePid = path.join(root, 'process');
const exitFile = path.join(root, 'exit');
const environmentFile = path.join(root, 'environment');
const environmentHash = require('node:crypto').createHash('sha256').update(JSON.stringify(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_') && !['_', 'SHLVL', 'PWD', 'OLDPWD'].includes(key)).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
const append = frame => fs.appendFileSync(output, JSON.stringify(frame) + '\n');
const signal = (pid, name) => {
  try { process.kill(pid, name); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const readPid = file => {
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid === 0) throw new Error('Invalid child process PID');
  return pid;
};
const stopOwner = async (file = pidFile) => {
  if (!fs.existsSync(file)) return;
  const target = readPid(file);
  if (signal(target, 'SIGTERM')) {
    for (let n = 0; signal(target, 0); n++) {
      if (target > 0 && !fs.existsSync(file)) break;
      if (n === 240) signal(target, 'SIGKILL');
      if (n === 480) throw new Error('Child process did not stop');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (file === pidFile) await stopOwner(lifelinePid);
  fs.rmSync(file, { force: true });
};
if (mode === 'stop') {
  stopOwner().catch(error => { console.error(error.message); process.exitCode = 1; });
} else if (mode === 'remove') {
  if (fs.existsSync(pidFile)) {
    const target = readPid(pidFile);
    if (signal(target, 0)) process.exit(1);
  }
  fs.rmSync(pidFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
} else if (mode === 'supervise') {
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const child = spawn(process.execPath, ['-e', null /* lifeline source */, lifelinePid, exitFile, command, ...args], { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let killTimer;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (child.pid !== undefined) signal(-child.pid, 'SIGTERM');
    killTimer = setTimeout(() => {
      if (child.pid !== undefined) signal(-child.pid, 'SIGKILL');
    }, 6000);
  };
  process.on('SIGTERM', stop);
  process.on('SIGHUP', () => {});
  child.stdin.on('error', () => {});
  child.stdout.on('data', data => append({ stdout: data.toString('base64') }));
  let stderrTail = Buffer.alloc(0);
  child.stderr.on('data', data => { stderrTail = Buffer.concat([stderrTail, data]).subarray(-8192); });
  child.on('error', error => { stderrTail = Buffer.from(error.message).subarray(-8192); });
  child.on('close', code => {
    clearTimeout(killTimer);
    clearInterval(timer);
    const event = fs.existsSync(exitFile) ? JSON.parse(fs.readFileSync(exitFile, 'utf8')) : { exitCode: code === null ? 1 : code, stderrTail: stderrTail.toString() };
    append(event);
    fs.rmSync(pidFile, { force: true });
  });
  let offset = 0;
  let buffered = Buffer.alloc(0);
  let sequence = 0;
  const timer = setInterval(() => {
    if (Date.now() - fs.statSync(heartbeat).mtimeMs > Number(lease)) stop();
    const fd = fs.openSync(input, 'r');
    const data = Buffer.alloc(65536);
    const length = fs.readSync(fd, data, 0, data.length, offset);
    fs.closeSync(fd);
    offset += length;
    buffered = Buffer.concat([buffered, data.subarray(0, length)]);
    let end;
    while ((end = buffered.indexOf(10)) >= 0) {
      const frame = JSON.parse(buffered.subarray(0, end).toString());
      buffered = buffered.subarray(end + 1);
      if (frame.sequence <= sequence) { append({ ack: sequence }); continue; }
      sequence = frame.sequence;
      fs.writeFileSync(acknowledged, String(sequence));
      if (frame.eof) child.stdin.end();
      else if (!stopped) child.stdin.write(Buffer.from(frame.data, 'base64'));
      append({ ack: sequence });
    }
  }, 25);
  fs.writeFileSync(ready, '');
} else {
  (async () => {
  if (!fs.existsSync(root)) {
    await stopOwner();
    // Older installations used a second PID file for native session resume.
    await stopOwner(pidFile.replace(/\.pid$/, '-resume.pid'));
  }
  if (mode === 'resume' && fs.existsSync(root) && (!fs.existsSync(pidFile) || !signal(readPid(pidFile), 0) || fs.readFileSync(environmentFile, 'utf8') !== environmentHash || Date.now() - fs.statSync(heartbeat).mtimeMs > Number(lease))) {
    await stopOwner();
    fs.rmSync(root, { recursive: true, force: true });
  }
  let retained = true;
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(root, { mode: 0o700 });
    retained = false;
    fs.writeFileSync(environmentFile, environmentHash, { mode: 0o600 });
    fs.writeFileSync(acknowledged, '0', { mode: 0o600 });
    fs.writeFileSync(delivered, '0', { mode: 0o600 });
    fs.writeFileSync(input, '', { mode: 0o600 });
    fs.writeFileSync(output, '', { mode: 0o600 });
    fs.writeFileSync(heartbeat, '', { mode: 0o600 });
    const supervisor = spawn(process.execPath, ['-e', null /* owner source */, 'supervise', pidFile, '0', lease, command, ...args], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    supervisor.unref();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let offset = mode === 'resume' && retained ? Number(fs.readFileSync(delivered, 'utf8')) : Number(cursor);
  const attachedAt = new Date();
  fs.utimesSync(heartbeat, attachedAt, attachedAt);
  let pending = Buffer.alloc(0);
  let ending = false;
  let waits = 0;
  let announced = false;
  const timer = setInterval(() => {
    if (!fs.existsSync(ready)) {
      if (++waits > 400) process.exit(1);
      return;
    }
    if (!announced) {
      announced = true;
      process.stdout.write(JSON.stringify({ ready: true, offset, sequence: fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).reduce((highest, line) => Math.max(highest, JSON.parse(line).sequence), Number(fs.readFileSync(acknowledged, 'utf8'))), retained }) + '\n');
    }
    const fd = fs.openSync(output, 'r');
    const data = Buffer.alloc(65536);
    const length = fs.readSync(fd, data, 0, data.length, offset + pending.length);
    fs.closeSync(fd);
    pending = Buffer.concat([pending, data.subarray(0, length)]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const frame = JSON.parse(pending.subarray(0, end).toString());
      offset += end + 1;
      pending = pending.subarray(end + 1);
      process.stdout.write(JSON.stringify({ ...frame, offset }) + '\n');
      if (frame.exitCode !== undefined) ending = true;
    }
    if (!ending && fs.existsSync(pidFile) && !signal(readPid(pidFile), 0) && fs.existsSync(exitFile)) {
      append(JSON.parse(fs.readFileSync(exitFile, 'utf8')));
      fs.rmSync(pidFile, { force: true });
      return;
    }
    if (ending) {
      clearInterval(timer);
      process.stdin.destroy();
      process.exitCode = 0;
    }
  }, 25);
  let incoming = Buffer.alloc(0);
  process.stdin.on('data', data => {
    incoming = Buffer.concat([incoming, data]);
    let end;
    while ((end = incoming.indexOf(10)) >= 0) {
      const line = incoming.subarray(0, end + 1);
      incoming = incoming.subarray(end + 1);
      const frame = JSON.parse(line.toString());
      if (frame.heartbeat) {
        const now = new Date();
        fs.utimesSync(heartbeat, now, now);
        fs.writeFileSync(delivered, String(frame.offset));
      } else fs.appendFileSync(input, line);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
`;

const program = source.replace("null /* lifeline source */", () => quoteSource(CHILD_LIFELINE));
export const PROCESS_OWNER = program.replace("null /* owner source */", () => quoteSource(program));
