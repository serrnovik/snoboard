import { lazy, Suspense } from "react";
import { ClientOnly } from "vike-react/ClientOnly";
import { DetailsDrawer } from "@/features/details/DetailsSheet";

const GraphView = lazy(() => import("../../src/features/graph/GraphView"));

function GraphFallback() {
  return <p className="p-6 text-sm text-muted-foreground">Loading graph…</p>;
}

function GraphClient() {
  return (
    <Suspense fallback={<GraphFallback />}>
      <GraphView />
    </Suspense>
  );
}

export function Page() {
  return (
    <>
      <div className="h-[calc(100svh-6rem)] min-h-80 sm:h-[calc(100svh-3rem)]">
        <ClientOnly fallback={<GraphFallback />}>
          <GraphClient />
        </ClientOnly>
      </div>
      <DetailsDrawer />
    </>
  );
}
