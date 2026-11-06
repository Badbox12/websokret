import { API_URL } from "./api";
import type { ClientEvent, ConnectionStatus, ServerEvent } from "./types";

type Handlers = {
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  onUnauthorized: () => void;
};

const WS_URL = API_URL.replace(/^http/, "ws") + "/ws";
const CLOSE_UNAUTHORIZED = 4001; // matches WsCloseUnauthorized on the server
const PING_MS = 25_000;

/**
 * Typed WebSocket client:
 *  - only accepts ClientEvent, only emits ServerEvent
 *  - waits for the server's `ready` before sending
 *  - queues `message.send` while offline and flushes on reconnect
 *  - reconnects with exponential backoff + jitter
 */
export class ChatSocket {
  private ws: WebSocket | null = null;
  private ready = false;
  private outbox: ClientEvent[] = [];
  private retry = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByUser = false;

  constructor(
    private token: string,
    private handlers: Handlers,
  ) {}

  connect() {
    this.closedByUser = false;
    this.handlers.onStatus(this.retry === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;

    ws.onmessage = (e) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(e.data)) as ServerEvent;
      } catch {
        return;
      }
      if (event.type === "ready") {
        this.ready = true;
        this.retry = 0;
        this.handlers.onStatus("online");
        this.outbox.splice(0).forEach((f) => this.send(f));
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_MS);
      }
      this.handlers.onEvent(event);
    };

    ws.onclose = (e) => {
      this.ready = false;
      clearInterval(this.pingTimer);
      if (this.closedByUser) return;
      if (e.code === CLOSE_UNAUTHORIZED) {
        this.handlers.onUnauthorized();
        return;
      }
      const delay = Math.min(15_000, 500 * 2 ** this.retry++) + Math.random() * 300;
      this.handlers.onStatus("reconnecting");
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  /** Sends now if connected; `message.send` is queued while offline, other events are dropped. */
  send(event: ClientEvent) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    } else if (event.type === "message.send") {
      this.outbox.push(event);
    }
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
