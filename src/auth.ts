import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { createUser, findUserById, findUserByName } from "./db";

export const jwtPlugin = jwt({
  name: "jwt",
  secret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  exp: "7d",
});

/**
 * Resolves `userId` from `Authorization: Bearer <token>`.
 * Returning status(401) short-circuits the request, so handlers get `userId: string`.
 */
export const authGuard = new Elysia({ name: "auth-guard" })
  .use(jwtPlugin)
  .resolve({ as: "scoped" }, async ({ headers, jwt, status }) => {
    const token = headers.authorization?.replace(/^Bearer\s+/i, "");
    const payload = token ? await jwt.verify(token) : false;
    if (!payload || !payload.sub) return status(401, { error: "unauthorized" });
    return { userId: String(payload.sub) };
  });

const credentials = t.Object({
  username: t.String({
    minLength: 3,
    maxLength: 32,
    pattern: "^[a-zA-Z0-9_]+$",
  }),
  password: t.String({ minLength: 6, maxLength: 128 }),
});

export const authRoutes = new Elysia({ prefix: "/auth" })
  .use(jwtPlugin)
  .post(
    "/register",
    async ({ body, jwt, status }) => {
      if (await findUserByName(body.username)) {
        return status(409, { error: "username taken" });
      }
      const user = await createUser(
        body.username,
        await Bun.password.hash(body.password),
      );
      return { token: await jwt.sign({ sub: user.id }), user };
    },
    { body: credentials },
  )
  .post(
    "/login",
    async ({ body, jwt, status }) => {
      const user = await findUserByName(body.username);
      if (
        !user ||
        !(await Bun.password.verify(body.password, user.password_hash))
      ) {
        return status(401, { error: "invalid credentials" });
      }
      return {
        token: await jwt.sign({ sub: user.id }),
        user: { id: user.id, username: user.username },
      };
    },
    { body: credentials },
  )
  .use(authGuard)
  .get("/me", async ({ userId, status }) => {
    const user = await findUserById(userId);
    return user ?? status(404, { error: "user not found" });
  });
