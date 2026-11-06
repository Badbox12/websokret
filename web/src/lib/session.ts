import type { User } from "./types";

// Tiny localStorage-backed session store usable outside React (e.g. by the API client).
const KEY = "chat.session";

export type Session = { token: string; user: User };

let current: Session | null | undefined; // undefined = not read yet
const listeners = new Set<() => void>();

function read(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export const session = {
  get(): Session | null {
    if (current === undefined) current = read();
    return current;
  },
  /** Server snapshot for useSyncExternalStore: always logged-out during SSR. */
  getServer(): Session | null {
    return null;
  },
  set(next: Session | null) {
    current = next;
    try {
      if (next) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable — keep in memory only */
    }
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
