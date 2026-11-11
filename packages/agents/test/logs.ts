import { Logger, References, type LogLevel } from "effect";

/** A log record that `collectLogs` captured. */
export interface LogRecord {
  readonly level: LogLevel.LogLevel;
  readonly message: unknown;
  readonly annotations: (typeof References.CurrentLogAnnotations)["Service"];
}

/** Returns the records of `levels` that the returned logger layer collects, in logging order. */
export const collectLogs = (levels: ReadonlyArray<LogLevel.LogLevel>) => {
  const records: Array<LogRecord> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message, fiber }) => {
    if (levels.includes(logLevel))
      records.push({
        level: logLevel,
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
  });
  return { records, layer: Logger.layer([logger]) };
};
