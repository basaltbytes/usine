/** Milliseconds before the first reconnection of a client MCP socket that OpenCode closed. */
export const MCP_RECONNECT_MS = 500;
/** The most milliseconds between reconnections of a client MCP socket. */
const MCP_RECONNECT_MAX_MS = 10_000;

/** Returns the milliseconds before the reconnection after one that waited `delay`: twice `delay`, up to 10 seconds. */
export const nextReconnectDelay = (delay: number): number =>
  Math.min(delay * 2, MCP_RECONNECT_MAX_MS);
