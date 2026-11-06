"use client";

import { useSyncExternalStore } from "react";
import { api, unwrap } from "@/lib/api";
import { session, type Session } from "@/lib/session";

const noop = () => () => {};

/** `null` = logged out. `undefined` = not known yet (server render / hydration). */
export function useSession(): Session | null | undefined {
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const value = useSyncExternalStore(session.subscribe, session.get, session.getServer);
  return hydrated ? value : undefined;
}

export async function login(username: string, password: string) {
  const data = await unwrap(api.auth.login.post({ username, password }));
  session.set(data);
  return data;
}

export async function register(username: string, password: string) {
  const data = await unwrap(api.auth.register.post({ username, password }));
  session.set(data);
  return data;
}

export function logout() {
  session.set(null);
}
