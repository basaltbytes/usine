import { Cause, Console, Logger, References } from "effect";

/**
 * Effect's default logger with an ISO 8601 UTC timestamp, such as `[2026-10-27T02:25:13.123Z]`, in
 * place of the local time of day, which has no date or offset and shifts with the process's time
 * zone (#603).
 */
const utcLogger = Logger.make<unknown, void>(({ cause, date, fiber, logLevel, message }) => {
  const parts: Array<unknown> = Array.isArray(message) ? [...message] : [message];
  if (cause.reasons.length > 0) parts.push(Cause.pretty(cause));
  const annotations = fiber.getRef(References.CurrentLogAnnotations);
  if (Object.keys(annotations).length > 0) parts.push(annotations);
  const spans = fiber
    .getRef(References.CurrentLogSpans)
    .map(([label, start]) => ` ${label.replace(/[\s="]/gu, "_")}=${date.getTime() - start}ms`)
    .join("");
  const console = fiber.getRef(Console.Console);
  const line = `[${date.toISOString()}] ${logLevel.toUpperCase()} (#${fiber.id})${spans}:`;
  if (fiber.getRef(References.LogToStderr)) console.error(line, ...parts);
  else console.log(line, ...parts);
});

/** Replaces the default loggers of every usine command: log lines in UTC, and span events. */
export const loggerLayer = Logger.layer([utcLogger, Logger.tracerLogger]);
