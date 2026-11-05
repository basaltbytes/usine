import { createConnection, createServer } from "node:net";

const [, localPort, host, port] = process.argv[2].split(":");
const server = createServer((client) => {
  const remote = createConnection({ host, port: Number(port) });
  client.pipe(remote).pipe(client);
  remote.on("error", () => client.destroy());
  client.on("error", () => remote.destroy());
  client.on("close", () => remote.destroy());
  remote.on("close", () => client.destroy());
});
server.listen(Number(localPort), "127.0.0.1");
