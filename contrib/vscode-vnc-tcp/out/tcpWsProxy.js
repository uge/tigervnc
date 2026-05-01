"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TcpWsProxy = void 0;
const node_net_1 = require("node:net");
const node_http_1 = require("node:http");
const node_url_1 = require("node:url");
const ws_1 = require("ws");
class TcpWsProxy {
    server = null;
    wss = null;
    listeningPort = 0;
    async start() {
        if (this.server && this.listeningPort > 0) {
            return this.listeningPort;
        }
        await new Promise((resolve, reject) => {
            const server = (0, node_http_1.createServer)((_, res) => {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("vscode-vnc-tcp proxy\n");
            });
            const wss = new ws_1.WebSocketServer({
                server,
                perMessageDeflate: false,
            });
            wss.on("connection", (ws, req) => {
                const reqUrl = new node_url_1.URL(req.url ?? "/", "ws://127.0.0.1");
                const tcpHost = reqUrl.searchParams.get("host") ?? "127.0.0.1";
                const tcpPort = Number(reqUrl.searchParams.get("port") ?? "5900");
                if (!Number.isInteger(tcpPort) || tcpPort <= 0 || tcpPort > 65535) {
                    ws.close(1008, "Invalid target port");
                    return;
                }
                const tcp = (0, node_net_1.createConnection)({ host: tcpHost, port: tcpPort });
                tcp.setNoDelay(true);
                tcp.on("data", (chunk) => {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(chunk, { binary: true });
                    }
                });
                tcp.on("end", () => ws.close(1000, "Server closed"));
                tcp.on("close", () => {
                    if (ws.readyState !== ws.CLOSED) {
                        ws.close(1001, "TCP closed");
                    }
                });
                tcp.on("error", (err) => ws.close(1011, `TCP error: ${err.message}`));
                ws.on("message", (data, isBinary) => {
                    if (isBinary) {
                        tcp.write(Buffer.from(data));
                    }
                    else {
                        tcp.write(Buffer.from(String(data)));
                    }
                });
                ws.on("close", () => tcp.destroy());
                ws.on("error", () => tcp.destroy());
            });
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
                const addr = server.address();
                if (!addr || typeof addr === "string") {
                    reject(new Error("Failed to resolve proxy listen port"));
                    return;
                }
                this.server = server;
                this.wss = wss;
                this.listeningPort = addr.port;
                resolve();
            });
        });
        return this.listeningPort;
    }
    async stop() {
        const wss = this.wss;
        const server = this.server;
        this.wss = null;
        this.server = null;
        this.listeningPort = 0;
        if (wss) {
            await new Promise((resolve) => wss.close(() => resolve()));
        }
        if (server) {
            await new Promise((resolve) => server.close(() => resolve()));
        }
    }
}
exports.TcpWsProxy = TcpWsProxy;
//# sourceMappingURL=tcpWsProxy.js.map