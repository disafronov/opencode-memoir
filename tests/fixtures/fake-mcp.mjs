import { createServer } from "node:net";

const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
if (portIndex < 0 || !Number.isInteger(port)) process.exit(2);

const server = createServer((socket) => socket.end());
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
