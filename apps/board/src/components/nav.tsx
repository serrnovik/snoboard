import { usePageContext } from "vike-react/usePageContext";
import { boardPath, graphPath, repoIdFromPath } from "@/lib/routes";

export function BoardNav() {
  const pageContext = usePageContext();
  const pathname = pageContext.urlPathname;
  if (pathname === "/login" || pathname === "/login/") return null;
  // Off a /r/<repo>/ route (legacy redirect still choosing a repo) keep the legacy
  // links; they redirect too, instead of guessing a repo id that may not exist.
  const routeRepo = repoIdFromPath(pathname);
  const repoId = routeRepo ?? "";
  const links = [
    { href: routeRepo === null ? "/" : boardPath(routeRepo), label: "Board", current: isBoardPath(pathname, repoId) },
    { href: routeRepo === null ? "/graph" : graphPath(routeRepo), label: "Dependencies", current: isGraphPath(pathname, repoId) },
  ];

  return (
    <nav aria-label="Snoboard" className="flex shrink-0 items-center gap-1">
      {links.map((link) => {
        const className = link.current
          ? "shrink-0 whitespace-nowrap rounded-md bg-muted px-2.5 py-1 text-sm font-medium text-foreground"
          : "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground";
        return (
          <a key={link.label} href={link.href} aria-current={link.current ? "page" : undefined} className={className}>
            {link.label}
          </a>
        );
      })}
    </nav>
  );
}

function isBoardPath(pathname: string, repoId: string): boolean {
  return pathname === "/" || pathname === `/r/${repoId}` || pathname === `/r/${repoId}/`;
}

function isGraphPath(pathname: string, repoId: string): boolean {
  return pathname === "/graph" || pathname === "/graph/" || pathname === `/r/${repoId}/graph` || pathname === `/r/${repoId}/graph/`;
}
