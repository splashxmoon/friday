import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, CopyIcon, LogOutIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Callout, Choice, dangerOutline, Note, PageHeader, SettingsGroup, SettingsRow, StateBadge, surface } from "@/components/dass";
import { useIntent } from "./intent.js";
import { ENGINE_MODELS, ENGINE_NAMES, ENGINE_TOOLS } from "../types.js";
import { FIRST_TOOLS } from "./engines.js";
import { Avatar, FridayMark, Icon } from "./icons.js";
import type { Identity } from "./storage.js";
import { Hint, Skeleton, SkeletonLines, barHeight } from "./ui.js";
import { EngineMark } from "./BrandMarks.js";
import {
  AboutTab,
  AppearanceTab,
  DataTab,
  NotificationsTab,
  ShortcutsTab,
} from "./SettingsPrefs.js";
import { ComputerSection } from "./SettingsComputer.js";
import type { WorkspaceUsage } from "./workspace-types.js";
import { isLocal, planLimits, planNow, startTeam } from "./edition.js";

/**
 * Settings, as a page of its own.
 *
 * It used to be a dialog over whatever you were doing, which is the wrong shape for something people come to on purpose,
 * read, and come back to: it couldn't be linked to, Back didn't leave it, and it had room for ten tabs and no more. As a
 * page it has an address for every section (`?view=settings&section=members`), it sits beside the chat list like People
 * and Connections, and it has room for what a team needs to run Friday: who is in the workspace, what every session
 * starts with, and the computer its coding agents run on.
 *
 * Anything that belongs to one session (which agent, which folder) stays in that session: it changes per run, and a
 * global setting would be wrong most of the time. What is here is either about you, about the workspace, or about this
 * computer, and each section says which.
 *
 * What it deliberately does not do is pretend: a control is only here when it does what it says.
 */
type Group = "You" | "Workspace" | "This computer" | "More";

interface SectionDef {
  id: string;
  label: string;
  group: Group;
  icon: Parameters<typeof Icon>[0]["name"];
  /** One sentence under the title: what this section is for. */
  blurb: string;
  /** What is in it, for the search box: a setting is found by what it does, not only by which section it is in. */
  keywords: string;
}

export const SECTIONS: SectionDef[] = [
  {
    id: "profile",
    label: "Profile",
    group: "You",
    icon: "user",
    blurb: "Who you are to everyone you work with.",
    keywords: "name display email account id sign out log out provider",
  },
  {
    id: "appearance",
    label: "Appearance",
    group: "You",
    icon: "sun",
    blurb: "How Friday looks on this device.",
    keywords:
      "theme dark light mode color colour look system size zoom text font scale motion animation",
  },
  {
    id: "notifications",
    label: "Notifications",
    group: "You",
    icon: "bell",
    blurb:
      "Only while Friday's window is hidden, and only when something waits on you: a question, a finished run, a failure.",
    keywords: "alerts away banner chime sound permission",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    group: "You",
    icon: "keyboard",
    blurb: "Every key that does something.",
    keywords: "keyboard keys hotkeys command",
  },
  {
    id: "computer",
    label: "Computer & coding tools",
    group: "This computer",
    icon: "plug",
    blurb: "The computer your coding agents run on, and the tools on it.",
    keywords:
      "computer machine connect link claude code codex cursor sign in install account folder runner",
  },
  {
    id: "data",
    label: "Data & backup",
    group: "More",
    icon: "download",
    blurb: "Carry your settings to another computer, or start them over.",
    keywords:
      "export import backup reset file analytics usage privacy share telemetry",
  },
  {
    id: "about",
    label: "About",
    group: "More",
    icon: "help",
    blurb: "Updates, release notes and the tour.",
    keywords: "version update release notes tour desktop app",
  },
];
const GROUPS: Group[] = ["You", "Workspace", "This computer", "More"];

/**
 * The sections a search finds: those holding the most of its words. Every word used to be required, so "dark mode" found
 * nothing because no section said "mode"; now a section with more of the words wins, and one word is enough.
 */
export function sectionsMatching<
  T extends { label: string; group: string; blurb: string; keywords: string },
>(list: T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const scored = list.map((s) => {
    const text = `${s.label} ${s.group} ${s.blurb} ${s.keywords}`.toLowerCase();
    return { s, n: words.filter((w) => text.includes(w)).length };
  });
  const best = Math.max(...scored.map((x) => x.n));
  return best ? scored.filter((x) => x.n === best).map((x) => x.s) : [];
}

/** What a section a plan doesn't have would hold, said as a sentence of its own. */
let MISSING: Record<string, string> = {};

/** A section by any name it has had: the old tab names keep working for links and for openSettings("account"). */
export function settingsSection(id: string | null | undefined): string {
  const aliases: Record<string, string> = {
    account: "profile",
    team: "members",
    people: "members",
    machine: "computer",
    tools: "computer",
  };
  const s = aliases[id ?? ""] ?? id ?? "";
  return SECTIONS.some((x) => x.id === s) ? s : "profile";
}

export interface Me {
  id: string;
  name: string;
  email?: string;
  provider?: string;
  avatar?: string;
}

export function SettingsPage({
  identity,
  workspace,
  section,
  onSection,
  onRename,
}: {
  identity: Identity;
  workspace: WorkspaceUsage | null;
  section: string;
  /** Go to a section: a navigation, so Back returns to the one before. */
  onSection: (id: string) => void;
  /** May return the save itself, so "Saved" waits for it and a failure is said. */
  onRename: (name: string) => void | Promise<unknown>;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [q, setQ] = useState("");
  const page = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLElement>(null);
  // Where focus lands: Settings opened as a whole puts it in the search; a section asked for by name (a link, the palette,
  // an upgrade prompt) puts it on that section's heading; a click in the list leaves it where it is.
  const search = useRef<HTMLInputElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const took = useRef(false);
  useIntent("settings-search", () => ((took.current = true), requestAnimationFrame(() => search.current?.focus())));
  useIntent("settings-section", () => ((took.current = true), requestAnimationFrame(() => head.current?.focus({ preventScroll: true }))));
  useEffect(() => {
    if (!took.current) requestAnimationFrame(() => head.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    fetch("/api/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => b?.user && setMe(b.user))
      .catch(() => {});
  }, []);
  // A new section starts at its top, not wherever the last one was scrolled to. The page is what scrolls. In braces: a newer
  // scrollTo returns a promise, and an effect that returns one hands React something it then calls as a cleanup, and crashes.
  useEffect(() => {
    page.current?.scrollTo({ top: 0 });
    // The section picked stays in view in the list, which scrolls on its own (an Enter in the search can pick one out of sight).
    menu.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [section]);
  // How tall the list may be: what the page shows below its top padding, so the list's last section is reachable however
  // short the window (see --settings-visible in style.css).
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const fit = () =>
      el.style.setProperty(
        "--settings-visible",
        `${el.clientHeight - parseFloat(getComputedStyle(el).paddingTop || "0")}px`,
      );
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // On Solo, what is about Friday's own agent (its defaults, models, and the allowance it spends) isn't there, and a personal
  // workspace has nobody to manage. A team whose plan lapsed keeps Members: it still has people in it. Memory stays: what is kept
  // about you is yours to see and forget, and the home screen suggests from it.
  const solo = planLimits(planNow(workspace)).fridayAgent === "none";
  const hidden = new Set(
    solo
      ? [
          "defaults",
          "integrations",
          "usage",
          "models",
          ...(workspace?.personal !== false ? ["members"] : []),
        ]
      : [],
  );
  const sections = SECTIONS.filter((s) => !hidden.has(s.id));
  const current = sections.find((s) => s.id === section) ?? sections[0]!;
  // A link to a section this plan does not have says so, rather than showing Profile under a URL that still says usage.
  const missing = hidden.has(section)
    ? SECTIONS.find((s) => s.id === section)
    : undefined;
  const query = q.trim().toLowerCase();
  const matches = useMemo(
    () => sectionsMatching(sections, query),
    [query, sections.length], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div className="page settings-page px-6!" ref={page}>
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-10 max-[760px]:grid-cols-1 max-[760px]:gap-5">
        <nav
          className="settings-menu sticky top-0 flex flex-col gap-4 self-start pb-8 max-[760px]:static max-[760px]:max-h-none max-[760px]:pb-0"
          aria-label="Settings sections"
          ref={menu}
        >
          <h1 className="m-0 px-2 pt-1 text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Settings</h1>
          <InputGroup className="h-8 rounded-lg border-[var(--border-strong)] bg-[var(--bg)] shadow-[var(--shadow-xs)]">
            <InputGroupAddon>
              <SearchIcon className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              value={q}
              ref={search}
              placeholder="Search settings"
              aria-label="Search settings"
              className="text-[13px]"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches[0]) onSection(matches[0].id);
                if (e.key === "Escape") setQ("");
              }}
            />
            {q && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQ("")}>
                  <XIcon />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <div className="flex flex-col gap-4 max-[760px]:flex-row max-[760px]:flex-wrap max-[760px]:gap-1.5">
            {GROUPS.map((g) => {
              const items = matches.filter((s) => s.group === g);
              if (!items.length) return null;
              return (
                <div key={g} className="flex flex-col gap-px max-[760px]:contents" role="group" aria-label={g}>
                  <div className="px-2 pb-1 text-[11.5px] font-medium text-[var(--text-muted)] max-[760px]:hidden">{g}</div>
                  {items.map((s) => {
                    const on = s.id === current.id && !missing;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        data-active={on || undefined}
                        className="dass-row flex-row items-center gap-2.5 py-1.5 text-[13px] text-[var(--ink-2)] data-[active]:font-medium data-[active]:text-[var(--ink)] max-[760px]:w-auto max-[760px]:rounded-full max-[760px]:border max-[760px]:border-[var(--border)] max-[760px]:px-3"
                        aria-current={on ? "page" : undefined}
                        onClick={() => onSection(s.id)}
                      >
                        <Icon name={s.icon} size={15} />
                        <span className="truncate">{s.label}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {/* Said to a screen reader as the list changes: how many sections the words found. */}
          <p className="sr-only" role="status">
            {query ? (matches.length ? `${matches.length} section${matches.length === 1 ? "" : "s"} found` : "No setting matches") : ""}
          </p>
          {!matches.length && <p className="m-0 px-2 text-[12.5px] text-[var(--text-muted)]">No setting matches “{q.trim()}”.</p>}
        </nav>

        {missing ? (
          <div className="min-w-0 pb-16">
            <PageHeader as="h2" titleRef={head} eyebrow={missing.group} title={missing.label} subtitle={MISSING[missing.id] ?? `${missing.label} comes with a Team plan.`} />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onSection("profile")}>
                Back to Profile
              </Button>
              <Button size="sm" onClick={() => startTeam()}>
                See plans
              </Button>
            </div>
          </div>
        ) : (
          <div className="min-w-0 pb-16">
            <PageHeader as="h2" titleRef={head} eyebrow={current.group} title={current.label} subtitle={current.blurb} />
            {current.id === "profile" && <AccountTab identity={identity} me={me} onRename={onRename} solo={solo} />}
            {current.id === "appearance" && <AppearanceTab />}
            {current.id === "notifications" && <NotificationsTab identity={identity} />}
            {current.id === "shortcuts" && <ShortcutsTab />}
            {current.id === "computer" && <ComputerSection identity={identity} />}
            {current.id === "data" && <DataTab />}
            {current.id === "about" && <AboutTab onReplayTour={() => window.dispatchEvent(new Event("friday:tour"))} />}
          </div>
        )}
      </div>
    </div>
  );
}

function AccountTab({
  identity,
  me,
  onRename,
  solo,
}: {
  identity: Identity;
  me: Me | null;
  onRename: (n: string) => void | Promise<unknown>;
  solo: boolean;
}) {
  const [name, setName] = useState(identity.name);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const dirty = name.trim() && name.trim() !== identity.name;

  return (
    <section className="flex flex-col gap-5">
      <div className={cn(surface, "flex items-center gap-3.5 px-4 py-4")}>
        <Avatar name={identity.name || "?"} id={identity.id} size={44} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-[var(--ink)]">{identity.name || "Unnamed"}</div>
          <div className="truncate text-[12.5px] text-[var(--text-muted)]">{isLocal() ? "On this computer" : me?.email || "No email on this account"}</div>
        </div>
      </div>

      <SettingsGroup title="Account">
        <SettingsRow
          label="Display name"
          htmlFor="settings-display-name"
          hint={solo ? "How Friday greets you, and the name on your sessions." : "Teammates see this the next time you join a session."}
          onSubmit={async () => {
            if (!dirty || saving) return;
            // "Saved" once the save has said so: it used to be said straight away, and a name the server refused stayed "Saved".
            setSaving(true);
            setErr("");
            try {
              await onRename(name.trim());
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            } catch (x) {
              setErr((x as Error).message || "Couldn't save the name. Try again.");
            } finally {
              setSaving(false);
            }
          }}
        >
          <Input id="settings-display-name" className="h-8 w-56 text-[13px]" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" type="submit" disabled={!dirty || saving}>
            {saving ? "Saving…" : saved ? "Saved" : "Save"}
          </Button>
        </SettingsRow>
      </SettingsGroup>
      <Note ok={false}>{err}</Note>

    </section>
  );
}


