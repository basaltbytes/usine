const field = (key: string, value: string): string => `"${key}=${value.replaceAll('"', '""')}"`;

/** A bind mount with CSV quoting, which preserves commas and colons in paths. */
export const bindMount = (source: string, destination: string, access: "readonly" | "writable") =>
  [
    "type=bind",
    field("source", source),
    field("destination", destination),
    ...(access === "readonly" ? ["readonly"] : []),
  ].join(",");
