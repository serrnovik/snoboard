import { usePageContext } from "vike-react/usePageContext";

const NAV_LINKS = [
  { href: "/", label: "Board" },
  { href: "/graph", label: "Dependencies" },
] as const;

export function BoardNav() {
  const pageContext = usePageContext();
  const pathname = pageContext.urlPathname;
  if (pathname === "/login" || pathname === "/login/") return null;

  return (
    <nav aria-label="Snoboard" className="flex shrink-0 items-center gap-1">
      {NAV_LINKS.map((link) => {
        const current = pathname === link.href;
        const className = current
          ? "shrink-0 whitespace-nowrap rounded-md bg-muted px-2.5 py-1 text-sm font-medium text-foreground"
          : "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground";
        return (
          <a key={link.href} href={link.href} aria-current={current ? "page" : undefined} className={className}>
            {link.label}
          </a>
        );
      })}
    </nav>
  );
}
