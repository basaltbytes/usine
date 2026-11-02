import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { codexChildBackendLayer, codexAppServerLive } from "@usine/agents/codex";
import { ChildRequest, CodexChildBackend, WorkingDirectory } from "@usine/agents/runtime";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { WorkerName } from "@usine/core/worker";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { Effect, FileSystem, Option, Stream } from "effect";

for (const failure of ["ssh-drop", "app-server-exit"] as const)
  it.live(
    `finishes on one Codex thread after ${failure} mid-turn`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-codex-drop-" });
          yield* fs.writeFileString(
            `${directory}/codex`,
            `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
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
  } else if (request.method === 'thread/resume') {
    fs.appendFileSync(process.env.CODEX_HOME + '/resumed', request.params.threadId + '\\n');
    process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: 'thread-one' }, model: 'test-model', instructionSources: [] } }) + '\\n');
  } else if (request.method === 'turn/start') {
    fs.appendFileSync(process.env.CODEX_HOME + '/turn-started', 'yes\\n');
    process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: 'turn-one' } } }) + '\\n');
    if ('${failure}' === 'app-server-exit' && !fs.existsSync(process.env.CODEX_HOME + '/resumed')) {
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
            `#!/usr/bin/node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const relay = spawn('sh', ['-c', process.argv.at(-1)], { stdio: ['pipe', 'pipe', 'pipe'] });
process.stdin.pipe(relay.stdin);
relay.stdout.pipe(process.stdout);
relay.stderr.pipe(process.stderr);
relay.stdin.on('error', () => {});
const timer = setInterval(() => {
  if ('${failure}' === 'ssh-drop' && !fs.existsSync('${directory}/dropped') && fs.existsSync('${directory}/turn-started')) {
    fs.writeFileSync('${directory}/dropped', 'yes');
    relay.kill();
    process.exit(255);
  }
}, 20);
relay.on('exit', code => { clearInterval(timer); process.exit(code || 0); });
`,
          );
          yield* fs.chmod(`${directory}/ssh`, 0o755);
          const running = yield* (yield* CodexChildBackend).launch(
            new ChildRequest({
              worker: WorkerName.make("boat"),
              machine: Option.none(),
              cwd: WorkingDirectory.make(directory),
              session: new ChildSession({
                id: AgentSessionId.make("parent:drop:child:1"),
                parentId: AgentSessionId.make("parent:drop"),
                agent: AgentName.make("developer"),
                brain: new BrainSpec({
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
              host: new RemoteShell({
                ssh: { command: `${directory}/ssh`, args: [] },
                sshEnvironment: {},
                destination: "worker",
              }),
            }),
          );
          assert.strictEqual((yield* running.result).message, "Completed on original thread");
          const events = yield* Stream.runCollect(running.events);
          assert.strictEqual(events.filter((event) => event._tag === "SessionStarted").length, 1);
          assert.strictEqual(events.filter((event) => event._tag === "TextOutput").length, 1);
          assert.strictEqual(yield* fs.readFileString(`${directory}/threads`), "thread-one\n");
          assert.strictEqual(
            yield* fs.readFileString(`${directory}/turn-started`),
            failure === "ssh-drop" ? "yes\n" : "yes\nyes\n",
          );
          if (failure === "app-server-exit")
            assert.strictEqual(yield* fs.readFileString(`${directory}/resumed`), "thread-one\n");
        }),
      ).pipe(
        Effect.provide(codexChildBackendLayer),
        Effect.provide(codexAppServerLive),
        Effect.provide(NodeServices.layer),
      ),
    20_000,
  );
