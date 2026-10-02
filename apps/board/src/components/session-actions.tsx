import { cn } from "cn";
import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { useData } from "vike-react/useData";
import { usePageContext } from "vike-react/usePageContext";
import { Button, buttonVariants } from "@/components/ui/button";

type AuthView = {
  cloudflareAccess?: boolean;
};

export function SessionActions() {
  const pathname = usePageContext().urlPathname;
  const data = useData<AuthView>();
  const cloudflareAccess = data?.cloudflareAccess === true;
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!cloudflareAccess) return;
    const controller = new AbortController();
    void loadSessionEmail(controller.signal, setEmail);
    return () => controller.abort();
  }, [cloudflareAccess]);

  if (pathname === "/login" || pathname === "/login/") return null;
  if (cloudflareAccess) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        {email !== null ? <span className="max-w-48 truncate text-sm text-muted-foreground">{email}</span> : null}
        <a
          aria-label="Sign out"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "max-sm:size-8 max-sm:px-0")}
          href="/cdn-cgi/access/logout"
        >
          <LogOut aria-hidden="true" className="sm:hidden" />
          <span className="hidden sm:inline">Sign out</span>
        </a>
      </div>
    );
  }
  return (
    <form method="post" action="/auth/logout">
      <Button type="submit" variant="ghost" size="sm" aria-label="Log out" className="max-sm:size-8 max-sm:px-0">
        <LogOut aria-hidden="true" className="sm:hidden" />
        <span className="hidden sm:inline">Log out</span>
      </Button>
    </form>
  );
}

async function loadSessionEmail(signal: AbortSignal, setEmail: (email: string) => void): Promise<void> {
  try {
    const response = await fetch("/api/session", {
      signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return;
    const email = readSessionEmail(await response.json());
    if (email === null) return;
    setEmail(email);
  } catch {
    return;
  }
}

function readSessionEmail(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("email" in body)) return null;
  const email = body.email;
  if (typeof email !== "string" || email.length === 0 || email.length > 254) return null;
  return email;
}
