import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FilePlus, FileText, ListChecks, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isEditableDocPath, isNewDocPath, type BoardItem, type Edit } from "snoboard/browser";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ReportMarkdown } from "@/components/report-markdown";
import { useImageAttachments, type EditorImages } from "@/features/attachments/images";
import { useEditConfig } from "@/features/basket/edit-config";
import { pendingDocs, useBasket } from "@/features/basket/store";
import { DocProposals } from "@/features/agent/ProposalNotice";
import { redirectToLogin } from "@/features/board/sync";
import { useRepoId } from "@/features/repo/context";
import type { ForgeLinkConfig } from "./links.js";
import type { Report } from "./report-links.js";
import {
  defaultDocFormat,
  docChipLabel,
  docFileUrl,
  docImageSrc,
  docLinkTarget,
  docSourceUrl,
  findAnchor,
  forgeDocUrl,
  groupViewerDocs,
  phasePacketKey,
  phasePacketTemplate,
  viewerDocs,
  withPendingDocs,
  type DocEntry,
  type DocFormat,
  type ViewerDoc,
} from "./doc-links.js";

type ReportItem = Pick<BoardItem, "id" | "path" | "sourceRef" | "reports" | "docs" | "phases">;

type PendingDocs = ReadonlyMap<string, { text: string; created: boolean }>;

/** Basket document edits of `item` (keyed by path with `.md`) and the item with created documents listed. */
function usePendingDocs<T extends ReportItem>(item: T, repoId: string): { pending: PendingDocs; item: T } {
  const basket = useBasket(repoId);
  const pending = useMemo(() => pendingDocs(basket.edits, item.id), [basket.edits, item.id]);
  const withPending = useMemo(() => withPendingDocs(item, pending), [item, pending]);
  return { pending, item: withPending };
}

/** The open document (index into `viewerDocs(item)`), its format and an optional `#anchor` to scroll to. */
export type ReportSelection = { index: number; format: DocFormat; anchor?: string };

const chipClass =
  "inline-flex max-w-full items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** A button that opens one report in the dialog. */
export function ReportChip({
  report,
  label,
  onOpen,
}: {
  report: Report;
  label: string;
  onOpen: (key: string) => void;
}) {
  return (
    <button
      type="button"
      className={chipClass}
      data-testid={`report-chip-${report.name}`}
      title={`${report.name} (${report.formats.join(", ")})`}
      onClick={() => onOpen(`reports/${report.name}`)}
    >
      <FileText aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Chips for a phase's documents: packets and other phase files, then an expandable "N tasks". */
export function PhaseDocChips({
  phase,
  docs,
  onOpen,
}: {
  phase: number;
  docs: readonly DocEntry[];
  onOpen: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (docs.length === 0) return null;
  const files = docs.filter((doc) => doc.kind !== "task");
  const tasks = docs.filter((doc) => doc.kind === "task");
  const chip = (doc: DocEntry) => (
    <button
      key={doc.path}
      type="button"
      className={chipClass}
      data-testid={`doc-chip-${doc.path}`}
      title={`${doc.path} (${doc.formats.join(", ")})`}
      onClick={() => onOpen(doc.path)}
    >
      <FileText aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{docChipLabel(doc)}</span>
    </button>
  );
  return (
    <span className="mt-1 flex flex-col gap-1" data-testid={`phase-docs-${phase}`}>
      <span className="flex flex-wrap gap-1">
        {files.map(chip)}
        {tasks.length > 0 ? (
          <button
            type="button"
            className={chipClass}
            aria-expanded={open}
            data-testid={`phase-tasks-toggle-${phase}`}
            onClick={() => setOpen((value) => !value)}
          >
            <ListChecks aria-hidden="true" className="size-3 shrink-0" />
            {tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}
            <ChevronDown aria-hidden="true" className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        ) : null}
      </span>
      {open ? (
        <span className="flex flex-wrap gap-1" data-testid={`phase-tasks-${phase}`}>
          {tasks.map(chip)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Large document viewer: a navigation tree of the initiative's documents (Initiative, Phase N,
 * Reports) next to the content; markdown rendered by the board, HTML in a script-less sandboxed frame.
 * When editing is enabled, markdown documents get an "Edit" button that queues `setDoc` in the
 * basket; pending document edits render from the basket and are marked in the navigation.
 */
export function ReportDialog({
  item: committedItem,
  repoId,
  forge,
  selection,
  onSelect,
  onClose,
}: {
  item: ReportItem;
  repoId: string;
  forge: ForgeLinkConfig;
  selection: ReportSelection | null;
  onSelect: (selection: ReportSelection) => void;
  onClose: () => void;
}) {
  const { pending, item } = usePendingDocs(committedItem, repoId);
  const docs = viewerDocs(item);
  const doc = selection === null ? undefined : docs[selection.index];
  return (
    <Dialog
      open={doc !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="report-dialog"
        className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none! flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(calc(100vw-2rem),1400px)]!"
        onKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select")) return;
          const index = selection?.index ?? 0;
          const step = (next: number) => {
            const target = docs[next];
            if (target !== undefined) onSelect({ index: next, format: defaultDocFormat(target) });
          };
          if (event.key === "ArrowLeft" && index > 0) step(index - 1);
          if (event.key === "ArrowRight" && index < docs.length - 1) step(index + 1);
        }}
      >
        {doc !== undefined && selection !== null ? (
          <ViewerBody
            item={item}
            repoId={repoId}
            forge={forge}
            docs={docs}
            doc={doc}
            selection={selection}
            pending={pending}
            onSelect={onSelect}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ViewerBody({
  item,
  repoId,
  forge,
  docs,
  doc,
  selection,
  pending,
  onSelect,
}: {
  item: ReportItem;
  repoId: string;
  forge: ForgeLinkConfig;
  docs: readonly ViewerDoc[];
  doc: ViewerDoc;
  selection: ReportSelection;
  pending: PendingDocs;
  onSelect: (selection: ReportSelection) => void;
}) {
  const editing = useEditConfig();
  const basket = useBasket(repoId);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [openAfterCreate, setOpenAfterCreate] = useState<string | null>(null);
  const format = doc.formats.includes(selection.format) ? selection.format : defaultDocFormat(doc);
  const count = docs.length;
  const index = selection.index;
  const go = (next: number) => {
    const target = docs[next];
    if (target !== undefined) onSelect({ index: next, format: defaultDocFormat(target) });
  };
  const file = `${doc.key}.md`;
  const pendingDoc = pending.get(file);
  const canEdit =
    editing.ready && editing.enabled && format === "md" && doc.formats.includes("md") && isEditableDocPath(file);
  const isEditing = editingKey === doc.key && canEdit;
  const raw = pendingDoc?.created === true ? null : forgeDocUrl(forge, item, doc, format);

  // A document created from the navigation opens (in the editor) once the basket lists it.
  useEffect(() => {
    if (openAfterCreate === null) return;
    const next = docs.findIndex((entry) => entry.key === openAfterCreate);
    if (next === -1) return;
    setOpenAfterCreate(null);
    onSelect({ index: next, format: "md" });
    setEditingKey(openAfterCreate);
  }, [docs, openAfterCreate, onSelect]);

  const createPacket =
    editing.ready && editing.enabled
      ? (phase: { id: number; title?: string }) => {
          const key = phasePacketKey(phase.id);
          if (!isNewDocPath(`${key}.md`)) return;
          basket.add({ kind: "createDoc", id: item.id, path: `${key}.md`, to: phasePacketTemplate(phase) });
          setOpenAfterCreate(key);
        }
      : undefined;

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3 pr-12">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous document"
            data-testid="report-prev"
            disabled={index === 0}
            onClick={() => go(index - 1)}
            className="rounded-md p-1 hover:bg-muted disabled:opacity-40"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
          <span className="text-xs text-muted-foreground tabular-nums" data-testid="report-position">
            {index + 1} / {count}
          </span>
          <button
            type="button"
            aria-label="Next document"
            data-testid="report-next"
            disabled={index >= count - 1}
            onClick={() => go(index + 1)}
            className="rounded-md p-1 hover:bg-muted disabled:opacity-40"
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <DialogTitle className="flex min-w-0 items-center gap-2 font-mono text-sm">
            <span className="truncate">{doc.key}</span>
            {pendingDoc !== undefined && format === "md" ? (
              <PendingBadge testId="doc-pending-current" created={pendingDoc.created} />
            ) : null}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {item.id}
            {doc.phase !== undefined ? ` · phase ${doc.phase}` : ""}
            {doc.kind === "task" ? " · task" : ""}
          </DialogDescription>
        </div>
        {doc.formats.length > 1 && !isEditing ? (
          <div role="group" aria-label="Format" className="inline-flex rounded-md border text-xs">
            {doc.formats.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={option === format}
                data-testid={`report-format-${option}`}
                onClick={() => onSelect({ index, format: option })}
                className="px-2 py-1 uppercase aria-pressed:bg-muted aria-pressed:font-medium"
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
        {canEdit && !isEditing ? (
          <Button type="button" variant="outline" size="sm" data-testid="doc-edit" onClick={() => setEditingKey(doc.key)}>
            <Pencil aria-hidden="true" className="size-3" />
            Edit
          </Button>
        ) : null}
        {raw !== null ? (
          <a
            href={raw}
            rel="noopener noreferrer"
            target="_blank"
            data-testid="report-raw"
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
          >
            Open on GitHub
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1">
        <DocNav
          docs={docs}
          index={index}
          onOpen={go}
          pending={pending}
          phases={item.phases ?? []}
          {...(createPacket === undefined ? {} : { onCreatePacket: createPacket })}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3" data-testid="doc-content">
          {!isEditing && format === "md" ? <DocProposals repoId={repoId} id={item.id} path={file} /> : null}
          {isEditing ? (
            <DocEditor
              key={doc.key}
              item={item}
              repoId={repoId}
              doc={doc}
              pending={pendingDoc}
              onDone={() => setEditingKey(null)}
            />
          ) : format === "html" ? (
            <HtmlReport src={docFileUrl(repoId, item.id, `${doc.key}.html`)} title={doc.key} />
          ) : (
            <MarkdownDoc
              item={item}
              repoId={repoId}
              forge={forge}
              doc={doc}
              docs={docs}
              anchor={selection.anchor}
              pendingText={pendingDoc?.text}
              onSelect={onSelect}
            />
          )}
        </div>
      </div>
    </>
  );
}

function PendingBadge({ testId, created }: { testId: string; created: boolean }) {
  return (
    <span
      data-testid={testId}
      title={created ? "New document in the basket" : "Edited in the basket"}
      className="shrink-0 rounded-sm bg-amber-500/15 px-1 py-px font-sans text-[10px] font-medium text-amber-700 uppercase dark:text-amber-300"
    >
      {created ? "new" : "pending"}
    </span>
  );
}

/** Left navigation tree of the viewer; hidden on narrow screens (prev / next still work). */
function DocNav({
  docs,
  index,
  onOpen,
  pending,
  phases,
  onCreatePacket,
}: {
  docs: readonly ViewerDoc[];
  index: number;
  onOpen: (index: number) => void;
  pending: PendingDocs;
  phases: readonly { id: number; title?: string }[];
  /** Set when editing is enabled: queue a new `phases/phase-<n>.packet.md`. */
  onCreatePacket?: (phase: { id: number; title?: string }) => void;
}) {
  const missing =
    onCreatePacket === undefined ? [] : phases.filter((phase) => !docs.some((doc) => doc.key === phasePacketKey(phase.id)));
  return (
    <nav
      aria-label="Documents"
      data-testid="doc-nav"
      className="hidden w-60 shrink-0 overflow-auto border-r px-2 py-3 text-xs md:block"
    >
      {groupViewerDocs(docs).map(({ group, entries }) => (
        <div key={group} className="mb-3">
          <h3 className="px-2 pb-1 font-medium text-muted-foreground">{group}</h3>
          <ul className="flex flex-col">
            {entries.map(({ doc, index: entryIndex }) => {
              const queued = doc.formats.includes("md") ? pending.get(`${doc.key}.md`) : undefined;
              return (
                <li key={doc.key}>
                  <button
                    type="button"
                    data-testid={`doc-nav-${doc.key}`}
                    aria-current={entryIndex === index ? "page" : undefined}
                    title={doc.key}
                    onClick={() => onOpen(entryIndex)}
                    className={`flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-left font-mono hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium ${doc.kind === "task" ? "pl-5" : ""}`}
                  >
                    <span className="truncate">{doc.kind === "report" ? doc.key.slice("reports/".length) : doc.title}</span>
                    {queued !== undefined ? <PendingBadge testId={`doc-pending-${doc.key}`} created={queued.created} /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {missing.length > 0 && onCreatePacket !== undefined ? (
        <div className="mb-3" data-testid="doc-new">
          <h3 className="px-2 pb-1 font-medium text-muted-foreground">New doc</h3>
          <ul className="flex flex-col">
            {missing.map((phase) => (
              <li key={phase.id}>
                <button
                  type="button"
                  data-testid={`doc-new-packet-${phase.id}`}
                  onClick={() => onCreatePacket(phase)}
                  className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-muted"
                >
                  <FilePlus aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate">Phase {phase.id} packet</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}

type SourceState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; text: string; hash: string | null; created: boolean };

/**
 * Markdown editor for one document. Starts from the pending basket text when there is one,
 * otherwise from the committed source (`doc-source`, which also gives the `fromHash`).
 * Save queues `setDoc` (or updates a `createDoc`) plus pasted images; Cancel drops the draft.
 */
function DocEditor({
  item,
  repoId,
  doc,
  pending,
  onDone,
}: {
  item: ReportItem;
  repoId: string;
  doc: ViewerDoc;
  pending: { text: string; created: boolean } | undefined;
  onDone: () => void;
}) {
  const basket = useBasket(repoId);
  const path = `${doc.key}.md`;
  const queuedHash = basket.edits.find(
    (edit): edit is Extract<Edit, { kind: "setDoc" }> => edit.kind === "setDoc" && edit.id === item.id && edit.path === path,
  )?.fromHash;
  const [source, setSource] = useState<SourceState>(() =>
    pending !== undefined && (pending.created || queuedHash !== undefined)
      ? { phase: "ready", text: pending.text, hash: queuedHash ?? null, created: pending.created }
      : { phase: "loading" },
  );
  const [draft, setDraft] = useState(source.phase === "ready" ? source.text : "");
  const attachments = useImageAttachments({ repoId, id: item.id, from: doc.key });
  const images: EditorImages = useMemo(
    () => ({
      attach: attachments.images.attach,
      resolve: (src: string) => attachments.images.resolve(src) || docImageSrc(src, { repoId, id: item.id, from: doc.key }),
    }),
    [attachments.images, repoId, item.id, doc.key],
  );

  useEffect(() => {
    if (source.phase !== "loading") return;
    const controller = new AbortController();
    void fetch(docSourceUrl(repoId, item.id, path), { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok || !isSourcePayload(body)) {
          setSource({ phase: "error", message: errorFrom(body, response.status) });
          return;
        }
        setSource({ phase: "ready", text: body.text, hash: body.hash, created: false });
        setDraft(body.text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSource({ phase: "error", message: "Could not load the document source" });
      });
    return () => controller.abort();
  }, [source.phase, repoId, item.id, path]);

  function save() {
    if (source.phase !== "ready") return;
    const unchanged = pending === undefined && draft === source.text;
    if (!unchanged) {
      if (source.created) {
        basket.add({ kind: "createDoc", id: item.id, path, to: draft });
      } else if (source.hash !== null) {
        basket.add({ kind: "setDoc", id: item.id, path, fromHash: source.hash, to: draft });
      }
    }
    for (const edit of attachments.editsFor(item.id, draft)) basket.add(edit);
    onDone();
  }

  function cancel() {
    attachments.discard();
    onDone();
  }

  if (source.phase === "loading") return <p className="py-4 text-sm text-muted-foreground">Loading document…</p>;
  if (source.phase === "error") {
    return (
      <div className="flex flex-col gap-2 py-2">
        <p
          role="alert"
          data-testid="doc-edit-error"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {source.message}
        </p>
        <div>
          <Button type="button" variant="outline" onClick={cancel}>
            Back
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="doc-editor">
      <MarkdownEditor aria-label={`Edit ${path}`} value={draft} onChange={setDraft} minHeight={480} images={images} />
      <div className="flex gap-2">
        <Button type="button" data-testid="doc-edit-save" onClick={save}>
          Save
        </Button>
        <Button type="button" variant="outline" data-testid="doc-edit-cancel" onClick={cancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Saved edits go to the basket; nothing is committed until the basket is submitted.</p>
    </div>
  );
}

function isSourcePayload(value: unknown): value is { text: string; hash: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { text?: unknown; hash?: unknown };
  return typeof record.text === "string" && typeof record.hash === "string" && /^[a-f0-9]{64}$/.test(record.hash);
}

function errorFrom(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
  return `Could not load the document source (${status})`;
}

/**
 * HTML twins render with no scripts, no same-origin access, no forms, no popups and no
 * top navigation: `sandbox=""` plus the endpoint's CSP (no network, inline styles only).
 */
export function HtmlReport({ src, title }: { src: string; title: string }) {
  return (
    <iframe
      data-testid="report-frame"
      src={src}
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      loading="lazy"
      className="h-full min-h-[60vh] w-full rounded-md border bg-white"
    />
  );
}

type MarkdownState = { phase: "loading" | "error" | "ready"; text: string };

function scrollToAnchor(root: HTMLElement | null, id: string): void {
  if (root === null) return;
  const target = findAnchor(root, id);
  if (target !== null && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
}

function MarkdownDoc({
  item,
  repoId,
  forge,
  doc,
  docs,
  anchor,
  pendingText,
  onSelect,
}: {
  item: ReportItem;
  repoId: string;
  forge: ForgeLinkConfig;
  doc: ViewerDoc;
  docs: readonly ViewerDoc[];
  anchor: string | undefined;
  /** Text of a pending basket edit; shown instead of the committed file. */
  pendingText?: string | undefined;
  onSelect: (selection: ReportSelection) => void;
}) {
  const [fetched, setState] = useState<MarkdownState>({ phase: "loading", text: "" });
  const state: MarkdownState = pendingText === undefined ? fetched : { phase: "ready", text: pendingText };
  const root = useRef<HTMLDivElement>(null);
  const url = docFileUrl(repoId, item.id, `${doc.key}.md`);
  // Images pasted in a pending edit preview from the browser's store until they are committed.
  const queuedImages = useImageAttachments({ repoId, id: item.id, from: doc.key }).images;
  const hasPending = pendingText !== undefined;
  useEffect(() => {
    if (hasPending) return;
    const controller = new AbortController();
    setState({ phase: "loading", text: "" });
    void fetch(url, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) {
          setState({ phase: "error", text: `Could not load the document (${response.status})` });
          return;
        }
        const text = await response.text();
        if (!controller.signal.aborted) setState({ phase: "ready", text });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ phase: "error", text: "Could not load the document" });
      });
    return () => controller.abort();
  }, [url, hasPending]);

  // A link like `phase-1.packet.md#scope` lands on the heading once the markdown has rendered.
  useEffect(() => {
    if (state.phase !== "ready" || anchor === undefined) return;
    const frame = requestAnimationFrame(() => scrollToAnchor(root.current, anchor));
    return () => cancelAnimationFrame(frame);
  }, [state.phase, anchor, state.text]);

  const folder = item.path.slice(0, item.path.lastIndexOf("/"));
  const renderLink = useCallback(
    (href: string, children: ReactNode) => {
      const target = docLinkTarget(href, { from: doc.key, docs, forge, sourceRef: item.sourceRef, folder });
      if (target.kind === "doc") {
        return (
          <a
            href={href}
            data-report-link=""
            // The client router would otherwise navigate to the raw relative path.
            data-vike="false"
            onClick={(event) => {
              event.preventDefault();
              if (target.index === docs.indexOf(doc) && target.format === "md" && target.anchor !== undefined) {
                scrollToAnchor(root.current, target.anchor);
              }
              onSelect(
                target.anchor === undefined
                  ? { index: target.index, format: target.format }
                  : { index: target.index, format: target.format, anchor: target.anchor },
              );
            }}
          >
            {children}
          </a>
        );
      }
      if (target.kind === "external") {
        return (
          <a href={target.href} rel="noopener noreferrer" target="_blank">
            {children}
          </a>
        );
      }
      if (target.kind === "anchor") {
        return (
          <a
            href={`#${target.id}`}
            data-vike="false"
            onClick={(event) => {
              event.preventDefault();
              scrollToAnchor(root.current, target.id);
            }}
          >
            {children}
          </a>
        );
      }
      return <span className="underline decoration-dotted">{children}</span>;
    },
    [doc, docs, forge, item.sourceRef, folder, onSelect],
  );

  if (state.phase === "loading") return <p className="py-4 text-sm text-muted-foreground">Loading document…</p>;
  if (state.phase === "error") {
    return (
      <p role="alert" className="my-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
        {state.text}
      </p>
    );
  }
  return (
    <div ref={root}>
      {hasPending ? (
        <p data-testid="doc-pending-note" className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          Showing the pending edit from the basket. Remove it from the basket to see the committed file.
        </p>
      ) : null}
      <ReportMarkdown
        markdown={state.text}
        resolveImage={(src) => queuedImages.resolve(src) || docImageSrc(src, { repoId, id: item.id, from: doc.key })}
        renderLink={renderLink}
      />
    </div>
  );
}

/**
 * State of the document viewer. `openDoc` takes a key from `viewerDocs` (`ROADMAP`,
 * `phases/phase-1.packet`, `reports/final.report`).
 */
export function useReportViewer(committedItem: ReportItem) {
  const [selection, setSelection] = useState<ReportSelection | null>(null);
  // Same list as the dialog, including documents created in the basket, so indices agree.
  const { item } = usePendingDocs(committedItem, useRepoId());
  const docs = viewerDocs(item);
  const openDoc = (key: string) => {
    const index = docs.findIndex((entry) => entry.key === key);
    const doc = docs[index];
    if (doc !== undefined) setSelection({ index, format: defaultDocFormat(doc) });
  };
  return { selection, setSelection, openDoc };
}

/** "Documents" section of the details panel: initiative-level documents (ROADMAP, CONVENTIONS, phases/README, ...). */
export function DocumentsSection({ docs, onOpen }: { docs: readonly DocEntry[]; onOpen: (key: string) => void }) {
  if (docs.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="docs-section">
      <h2 className="text-sm font-medium">Documents</h2>
      <ul className="flex flex-col gap-1 text-sm">
        {docs.map((doc) => (
          <li key={doc.path} className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-testid={`doc-open-${doc.path}`}
              onClick={() => onOpen(doc.path)}
              className="inline-flex min-w-0 items-center gap-1 text-left text-primary underline-offset-4 hover:underline"
            >
              <FileText aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-xs">{doc.path}</span>
            </button>
            <span className="text-xs text-muted-foreground">{doc.formats.join(" · ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReportsSection({
  reports,
  onOpen,
}: {
  reports: readonly Report[];
  onOpen: (key: string) => void;
}) {
  if (reports.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="reports-section">
      <h2 className="text-sm font-medium">Reports</h2>
      <ul className="flex flex-col gap-1 text-sm">
        {reports.map((report) => (
          <li key={report.name} className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-testid={`report-open-${report.name}`}
              onClick={() => onOpen(`reports/${report.name}`)}
              className="inline-flex min-w-0 items-center gap-1 text-left text-primary underline-offset-4 hover:underline"
            >
              <FileText aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-xs">{report.name}</span>
            </button>
            <span className="text-xs text-muted-foreground">{report.formats.join(" · ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
