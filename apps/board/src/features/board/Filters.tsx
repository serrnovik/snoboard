import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { ReactNode } from "react";
import { priorityLabel, type BoardQuery } from "@/features/board/model";
import { ProjectIcon, useDisplay } from "@/features/icons/display";

const ALL = "__all__";

export function Filters({
  query,
  projects,
  openCounts,
  labels,
  priorities,
  staleCount = 0,
  staleAfterDays,
  onChange,
}: {
  query: BoardQuery;
  projects: readonly string[];
  /** Open initiatives per project (not done, parked or dropped). */
  openCounts?: ReadonlyMap<string, number>;
  labels: readonly string[];
  priorities: readonly string[];
  staleCount?: number;
  staleAfterDays?: number;
  onChange: (next: BoardQuery) => void;
}) {
  const display = useDisplay();
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      role="search"
      onSubmit={(event) => event.preventDefault()}
    >
      <FilterSelect
        label="Project"
        allLabel="All projects"
        value={query.project}
        options={projects}
        render={(project) => (
          <ProjectOption project={project} name={display.projects[project]?.name} count={openCounts?.get(project)} />
        )}
        onChange={(project) => onChange({ ...query, project })}
      />
      <FilterSelect
        label="Label"
        allLabel="All labels"
        value={query.label}
        options={labels}
        render={(label) => <LabelOption label={label} icon={display.labels[label]?.icon} />}
        onChange={(label) => onChange({ ...query, label })}
      />
      <FilterSelect
        label="Priority"
        allLabel="All priorities"
        format={priorityLabel}
        value={query.priority}
        options={priorities}
        onChange={(priority) => onChange({ ...query, priority })}
      />
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Search
        <Input
          type="search"
          value={query.search}
          placeholder="Search id or title"
          aria-label="Search id or title"
          onChange={(event) => onChange({ ...query, search: event.target.value })}
        />
      </label>
      <label className="flex h-8 items-center gap-2 text-sm">
        Show legacy
        <Switch
          checked={query.showLegacy}
          onCheckedChange={(checked) => onChange({ ...query, showLegacy: checked })}
        />
      </label>
      <label
        className="flex h-8 items-center gap-2 text-sm"
        title={staleAfterDays === undefined ? undefined : `Open and untouched for more than ${staleAfterDays} days`}
      >
        Hide stale{staleCount > 0 ? <span className="text-xs text-muted-foreground">({staleCount})</span> : null}
        <Switch
          checked={query.hideStale}
          aria-label="Hide stale initiatives"
          onCheckedChange={(checked) => onChange({ ...query, hideStale: checked })}
        />
      </label>
    </form>
  );
}

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  format = (option: string) => option,
  render,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string | null;
  options: readonly string[];
  format?: (option: string) => string;
  /** Rich option content (icon, count); the trigger shows it too. */
  render?: (option: string) => ReactNode;
  onChange: (value: string | null) => void;
}) {
  const selected = value ?? ALL;
  const choices = options.includes(selected) || selected === ALL ? options : [...options, selected];
  const items: Record<string, ReactNode> = { [ALL]: allLabel };
  for (const option of choices) items[option] = render === undefined ? format(option) : render(option);
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Select
        items={items}
        value={selected}
        onValueChange={(next) => {
          onChange(next == null || next === ALL ? null : next);
        }}
      >
        <SelectTrigger aria-label={label} className={render === undefined ? "w-40" : "w-48"}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {choices.map((option) => (
            <SelectItem key={option} value={option}>
              {render === undefined ? format(option) : render(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** "🧩 name  4": icon, display name (folder name in the title) and the open count. */
export function ProjectOption({ project, name, count }: { project: string; name?: string; count?: number }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5" title={name === undefined ? undefined : project}>
      <ProjectIcon project={project} />
      <span className="min-w-0 truncate">{name ?? project}</span>
      {count !== undefined ? (
        <span
          data-testid={`open-count-${project}`}
          className={count === 0 ? "ml-auto pl-2 text-xs text-muted-foreground/60" : "ml-auto pl-2 text-xs text-muted-foreground"}
        >
          <span aria-hidden="true">{count}</span>
          <span className="sr-only">, {count} open</span>
        </span>
      ) : null}
    </span>
  );
}

function LabelOption({ label, icon }: { label: string; icon?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {icon !== undefined ? <span aria-hidden="true">{icon}</span> : null}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
