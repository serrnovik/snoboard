import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const PageActionsContext = createContext<HTMLElement | null>(null);

export function PageActionsProvider({
  element,
  children,
}: {
  element: HTMLElement | null;
  children: ReactNode;
}) {
  return <PageActionsContext.Provider value={element}>{children}</PageActionsContext.Provider>;
}

export function PageActionsPortal({ children }: { children: ReactNode }) {
  const element = useContext(PageActionsContext);
  if (element === null) return null;
  return createPortal(children, element);
}
