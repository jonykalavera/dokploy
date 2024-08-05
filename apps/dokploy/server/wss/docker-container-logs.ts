import type http from "node:http";
import { spawn } from "node-pty";
import { WebSocketServer } from "ws";
import { validateWebSocketRequest } from "../auth/auth";
import { getShell } from "./utils";
import { validateBearerToken } from "../auth/token";

export async function authenticate(req, validators) {
	for (const validator of validators) {
        let {user, session} = await validator(req);
		if (user && session) {
			return {user, session};
		}
	}
}

export const setupDockerContainerLogsWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		path: "/docker-container-logs",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);

		if (pathname === "/_next/webpack-hmr") {
			return;
		}
		if (pathname === "/docker-container-logs") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	wssTerm.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const containerId = url.searchParams.get("containerId");
		const tail = url.searchParams.get("tail");
		const { user, session } = await authenticate(req, [validateWebSocketRequest, validateBearerToken]);

		if (!containerId) {
			ws.close(4000, "containerId no provided");
			return;
		}

		if (!user || !session) {
			ws.close();
			return;
		}
		try {
			const shell = getShell();
			const ptyProcess = spawn(
				shell,
				["-c", `docker container logs --tail ${tail} --follow ${containerId}`],
				{
					name: "xterm-256color",
					cwd: process.env.HOME,
					env: process.env,
					encoding: "utf8",
					cols: 80,
					rows: 30,
				},
			);

			ptyProcess.onData((data) => {
				ws.send(data);
			});
			ws.on("close", () => {
				ptyProcess.kill();
			});
			ws.on("message", (message) => {
				try {
					let command: string | Buffer[] | Buffer | ArrayBuffer;
					if (Buffer.isBuffer(message)) {
						command = message.toString("utf8");
					} else {
						command = message;
					}
					ptyProcess.write(command.toString());
				} catch (error) {
					// @ts-ignore
					const errorMessage = error?.message as unknown as string;
					ws.send(errorMessage);
				}
			});
		} catch (error) {
			// @ts-ignore
			const errorMessage = error?.message as unknown as string;

			ws.send(errorMessage);
		}
	});
};
