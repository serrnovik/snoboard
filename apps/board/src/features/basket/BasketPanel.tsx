import { Button } from "@/components/ui/button";
import { EditLabel } from "@/features/basket/EditLabel";
import { SubmitDialog } from "@/features/basket/SubmitDialog";
import { describeEdit, useBasket } from "@/features/basket/store";

export function BasketPanel({
  enabled,
  canSubmit = false,
  repoId,
  titles,
}: {
  enabled: boolean;
  canSubmit?: boolean;
  repoId?: string;
  titles?: ReadonlyMap<string, string>;
}) {
  const basket = useBasket(repoId);
  if (!enabled) return null;

  return (
    <section
      aria-label="Basket"
      data-testid="basket-panel"
      className="mx-4 flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2 text-card-foreground"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Basket</h2>
        <span data-testid="basket-count" className="text-xs text-muted-foreground">
          {basket.edits.length}
        </span>
      </header>
      {basket.edits.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pending edits.</p>
      ) : (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {basket.edits.map((edit, index) => {
            const label = describeEdit(edit, titles);
            return (
              <li key={`${label}:${index}`} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                <EditLabel edit={edit} titles={titles} className="min-w-0 flex-1" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  aria-label={`Remove ${label}`}
                  onClick={() => basket.remove(index)}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {basket.edits.length > 0 ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => basket.clear()}>
            Clear
          </Button>
        </div>
      ) : null}
      {canSubmit ? (
        <SubmitDialog repoId={repoId} titles={titles} />
      ) : (
        <p data-testid="submit-readonly" className="text-sm text-muted-foreground">
          This sign-in can view the board but not submit edits.
        </p>
      )}
    </section>
  );
}
