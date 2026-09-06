import { Match, Option, Schema } from "effect";
import type { TranscriptTool } from "../model.ts";
import { presentFile } from "./files.ts";
import { JsonObject, code, content, fields, object, string, type ToolSection } from "./sections.ts";

export type { ToolSection } from "./sections.ts";

/** A tool's purpose, subject, and readable content; its original payload remains on TranscriptTool. */
export interface ToolPresentation {
  readonly category: "command" | "read" | "edit" | "write" | "search" | "agent" | "tool";
  readonly title: string;
  readonly subject: string;
  readonly input: ReadonlyArray<ToolSection>;
  readonly output: ReadonlyArray<ToolSection>;
}

/** Classifies a harness tool name for both its presentation and routine-work summaries. */
export const toolCategory = (name: string): ToolPresentation["category"] => {
  switch (name.toLowerCase()) {
    case "bash":
    case "powershell":
    case "shell":
    case "command":
      return "command";
    case "read":
      return "read";
    case "edit":
    case "file_change":
      return "edit";
    case "write":
      return "write";
    case "grep":
    case "glob":
    case "find":
    case "ls":
    case "web_search":
      return "search";
    case "subagent":
    case "agent":
    case "task":
      return "agent";
    default:
      return "tool";
  }
};

interface Payload {
  readonly name: string;
  readonly input: Schema.Json | undefined;
  readonly output: Schema.Json | undefined;
}
type Body = Omit<ToolPresentation, "category">;

const command = ({ input, output }: Payload): Body => {
  const request = object(input ?? output);
  const result = object(output);
  const command = string(request.command) ?? string(result.command);
  return {
    title: "Command",
    subject: command ?? "Command details unavailable",
    input: [
      ...(command === undefined ? [] : [code("Command", command, "bash")]),
      ...fields("Options", request, [
        "command",
        "type",
        "id",
        "status",
        "aggregatedOutput",
        "exitCode",
        "durationMs",
        "processId",
        "source",
        "commandActions",
      ]),
    ],
    output:
      result.type === "commandExecution"
        ? [
            ...content(result.aggregatedOutput, "Output"),
            ...fields("Execution", result, [
              "type",
              "id",
              "status",
              "command",
              "cwd",
              "aggregatedOutput",
              "processId",
              "source",
              "commandActions",
            ]),
          ]
        : content(output, "Output"),
  };
};

const search = ({ input, output, name }: Payload): Body => {
  const request = object(input ?? output);
  const result = object(output);
  const action = object(request.action);
  return {
    title: name.toLowerCase() === "ls" ? "List files" : "Search",
    subject:
      string(request.pattern) ??
      string(request.query) ??
      string(action.query) ??
      string(action.url) ??
      string(request.path) ??
      "Search details unavailable",
    input: fields("Search", request, ["type", "id"]),
    output:
      result.type === "webSearch"
        ? fields("Search", result, ["type", "id"])
        : content(output, "Results"),
  };
};

const agent = ({ input, output }: Payload): Body => {
  const request = object(input);
  const task = string(request.task) ?? string(request.prompt);
  return {
    title: "Delegate",
    subject: string(request.description) ?? task ?? "Delegated task",
    input: [
      ...(task === undefined ? [] : [{ _tag: "Text" as const, label: "Task", text: task }]),
      ...fields("Agent", request, ["task", "prompt"]),
    ],
    output: content(output, "Report").map((section) =>
      section._tag === "Code"
        ? { _tag: "Text", label: section.label, text: section.text }
        : section,
    ),
  };
};

const tool = ({ input, output, name }: Payload): Body => {
  const request = object(input);
  const result = object(output);
  const wrapped =
    request.type === "mcpToolCall" ||
    request.type === "dynamicToolCall" ||
    result.type === "mcpToolCall" ||
    result.type === "dynamicToolCall";
  const args = wrapped ? (request.arguments ?? result.arguments) : input;
  const title = wrapped
    ? [
        string(request.server) ??
          string(result.server) ??
          string(request.namespace) ??
          string(result.namespace),
        string(request.tool) ?? string(result.tool),
      ]
        .filter((part) => part !== undefined)
        .join(" · ")
    : name;
  return {
    title: title || name,
    subject: Schema.is(JsonObject)(args)
      ? `${Object.keys(args).length} parameters`
      : Schema.is(Schema.String)(args)
        ? args
        : "Tool details",
    input: content(args, "Parameters"),
    output: wrapped
      ? [
          ...content(result.result ?? result.contentItems, "Output"),
          ...content(result.error, "Error"),
        ]
      : content(output, "Output"),
  };
};

/** Decodes known harness envelopes for display without changing or discarding the durable tool payload. */
export const presentTool = (entry: TranscriptTool): ToolPresentation => {
  const payload: Payload = {
    name: entry.name,
    input: Option.match(entry.start, { onNone: () => undefined, onSome: ({ input }) => input }),
    output: Match.valueTags(entry.state, {
      Running: () => undefined,
      Stopped: () => undefined,
      Finished: ({ output }) => output,
      Error: ({ output }) => output,
    }),
  };
  const kind = toolCategory(entry.name);
  const presenters = {
    command,
    read: ({ input, output }: Payload) => presentFile(input, output, "read"),
    edit: ({ input, output }: Payload) => presentFile(input, output, "edit"),
    write: ({ input, output }: Payload) => presentFile(input, output, "write"),
    search,
    agent,
    tool,
  } satisfies Record<ToolPresentation["category"], (payload: Payload) => Body>;
  return { category: kind, ...presenters[kind](payload) };
};
