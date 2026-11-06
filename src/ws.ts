import { Elysia, t } from "elysia";
import { jwtPlugin } from "./auth";
import { getUserRoomIds, isMember, markRead, saveMessage } from "./db";
import { ClientEventSchema, type ServerEvent, type WsCloseUnauthorized } from "./protocol";

// Minimal shape of the socket we rely on (ElysiaWS satisfies it).
type Sock = {
  id: string;
  send(data: unknown): unknown;
  subscribe(topic: string): unknown;
  publish(topic: string, data: unknown): unknown;
  close(code?: number, reason?: string): unknown;
};

// Typed helpers: every outgoing frame must be a valid ServerEvent.
const emit = (s: Pick<Sock, "send">, event: ServerEvent) => s.send(event);
const broadcast = (s: Pick<Sock, "publish">, topic: string, event: ServerEvent) =>
  s.publish(topic, event);

// ---------- Connection registry (single node; replace with Redis for multi-node) ----------
const socketsByUser = new Map<string, Set<Sock>>();
const userBySocket = new Map<string, string>();
/** Per-socket promise chain so a client's frames are handled in arrival order. */
const queues = new Map<string, Promise<void>>();

const roomTopic = (roomId: string) => `room:${roomId}`;
const PRESENCE = "presence";
const CLOSE_UNAUTHORIZED: WsCloseUnauthorized = 4001;

export const isOnline = (userId: string) =>
  (socketsByUser.get(userId)?.size ?? 0) > 0;

/** Called from REST when a user is added to a room so their live sockets start receiving it. */
export function joinRoom(userId: string, roomId: string) {
  for (const s of socketsByUser.get(userId) ?? []) {
    s.subscribe(roomTopic(roomId));
    emit(s, { type: "room.joined", roomId });
  }
}

// ---------- Simple token-bucket rate limit: 10 msgs/sec burst, refills 5/sec ----------
const buckets = new Map<string, { tokens: number; ts: number }>();
function allow(userId: string, capacity = 10, refillPerSec = 5) {
  const nowMs = Date.now();
  const b = buckets.get(userId) ?? { tokens: capacity, ts: nowMs };
  b.tokens = Math.min(
    capacity,
    b.tokens + ((nowMs - b.ts) / 1000) * refillPerSec,
  );
  b.ts = nowMs;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  buckets.set(userId, b);
  return ok;
}

export const wsGateway = new Elysia().use(jwtPlugin).ws("/ws", {
  query: t.Object({ token: t.String() }),
  body: ClientEventSchema,
  idleTimeout: 60, // seconds; client pings every 25s

  async open(ws) {
    const payload = await ws.data.jwt.verify(ws.data.query.token);
    if (!payload || !payload.sub) {
      ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    const userId = String(payload.sub);
    const roomIds = await getUserRoomIds(userId);
    if (ws.raw.readyState !== 1) return; // closed while we were loading

    for (const roomId of roomIds) ws.subscribe(roomTopic(roomId));
    ws.subscribe(PRESENCE);

    // Register only after subscriptions exist, so nothing sent before "ready" is lost
    const wasOnline = isOnline(userId);
    userBySocket.set(ws.id, userId);
    if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
    socketsByUser.get(userId)!.add(ws as unknown as Sock);

    const online = [...socketsByUser.keys()].filter(isOnline);
    emit(ws, { type: "ready", userId, online });
    if (!wasOnline)
      broadcast(ws, PRESENCE, { type: "presence", userId, status: "online" });
  },

  message(ws, msg) {
    const userId = userBySocket.get(ws.id);
    if (!userId) {
      emit(ws, {
        type: "error",
        code: "NOT_READY",
        message: "wait for 'ready' before sending",
      });
      return;
    }

    const task = async () => {
      switch (msg.type) {
        case "ping":
          emit(ws, { type: "pong" });
          return;

        case "message.send": {
          if (!allow(userId)) {
            emit(ws, { type: "error", code: "RATE_LIMITED", clientMsgId: msg.clientMsgId });
            return;
          }
          if (!(await isMember(msg.roomId, userId))) {
            emit(ws, { type: "error", code: "FORBIDDEN", clientMsgId: msg.clientMsgId });
            return;
          }
          const body = msg.body.trim();
          if (!body) return;

          const { message: saved, duplicate } = await saveMessage(
            msg.roomId,
            userId,
            msg.clientMsgId,
            body,
          );
          emit(ws, { type: "message.ack", clientMsgId: msg.clientMsgId, message: saved });
          if (duplicate) return; // client retry: re-ack only, don't fan out again
          // publish() excludes the sender; deliver to the sender's *other* tabs explicitly
          broadcast(ws, roomTopic(msg.roomId), { type: "message.new", message: saved });
          for (const s of socketsByUser.get(userId) ?? []) {
            if (s.id !== ws.id) emit(s, { type: "message.new", message: saved });
          }
          return;
        }

        case "typing":
          if (!(await isMember(msg.roomId, userId))) return;
          broadcast(ws, roomTopic(msg.roomId), {
            type: "typing",
            roomId: msg.roomId,
            userId,
            isTyping: msg.isTyping,
          });
          return;

        case "read":
          if (!(await isMember(msg.roomId, userId))) return;
          await markRead(msg.roomId, userId, msg.seq);
          broadcast(ws, roomTopic(msg.roomId), {
            type: "read",
            roomId: msg.roomId,
            userId,
            seq: msg.seq,
          });
          return;
      }
    };

    // Process one socket's frames in order (DB calls are async now)
    const next = (queues.get(ws.id) ?? Promise.resolve())
      .then(task)
      .catch((err) => {
        console.error("ws message failed:", err);
        emit(ws, { type: "error", code: "INTERNAL", message: "Something went wrong" });
      });
    queues.set(ws.id, next);
  },

  close(ws) {
    queues.delete(ws.id);
    const userId = userBySocket.get(ws.id);
    if (!userId) return;
    userBySocket.delete(ws.id);
    const set = socketsByUser.get(userId);
    if (set) {
      for (const s of set) if (s.id === ws.id) set.delete(s);
      if (set.size === 0) {
        socketsByUser.delete(userId);
        // The closing socket can't publish; notify everyone else directly.
        for (const socks of socketsByUser.values()) {
          for (const s of socks)
            emit(s, { type: "presence", userId, status: "offline" });
        }
      }
    }
  },
});
