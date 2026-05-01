"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TcpSession = void 0;
const net = __importStar(require("net"));
const crypto_1 = require("crypto");
class TcpSession {
    host;
    port;
    onEvent;
    sessionId;
    socket = null;
    constructor(host, port, onEvent) {
        this.host = host;
        this.port = port;
        this.onEvent = onEvent;
        this.sessionId = (0, crypto_1.randomUUID)();
    }
    connect() {
        if (this.socket) {
            return;
        }
        const socket = net.createConnection({
            host: this.host,
            port: this.port,
        });
        this.socket = socket;
        socket.on("connect", () => {
            this.onEvent({ type: "connected", sessionId: this.sessionId });
        });
        socket.on("data", (chunk) => {
            this.onEvent({
                type: "data",
                sessionId: this.sessionId,
                payloadBase64: chunk.toString("base64"),
            });
        });
        socket.on("close", (hadError) => {
            this.socket = null;
            this.onEvent({
                type: "closed",
                sessionId: this.sessionId,
                reason: hadError ? "Socket closed after error" : "Socket closed",
            });
        });
        socket.on("error", (err) => {
            this.onEvent({
                type: "error",
                sessionId: this.sessionId,
                message: err.message,
            });
        });
    }
    writeBase64(payloadBase64) {
        if (!this.socket) {
            return;
        }
        const payload = Buffer.from(payloadBase64, "base64");
        this.socket.write(payload);
    }
    disconnect() {
        if (!this.socket) {
            return;
        }
        this.socket.end();
        this.socket.destroy();
        this.socket = null;
    }
}
exports.TcpSession = TcpSession;
//# sourceMappingURL=tcpSession.js.map