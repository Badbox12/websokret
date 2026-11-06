// libSQL client: works with Turso (production) AND a local SQLite file (dev).
//   TURSO_DATABASE_URL=libsql://<db>-<org>.turso.io + TURSO_AUTH_TOKEN  → Turso
//   unset                                                             → file:chat.db
import { createClient, type InStatement, type InValue, type Row } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL || `file:${process.env.DB_PATH ?? "chat.db"}`;
const isLocalFile = url.startsWith("file:");

export const db = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ---------- Schema (idempotent; runs once at startup) ----------
const SCHEMA = `
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
`;

export async function migrate() {
  if (isLocalFile) await db.execute("PRAGMA journal_mode = WAL;");
  await db.executeMultiple(SCHEMA);
}

// ---------- Query helpers ----------
const toObject = <T>(row: Row, columns: string[]) =>
  Object.fromEntries(columns.map((c) => [c, row[c]])) as T;

async function all<T>(sql: string, args: InValue[] = []): Promise<T[]> {
  const rs = await db.execute({ sql, args });
  return rs.rows.map((r) => toObject<T>(r, rs.columns));
}

async function get<T>(sql: string, args: InValue[] = []): Promise<T | null> {
  return (await all<T>(sql, args))[0] ?? null;
}

async function run(sql: string, args: InValue[] = []) {
  await db.execute({ sql, args });
}

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
export async function createUser(username: string, passwordHash: string) {
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
    [id, username, passwordHash, now()],
  );
  return { id, username };
}

export const findUserByName = (username: string) =>
  get<User>("SELECT * FROM users WHERE username = ?", [username]);

export const findUserById = (id: string) =>
  get<{ id: string; username: string }>("SELECT id, username FROM users WHERE id = ?", [id]);

// ---------- Rooms ----------
export async function createRoom(
  type: "dm" | "group",
  name: string | null,
  createdBy: string,
  memberIds: string[],
) {
  const id = crypto.randomUUID();
  const ts = now();
  const statements: InStatement[] = [
    {
      sql: "INSERT INTO rooms (id, type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [id, type, name, createdBy, ts],
    },
    ...[...new Set([createdBy, ...memberIds])].map((uid) => ({
      sql: "INSERT OR IGNORE INTO room_members (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
      args: [id, uid, uid === createdBy ? "owner" : "member", ts],
    })),
  ];
  await db.batch(statements, "write"); // atomic: all or nothing
  return id;
}

export const addMember = (roomId: string, userId: string) =>
  run("INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)", [
    roomId,
    userId,
    now(),
  ]);

export const isMember = async (roomId: string, userId: string) =>
  !!(await get("SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?", [
    roomId,
    userId,
  ]));

export const getUserRoomIds = async (userId: string) =>
  (
    await all<{ room_id: string }>("SELECT room_id FROM room_members WHERE user_id = ?", [userId])
  ).map((r) => r.room_id);

export const getRoomMemberIds = async (roomId: string) =>
  (
    await all<{ user_id: string }>("SELECT user_id FROM room_members WHERE room_id = ?", [roomId])
  ).map((r) => r.user_id);

export const listRoomsForUser = (userId: string) =>
  all<RoomSummary>(
    `SELECT r.id, r.type, r.name, r.last_seq AS lastSeq,
            (r.last_seq - m.last_read_seq) AS unread,
            (SELECT group_concat(u.username, ', ')
               FROM room_members rm JOIN users u ON u.id = rm.user_id
              WHERE rm.room_id = r.id) AS members
       FROM rooms r
       JOIN room_members m ON m.room_id = r.id AND m.user_id = ?
      ORDER BY r.last_seq DESC, r.created_at DESC`,
    [userId],
  );

// ---------- Messages ----------
const MSG_SELECT = `
  SELECT m.id, m.room_id AS roomId, m.sender_id AS senderId, u.username AS senderName,
         m.seq, m.client_msg_id AS clientMsgId, m.body, m.created_at AS createdAt
    FROM messages m JOIN users u ON u.id = m.sender_id`;

const findByClientId = (senderId: string, clientMsgId: string) =>
  get<Message>(`${MSG_SELECT} WHERE m.sender_id = ? AND m.client_msg_id = ?`, [
    senderId,
    clientMsgId,
  ]);

/**
 * Idempotent + ordered insert, in ONE atomic batch (one network round trip to Turso):
 *  1. bump rooms.last_seq
 *  2. insert the message using that seq
 *  3. mark it read for the sender
 *  4. return the saved row
 * (sender_id, client_msg_id) is UNIQUE, so a racing retry fails the batch and we
 * return the already-saved message instead.
 */
export async function saveMessage(
  roomId: string,
  senderId: string,
  clientMsgId: string,
  body: string,
): Promise<{ message: Message; duplicate: boolean }> {
  const existing = await findByClientId(senderId, clientMsgId);
  if (existing) return { message: existing, duplicate: true };

  const id = crypto.randomUUID();
  try {
    const results = await db.batch(
      [
        { sql: "UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ?", args: [roomId] },
        {
          sql: `INSERT INTO messages (id, room_id, sender_id, seq, client_msg_id, body, created_at)
                SELECT ?, id, ?, last_seq, ?, ?, ? FROM rooms WHERE id = ?`,
          args: [id, senderId, clientMsgId, body, now(), roomId],
        },
        {
          sql: `UPDATE room_members SET last_read_seq = (SELECT last_seq FROM rooms WHERE id = ?)
                 WHERE room_id = ? AND user_id = ?`,
          args: [roomId, roomId, senderId],
        },
        { sql: `${MSG_SELECT} WHERE m.id = ?`, args: [id] },
      ],
      "write",
    );
    const rs = results[3];
    return { message: toObject<Message>(rs.rows[0], rs.columns), duplicate: false };
  } catch (err) {
    const raced = await findByClientId(senderId, clientMsgId);
    if (raced) return { message: raced, duplicate: true };
    throw err;
  }
}

/** Pagination: `before` for scrolling up, `after` for reconnect catch-up. */
export async function getMessages(
  roomId: string,
  opts: { before?: number; after?: number; limit: number },
) {
  if (opts.after !== undefined) {
    return all<Message>(
      `${MSG_SELECT} WHERE m.room_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`,
      [roomId, opts.after, opts.limit],
    );
  }
  const rows = await all<Message>(
    `${MSG_SELECT} WHERE m.room_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`,
    [roomId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit],
  );
  return rows.reverse(); // oldest → newest for rendering
}

export const markRead = (roomId: string, userId: string, seq: number) =>
  run(
    "UPDATE room_members SET last_read_seq = MAX(last_read_seq, ?) WHERE room_id = ? AND user_id = ?",
    [seq, roomId, userId],
  );
