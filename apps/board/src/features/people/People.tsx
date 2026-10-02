import { useState } from "react";
import type { InitiativePeople, Person } from "snoboard/browser";
import { formatAge } from "@/features/board/age";

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const CARD_LIMIT = 3;

/** GitHub avatar only for a known, well-formed login; never any other external image. */
export function avatarUrl(person: Pick<Person, "login">): string | null {
  if (person.login === undefined || !LOGIN.test(person.login)) return null;
  return `https://github.com/${person.login}.png?size=40`;
}

export function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s._-]/gu, "")
    .split(/[\s._-]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "?";
  const first = parts[0]!.charAt(0);
  const second = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : (parts[0]!.charAt(1) ?? "");
  return `${first}${second}`.toUpperCase();
}

export function Avatar({ person, size = "sm" }: { person: Person; size?: "sm" | "md" }) {
  const [failed, setFailed] = useState(false);
  const url = avatarUrl(person);
  const box = size === "sm" ? "size-5 text-[9px]" : "size-6 text-[10px]";
  if (url !== null && !failed) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
        className={`${box} shrink-0 rounded-full bg-muted ring-1 ring-background`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${box} inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-1 ring-background`}
    >
      {initials(person.name)}
    </span>
  );
}

/** Card row: creator first, then other participants; at most three, then "+N". */
export function PeopleRow({ people }: { people: InitiativePeople }) {
  const ordered = orderedPeople(people);
  const shown = ordered.slice(0, CARD_LIMIT);
  const extra = ordered.length - shown.length;
  const names = ordered.map((person) => person.name).join(", ");
  return (
    <p className="flex items-center gap-1" data-testid="people-row" aria-label={`People: ${names}`} title={names}>
      <span className="flex -space-x-1">
        {shown.map((person) => (
          <Avatar key={person.key} person={person} />
        ))}
      </span>
      {extra > 0 ? <span className="text-xs text-muted-foreground">+{extra}</span> : null}
    </p>
  );
}

export function orderedPeople(people: InitiativePeople): Person[] {
  const creator = people.creator;
  if (creator === null) return [...people.participants];
  return [creator, ...people.participants.filter((person) => person.key !== creator.key)];
}

export function PeopleDetails({ people, now = Date.now() }: { people: InitiativePeople; now?: number }) {
  const creator = people.creator;
  const age = creator === null ? null : formatAge(creator.date, now);
  return (
    <section className="flex flex-col gap-2 text-sm" data-testid="people">
      <h2 className="font-medium">People</h2>
      {creator !== null ? (
        <p className="flex items-center gap-2" data-testid="creator">
          <Avatar person={creator} size="md" />
          <span>
            Created by {creator.name}
            {age !== null ? (
              <>
                {" · "}
                <time dateTime={creator.date} title={creator.date}>
                  {age === "now" ? "just now" : `${age} ago`}
                </time>
              </>
            ) : null}
          </span>
        </p>
      ) : null}
      {people.participants.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Participants</span>
          <ul className="flex flex-wrap gap-x-3 gap-y-1" data-testid="participants">
            {people.participants.map((person) => (
              <li key={person.key} className="flex items-center gap-1">
                <Avatar person={person} size="md" />
                <span>{person.name}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
