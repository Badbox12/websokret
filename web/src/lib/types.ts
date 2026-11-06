// Type-only imports from the Elysia server (../../../src). Nothing here ships to
// the browser bundle — it only keeps client and server contracts in sync.
export type { App } from "../../../src/index";
export type {
  ClientEvent,
  ServerEvent,
  Message,
  RoomSummary,
} from "../../../src/protocol";

import type { Message } from "../../../src/protocol";

/** A message we've sent but the server hasn't acked yet. */
export type PendingMessage = Omit<Message, "id" | "seq" | "createdAt"> & {
  pending: true;
};

export type ChatMessage = (Message & { pending?: false }) | PendingMessage;

export type User = { id: string; username: string };

export type ConnectionStatus = "connecting" | "online" | "reconnecting";
