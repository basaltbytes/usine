// A scripted OpenAI Responses API on loopback, which OpenCode calls while a replay records. It
// prints its base URL as `{"url": ...}` and answers each streamed request by the conversation:
// with a `shell` call of `node wait.cjs` for the waiting task, and otherwise with the reply that
// the scenario's last instruction names. Every answer reports usage.
import { createServer } from "node:http";

const textsOf = (input) =>
  (Array.isArray(input) ? input : []).flatMap((item) => {
    if (item.type === "function_call") return [{ role: "call", text: item.name }];
    if (item.type === "function_call_output") return [{ role: "tool", text: String(item.output) }];
    const content = Array.isArray(item.content)
      ? item.content
      : [{ text: String(item.content ?? "") }];
    return content.map((part) => ({ role: item.role, text: part.text ?? "" }));
  });

const answer = (body) => {
  const texts = textsOf(body.input);
  const users = texts.filter(({ role }) => role === "user").map(({ text }) => text);
  const last = users.at(-1) ?? "";
  if (last.includes("REPLAY_SECOND")) return { text: "REPLAY_SECOND" };
  if (users.some((text) => text.includes("REPLAY_GUIDED"))) return { text: "REPLAY_GUIDED" };
  if (last.includes("node wait.cjs") && !texts.some(({ role }) => role === "call"))
    return { call: { command: "node wait.cjs", description: "Wait for the test" } };
  return { text: "REPLAY_DONE" };
};

let responses = 0;
const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `No route for ${request.url}` } }));
      return;
    }
    const body = JSON.parse(raw);
    const plan = answer(body);
    responses += 1;
    const id = `resp_${responses}`;
    const base = { id, object: "response", created_at: 0, model: body.model, output: [] };
    const send = (data) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    send({ type: "response.created", response: { ...base, status: "in_progress" } });
    let item;
    if (plan.call !== undefined) {
      const args = JSON.stringify(plan.call);
      item = {
        type: "function_call",
        id: `fc_${responses}`,
        call_id: `call_${responses}`,
        name: "shell",
        arguments: args,
        status: "completed",
      };
      send({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, arguments: "", status: "in_progress" },
      });
      send({
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: args,
      });
      send({
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: 0,
        arguments: args,
      });
    } else {
      const part = { type: "output_text", text: plan.text, annotations: [] };
      item = {
        type: "message",
        id: `msg_${responses}`,
        status: "completed",
        role: "assistant",
        content: [part],
      };
      send({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      });
      send({
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { ...part, text: "" },
      });
      send({
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: plan.text,
      });
      send({
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: plan.text,
      });
      send({
        type: "response.content_part.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part,
      });
    }
    send({ type: "response.output_item.done", output_index: 0, item });
    send({
      type: "response.completed",
      response: {
        ...base,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 1200,
          input_tokens_details: { cached_tokens: 200 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 1220,
        },
      },
    });
    response.end();
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}/v1` })}\n`);
});
process.stdin.on("end", () => server.close(() => process.exit(0)));
process.stdin.resume();
