"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { api, unwrap } from "@/lib/api";
import { ChatSocket } from "@/lib/chat-socket";
import { session, type Session } from "@/lib/session";
import type {
  ChatMessage,
  ConnectionStatus,
  Message,
  RoomSummary,
  ServerEvent,
} from "@/lib/types";

// ---------------- State ----------------
type State = {
  status: ConnectionStatus;
  rooms: RoomSummary[];
  activeRoomId: string | null;
  /** roomId → (senderId:clientMsgId) → message. Keyed so acks replace pending copies. */
  messages: Record<string, Record<string, ChatMessage>>;
  /** roomId → whether older history may exist */
  hasMore: Record<string, boolean>;
  online: Record<string, true>;
  /** roomId → userId → expiry timestamp */
  typing: Record<string, Record<string, number>>;
  /** userId → username (learned from messages) */
  names: Record<string, string>;
  lastError: string | null;
};

type Action =
  | { type: "status"; status: ConnectionStatus }
  | { type: "rooms"; rooms: RoomSummary[] }
  | { type: "open"; roomId: string }
  | { type: "merge"; roomId: string; messages: Message[]; hasMore?: boolean }
  | { type: "pending"; message: Extract<ChatMessage, { pending: true }> }
  | { type: "received"; message: Message; fromOther: boolean }
  | { type: "typing"; roomId: string; userId: string; until: number | null }
  | { type: "typing.expire"; roomId: string; userId: string; until: number }
  | { type: "online"; userIds: string[] }
  | { type: "presence"; userId: string; online: boolean }
  | { type: "error"; message: string | null };

const PAGE = 50;
const keyOf = (m: { senderId: string; clientMsgId: string }) => `${m.senderId}:${m.clientMsgId}`;

function omit<T extends Record<string, unknown>>(obj: T | undefined, key: string): T {
  const copy = { ...obj } as T;
  delete copy[key];
  return copy;
}

const initial: State = {
  status: "connecting",
  rooms: [],
  activeRoomId: null,
  messages: {},
  hasMore: {},
  online: {},
  typing: {},
  names: {},
  lastError: null,
};

function withMessages(state: State, roomId: string, msgs: ChatMessage[]): State {
  const room = { ...state.messages[roomId] };
  const names = { ...state.names };
  for (const m of msgs) {
    room[keyOf(m)] = m;
    names[m.senderId] = m.senderName;
  }
  return { ...state, names, messages: { ...state.messages, [roomId]: room } };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status };

    case "rooms":
      return {
        ...state,
        // The open room is being read, so never show it as unread
        rooms: action.rooms.map((r) =>
          r.id === state.activeRoomId ? { ...r, unread: 0 } : r,
        ),
      };

    case "open":
      return {
        ...state,
        activeRoomId: action.roomId,
        rooms: state.rooms.map((r) => (r.id === action.roomId ? { ...r, unread: 0 } : r)),
      };

    case "merge": {
      const next = withMessages(state, action.roomId, action.messages);
      return action.hasMore === undefined
        ? next
        : { ...next, hasMore: { ...next.hasMore, [action.roomId]: action.hasMore } };
    }

    case "pending":
      return withMessages(state, action.message.roomId, [action.message]);

    case "received": {
      const { message: m } = action;
      let next = withMessages(state, m.roomId, [m]);
      // Sender stopped typing once their message arrives
      if (next.typing[m.roomId]?.[m.senderId]) {
        const rest = omit(next.typing[m.roomId], m.senderId);
        next = { ...next, typing: { ...next.typing, [m.roomId]: rest } };
      }
      // Bump room to the top, update counters
      const idx = next.rooms.findIndex((r) => r.id === m.roomId);
      if (idx >= 0) {
        const r = next.rooms[idx];
        const unread =
          action.fromOther && m.roomId !== next.activeRoomId ? r.unread + 1 : r.unread;
        const updated = { ...r, lastSeq: Math.max(r.lastSeq, m.seq), unread };
        next = { ...next, rooms: [updated, ...next.rooms.filter((_, i) => i !== idx)] };
      }
      return next;
    }

    case "typing": {
      const room =
        action.until === null
          ? omit(state.typing[action.roomId], action.userId)
          : { ...state.typing[action.roomId], [action.userId]: action.until };
      return { ...state, typing: { ...state.typing, [action.roomId]: room } };
    }

    case "typing.expire": {
      if (state.typing[action.roomId]?.[action.userId] !== action.until) return state;
      const rest = omit(state.typing[action.roomId], action.userId);
      return { ...state, typing: { ...state.typing, [action.roomId]: rest } };
    }

    case "online":
      return {
        ...state,
        online: Object.fromEntries(action.userIds.map((id) => [id, true as const])),
      };

    case "presence":
      return {
        ...state,
        online: action.online
          ? { ...state.online, [action.userId]: true }
          : omit(state.online, action.userId),
      };

    case "error":
      return { ...state, lastError: action.message };
  }
}

// ---------------- Helpers ----------------
export function sortedMessages(map: Record<string, ChatMessage> | undefined): ChatMessage[] {
  if (!map) return [];
  // Confirmed messages by seq; pending ones stay at the bottom in send order.
  return Object.values(map).sort((a, b) => {
    if (a.pending || b.pending) return Number(!!a.pending) - Number(!!b.pending);
    return a.seq - b.seq;
  });
}

function maxSeq(map: Record<string, ChatMessage> | undefined): number {
  let max = 0;
  for (const m of Object.values(map ?? {})) if (!m.pending && m.seq > max) max = m.seq;
  return max;
}

function minSeq(map: Record<string, ChatMessage> | undefined): number | null {
  let min: number | null = null;
  for (const m of Object.values(map ?? {}))
    if (!m.pending && (min === null || m.seq < min)) min = m.seq;
  return min;
}

export function roomLabel(room: RoomSummary, me: string): string {
  if (room.name) return room.name;
  const others = room.members.split(", ").filter((n) => n !== me);
  return others.join(", ") || "Just you";
}

// ---------------- Hook ----------------
export function useChat(auth: Session) {
  const [state, dispatch] = useReducer(reducer, initial);
  // Latest state for socket callbacks without re-subscribing on every change
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const socketRef = useRef<ChatSocket | null>(null);

  const me = auth.user;

  const loadRooms = useCallback(async () => {
    try {
      dispatch({ type: "rooms", rooms: await unwrap(api.rooms.get()) });
    } catch (e) {
      dispatch({ type: "error", message: (e as Error).message });
    }
  }, []);

  const markRead = useCallback((roomId: string) => {
    const seq = maxSeq(stateRef.current.messages[roomId]);
    if (seq > 0) socketRef.current?.send({ type: "read", roomId, seq });
  }, []);

  // Socket lifecycle
  useEffect(() => {
    const typingTimers = new Set<ReturnType<typeof setTimeout>>();

    const onEvent = async (event: ServerEvent) => {
      const s = stateRef.current;
      switch (event.type) {
        case "ready": {
          dispatch({ type: "online", userIds: event.online });
          // Catch up on anything missed while disconnected
          await Promise.all(
            Object.keys(s.messages).map(async (roomId) => {
              const after = maxSeq(s.messages[roomId]);
              const missed = await unwrap(
                api.rooms({ id: roomId }).messages.get({ query: { after, limit: 100 } }),
              ).catch(() => []);
              if (missed.length) dispatch({ type: "merge", roomId, messages: missed });
            }),
          );
          await loadRooms();
          break;
        }
        case "message.ack":
          dispatch({ type: "received", message: event.message, fromOther: false });
          break;
        case "message.new": {
          const m = event.message;
          dispatch({ type: "received", message: m, fromOther: m.senderId !== me.id });
          if (!s.rooms.some((r) => r.id === m.roomId)) await loadRooms();
          if (m.roomId === s.activeRoomId && document.hasFocus()) {
            socketRef.current?.send({ type: "read", roomId: m.roomId, seq: m.seq });
          }
          break;
        }
        case "typing": {
          if (!event.isTyping) {
            dispatch({ type: "typing", roomId: event.roomId, userId: event.userId, until: null });
            break;
          }
          const until = Date.now() + 5000;
          dispatch({ type: "typing", roomId: event.roomId, userId: event.userId, until });
          const t = setTimeout(() => {
            typingTimers.delete(t);
            dispatch({ type: "typing.expire", roomId: event.roomId, userId: event.userId, until });
          }, 5000);
          typingTimers.add(t);
          break;
        }
        case "presence":
          dispatch({ type: "presence", userId: event.userId, online: event.status === "online" });
          break;
        case "room.joined":
          await loadRooms();
          break;
        case "error":
          dispatch({
            type: "error",
            message:
              event.code === "RATE_LIMITED"
                ? "You're sending messages too fast."
                : event.message ?? event.code,
          });
          break;
        case "read":
        case "pong":
          break;
      }
    };

    const socket = new ChatSocket(auth.token, {
      onEvent: (e) => void onEvent(e),
      onStatus: (status) => dispatch({ type: "status", status }),
      onUnauthorized: () => session.set(null),
    });
    socketRef.current = socket;
    socket.connect();
    void loadRooms();

    return () => {
      socket.close();
      socketRef.current = null;
      typingTimers.forEach(clearTimeout);
    };
  }, [auth.token, me.id, loadRooms]);

  // Mark the open room as read when the window regains focus
  useEffect(() => {
    const onFocus = () => {
      const roomId = stateRef.current.activeRoomId;
      if (roomId) markRead(roomId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [markRead]);

  // ---------------- Actions ----------------
  const openRoom = useCallback(
    async (roomId: string) => {
      dispatch({ type: "open", roomId });
      if (!stateRef.current.messages[roomId]) {
        try {
          const msgs = await unwrap(
            api.rooms({ id: roomId }).messages.get({ query: { limit: PAGE } }),
          );
          dispatch({ type: "merge", roomId, messages: msgs, hasMore: msgs.length === PAGE });
        } catch (e) {
          dispatch({ type: "error", message: (e as Error).message });
        }
      }
      markRead(roomId);
    },
    [markRead],
  );

  const loadOlder = useCallback(async () => {
    const { activeRoomId: roomId, messages, hasMore } = stateRef.current;
    if (!roomId || hasMore[roomId] === false) return;
    const before = minSeq(messages[roomId]);
    if (before === null || before <= 1) {
      dispatch({ type: "merge", roomId, messages: [], hasMore: false });
      return;
    }
    const older = await unwrap(
      api.rooms({ id: roomId }).messages.get({ query: { before, limit: PAGE } }),
    );
    dispatch({ type: "merge", roomId, messages: older, hasMore: older.length === PAGE });
  }, []);

  const sendMessage = useCallback(
    (body: string) => {
      const roomId = stateRef.current.activeRoomId;
      const text = body.trim();
      if (!roomId || !text) return;
      const clientMsgId = crypto.randomUUID();
      dispatch({
        type: "pending",
        message: {
          roomId,
          clientMsgId,
          body: text,
          senderId: me.id,
          senderName: me.username,
          pending: true,
        },
      });
      socketRef.current?.send({ type: "message.send", roomId, clientMsgId, body: text });
    },
    [me.id, me.username],
  );

  const setTyping = useCallback((isTyping: boolean) => {
    const roomId = stateRef.current.activeRoomId;
    if (roomId) socketRef.current?.send({ type: "typing", roomId, isTyping });
  }, []);

  const createRoom = useCallback(
    async (members: string[], name?: string) => {
      const type = members.length === 1 && !name ? "dm" : "group";
      const { id } = await unwrap(api.rooms.post({ type, name, members }));
      await loadRooms();
      await openRoom(id);
    },
    [loadRooms, openRoom],
  );

  const addMember = useCallback(
    async (username: string) => {
      const roomId = stateRef.current.activeRoomId;
      if (!roomId) return;
      await unwrap(api.rooms({ id: roomId }).members.post({ username }));
      await loadRooms();
    },
    [loadRooms],
  );

  const clearError = useCallback(() => dispatch({ type: "error", message: null }), []);

  // ---------------- Derived ----------------
  const activeRoom = useMemo(
    () => state.rooms.find((r) => r.id === state.activeRoomId) ?? null,
    [state.rooms, state.activeRoomId],
  );
  const activeMessages = useMemo(
    () => (state.activeRoomId ? sortedMessages(state.messages[state.activeRoomId]) : []),
    [state.messages, state.activeRoomId],
  );
  const typingNames = useMemo(() => {
    const map = state.activeRoomId ? state.typing[state.activeRoomId] : undefined;
    return Object.keys(map ?? {})
      .filter((id) => id !== me.id)
      .map((id) => state.names[id] ?? "Someone");
  }, [state.typing, state.activeRoomId, state.names, me.id]);

  return {
    me,
    state,
    activeRoom,
    activeMessages,
    typingNames,
    hasMore: state.activeRoomId ? state.hasMore[state.activeRoomId] !== false : false,
    openRoom,
    loadOlder,
    sendMessage,
    setTyping,
    createRoom,
    addMember,
    clearError,
  };
}

export type Chat = ReturnType<typeof useChat>;
