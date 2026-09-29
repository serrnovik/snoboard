import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { BoardQuery } from "@/features/board/model";

const ALL = "__all__";

export function Filters({
  query,
  projects,
  labels,
  priorities,
  onChange,
}: {
  query: BoardQuery;
  projects: readonly string[];
  labels: readonly string[];
  priorities: readonly string[];
  onChange: (next: BoardQuery) => void;
}) {
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
        onChange={(project) => onChange({ ...query, project })}
      />
      <FilterSelect
        label="Label"
        allLabel="All labels"
        value={query.label}
        options={labels}
        onChange={(label) => onChange({ ...query, label })}
      />
      <FilterSelect
        label="Priority"
        allLabel="All priorities"
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
    </form>
  );
}

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string | null;
  options: readonly string[];
  onChange: (value: string | null) => void;
}) {
  const selected = value ?? ALL;
  const choices = options.includes(selected) || selected === ALL ? options : [...options, selected];
  const items: Record<string, string> = { [ALL]: allLabel };
  for (const option of choices) items[option] = option;
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
        <SelectTrigger aria-label={label} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {choices.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
