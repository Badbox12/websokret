// MongoDB data layer. Same exported functions as before, so routes/ws are unchanged.
//   MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net  (Atlas)
//   unset → mongodb://127.0.0.1:27017 (local)
//   MONGODB_DB=chat (database name, optional)
import { MongoClient, MongoServerError } from "mongodb";

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });

/** DB name: MONGODB_DB, else the name in the URI path (…mongodb.net/realtimechat), else "chat". */
function dbName() {
  if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
  try {
    const fromPath = decodeURIComponent(new URL(uri).pathname.slice(1));
    if (fromPath) return fromPath;
  } catch {
    /* unparsable URI: the driver will report it on connect */
  }
  return "chat";
}
const mdb = client.db(dbName());

// ---------- Documents (string UUID _ids keep API ids as plain strings) ----------
type UserDoc = { _id: string; username: string; passwordHash: string; createdAt: Date };
type RoomDoc = {
  _id: string;
  type: "dm" | "group";
  name: string | null;
  createdBy: string;
  /** Per-room message counter → strict ordering via atomic $inc */
  lastSeq: number;
  createdAt: Date;
};
type MemberDoc = {
  roomId: string;
  userId: string;
  role: "owner" | "member";
  lastReadSeq: number;
  joinedAt: Date;
};
type MessageDoc = {
  _id: string;
  roomId: string;
  senderId: string;
  /** Denormalized (usernames never change) so reads need no join */
  senderName: string;
  seq: number;
  clientMsgId: string;
  body: string;
  createdAt: Date;
};

const users = mdb.collection<UserDoc>("users");
const rooms = mdb.collection<RoomDoc>("rooms");
const members = mdb.collection<MemberDoc>("room_members");
const messages = mdb.collection<MessageDoc>("messages");

/** Connects and creates indexes (idempotent). Call once at startup. */
export async function migrate() {
  try {
    await client.connect();
    await mdb.command({ ping: 1 });
  } catch (err) {
    const e = err as { codeName?: string; code?: number; message?: string; name?: string };
    const host = uri.replace(/\/\/[^@]*@/, "//<credentials>@"); // never log the password
    console.error(`\n❌ Could not connect to MongoDB at ${host}\n   ${e.message}`);
    if (e.code === 8000 || /auth/i.test(e.message ?? "")) {
      console.error(
        "   → Wrong username/password. Use a *database user* from Atlas → Database Access\n" +
          "     (not your Atlas website login), and URL-encode special characters in the password.",
      );
    } else if (e.name === "MongoServerSelectionError") {
      console.error(
        "   → Server unreachable. Check Atlas → Network Access allows your IP (or 0.0.0.0/0),\n" +
          "     or start a local MongoDB if MONGODB_URI is unset.",
      );
    }
    process.exit(1);
  }
  console.log(`🍃 MongoDB connected (database "${mdb.databaseName}")`);
  await Promise.all([
    users.createIndexes([{ key: { username: 1 }, unique: true }]),
    members.createIndexes([
      { key: { roomId: 1, userId: 1 }, unique: true },
      { key: { userId: 1 } },
    ]),
    messages.createIndexes([
      { key: { roomId: 1, seq: -1 }, unique: true },
      // Idempotency key: a retried send can never be stored twice
      { key: { senderId: 1, clientMsgId: 1 }, unique: true },
    ]),
  ]);
}

const isDuplicateKey = (err: unknown) => err instanceof MongoServerError && err.code === 11000;

// ---------- API-facing types (unchanged) ----------
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

const toMessage = (d: MessageDoc): Message => ({
  id: d._id,
  roomId: d.roomId,
  senderId: d.senderId,
  senderName: d.senderName,
  seq: d.seq,
  clientMsgId: d.clientMsgId,
  body: d.body,
  createdAt: d.createdAt.toISOString(),
});

// ---------- Users ----------
export async function createUser(username: string, passwordHash: string) {
  const id = crypto.randomUUID();
  await users.insertOne({ _id: id, username, passwordHash, createdAt: new Date() });
  return { id, username };
}

export async function findUserByName(username: string): Promise<User | null> {
  const u = await users.findOne({ username });
  return u
    ? { id: u._id, username: u.username, password_hash: u.passwordHash, created_at: u.createdAt.toISOString() }
    : null;
}

export async function findUserById(id: string) {
  const u = await users.findOne({ _id: id }, { projection: { username: 1 } });
  return u ? { id: u._id, username: u.username } : null;
}

// usernames are immutable → safe to cache for denormalizing senderName
const nameCache = new Map<string, string>();
async function usernameOf(userId: string) {
  let name = nameCache.get(userId);
  if (!name) {
    name = (await findUserById(userId))?.username ?? "unknown";
    nameCache.set(userId, name);
  }
  return name;
}

// ---------- Rooms ----------
export async function createRoom(
  type: "dm" | "group",
  name: string | null,
  createdBy: string,
  memberIds: string[],
) {
  const id = crypto.randomUUID();
  const now = new Date();
  await rooms.insertOne({ _id: id, type, name, createdBy, lastSeq: 0, createdAt: now });
  await members.insertMany(
    [...new Set([createdBy, ...memberIds])].map((userId) => ({
      roomId: id,
      userId,
      role: userId === createdBy ? ("owner" as const) : ("member" as const),
      lastReadSeq: 0,
      joinedAt: now,
    })),
  );
  return id;
}

/** "Insert or ignore": upsert that only writes fields when the membership is new. */
export async function addMember(roomId: string, userId: string) {
  await members.updateOne(
    { roomId, userId },
    { $setOnInsert: { role: "member", lastReadSeq: 0, joinedAt: new Date() } },
    { upsert: true },
  );
}

export async function isMember(roomId: string, userId: string) {
  return !!(await members.findOne({ roomId, userId }, { projection: { _id: 1 } }));
}

export async function getUserRoomIds(userId: string) {
  const rows = await members.find({ userId }, { projection: { roomId: 1 } }).toArray();
  return rows.map((r) => r.roomId);
}

export async function getRoomMemberIds(roomId: string) {
  const rows = await members.find({ roomId }, { projection: { userId: 1 } }).toArray();
  return rows.map((r) => r.userId);
}

/** One aggregation round trip: my memberships → room → all members → usernames. */
export async function listRoomsForUser(userId: string): Promise<RoomSummary[]> {
  const rows = await members
    .aggregate<RoomSummary & { usernames: string[] }>([
      { $match: { userId } },
      { $lookup: { from: "rooms", localField: "roomId", foreignField: "_id", as: "room" } },
      { $unwind: "$room" },
      { $lookup: { from: "room_members", localField: "roomId", foreignField: "roomId", as: "all" } },
      { $lookup: { from: "users", localField: "all.userId", foreignField: "_id", as: "people" } },
      {
        $project: {
          _id: 0,
          id: "$room._id",
          type: "$room.type",
          name: "$room.name",
          lastSeq: "$room.lastSeq",
          unread: { $max: [0, { $subtract: ["$room.lastSeq", "$lastReadSeq"] }] },
          usernames: "$people.username",
          createdAt: "$room.createdAt",
        },
      },
      { $sort: { lastSeq: -1, createdAt: -1 } },
    ])
    .toArray();

  return rows.map(({ usernames, ...r }) => ({
    id: r.id,
    type: r.type,
    name: r.name ?? null,
    lastSeq: r.lastSeq,
    unread: r.unread,
    members: usernames.join(", "),
  }));
}

// ---------- Messages ----------
/**
 * Idempotent + ordered insert:
 *  1. already saved (client retry)? → return it
 *  2. atomically $inc rooms.lastSeq → this message's seq (no two messages share one)
 *  3. insert; the unique (senderId, clientMsgId) index catches a racing retry
 *  4. mark it read for the sender
 */
export async function saveMessage(
  roomId: string,
  senderId: string,
  clientMsgId: string,
  body: string,
): Promise<{ message: Message; duplicate: boolean }> {
  const existing = await messages.findOne({ senderId, clientMsgId });
  if (existing) return { message: toMessage(existing), duplicate: true };

  const room = await rooms.findOneAndUpdate(
    { _id: roomId },
    { $inc: { lastSeq: 1 } },
    { returnDocument: "after", projection: { lastSeq: 1 } },
  );
  if (!room) throw new Error(`room not found: ${roomId}`);

  const doc: MessageDoc = {
    _id: crypto.randomUUID(),
    roomId,
    senderId,
    senderName: await usernameOf(senderId),
    seq: room.lastSeq,
    clientMsgId,
    body,
    createdAt: new Date(),
  };

  try {
    await messages.insertOne(doc);
  } catch (err) {
    if (isDuplicateKey(err)) {
      const raced = await messages.findOne({ senderId, clientMsgId });
      if (raced) return { message: toMessage(raced), duplicate: true };
    }
    throw err;
  }

  await members.updateOne({ roomId, userId: senderId }, { $max: { lastReadSeq: doc.seq } });
  return { message: toMessage(doc), duplicate: false };
}

/** Pagination: `before` for scrolling up, `after` for reconnect catch-up. */
export async function getMessages(
  roomId: string,
  opts: { before?: number; after?: number; limit: number },
) {
  if (opts.after !== undefined) {
    const docs = await messages
      .find({ roomId, seq: { $gt: opts.after } })
      .sort({ seq: 1 })
      .limit(opts.limit)
      .toArray();
    return docs.map(toMessage);
  }
  const docs = await messages
    .find({ roomId, ...(opts.before !== undefined && { seq: { $lt: opts.before } }) })
    .sort({ seq: -1 })
    .limit(opts.limit)
    .toArray();
  return docs.reverse().map(toMessage); // oldest → newest for rendering
}

export async function markRead(roomId: string, userId: string, seq: number) {
  await members.updateOne({ roomId, userId }, { $max: { lastReadSeq: seq } });
}
