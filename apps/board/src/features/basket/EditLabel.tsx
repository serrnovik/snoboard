import type { Edit } from "snoboard/browser";
import { editTitle, formatPending } from "@/features/basket/store";

export function EditLabel({
  edit,
  titles,
  className,
}: {
  edit: Edit;
  titles?: ReadonlyMap<string, string>;
  className?: string;
}) {
  const title = editTitle(edit, titles);
  const lead = edit.kind === "createInitiative" ? `${edit.project}/${edit.slug}` : edit.id;
  const change = edit.kind === "createInitiative" ? "create" : formatPending(edit);
  return (
    <span data-testid="edit-label" className={`flex min-w-0 items-baseline gap-1 ${className ?? ""}`}>
      {[
        <span key="lead" className="shrink-0">{lead}</span>,
        <span key="dot" className="shrink-0" aria-hidden="true">{" · "}</span>,
        <span key="title" data-testid="edit-label-title" className="min-w-0 truncate" title={title}>{title}</span>,
        <span key="change" className="shrink-0">{` — ${change}`}</span>,
      ]}
    </span>
  );
}
