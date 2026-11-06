"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { login, register, useSession } from "@/hooks/use-session";

type Mode = "login" | "register";

export function LoginForm() {
  const router = useRouter();
  const current = useSession();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already logged in → go to chat
  useEffect(() => {
    if (current) router.replace("/");
  }, [current, router]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await (mode === "login" ? login : register)(username.trim(), password);
      router.replace("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div>
        <h1 className="text-xl font-semibold">
          {mode === "login" ? "Welcome back" : "Create an account"}
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          {mode === "login" ? "Log in to continue chatting." : "Pick a username and password."}
        </p>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Username</span>
        <input
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          minLength={3}
          maxLength={32}
          pattern="[a-zA-Z0-9_]+"
          title="3–32 letters, numbers or _"
          required
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Password</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={6}
          required
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy} className="btn-primary w-full">
        {busy ? "Please wait…" : mode === "login" ? "Log in" : "Register"}
      </button>

      <p className="text-center text-sm text-zinc-500">
        {mode === "login" ? "No account?" : "Already have one?"}{" "}
        <button
          type="button"
          className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "Register" : "Log in"}
        </button>
      </p>
      <p className="mt-4 text-center text-sm justify-center text-zinc-500 dark:text-zinc-400"
      >Developing by sokret</p>
    </form>
  );
}
