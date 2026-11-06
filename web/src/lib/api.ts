import { treaty } from "@elysiajs/eden";
import { session } from "./session";
import type { App } from "./types";

/**
 * NEXT_PUBLIC_API_URL if set; otherwise the API on port 3000 of whatever host
 * served this page — so opening http://192.168.x.x:3001 on another PC talks to
 * http://192.168.x.x:3000 instead of that PC's own localhost.
 */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3000`
    : "http://localhost:3000");

/**
 * End-to-end typed client generated from the server's `App` type.
 *   api.auth.login.post({ username, password })
 *   api.rooms.get()
 *   api.rooms({ id }).messages.get({ query: { before: 10 } })
 * Paths, bodies, query params and responses are all checked by TypeScript.
 */
export const api = treaty<App>(API_URL, {
  headers() {
    const token = session.get()?.token;
    return token ? { authorization: `Bearer ${token}` } : undefined;
  },
});

/** Extracts a readable message from an Eden error (`{ status, value }`). */
export function errorMessage(error: { status: unknown; value: unknown } | null): string {
  if (!error) return "Unknown error";
  const v = error.value;
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    if ("error" in v && typeof v.error === "string") return v.error;
    if ("message" in v && typeof v.message === "string") return v.message;
  }
  return `Request failed (${String(error.status)})`;
}

/** Unwraps an Eden result: returns `data` or throws with the server's error message. */
export async function unwrap<T, E extends { status: unknown; value: unknown }>(
  promise: Promise<{ data: T; error: null } | { data: null; error: E }>,
): Promise<T> {
  const res = await promise;
  if (res.error) {
    if (res.error.status === 401) session.set(null); // token expired/invalid
    throw new Error(errorMessage(res.error));
  }
  return res.data as T;
}
