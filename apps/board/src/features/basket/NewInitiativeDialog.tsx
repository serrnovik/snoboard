import { X } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import { MAX_INITIATIVE_BODY_LENGTH } from "snoboard/browser";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBasket } from "@/features/basket/store";
import { useImageAttachments } from "@/features/attachments/images";
import { useRepoId } from "@/features/repo/context";
import { parseIcon, ProjectIcon, useDisplay, type BoardDisplay } from "@/features/icons/display";

// Same rules as the server's edit schema (packages/core/src/edit-schema.ts).
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SLUG_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NEW_PROJECT = "__new_project__";
const MAX_SUGGESTIONS = 8;

export type InitiativeChoice = {
  id: string;
  title: string;
  done?: boolean;
};

/** Body of the standard initiative template (packages/core/src/templates/initiative.md). */
export function templateBody(title: string): string {
  return [`# ${title}`, "", "## Summary", "", "## Goals", "", "## Phases"].join(String.fromCharCode(10));
}

/** Lowercase, a-z0-9 words joined by single hyphens. */
export function suggestSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** Option text for the native project picker: emoji icon, display name and open count. */
export function projectOptionText(project: string, display: BoardDisplay, count: number | undefined): string {
  const icon = parseIcon(display.projects[project]?.icon);
  const prefix = icon?.kind === "emoji" ? `${icon.value} ` : "";
  const name = display.projects[project]?.name ?? project;
  return `${prefix}${name}${count === undefined ? "" : ` (${count} open)`}`;
}

export function NewInitiativeDialog({
  projects,
  openCounts,
  initiatives,
  statuses,
  priorities,
  defaultProject,
}: {
  projects: readonly string[];
  /** Open initiatives per project. */
  openCounts?: ReadonlyMap<string, number>;
  initiatives: readonly InitiativeChoice[];
  statuses: readonly string[];
  priorities: readonly string[];
  /** Project the board is filtered on, if any. */
  defaultProject?: string | null;
}) {
  const repoId = useRepoId();
  const basket = useBasket(repoId);
  const display = useDisplay();
  const attachments = useImageAttachments({ repoId });
  const [open, setOpen] = useState(false);
  const formId = useId();
  const initialProject =
    defaultProject != null && projects.includes(defaultProject) ? defaultProject : (projects[0] ?? NEW_PROJECT);
  const [projectChoice, setProjectChoice] = useState(initialProject);
  const [newProject, setNewProject] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [text, setText] = useState("");
  const [textEdited, setTextEdited] = useState(false);
  const [status, setStatus] = useState(statuses[0] ?? "");
  const [priority, setPriority] = useState(priorities[0] ?? "");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setProjectChoice(initialProject);
    setNewProject("");
    setTitle("");
    setSlug("");
    setSlugEdited(false);
    setText("");
    setTextEdited(false);
    setStatus(statuses[0] ?? "");
    setPriority(priorities[0] ?? "");
    setDependsOn([]);
    setSearch("");
    setError(null);
  }

  const effectiveSlug = slugEdited ? slug : suggestSlug(title);
  const effectiveText = textEdited ? text : templateBody(title.trim());

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextProject = (projectChoice === NEW_PROJECT ? newProject : projectChoice).trim();
    const nextSlug = effectiveSlug.trim();
    const nextTitle = title.trim();
    if (!PROJECT_NAME.test(nextProject)) {
      setError("Project must start with a letter or digit and use only lowercase letters, digits, _ or -.");
      return;
    }
    if (nextTitle.length === 0) {
      setError("Title is required.");
      return;
    }
    if (!SLUG_NAME.test(nextSlug)) {
      setError("Slug must use lowercase letters, digits, and single hyphens.");
      return;
    }
    if (!statuses.includes(status) || !priorities.includes(priority)) {
      setError("Choose a status and a priority.");
      return;
    }
    if (effectiveText.length > MAX_INITIATIVE_BODY_LENGTH) {
      setError("Text is too long.");
      return;
    }
    basket.add({
      kind: "createInitiative",
      project: nextProject,
      slug: nextSlug,
      title: nextTitle,
      status,
      priority,
      body: effectiveText,
      ...(dependsOn.length === 0 ? {} : { depends_on: [...dependsOn].sort((left, right) => left.localeCompare(right)) }),
    });
    // Images belong to the new folder; the server resolves `new:<project>/<slug>` to it.
    for (const edit of attachments.editsFor(`new:${nextProject}/${nextSlug}`, effectiveText)) basket.add(edit);
    reset();
    setOpen(false);
  }

  const titleById = useMemo(() => new Map(initiatives.map((entry) => [entry.id, entry.title])), [initiatives]);
  const suggestions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return [];
    return initiatives
      .filter((entry) => !dependsOn.includes(entry.id))
      .filter((entry) => entry.id.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle))
      .sort((left, right) => Number(left.done === true) - Number(right.done === true))
      .slice(0, MAX_SUGGESTIONS);
  }, [initiatives, dependsOn, search]);

  function addDependency(id: string) {
    setDependsOn((current) => (current.includes(id) ? current : [...current, id]));
    setSearch("");
  }

  const statusItems = Object.fromEntries(statuses.map((entry) => [entry, entry]));
  const priorityItems = Object.fromEntries(priorities.map((entry) => [entry, entry]));
  const fieldClass = "flex flex-col gap-1 text-sm";
  const selectClass =
    "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          attachments.discard();
          reset();
        }
      }}
    >
      <DialogTrigger render={<Button type="button" variant="outline" />}>New initiative</DialogTrigger>
      <DialogContent
        data-testid="new-initiative-dialog"
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>New initiative</DialogTitle>
          <DialogDescription>Add it to the basket. Nothing is sent until you submit.</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={onSubmit}>
          <div data-testid="new-initiative-body" className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1">
            {error !== null ? (
              <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <label className={fieldClass} htmlFor={`${formId}-project`}>
              <span className="flex items-center gap-1.5">
                Project
                {projectChoice !== NEW_PROJECT ? <ProjectIcon project={projectChoice} /> : null}
              </span>
              <select
                id={`${formId}-project`}
                className={selectClass}
                value={projectChoice}
                onChange={(event) => setProjectChoice(event.target.value)}
              >
                {projects.map((entry) => (
                  <option key={entry} value={entry}>
                    {projectOptionText(entry, display, openCounts?.get(entry))}
                  </option>
                ))}
                <option value={NEW_PROJECT}>+ New project…</option>
              </select>
            </label>
            {projectChoice === NEW_PROJECT ? (
              <label className={fieldClass} htmlFor={`${formId}-new-project`}>
                New project name
                <Input
                  id={`${formId}-new-project`}
                  value={newProject}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="lowercase, a-z 0-9 _ -"
                  onChange={(event) => setNewProject(event.target.value)}
                />
              </label>
            ) : null}
            <label className={fieldClass} htmlFor={`${formId}-title`}>
              Title
              <Input id={`${formId}-title`} value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <p data-testid="new-initiative-number" className="-mt-2 text-xs text-muted-foreground">
              Number is assigned when you submit.
            </p>
            <label className={fieldClass} htmlFor={`${formId}-slug`}>
              Slug
              <Input
                id={`${formId}-slug`}
                value={effectiveSlug}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value);
                }}
              />
            </label>
            <div className={fieldClass}>
              <span>Text</span>
              <MarkdownEditor
                aria-label="Initiative text"
                value={effectiveText}
                minHeight={220}
                images={attachments.images}
                onChange={(next) => {
                  setTextEdited(true);
                  setText(next);
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className={fieldClass}>
                <span id={`${formId}-status-label`}>Status</span>
                <Select
                  items={statusItems}
                  value={status}
                  onValueChange={(next) => {
                    if (next != null) setStatus(next);
                  }}
                >
                  <SelectTrigger id={`${formId}-status`} aria-labelledby={`${formId}-status-label`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {entry}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className={fieldClass}>
                <span id={`${formId}-priority-label`}>Priority</span>
                <Select
                  items={priorityItems}
                  value={priority}
                  onValueChange={(next) => {
                    if (next != null) setPriority(next);
                  }}
                >
                  <SelectTrigger id={`${formId}-priority`} aria-labelledby={`${formId}-priority-label`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {priorities.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {entry}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div role="group" aria-labelledby={`${formId}-deps-label`} className={fieldClass}>
              <span id={`${formId}-deps-label`}>Depends on</span>
              {dependsOn.length > 0 ? (
                <ul className="flex flex-wrap gap-1" aria-label="Selected dependencies">
                  {dependsOn.map((id) => (
                    <li
                      key={id}
                      data-testid="dependency-chip"
                      className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
                    >
                      <span className="truncate" title={titleById.get(id) ?? id}>
                        {id}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${id}`}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setDependsOn((current) => current.filter((entry) => entry !== id))}
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Input
                aria-label="Search dependencies"
                placeholder="Type an id or title"
                value={search}
                autoComplete="off"
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && suggestions[0] !== undefined) {
                    event.preventDefault();
                    addDependency(suggestions[0].id);
                  }
                }}
              />
              {search.trim().length > 0 ? (
                suggestions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No matching initiatives.</p>
                ) : (
                  <ul aria-label="Dependency suggestions" className="flex flex-col rounded-lg border">
                    {suggestions.map((entry) => (
                      <li key={entry.id}>
                        <button
                          type="button"
                          data-testid="dependency-suggestion"
                          className="flex w-full min-w-0 gap-2 px-2 py-1 text-left text-sm hover:bg-muted"
                          onClick={() => addDependency(entry.id)}
                        >
                          <span className="shrink-0 font-mono text-xs leading-5">{entry.id}</span>
                          <span className="min-w-0 truncate" title={entry.title}>
                            {entry.title}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit">Add to basket</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
