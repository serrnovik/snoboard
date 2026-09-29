import type { LegacyItem } from "snoboard/browser";

export function LegacyList({ items }: { items: readonly LegacyItem[] }) {
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">Legacy ({items.length})</summary>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No legacy initiatives.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.path} className="text-sm">
              <span className="font-medium">{item.title}</span>
              <span className="block text-muted-foreground">{item.path}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
