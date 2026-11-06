// Shared WebSocket protocol. The server validates ClientEvent at runtime;
// the Next.js app imports these *types* so both sides stay in sync.
import { t, type Static } from "elysia";
import type { Message } from "./db";

export type { Message, RoomSummary } from "./db";

// ---------- Client → Server ----------
export const ClientEventSchema = t.Union([
  t.Object({
    type: t.Literal("message.send"),
    roomId: t.String(),
    clientMsgId: t.String({ minLength: 1, maxLength: 64 }),
    body: t.String({ minLength: 1, maxLength: 4000 }),
  }),
  t.Object({
    type: t.Literal("typing"),
    roomId: t.String(),
    isTyping: t.Boolean(),
  }),
  t.Object({ type: t.Literal("read"), roomId: t.String(), seq: t.Number() }),
  t.Object({ type: t.Literal("ping") }),
]);

export type ClientEvent = Static<typeof ClientEventSchema>;

// ---------- Server → Client ----------
export type ErrorCode = "NOT_READY" | "RATE_LIMITED" | "FORBIDDEN" | "INTERNAL";

export type ServerEvent =
  | { type: "ready"; userId: string; online: string[] }
  | { type: "pong" }
  | { type: "message.ack"; clientMsgId: string; message: Message }
  | { type: "message.new"; message: Message }
  | { type: "typing"; roomId: string; userId: string; isTyping: boolean }
  | { type: "read"; roomId: string; userId: string; seq: number }
  | { type: "presence"; userId: string; status: "online" | "offline" }
  | { type: "room.joined"; roomId: string }
  | { type: "error"; code: ErrorCode; message?: string; clientMsgId?: string };

/** Custom close code sent when the token is missing/invalid. */
export type WsCloseUnauthorized = 4001;
