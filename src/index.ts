import os from "node:os";
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { authRoutes } from "./auth";
import { logger } from "./logger";
import { roomRoutes } from "./rooms";
import { wsGateway } from "./ws";

const isProd = process.env.NODE_ENV === "production";
const allowedOrigins = new Set(
  (process.env.CORS_ORIGIN ?? "http://localhost:3001").split(",").map((s) => s.trim()),
);

// localhost, 127.x, 10.x, 172.16–31.x, 192.168.x — i.e. this PC or devices on your LAN
const LOCAL_HOST =
  /^(localhost|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/;

/** Explicit CORS_ORIGIN list always works; in development any local/LAN origin is allowed too. */
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  if (isProd) return false;
  try {
    return LOCAL_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const app = new Elysia()
  .use(logger) // register first so it times every route
  .use(
    cors({
      origin: isAllowedOrigin,
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  )
  .onError(({ code, error, status }) => {
    if (code === "VALIDATION") {
      return status(400, { error: "validation failed", details: error.message });
    }
  })
  .get("/health", () => ({ ok: true }))
  .use(authRoutes)
  .use(roomRoutes)
  .use(wsGateway)
  // 0.0.0.0 = listen on every network interface, not just localhost
  .listen({ port: Number(process.env.PORT ?? 3000), hostname: "0.0.0.0" });

/** Imported (type-only) by the Next.js app for end-to-end type safety via Eden. */
export type App = typeof app;

const port = app.server?.port;
const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === "IPv4" && !i.internal)
  .map((i) => `http://${i!.address}:${port}`);
console.log(`💬 Chat server running at http://localhost:${port}`);
if (lan.length) console.log(`   On your network:  ${lan.join(", ")}`);
