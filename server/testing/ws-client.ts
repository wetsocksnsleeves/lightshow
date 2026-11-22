import { WebSocket } from "ws";
import {
  encodeMessage,
  parseServerMessage,
  type ClientMessage,
  type MessageOfType,
  type ServerMessage,
  type ServerMessageType,
} from "@/lib/protocol";

/**
 * A protocol-aware WebSocket client for tests. Buffers every server message
 * so a test can wait for the next message of a given type.
 */
export class TestClient {
  readonly received: ServerMessage[] = [];
  private cursor = 0;
  private waiters: (() => void)[] = [];
  private closed = false;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const parsed = parseServerMessage(String(data));
      if (!parsed.ok) throw new Error(`bad server message: ${parsed.error}`);
      this.received.push(parsed.message);
      this.wake();
    });
    ws.on("close", () => {
      this.closed = true;
      this.wake();
    });
  }

  static connect(
    url: string,
    headers?: Record<string, string>,
  ): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, headers ? { headers } : undefined);
      const client = new TestClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(encodeMessage(message));
  }

  /**
   * Resolve with the next not-yet-consumed message of `type`, skipping (and
   * consuming) other types before it.
   */
  async next<T extends ServerMessageType>(
    type: T,
    timeoutMs = 2_000,
  ): Promise<MessageOfType<ServerMessage, T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.received.length) {
        const message = this.received[this.cursor++]!;
        if (message.type === type) {
          return message as MessageOfType<ServerMessage, T>;
        }
      }
      if (this.closed) throw new Error(`socket closed waiting for ${type}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** All messages of `type` received so far, consumed or not. */
  all<T extends ServerMessageType>(type: T): MessageOfType<ServerMessage, T>[] {
    return this.received.filter(
      (m): m is MessageOfType<ServerMessage, T> => m.type === type,
    );
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
