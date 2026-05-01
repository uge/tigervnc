import * as net from "net";
import { randomUUID } from "crypto";

export type TcpSessionEvent =
  | { type: "connected"; sessionId: string }
  | { type: "data"; sessionId: string; payloadBase64: string }
  | { type: "closed"; sessionId: string; reason?: string }
  | { type: "error"; sessionId: string; message: string };

export class TcpSession {
  public readonly sessionId: string;
  private socket: net.Socket | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly onEvent: (event: TcpSessionEvent) => void
  ) {
    this.sessionId = randomUUID();
  }

  connect(): void {
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

    socket.on("data", (chunk: Buffer) => {
      this.onEvent({
        type: "data",
        sessionId: this.sessionId,
        payloadBase64: chunk.toString("base64"),
      });
    });

    socket.on("close", (hadError: boolean) => {
      this.socket = null;
      this.onEvent({
        type: "closed",
        sessionId: this.sessionId,
        reason: hadError ? "Socket closed after error" : "Socket closed",
      });
    });

    socket.on("error", (err: Error) => {
      this.onEvent({
        type: "error",
        sessionId: this.sessionId,
        message: err.message,
      });
    });
  }

  writeBase64(payloadBase64: string): void {
    if (!this.socket) {
      return;
    }
    const payload = Buffer.from(payloadBase64, "base64");
    this.socket.write(payload);
  }

  disconnect(): void {
    if (!this.socket) {
      return;
    }
    this.socket.end();
    this.socket.destroy();
    this.socket = null;
  }
}
