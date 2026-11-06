"use client";

import { useState } from "react";
import { logout } from "@/hooks/use-session";
import { roomLabel, type Chat } from "@/hooks/use-chat";
import type { ConnectionStatus } from "@/lib/types";

const statusStyle: Record<ConnectionStatus, { dot: string; label: string }> = {
  online: { dot: "bg-green-500", label: "Online" },
  connecting: { dot: "bg-amber-400", label: "Connecting…" },
  reconnecting: { dot: "bg-amber-400 animate-pulse", label: "Reconnecting…" },
};

export function Sidebar({ chat }: { chat: Chat }) {
  const { me, state, openRoom } = chat;
  const status = statusStyle[state.status];

  return (
    <aside className="flex max-h-[45dvh] w-full shrink-0 flex-col border-b border-zinc-200 bg-white md:max-h-none md:w-72 md:border-r md:border-b-0 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-200 p-4 dark:border-zinc-800">
        <div className="min-w-0">
          <p className="truncate font-semibold">{me.username}</p>
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className={`size-2 rounded-full ${status.dot}`} />
            {status.label}
          </p>
        </div>
        <button onClick={logout} className="btn-ghost text-xs">
          Log out
        </button>
      </header>

      <nav className="flex-1 overflow-y-auto">
        {state.rooms.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">No chats yet. Start one below.</p>
        )}
        <ul>
          {state.rooms.map((room) => {
            const active = room.id === state.activeRoomId;
            return (
              <li key={room.id}>
                <button
                  onClick={() => void openRoom(room.id)}
                  className={`flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm transition-colors ${
                    active
                      ? "bg-blue-50 dark:bg-blue-950/50"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {room.type === "group" ? "# " : ""}
                      {roomLabel(room, me.username)}
                    </span>
                    <span className="block text-xs text-zinc-500">
                      {room.type === "dm" ? "Direct message" : `${room.members.split(", ").length} members`}
                    </span>
                  </span>
                  {room.unread > 0 && !active && (
                    <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white">
                      {room.unread}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <NewRoomForm chat={chat} />
    </aside>
  );
}

function NewRoomForm({ chat }: { chat: Chat }) {
  const [members, setMembers] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const list = members
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return;
    setBusy(true);
    setError(null);
    try {
      await chat.createRoom(list, name.trim() || undefined);
      setMembers("");
      setName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 border-t border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">New chat</p>
      <input
        className="input"
        placeholder="Usernames, comma separated"
        value={members}
        onChange={(e) => setMembers(e.target.value)}
        required
      />
      <input
        className="input"
        placeholder="Group name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={64}
      />
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={busy} className="btn-primary w-full">
        {busy ? "Creating…" : "Start chat"}
      </button>
    </form>
  );
}
