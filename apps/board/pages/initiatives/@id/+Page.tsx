import { usePageContext } from "vike-react/usePageContext";
import { InitiativePage } from "@/features/details/DetailsSheet";

export function Page() {
  const id = usePageContext().routeParams?.id;
  if (typeof id !== "string" || id.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Missing initiative.</p>;
  }
  return <InitiativePage id={id} />;
}
