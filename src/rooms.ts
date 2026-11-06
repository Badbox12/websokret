import { Elysia, t } from "elysia";
import { authGuard } from "./auth";
import {
  addMember,
  createRoom,
  findUserByName,
  getMessages,
  isMember,
  listRoomsForUser,
} from "./db";
import { joinRoom } from "./ws";

export const roomRoutes = new Elysia({ prefix: "/rooms" })
  .use(authGuard)
  .get("/", ({ userId }) => listRoomsForUser(userId))

  .post(
    "/",
    ({ userId, body, status }) => {
      const memberIds: string[] = [];
      for (const name of body.members) {
        const u = findUserByName(name);
        if (!u) return status(404, { error: `user not found: ${name}` });
        memberIds.push(u.id);
      }
      if (body.type === "dm" && memberIds.length !== 1) {
        return status(400, { error: "a dm needs exactly one other member" });
      }

      const roomId = createRoom(body.type, body.name ?? null, userId, memberIds);
      // Live-subscribe every connected member's sockets to the new room
      for (const uid of [userId, ...memberIds]) joinRoom(uid, roomId);
      return { id: roomId };
    },
    {
      body: t.Object({
        type: t.Union([t.Literal("dm"), t.Literal("group")]),
        name: t.Optional(t.String({ maxLength: 64 })),
        members: t.Array(t.String(), { maxItems: 100 }),
      }),
    },
  )

  .post(
    "/:id/members",
    ({ userId, params, body, status }) => {
      if (!isMember(params.id, userId)) return status(403, { error: "forbidden" });
      const u = findUserByName(body.username);
      if (!u) return status(404, { error: "user not found" });
      addMember(params.id, u.id);
      joinRoom(u.id, params.id);
      return { ok: true as const };
    },
    { body: t.Object({ username: t.String() }) },
  )

  .get(
    "/:id/messages",
    ({ userId, params, query, status }) => {
      if (!isMember(params.id, userId)) return status(403, { error: "forbidden" });
      return getMessages(params.id, {
        before: query.before,
        after: query.after,
        limit: Math.min(query.limit ?? 50, 100),
      });
    },
    {
      query: t.Object({
        before: t.Optional(t.Numeric()),
        after: t.Optional(t.Numeric()),
        limit: t.Optional(t.Numeric()),
      }),
    },
  );
