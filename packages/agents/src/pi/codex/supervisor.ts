/** Remote Node program: a detached app-server supervisor and a replaceable SSH relay. */
const source = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const [mode, pidFile, cursor, ...args] = process.argv.slice(1);
const key = crypto.createHash('sha256').update(pidFile).digest('hex');
const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'usine-transport', key);
const input = path.join(root, 'input');
const output = path.join(root, 'output');
const ready = path.join(root, 'ready');
const append = (frame) => fs.appendFileSync(output, JSON.stringify(frame) + '\n');
if (mode === 'remove') {
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); process.exit(1); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  fs.rmSync(root, { recursive: true, force: true });
} else if (mode === 'supervise') {
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  const stop = () => {
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGHUP', () => {});
  child.stdin.on('error', () => {});
  child.stdout.on('data', data => append({ stdout: data.toString('base64') }));
  child.stderr.on('data', data => append({ stderr: data.toString('base64') }));
  child.on('error', error => append({ stderr: Buffer.from(error.message).toString('base64') }));
  child.on('close', code => {
    exited = true;
    append({ exitCode: code === null ? 1 : code });
    fs.rmSync(pidFile, { force: true });
    clearInterval(timer);
  });
  let offset = 0;
  let buffered = '';
  let sequence = 0;
  const timer = setInterval(() => {
    const fd = fs.openSync(input, 'r');
    const data = Buffer.alloc(65536);
    const length = fs.readSync(fd, data, 0, data.length, offset);
    fs.closeSync(fd);
    offset += length;
    buffered += data.subarray(0, length).toString();
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if (frame.sequence <= sequence) continue;
      sequence = frame.sequence;
      if (frame.eof) child.stdin.end();
      else if (!exited) child.stdin.write(Buffer.from(frame.data, 'base64'));
    }
  }, 25);
  fs.writeFileSync(ready, '');
} else {
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(root, { mode: 0o700 });
    fs.writeFileSync(input, '', { mode: 0o600 });
    fs.writeFileSync(output, '', { mode: 0o600 });
    const supervisor = spawn(process.execPath, ['-e', null /* supervisor source */, 'supervise', pidFile, '0', ...args], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    supervisor.unref();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let offset = Number(cursor);
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
      process.stdout.write(JSON.stringify({ ready: true, offset }) + '\n');
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
    if (ending) {
      clearInterval(timer);
      process.stdin.destroy();
      process.exitCode = 0;
    } else {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); }
      catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') process.exit(1); else throw error; }
    }
  }, 25);
  readline.createInterface({ input: process.stdin }).on('line', line => {
    fs.appendFileSync(input, line + '\n');
  });
  process.stdin.on('end', () => process.exit(0));
}
`;

export const CODEX_SUPERVISOR = source.replace("null /* supervisor source */", () =>
  JSON.stringify(source),
);
