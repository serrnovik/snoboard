import { z } from "zod";
import { ASSET_PATH, ATTACHMENT_TYPES, extensionFor, MAX_ATTACHMENT_BYTES, NEW_INITIATIVE_REF } from "./attachments.js";
import { MAX_ISSUE_REFS, parseIssueRef } from "./issues.js";
import { LinkSchema, MAX_LINKS } from "./links.js";
import { MAX_ICON_LENGTH, parseIcon } from "./icons.js";

// No Node imports here: the browser bundle (snoboard/browser) uses this schema.
export const PROJECT_NAME = /^[a-z0-9_][a-z0-9_-]*$/;
export const SLUG_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const INITIATIVE_ID = /^[a-z0-9_-]+-\d{3}$/;
export const DEPENDENCY_ID = /^[a-z0-9_-]+-\d{3}(#([1-9]\d*))?$/;

/** Upper bound for initiative body text in setBody and createInitiative (characters). */
export const MAX_INITIATIVE_BODY_LENGTH = 60_000;
const BodyText = z.string().max(MAX_INITIATIVE_BODY_LENGTH);
const IssueRefText = z
  .string()
  .max(300)
  .refine((value) => parseIssueRef(value) !== undefined, { message: "not a valid issue ref" });
const SeenLink = z.object({ title: z.string(), url: z.string() });
/** An initiative id, or `new:<project>/<slug>` for an initiative created in the same basket. */
const AttachmentTarget = z
  .string()
  .refine((value) => INITIATIVE_ID.test(value) || NEW_INITIATIVE_REF.test(value), {
    message: "must be an initiative id or new:<project>/<slug>",
  });

export const EditSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("setStatus"),
    id: z.string().regex(INITIATIVE_ID),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    kind: z.literal("setPriority"),
    id: z.string().regex(INITIATIVE_ID),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    kind: z.literal("setPhaseStatus"),
    id: z.string().regex(INITIATIVE_ID),
    phase: z.number().int().positive(),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    kind: z.literal("setTitle"),
    id: z.string().regex(INITIATIVE_ID),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    kind: z.literal("setIcon"),
    id: z.string().regex(INITIATIVE_ID),
    /** Current `icon`; empty when the initiative has none. */
    from: z.string().max(MAX_ICON_LENGTH),
    /** New `icon`; empty removes the field. */
    to: z
      .string()
      .max(MAX_ICON_LENGTH)
      .refine((value) => value === "" || parseIcon(value) !== undefined, {
        message: "must be one or two emoji or a repo-relative .png, .svg, .webp or .ico path",
      }),
  }),
  z.object({
    kind: z.literal("setLabels"),
    id: z.string().regex(INITIATIVE_ID),
    from: z.array(z.string()),
    to: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("setBody"),
    id: z.string().regex(INITIATIVE_ID),
    fromHash: z.string().regex(/^[a-f0-9]{64}$/),
    to: BodyText,
  }),
  z.object({
    kind: z.literal("setIssues"),
    id: z.string().regex(INITIATIVE_ID),
    from: z.array(z.string()),
    to: z.array(IssueRefText).max(MAX_ISSUE_REFS),
  }),
  z.object({
    kind: z.literal("setLinks"),
    id: z.string().regex(INITIATIVE_ID),
    from: z.array(SeenLink),
    to: z.array(LinkSchema).max(MAX_LINKS),
  }),
  z.object({
    kind: z.literal("addAttachment"),
    id: AttachmentTarget,
    /** Relative to the initiative folder. */
    path: z.string().regex(ASSET_PATH),
    contentType: z.enum(ATTACHMENT_TYPES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
    /** Browser-only handle for the bytes in IndexedDB. The server ignores it. */
    key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  }).refine((value) => value.path.endsWith(`.${extensionFor(value.contentType)}`), {
    message: "path extension does not match contentType",
    path: ["path"],
  }),
  z.object({
    kind: z.literal("createInitiative"),
    project: z.string().regex(PROJECT_NAME),
    slug: z.string().regex(SLUG_NAME),
    title: z.string().min(1),
    status: z.string().min(1),
    priority: z.string().min(1),
    depends_on: z.array(z.string().regex(DEPENDENCY_ID)).optional(),
    /** Markdown body below the frontmatter. Frontmatter is always generated from the other fields. */
    body: BodyText.optional(),
  }),
]);

export type Edit = z.infer<typeof EditSchema>;
