import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = { title: "Log in · Chat" };

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <LoginForm />
      
    </main>
  );
}
