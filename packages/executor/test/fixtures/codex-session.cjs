#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const home = process.env.CODEX_HOME;
const rollout = path.join(home, "sessions", "rollout-thread-one.jsonl");
let resumed = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  switch (request.method) {
    case "initialize":
      reply({});
      break;
    case "account/read":
      reply({ account: { type: "chatgpt", email: "test@example.com" }, requiresOpenaiAuth: true });
      break;
    case "model/list":
      reply({ data: [{ id: "test-model", model: "test-model" }], nextCursor: null });
      break;
    case "thread/start":
      fs.mkdirSync(path.dirname(rollout), { recursive: true });
      fs.writeFileSync(rollout, "thread-one\n");
      reply({
        thread: { id: "thread-one" },
        model: "test-model",
        modelProvider: "openai",
        instructionSources: [],
      });
      break;
    case "thread/resume":
      if (
        !fs.existsSync(rollout) ||
        fs.readFileSync(rollout, "utf8").trim() !== request.params.threadId
      ) {
        send({
          id: request.id,
          error: {
            code: -32600,
            message: "no rollout found for thread id " + request.params.threadId,
          },
        });
        break;
      }
      resumed = true;
      fs.writeFileSync(path.join(home, "resumed"), request.params.threadId);
      reply({
        thread: { id: "thread-one", turns: [] },
        model: "test-model",
        modelProvider: "openai",
        instructionSources: [],
      });
      break;
    case "turn/start":
      reply({ turn: { id: "turn-one" } });
      if (resumed) {
        send({
          method: "item/completed",
          params: {
            threadId: "thread-one",
            turnId: "turn-one",
            item: { type: "agentMessage", id: "answer", text: "Resumed original thread" },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: "thread-one",
            turn: { id: "turn-one", status: "completed", error: null },
          },
        });
      }
      break;
  }
});
