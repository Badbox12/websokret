import { Elysia } from "elysia";

// Logs every HTTP request as:  GET /rooms 200 3.42ms
const startTimes = new WeakMap<Request, number>();

const color = (status: number) =>
  status >= 500 ? "\x1b[31m" : status >= 400 ? "\x1b[33m" : status >= 300 ? "\x1b[36m" : "\x1b[32m";
const reset = "\x1b[0m";
const dim = "\x1b[2m";

export const logger = new Elysia({ name: "logger" })
  .onRequest(({ request }) => {
    startTimes.set(request, performance.now());
  })
  .onAfterResponse({ as: "global" }, ({ request, set }) => {
    const start = startTimes.get(request);
    if (start === undefined) return;
    const { pathname, search } = new URL(request.url);
    const path = pathname + search;
    const ms = (performance.now() - start).toFixed(2);
    const status = typeof set.status === "number" ? set.status : 200;
    const time = new Date().toLocaleTimeString();
    console.log(
      `${dim}${time}${reset} ${request.method.padEnd(6)} ${path} ${color(status)}${status}${reset} ${ms}ms`,
    );
  });
