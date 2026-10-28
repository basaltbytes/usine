import type { Server } from "node:http";
import type { Socket } from "node:net";
import { Effect } from "effect";

/** Tracks HTTP sockets, including CONNECT tunnels that Node's `closeAllConnections` excludes. */
export const trackConnections = (server: Server) => {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return Effect.fn("GatewayNode.closeConnections")(function* () {
    yield* Effect.logInfo("Closing gateway connections", { connections: sockets.size });
    server.close();
    server.closeIdleConnections();
    for (const socket of sockets) socket.destroy();
  });
};
