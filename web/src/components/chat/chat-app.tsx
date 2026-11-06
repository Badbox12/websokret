"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/hooks/use-session";
import { useChat } from "@/hooks/use-chat";
import type { Session } from "@/lib/session";
import { Sidebar } from "./sidebar";
import { ChatPanel } from "./chat-panel";

/** Auth gate: waits for the client session, redirects to /login when logged out. */
export function ChatApp() {
  const router = useRouter();
  const session = useSession();

  useEffect(() => {
    if (session === null) router.replace("/login");
  }, [session, router]);

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
        Loading…
      </div>
    );
  }
  // key: remount (fresh socket + state) if a different user logs in
  return <Chat key={session.user.id} session={session} />;
}

function Chat({ session }: { session: Session }) {
  const chat = useChat(session);

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <Sidebar chat={chat} />
      <ChatPanel chat={chat} />
      {chat.state.lastError && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-red-600 px-4 py-2 text-sm text-white shadow-lg"
        >
          {chat.state.lastError}
          <button onClick={chat.clearError} className="font-semibold" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
