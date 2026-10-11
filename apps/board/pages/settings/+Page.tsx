import { AgentAccess } from "@/features/agent/AgentAccess";

export function Page() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <AgentAccess />
    </main>
  );
}
