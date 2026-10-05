import { useEffect, useId, useState } from "react";
import type { BoardItem, Edit, IssueLinkConfig, Phase } from "snoboard/browser";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { redirectToLogin } from "@/features/board/sync";
import { useEditConfig } from "@/features/basket/edit-config";
import { useBasket } from "@/features/basket/store";
import { useImageAttachments } from "@/features/attachments/images";
import { IssuesEditor, LinksEditor } from "@/features/details/ListEditors";
import type { CreateProviderId } from "@/features/issues/NewIssueDialog";
import { useRepoId } from "@/features/repo/context";
import { repoApi } from "@/lib/routes";
import { iconProblem } from "snoboard/browser";
import { Icon } from "@/features/icons/display";

/** A few one-click choices; any emoji or repo image path can be typed. */
export const ICON_SUGGESTIONS = ["🚀", "🧩", "🛠️", "🐛", "📈", "🔒", "🎨", "🧠", "⚡", "📦"] as const;

const INITIATIVE_ID = /^[a-z0-9_-]+-\d{3}$/;

type BoardLists = {
  statuses: string[];
  priorities: string[];
};

export function EditControls({ item }: { item: BoardItem }) {
  const editing = useEditConfig();
  const lists = useBoardLists(editing.enabled);
  if (!editing.ready || !editing.enabled || !isEditable(item) || lists === null) return null;
  return (
    <EditForm
      item={item}
      statuses={lists.statuses}
      priorities={lists.priorities}
      issueLinks={editing.issues ?? {}}
      createProviders={editing.createProviders ?? []}
      csrf={editing.csrf}
    />
  );
}

function EditForm({
  item,
  statuses,
  priorities,
  issueLinks,
  createProviders,
  csrf,
}: {
  item: BoardItem;
  statuses: readonly string[];
  priorities: readonly string[];
  issueLinks: IssueLinkConfig;
  createProviders: readonly CreateProviderId[];
  csrf: string | undefined;
}) {
  const basket = useBasket(useRepoId());
  const formId = useId();
  const edits = basket.edits.filter((edit) => "id" in edit && edit.id === item.id);
  const statusValue = displayedScalar(edits, "setStatus") ?? item.status;
  const priorityValue = displayedScalar(edits, "setPriority") ?? item.priority;
  const titleValue = displayedScalar(edits, "setTitle") ?? item.title;
  const labelValue = displayedLabels(edits) ?? item.labels ?? [];
  const labelText = labelValue.join(", ");
  const [title, setTitle] = useState(titleValue);
  const [labels, setLabels] = useState(labelText);
  const [titleError, setTitleError] = useState<string | null>(null);
  const iconValue = displayedIcon(edits) ?? item.icon ?? "";
  const [icon, setIcon] = useState(iconValue);
  const [iconError, setIconError] = useState<string | null>(null);

  useEffect(() => {
    setIcon(iconValue);
  }, [iconValue]);

  function commitIcon(next = icon) {
    const value = next.trim();
    if (value !== "" && iconProblem(value) !== undefined) {
      setIconError("Use one or two emoji, or a repo image path (.png, .svg, .webp, .ico).");
      return;
    }
    setIconError(null);
    setIcon(value);
    basket.add({ kind: "setIcon", id: item.id, from: item.icon ?? "", to: value });
  }

  useEffect(() => {
    setTitle(titleValue);
  }, [titleValue]);

  useEffect(() => {
    setLabels(labelText);
  }, [labelText]);

  function commitTitle() {
    if (title.trim().length === 0) {
      setTitleError("Title is required.");
      return;
    }
    setTitleError(null);
    basket.add({ kind: "setTitle", id: item.id, from: item.title, to: title });
  }

  function commitLabels() {
    basket.add({
      kind: "setLabels",
      id: item.id,
      from: item.labels ?? [],
      to: parseLabels(labels),
    });
  }

  return (
    <section aria-label="Edit initiative" data-testid="edit-controls" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Edit</h2>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${formId}-title`}>
        Title
        <Input
          id={`${formId}-title`}
          value={title}
          aria-invalid={titleError !== null}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commitTitle();
          }}
        />
      </label>
      {titleError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {titleError}
        </p>
      ) : null}
      <ChoiceField
        id={`${formId}-status`}
        label="Status"
        value={statusValue}
        options={statuses}
        onChange={(to) => basket.add({ kind: "setStatus", id: item.id, from: item.status, to })}
      />
      <ChoiceField
        id={`${formId}-priority`}
        label="Priority"
        value={priorityValue}
        options={priorities}
        onChange={(to) => basket.add({ kind: "setPriority", id: item.id, from: item.priority, to })}
      />
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${formId}-labels`}>
        Labels
        <Input
          id={`${formId}-labels`}
          value={labels}
          placeholder="comma-separated"
          onChange={(event) => setLabels(event.target.value)}
          onBlur={commitLabels}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commitLabels();
          }}
        />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <label className="flex flex-col gap-1" htmlFor={`${formId}-icon`}>
          Icon
          <span className="flex items-center gap-2">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border text-base" data-testid="icon-preview">
              <Icon value={iconProblem(icon.trim()) === undefined ? icon.trim() : undefined} />
            </span>
            <Input
              id={`${formId}-icon`}
              value={icon}
              placeholder="emoji or path/to/icon.svg (empty: project icon)"
              aria-invalid={iconError !== null}
              onChange={(event) => setIcon(event.target.value)}
              onBlur={() => commitIcon()}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitIcon();
              }}
            />
          </span>
        </label>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Icon suggestions">
          {ICON_SUGGESTIONS.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-label={`Use icon ${choice}`}
              className="inline-flex size-7 items-center justify-center rounded-md border text-base hover:bg-muted"
              onClick={() => commitIcon(choice)}
            >
              {choice}
            </button>
          ))}
          {iconValue !== "" ? (
            <button
              type="button"
              className="rounded-md border px-2 text-xs hover:bg-muted"
              onClick={() => commitIcon("")}
            >
              Clear
            </button>
          ) : null}
        </div>
        {iconError !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {iconError}
          </p>
        ) : null}
      </div>
      <IssuesEditor
        id={item.id}
        issues={item.issues}
        linkConfig={issueLinks}
        create={{ providers: createProviders, csrf, title: titleValue, summary: item.summary }}
      />
      <LinksEditor id={item.id} links={item.links} />
      {item.phases !== undefined && item.phases.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Phase status</legend>
          {item.phases.map((phase) => (
            <ChoiceField
              key={phase.id}
              id={`${formId}-phase-${phase.id}`}
              label={`Phase ${phase.id} status`}
              value={displayedPhase(edits, phase)}
              options={statuses}
              onChange={(to) =>
                basket.add({
                  kind: "setPhaseStatus",
                  id: item.id,
                  phase: phase.id,
                  from: phase.status,
                  to,
                })
              }
            />
          ))}
        </fieldset>
      ) : null}
      <BodyEditor id={item.id} />
    </section>
  );
}

function ChoiceField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const choices = options.includes(value) ? options : [...options, value];
  const items = Object.fromEntries(choices.map((entry) => [entry, entry]));
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span id={`${id}-label`}>{label}</span>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (next == null || next === value) return;
          onChange(next);
        }}
      >
        <SelectTrigger id={id} aria-labelledby={`${id}-label`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((entry) => (
            <SelectItem key={entry} value={entry}>
              {entry}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function BodyEditor({ id }: { id: string }) {
  const repoId = useRepoId();
  const basket = useBasket(repoId);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [hash, setHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useImageAttachments({ repoId, id });

  async function start() {
    setError(null);
    setLoading(true);
    try {
      const response = await fetch(repoApi(repoId, `/initiatives/${encodeURIComponent(id)}/body`), {
        credentials: "same-origin",
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isBodyPayload(body)) {
        setError(messageFrom(body, response.status));
        return;
      }
      setDraft(body.body);
      setHash(body.hash);
      setOpen(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the text");
    } finally {
      setLoading(false);
    }
  }

  function save() {
    if (hash === null) return;
    basket.add({ kind: "setBody", id, fromHash: hash, to: draft });
    for (const edit of attachments.editsFor(id, draft)) basket.add(edit);
    setOpen(false);
  }

  function cancel() {
    attachments.discard();
    setOpen(false);
    setDraft("");
    setHash(null);
    setError(null);
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="button" variant="outline" disabled={loading} onClick={() => void start()}>
            {loading ? "Loading text…" : "Edit text"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1 text-sm">
        <span>Initiative text</span>
        <MarkdownEditor
          aria-label="Initiative text"
          value={draft}
          onChange={setDraft}
          minHeight={320}
          images={attachments.images}
        />
      </div>
      <div className="flex gap-2">
        <Button type="button" onClick={save}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function useBoardLists(enabled: boolean): BoardLists | null {
  const repoId = useRepoId();
  const [lists, setLists] = useState<BoardLists | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch(repoApi(repoId, "/board"), { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        setLists(listsFrom(body));
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLists(null);
      });
    return () => controller.abort();
  }, [enabled, repoId]);

  return enabled ? lists : null;
}

function listsFrom(value: unknown): BoardLists | null {
  if (typeof value !== "object" || value === null || !("config" in value)) return null;
  const config = value.config;
  if (typeof config !== "object" || config === null) return null;
  const record = config as { statuses?: unknown; priorities?: unknown };
  if (!isStringList(record.statuses) || !isStringList(record.priorities)) return null;
  return { statuses: record.statuses, priorities: record.priorities };
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEditable(item: BoardItem): boolean {
  return INITIATIVE_ID.test(item.id) && item.status.length > 0 && item.priority.length > 0;
}

function displayedScalar(edits: readonly Edit[], kind: "setStatus" | "setPriority" | "setTitle"): string | undefined {
  const match = edits.find((edit) => edit.kind === kind);
  if (match === undefined || match.kind === "setLabels" || match.kind === "setBody" || match.kind === "createInitiative") {
    return undefined;
  }
  if (match.kind !== kind) return undefined;
  return match.to;
}

function displayedIcon(edits: readonly Edit[]): string | undefined {
  const match = edits.find((edit) => edit.kind === "setIcon");
  return match?.kind === "setIcon" ? match.to : undefined;
}

function displayedLabels(edits: readonly Edit[]): string[] | undefined {
  const match = edits.find((edit) => edit.kind === "setLabels");
  return match?.kind === "setLabels" ? match.to : undefined;
}

function displayedPhase(edits: readonly Edit[], phase: Phase): string {
  const match = edits.find((edit) => edit.kind === "setPhaseStatus" && edit.phase === phase.id);
  return match?.kind === "setPhaseStatus" ? match.to : phase.status;
}

function parseLabels(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isBodyPayload(value: unknown): value is { body: string; hash: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { body?: unknown; hash?: unknown };
  return typeof record.body === "string" && typeof record.hash === "string" && /^[a-f0-9]{64}$/.test(record.hash);
}

function messageFrom(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `Could not load the text (${status})`;
}
