"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { roomLabel, type Chat } from "@/hooks/use-chat";
import type { ChatMessage } from "@/lib/types";

export function ChatPanel({ chat }: { chat: Chat }) {
  const { activeRoom, me } = chat;

  if (!activeRoom) {
    return (
      <main className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-500">
        Select a chat or start a new one.
      </main>
    );
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{roomLabel(activeRoom, me.username)}</h2>
          <p className="truncate text-xs text-zinc-500">{activeRoom.members}</p>
        </div>
        {activeRoom.type === "group" && <AddMember chat={chat} />}
      </header>
      <MessageList key={activeRoom.id} chat={chat} />
      <TypingIndicator names={chat.typingNames} />
      <Composer key={`c-${activeRoom.id}`} chat={chat} />
    </main>
  );
}

function MessageList({ chat }: { chat: Chat }) {
  const { activeMessages: messages, me, state, hasMore, loadOlder } = chat;
  const ref = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Keep scrolled to bottom on new messages, or preserve position after loading older ones
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (stickToBottom.current || messages.at(-1)?.senderId === me.id) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, me.id]);

  async function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (el.scrollTop === 0 && hasMore && !loadingOlder && messages.length) {
      setLoadingOlder(true);
      prevHeight.current = el.scrollHeight;
      try {
        await loadOlder();
      } finally {
        setLoadingOlder(false);
      }
    }
  }

  return (
    <div ref={ref} onScroll={onScroll} className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
      {loadingOlder && <p className="text-center text-xs text-zinc-500">Loading older…</p>}
      {!hasMore && messages.length > 0 && (
        <p className="pb-2 text-center text-xs text-zinc-400">Beginning of conversation</p>
      )}
      {messages.length === 0 && (
        <p className="m-auto text-sm text-zinc-500">No messages yet. Say hi 👋</p>
      )}
      {messages.map((m, i) => (
        <Bubble
          key={`${m.senderId}:${m.clientMsgId}`}
          message={m}
          mine={m.senderId === me.id}
          online={!!state.online[m.senderId]}
          showName={messages[i - 1]?.senderId !== m.senderId}
        />
      ))}
    </div>
  );
}

function Bubble({
  message: m,
  mine,
  online,
  showName,
}: {
  message: ChatMessage;
  mine: boolean;
  online: boolean;
  showName: boolean;
}) {
  const time = m.pending
    ? "Sending…"
    : new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"} ${showName ? "mt-2" : ""}`}>
      {showName && !mine && (
        <span className="mb-0.5 flex items-center gap-1.5 px-1 text-xs text-zinc-500">
          <span className={`size-1.5 rounded-full ${online ? "bg-green-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
          {m.senderName}
        </span>
      )}
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap ${
          mine
            ? "rounded-br-sm bg-blue-600 text-white"
            : "rounded-bl-sm border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        } ${m.pending ? "opacity-60" : ""}`}
      >
        {m.body}
      </div>
      <span className="px-1 pt-0.5 text-[11px] text-zinc-400">{time}</span>
    </div>
  );
}

function TypingIndicator({ names }: { names: string[] }) {
  const text =
    names.length === 0
      ? ""
      : names.length === 1
        ? `${names[0]} is typing…`
        : `${names.join(", ")} are typing…`;
  return (
    <div className="h-5 px-4 text-xs text-zinc-500" aria-live="polite">
      {text}
    </div>
  );
}

function Composer({ chat }: { chat: Chat }) {
  const [text, setText] = useState("");
  const lastTypingSent = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { setTyping } = chat;

  useEffect(() => () => clearTimeout(stopTimer.current), []);

  function onChange(value: string) {
    setText(value);
    // Throttle "typing" to once every 3s; send "stopped" after 3s idle
    const now = Date.now();
    if (now - lastTypingSent.current > 3000) {
      setTyping(true);
      lastTypingSent.current = now;
    }
    clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => {
      setTyping(false);
      lastTypingSent.current = 0;
    }, 3000);
  }

  function submit() {
    if (!text.trim()) return;
    chat.sendMessage(text);
    setText("");
    clearTimeout(stopTimer.current);
    setTyping(false);
    lastTypingSent.current = 0;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <textarea
        className="input max-h-40 min-h-10 resize-none"
        rows={1}
        placeholder="Type a message…  (Enter to send, Shift+Enter for new line)"
        value={text}
        maxLength={4000}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type="submit" className="btn-primary" disabled={!text.trim()}>
        Send
      </button>
    </form>
  );
}

function AddMember({ chat }: { chat: Chat }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn-ghost shrink-0 text-xs" onClick={() => setOpen(true)}>
        + Add member
      </button>
    );
  }

  return (
    <form
      className="flex shrink-0 items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await chat.addMember(username.trim());
          setUsername("");
          setOpen(false);
          setError(null);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      <input
        className="input w-36 py-1 text-xs"
        placeholder="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus
        required
      />
      <button type="submit" className="btn-primary py-1 text-xs">
        Add
      </button>
      <button type="button" className="btn-ghost py-1 text-xs" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
