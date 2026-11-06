// SQLite (bun:sqlite) keeps the MVP zero-setup. The schema mirrors the
// Postgres design, so swapping to Bun.sql / Postgres later is mechanical.
import { Database } from "bun:sqlite";

export const db = new Database(process.env.DB_PATH ?? "chat.db", {
  create: true,
});
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('dm','group')),
  name       TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  last_seq   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  joined_at     TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id     TEXT NOT NULL REFERENCES users(id),
  seq           INTEGER NOT NULL,
  client_msg_id TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (room_id, seq),
  UNIQUE (sender_id, client_msg_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages (room_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_members_user ON room_members (user_id);
`);

// ---------- Types ----------
export type User = {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
};
export type Message = {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  seq: number;
  clientMsgId: string;
  body: string;
  createdAt: string;
};
export type RoomSummary = {
  id: string;
  type: "dm" | "group";
  name: string | null;
  lastSeq: number;
  unread: number;
  /** Comma-separated usernames of all members */
  members: string;
};

const now = () => new Date().toISOString();

// ---------- Users ----------
export function createUser(username: string, passwordHash: string) {
  const id = crypto.randomUUID();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, username, passwordHash, now());
  return { id, username };
}

export const findUserByName = (username: string) =>
  db
    .query("SELECT * FROM users WHERE username = ?")
    .get(username) as User | null;

export const findUserById = (id: string) =>
  db.query("SELECT id, username FROM users WHERE id = ?").get(id) as {
    id: string;
    username: string;
  } | null;

// ---------- Rooms ----------
export const createRoom = db.transaction(
  (
    type: "dm" | "group",
    name: string | null,
    createdBy: string,
    memberIds: string[],
  ) => {
    const id = crypto.randomUUID();
    const ts = now();
    db.query(
      "INSERT INTO rooms (id, type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, type, name, createdBy, ts);
    const add = db.query(
      "INSERT OR IGNORE INTO room_members (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
    );
    for (const uid of new Set([createdBy, ...memberIds])) {
      add.run(id, uid, uid === createdBy ? "owner" : "member", ts);
    }
    return id;
  },
);

export function addMember(roomId: string, userId: string) {
  db.query(
    "INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)",
  ).run(roomId, userId, now());
}

export const isMember = (roomId: string, userId: string) =>
  !!db
    .query("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?")
    .get(roomId, userId);

export const getUserRoomIds = (userId: string) =>
  (
    db
      .query("SELECT room_id FROM room_members WHERE user_id = ?")
      .all(userId) as { room_id: string }[]
  ).map((r) => r.room_id);

export const getRoomMemberIds = (roomId: string) =>
  (
    db
      .query("SELECT user_id FROM room_members WHERE room_id = ?")
      .all(roomId) as { user_id: string }[]
  ).map((r) => r.user_id);

export function listRoomsForUser(userId: string): RoomSummary[] {
  return db
    .query(
      `SELECT r.id, r.type, r.name, r.last_seq AS lastSeq,
              (r.last_seq - m.last_read_seq) AS unread,
              (SELECT group_concat(u.username, ', ')
                 FROM room_members rm JOIN users u ON u.id = rm.user_id
                WHERE rm.room_id = r.id) AS members
         FROM rooms r
         JOIN room_members m ON m.room_id = r.id AND m.user_id = ?
        ORDER BY r.last_seq DESC, r.created_at DESC`,
    )
    .all(userId) as RoomSummary[];
}

// ---------- Messages ----------
const MSG_SELECT = `
  SELECT m.id, m.room_id AS roomId, m.sender_id AS senderId, u.username AS senderName,
         m.seq, m.client_msg_id AS clientMsgId, m.body, m.created_at AS createdAt
    FROM messages m JOIN users u ON u.id = m.sender_id`;

/**
 * Idempotent + ordered insert:
 *  - (sender_id, client_msg_id) dedupes client retries
 *  - rooms.last_seq is incremented in the same transaction → strict per-room order
 */
export const saveMessage = db.transaction(
  (
    roomId: string,
    senderId: string,
    clientMsgId: string,
    body: string,
  ): { message: Message; duplicate: boolean } => {
    const existing = db
      .query(`${MSG_SELECT} WHERE m.sender_id = ? AND m.client_msg_id = ?`)
      .get(senderId, clientMsgId) as Message | null;
    if (existing) return { message: existing, duplicate: true };

    const { last_seq } = db
      .query(
        "UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq",
      )
      .get(roomId) as { last_seq: number };

    const id = crypto.randomUUID();
    db.query(
      `INSERT INTO messages (id, room_id, sender_id, seq, client_msg_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, roomId, senderId, last_seq, clientMsgId, body, now());

    // Sender has obviously read their own message
    db.query(
      "UPDATE room_members SET last_read_seq = ? WHERE room_id = ? AND user_id = ?",
    ).run(last_seq, roomId, senderId);

    return {
      message: db.query(`${MSG_SELECT} WHERE m.id = ?`).get(id) as Message,
      duplicate: false,
    };
  },
);

/** Pagination: `before` for scrolling up, `after` for reconnect catch-up. */
export function getMessages(
  roomId: string,
  opts: { before?: number; after?: number; limit: number },
) {
  if (opts.after !== undefined) {
    return db
      .query(
        `${MSG_SELECT} WHERE m.room_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`,
      )
      .all(roomId, opts.after, opts.limit) as Message[];
  }
  const rows = db
    .query(
      `${MSG_SELECT} WHERE m.room_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`,
    )
    .all(
      roomId,
      opts.before ?? Number.MAX_SAFE_INTEGER,
      opts.limit,
    ) as Message[];
  return rows.reverse(); // oldest → newest for rendering
}

export function markRead(roomId: string, userId: string, seq: number) {
  db.query(
    "UPDATE room_members SET last_read_seq = MAX(last_read_seq, ?) WHERE room_id = ? AND user_id = ?",
  ).run(seq, roomId, userId);
}
