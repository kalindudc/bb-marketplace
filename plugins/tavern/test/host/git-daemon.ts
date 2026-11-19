import { spawn } from "node:child_process";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import { realGit } from "./emulated-git";

export async function serveGit(repository: string) {
  const root = dirname(repository), sockets = new Set<Socket>();
  const server = createServer({ pauseOnConnect: true }, socket => {
    sockets.add(socket);
    const git = spawn(realGit, ["daemon", "--inetd", "--export-all", "--enable=receive-pack", "--base-path=" + root, root], { stdio: [socket, socket, "ignore"] });
    git.on("error", () => socket.destroy());
    git.on("close", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `git://127.0.0.1:${(server.address() as AddressInfo).port}/${encodeURIComponent(basename(repository))}`, close: () => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
