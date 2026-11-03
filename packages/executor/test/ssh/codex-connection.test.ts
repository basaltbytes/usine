import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { CodexAppServer, codexChildBackendLayer, codexAppServerLive } from "@usine/agents/codex";
import { ChildRequest, CodexChildBackend, WorkingDirectory } from "@usine/agents/runtime";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { WorkerName } from "@usine/core/worker";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { Effect, FileSystem, Layer, Option, Result, Stream } from "effect";
import { execPath } from "node:process";

for (const failure of [
  "ssh-drop",
  "ssh-input-drop",
  "ssh-input-eof",
  "ssh-frame-drop",
  "ssh-frame-eof",
  "app-server-exit",
  "app-server-zero-exit",
  "initial-turn-exit",
  "initial-turn-saved-exit",
  "before-initial-turn-exit",
  "supervisor-exit",
  "resume-exit",
  "resume-zero-exit",
] as const)
  it.live(
    failure === "resume-exit" || failure === "resume-zero-exit"
      ? `fails after one thread resume when the app-server exits again (${failure})`
      : `finishes on one Codex thread after ${failure}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-codex-drop-" });
          yield* fs.symlink(execPath, `${directory}/node`);
          yield* fs.writeFileString(
            `${directory}/codex`,
            `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
process.stdout.on('error', () => {});
if (['supervisor-exit', 'app-server-zero-exit'].includes('${failure}') && !fs.existsSync(process.env.CODEX_HOME + '/original-pids')) {
  fs.writeFileSync(process.env.CODEX_HOME + '/original-pids', JSON.stringify([process.ppid, process.pid]));
  const command = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.CODEX_HOME + '/command-pid', String(command.pid));
  if ('${failure}' === 'supervisor-exit') {
    process.on('SIGTERM', () => {});
    process.stdin.on('end', () => {});
    setInterval(() => {}, 1000);
  }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
  } else if (request.method === 'account/read') {
    process.stdout.write(JSON.stringify({ id: request.id, result: { account: { type: 'chatgpt', email: 'test@example.com' }, requiresOpenaiAuth: true } }) + '\\n');
  } else if (request.method === 'model/list') {
    process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{ id: 'test-model', model: 'test-model' }], nextCursor: null } }) + '\\n');
  } else if (request.method === 'thread/start') {
    fs.appendFileSync(process.env.CODEX_HOME + '/threads', 'thread-one\\n');
    process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: 'thread-one' }, model: 'test-model', instructionSources: [] } }) + '\\n');
    if ('${failure}' === 'before-initial-turn-exit') process.exit(0);
  } else if (request.method === 'thread/resume') {
    if (['supervisor-exit', 'app-server-zero-exit'].includes('${failure}')) {
      const pids = JSON.parse(fs.readFileSync(process.env.CODEX_HOME + '/original-pids'));
      pids.push(Number(fs.readFileSync(process.env.CODEX_HOME + '/command-pid')));
      for (const pid of pids) {
        try { process.kill(pid, 0); process.exit(2); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      fs.writeFileSync(process.env.CODEX_HOME + '/original-stopped', 'yes');
    }
    fs.appendFileSync(process.env.CODEX_HOME + '/resumed', request.params.threadId + '\\n');
    const turns = fs.existsSync(process.env.CODEX_HOME + '/saved-inputs')
      ? fs.readFileSync(process.env.CODEX_HOME + '/saved-inputs', 'utf8').trim().split('\\n').map(line => ({ items: [{ type: 'userMessage', content: JSON.parse(line) }] }))
      : [];
    process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: 'thread-one', turns }, model: 'test-model', instructionSources: [] } }) + '\\n');
  } else if (request.method === 'turn/start') {
    fs.appendFileSync(process.env.CODEX_HOME + '/turn-started', 'yes\\n');
    if (['initial-turn-exit', 'resume-exit'].includes('${failure}') && !fs.existsSync(process.env.CODEX_HOME + '/resumed')) {
      process.exit(1);
    }
    fs.appendFileSync(process.env.CODEX_HOME + '/saved-inputs', JSON.stringify(request.params.input) + '\\n');
    if ('${failure}' === 'initial-turn-saved-exit' && !fs.existsSync(process.env.CODEX_HOME + '/resumed')) {
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: 'turn-one' } } }) + '\\n');
    if ('${failure}' === 'supervisor-exit' && !fs.existsSync(process.env.CODEX_HOME + '/resumed')) {
      process.kill(process.ppid, 'SIGKILL');
      return;
    }
    if ('${failure}' === 'resume-zero-exit' || ('${failure}' === 'app-server-zero-exit' && !fs.existsSync(process.env.CODEX_HOME + '/resumed'))) {
      setTimeout(() => process.exit(0), 50);
      return;
    }
    if ('${failure}' === 'resume-exit' || ('${failure}' === 'app-server-exit' && !fs.existsSync(process.env.CODEX_HOME + '/resumed'))) {
      setTimeout(() => process.exit(1), 50);
      return;
    }
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread-one', turnId: 'turn-one', item: { type: 'agentMessage', id: 'answer', text: 'Completed on original thread' } } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed', error: null } } }) + '\\n');
    }, 500);
  }
});
`,
          );
          yield* fs.chmod(`${directory}/codex`, 0o755);
          yield* fs.writeFileString(
            `${directory}/ssh`,
            `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const relay = spawn('sh', ['-c', process.argv.at(-1)], { stdio: ['pipe', 'pipe', 'pipe'] });
let inputDropped = false;
if ('${failure}'.startsWith('ssh-input-')) {
  let input = '';
  process.stdin.on('data', data => {
    if (inputDropped) return;
    input += data.toString();
    let end;
    while ((end = input.indexOf('\\n')) >= 0) {
      const line = input.slice(0, end);
      input = input.slice(end + 1);
      const frame = JSON.parse(line);
      if (!fs.existsSync('${directory}/dropped') && frame.data && Buffer.from(frame.data, 'base64').toString().includes('turn/start')) {
        inputDropped = true;
        fs.writeFileSync('${directory}/dropped', 'yes');
        relay.stdin.end('${failure}' === 'ssh-input-eof' ? line : line.slice(0, Math.floor(line.length / 2)));
        return;
      }
      relay.stdin.write(line + '\\n');
    }
  });
} else process.stdin.pipe(relay.stdin);
let buffered = '';
let offset = 0;
relay.stdout.on('data', data => {
  if (!'${failure}'.startsWith('ssh-frame-')) {
    process.stdout.write(data);
    return;
  }
  buffered += data.toString();
  let end;
  while ((end = buffered.indexOf('\\n')) >= 0) {
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    const frame = JSON.parse(line);
    if (frame.ready) fs.appendFileSync('${directory}/cursors', String(frame.offset) + '\\n');
    if (!fs.existsSync('${directory}/dropped') && frame.stdout && Buffer.from(frame.stdout, 'base64').toString().includes('item/completed')) {
      fs.writeFileSync('${directory}/dropped', String(offset));
      process.stdout.write('${failure}' === 'ssh-frame-eof' ? line : line.slice(0, Math.floor(line.length / 2)), () => {
        relay.kill();
        process.exit(255);
      });
      return;
    }
    offset = frame.offset;
    process.stdout.write(line + '\\n');
  }
});
relay.stderr.pipe(process.stderr);
relay.stdin.on('error', () => {});
const timer = setInterval(() => {
  if ('${failure}' === 'ssh-drop' && !fs.existsSync('${directory}/dropped') && fs.existsSync('${directory}/turn-started')) {
    fs.writeFileSync('${directory}/dropped', 'yes');
    relay.kill();
    process.exit(255);
  }
}, 20);
relay.on('exit', code => { clearInterval(timer); process.exit(inputDropped ? 255 : code || 0); });
`,
          );
          const running = yield* (yield* CodexChildBackend).launch(
            ChildRequest.make({
              worker: WorkerName.make("boat"),
              machine: Option.none(),
              cwd: WorkingDirectory.make(directory),
              session: ChildSession.make({
                id: AgentSessionId.make("parent:drop:child:1"),
                parentId: AgentSessionId.make("parent:drop"),
                agent: AgentName.make("developer"),
                brain: BrainSpec.make({
                  harness: "codex",
                  model: ModelId.make("test-model"),
                  effort: "off",
                }),
              }),
              prompt: "Finish this attempt.",
              environment: {
                PATH: `${directory}:/usr/local/bin:/usr/bin:/bin`,
                CODEX_HOME: directory,
              },
              host: RemoteShell.make({
                ssh: { command: execPath, args: [`${directory}/ssh`] },
                sshEnvironment: {},
                destination: "worker",
              }),
            }),
          );
          if (failure === "resume-exit" || failure === "resume-zero-exit") {
            const error = yield* running.result.pipe(Effect.flip);
            assert.strictEqual(error._tag, "SessionOperationError");
            assert.strictEqual(yield* fs.readFileString(`${directory}/resumed`), "thread-one\n");
            assert.strictEqual(yield* fs.readFileString(`${directory}/threads`), "thread-one\n");
            return;
          }
          assert.strictEqual((yield* running.result).message, "Completed on original thread");
          const events = yield* Stream.runCollect(running.events);
          assert.strictEqual(events.filter((event) => event._tag === "SessionStarted").length, 1);
          assert.strictEqual(events.filter((event) => event._tag === "TextOutput").length, 1);
          assert.strictEqual(yield* fs.readFileString(`${directory}/threads`), "thread-one\n");
          assert.strictEqual(
            yield* fs.readFileString(`${directory}/turn-started`),
            failure.startsWith("ssh-") || failure === "before-initial-turn-exit"
              ? "yes\n"
              : "yes\nyes\n",
          );
          if (failure.startsWith("ssh-input-")) {
            assert.isTrue(yield* fs.exists(`${directory}/dropped`), "the SSH input was truncated");
            assert.isFalse(
              yield* fs.exists(`${directory}/resumed`),
              "the original app-server survives the drop",
            );
          }
          if (failure.startsWith("ssh-frame-"))
            assert.strictEqual(
              yield* fs.readFileString(`${directory}/cursors`),
              `0\n${yield* fs.readFileString(`${directory}/dropped`)}\n`,
              "reconnect replays from the last complete frame",
            );
          if (!failure.startsWith("ssh-"))
            assert.strictEqual(yield* fs.readFileString(`${directory}/resumed`), "thread-one\n");
          const saved = (yield* fs.readFileString(`${directory}/saved-inputs`)).trim().split("\n");
          const originalInput = JSON.stringify([
            { type: "text", text: "Finish this attempt.", text_elements: [] },
          ]);
          assert.strictEqual(
            saved[0],
            originalInput,
            "the saved thread contains the original task",
          );
          assert.strictEqual(saved.filter((input) => input === originalInput).length, 1);
          if (failure === "supervisor-exit" || failure === "app-server-zero-exit")
            assert.strictEqual(yield* fs.readFileString(`${directory}/original-stopped`), "yes");
        }),
      ).pipe(
        Effect.provide(codexChildBackendLayer),
        Effect.provide(
          failure === "before-initial-turn-exit"
            ? Layer.effect(
                CodexAppServer,
                Effect.gen(function* () {
                  const server = yield* CodexAppServer;
                  return CodexAppServer.of({
                    open: (client) =>
                      server.open(client).pipe(
                        Effect.map((connection) => ({
                          ...connection,
                          request: (operation, method, params) =>
                            Effect.gen(function* () {
                              const response = yield* connection.request(operation, method, params);
                              if (method === "thread/start") {
                                const recorded = yield* Stream.runDrain(
                                  connection.notifications,
                                ).pipe(Effect.result);
                                assert(Result.isFailure(recorded), "process loss is recorded");
                              }
                              return response;
                            }),
                        })),
                      ),
                  });
                }),
              ).pipe(Layer.provide(codexAppServerLive))
            : codexAppServerLive,
        ),
        Effect.provide(NodeServices.layer),
      ),
    20_000,
  );
