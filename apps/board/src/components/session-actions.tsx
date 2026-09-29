import { LogOut } from "lucide-react";
import { usePageContext } from "vike-react/usePageContext";
import { Button } from "@/components/ui/button";

export function SessionActions() {
  const pathname = usePageContext().urlPathname;
  if (pathname === "/login" || pathname === "/login/") return null;
  return (
    <form method="post" action="/auth/logout">
      <Button type="submit" variant="ghost" size="sm" aria-label="Log out" className="max-sm:size-8 max-sm:px-0">
        <LogOut aria-hidden="true" className="sm:hidden" />
        <span className="hidden sm:inline">Log out</span>
      </Button>
    </form>
  );
}
