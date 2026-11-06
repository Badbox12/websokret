# websokret-api

Real-time chat API: **Bun + Elysia**, **WebSocket**, **MongoDB**, JWT auth.

## Run locally

```bash
bun install
cp .env.example .env    # then fill in MONGODB_URI and JWT_SECRET
bun run dev             # http://localhost:3000, restarts on file changes
```

| Script | What it does |
|---|---|
| `bun run dev` | Dev server with watch mode |
| `bun run start` | Production server (`NODE_ENV=production`) |
| `bun run typecheck` | TypeScript check |

## Environment variables

| Name | Required | Example | Notes |
|---|---|---|---|
| `MONGODB_URI` | yes | `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net` | Atlas → Database Access user (not your Atlas login) |
| `MONGODB_DB` | no | `chat` | Defaults to the db in the URI path, else `chat` |
| `JWT_SECRET` | yes in prod | `openssl rand -hex 32` | Server refuses to start in production if missing or < 32 chars |
| `CORS_ORIGIN` | yes in prod | `https://your-frontend.app` | Comma-separated list of allowed frontend origins |
| `PORT` | no | `3000` | Render sets this automatically |
| `NODE_ENV` | no | `production` | In development, any localhost/LAN origin is also allowed by CORS |

## API

All routes except `/health`, `/auth/register` and `/auth/login` need `Authorization: Bearer <token>`.

| Method | Path | Body / Query |
|---|---|---|
| GET | `/health` | – |
| POST | `/auth/register` | `{ username, password }` → `{ token, user }` |
| POST | `/auth/login` | `{ username, password }` → `{ token, user }` |
| GET | `/auth/me` | – |
| GET | `/rooms` | – (your rooms with unread counts) |
| POST | `/rooms` | `{ type: "dm" \| "group", name?, members: ["username"] }` |
| POST | `/rooms/:id/members` | `{ username }` |
| GET | `/rooms/:id/messages` | `?before=<seq>` or `?after=<seq>`, `&limit=50` |

### WebSocket — `wss://<host>/ws?token=<JWT>`

Wait for `{"type":"ready"}` before sending. Full types: [`src/protocol.ts`](src/protocol.ts).

Client → server:

```json
{ "type": "message.send", "roomId": "...", "clientMsgId": "uuid", "body": "hi" }
{ "type": "typing", "roomId": "...", "isTyping": true }
{ "type": "read", "roomId": "...", "seq": 12 }
{ "type": "ping" }
```

Server → client: `ready`, `message.ack`, `message.new`, `typing`, `read`, `presence`, `room.joined`, `pong`, `error`.

## Deploy to Render

1. MongoDB Atlas → **Network Access** → allow `0.0.0.0/0` (Render has no fixed IPs on the free plan).
2. Render → **New → Blueprint** → pick this repo (uses [`render.yaml`](render.yaml) + [`Dockerfile`](Dockerfile)).
3. Fill in `MONGODB_URI` and `CORS_ORIGIN` when asked. `JWT_SECRET` is generated for you.
4. Check `https://<your-service>.onrender.com/health` → `{"ok":true}`.

Every push to `main` redeploys. Free services sleep after 15 min idle; the first request then takes ~1 min.
