#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
const resume = args.find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length);
const sessionFlag = args.indexOf("--session-id");
const sessionId =
  resume ??
  args.find((arg) => arg.startsWith("--session-id="))?.slice("--session-id=".length) ??
  (sessionFlag < 0 ? undefined : args[sessionFlag + 1]);
if (!sessionId) throw new Error("Claude session ID was not assigned");
const file = path.join(process.env.HOME, ".claude", "projects", "project", `${sessionId}.jsonl`);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [],
          models: [{ value: "test-model" }],
          account: { apiKeySource: "oauth" },
        },
      },
    });
    return;
  }
  if (message.type !== "user") return;
  if (resume !== undefined) {
    if (resume !== sessionId || fs.readFileSync(file, "utf8").trim() !== sessionId)
      throw new Error("The original Claude session is missing");
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${sessionId}\n`);
  }
  send({ type: "system", subtype: "init", session_id: sessionId });
  send({
    type: "assistant",
    message: {
      id: "message-one",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "Original conversation" }],
    },
  });
  if (resume !== undefined)
    send({ type: "result", subtype: "success", result: "Resumed original conversation" });
});
