/**
 * The issue inbox: what is on your plate in GitHub and Linear, read into one list, each one a session away (Arun, 2026-10-25:
 * every open-source tool of this kind lists your issues with a Start button; ours starts a Friday session, plan first).
 *
 * GitHub issues are read by the person's own computer with its GitHub login (runner/workspace.ts), the way Code Review reads
 * pull requests. Linear issues come through the workspace's Linear key (Settings · Integrations), as the key's own assigned
 * issues. What is pure lives here, so the browser and the tests read an issue the same way the runner and the server do.
 */

export interface InboxIssue {
  source: "github" | "linear";
  /** The same key issue-hooks.ts gives a labelled issue, so a session the label started is found for it. */
  key: string;
  /** "owner/repo#12" or "ENG-42". */
  ref: string;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  createdAt?: string;
  author?: string;
  avatar?: string;
  labels: { name: string; color?: string }[];
  /** GitHub: the repo and number the session's issue field takes. */
  repo?: string;
  number?: number;
  comments?: number;
  assignees?: string[];
  /** Linear: where it stands, as its team's workflow names it. */
  state?: string;
  stateType?: "triage" | "backlog" | "unstarted" | "started";
  /** Linear: 1 urgent … 4 low; 0 none. */
  priority?: number;
  priorityLabel?: string;
  milestone?: string;
}

export interface GithubIssues {
  available: boolean;
  account?: string;
  reason?: string;
  /** Open, assigned to you. */
  assigned: InboxIssue[];
  /** Open, opened by you, not assigned to you. */
  authored: InboxIssue[];
}

export interface LinearIssues {
  available: boolean;
  account?: string;
  reason?: string;
  issues: InboxIssue[];
}

/** The two GitHub searches, as its own search box would take them. */
export function issueSearches(): { assigned: string; authored: string } {
  return {
    assigned: "is:issue is:open assignee:@me archived:false sort:updated-desc",
    authored: "is:issue is:open author:@me -assignee:@me archived:false sort:updated-desc",
  };
}

export const ISSUE_QUERY = `query($assigned: String!, $authored: String!) {
  viewer { login }
  assigned: search(query: $assigned, type: ISSUE, first: 40) { nodes { ...I } }
  authored: search(query: $authored, type: ISSUE, first: 25) { nodes { ...I } }
}
fragment I on Issue {
  number title url body createdAt updatedAt
  repository { nameWithOwner }
  author { login avatarUrl }
  labels(first: 10) { nodes { name color } }
  assignees(first: 6) { nodes { login } }
  comments { totalCount }
  milestone { title }
}`;

type GhNode = {
  number?: number; title?: string; url?: string; body?: string | null; createdAt?: string; updatedAt?: string;
  repository?: { nameWithOwner?: string }; author?: { login?: string; avatarUrl?: string } | null;
  labels?: { nodes?: { name?: string; color?: string }[] }; assignees?: { nodes?: { login?: string }[] };
  comments?: { totalCount?: number }; milestone?: { title?: string } | null;
};

function ghList(nodes?: GhNode[]): InboxIssue[] {
  // A search can turn up something that isn't an issue (an empty node); those are left out.
  return (nodes ?? [])
    .filter((n) => n.url && n.number && n.repository?.nameWithOwner)
    .map((n) => {
      const repo = n.repository!.nameWithOwner!;
      const assignees = (n.assignees?.nodes ?? []).map((a) => a.login).filter((x): x is string => !!x);
      return {
        source: "github" as const,
        key: `gh:${repo}#${n.number}`,
        ref: `${repo}#${n.number}`,
        title: n.title ?? `Issue #${n.number}`,
        body: (n.body ?? "").slice(0, 20_000),
        url: n.url!,
        updatedAt: n.updatedAt ?? "",
        ...(n.createdAt ? { createdAt: n.createdAt } : {}),
        ...(n.author?.login ? { author: n.author.login } : {}),
        ...(n.author?.avatarUrl ? { avatar: n.author.avatarUrl } : {}),
        labels: (n.labels?.nodes ?? []).filter((l) => l.name).map((l) => ({ name: l.name!, ...(l.color ? { color: `#${l.color.replace(/^#/, "")}` } : {}) })),
        repo,
        number: n.number!,
        comments: n.comments?.totalCount ?? 0,
        ...(assignees.length ? { assignees } : {}),
        ...(n.milestone?.title ? { milestone: n.milestone.title } : {}),
      };
    });
}

/** GitHub's answer to ISSUE_QUERY, as the two lists the inbox shows. */
export function issuesFromGraphql(j: unknown): Omit<GithubIssues, "available"> {
  const d = (j as { data?: { viewer?: { login?: string }; assigned?: { nodes?: GhNode[] }; authored?: { nodes?: GhNode[] } } } | null)?.data;
  return { ...(d?.viewer?.login ? { account: d.viewer.login } : {}), assigned: ghList(d?.assigned?.nodes), authored: ghList(d?.authored?.nodes) };
}

/** The Linear key's own open assigned issues, newest change first. */
export const LINEAR_QUERY = `query {
  viewer { name displayName
    assignedIssues(first: 50, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { id identifier title description url priority priorityLabel createdAt updatedAt
        state { name type } team { key } labels { nodes { name color } } creator { name } comments { nodes { id } } }
    }
  }
}`;

type LinearNode = {
  id?: string; identifier?: string; title?: string; description?: string | null; url?: string; priority?: number; priorityLabel?: string;
  createdAt?: string; updatedAt?: string; state?: { name?: string; type?: string } | null; labels?: { nodes?: { name?: string; color?: string }[] };
  creator?: { name?: string } | null; comments?: { nodes?: { id?: string }[] };
};

/** Linear's answer to LINEAR_QUERY, as the inbox's list. */
export function linearIssuesFrom(j: unknown): Omit<LinearIssues, "available"> {
  const v = (j as { data?: { viewer?: { name?: string; displayName?: string; assignedIssues?: { nodes?: LinearNode[] } } } } | null)?.data?.viewer;
  const issues = (v?.assignedIssues?.nodes ?? [])
    .filter((n) => n.id && n.url)
    .map((n) => {
      const t = n.state?.type;
      const stateType: InboxIssue["stateType"] = t === "triage" || t === "backlog" || t === "unstarted" || t === "started" ? t : undefined;
      return {
        source: "linear" as const,
        key: `linear:${n.id}`,
        ref: n.identifier ?? n.id!,
        title: n.title ?? n.identifier ?? "Linear issue",
        body: (n.description ?? "").slice(0, 20_000),
        url: n.url!,
        updatedAt: n.updatedAt ?? "",
        ...(n.createdAt ? { createdAt: n.createdAt } : {}),
        ...(n.creator?.name ? { author: n.creator.name } : {}),
        labels: (n.labels?.nodes ?? []).filter((l) => l.name).map((l) => ({ name: l.name!, ...(l.color ? { color: l.color } : {}) })),
        ...(n.state?.name ? { state: n.state.name } : {}),
        ...(stateType ? { stateType } : {}),
        ...(typeof n.priority === "number" ? { priority: n.priority } : {}),
        ...(n.priorityLabel ? { priorityLabel: n.priorityLabel } : {}),
        comments: n.comments?.nodes?.length ?? 0,
      };
    });
  return { ...(v?.displayName || v?.name ? { account: v.displayName || v.name } : {}), issues };
}

/**
 * What goes in the box when Start work is pressed: a GitHub issue's link first, which the box reads as the task (the branch and
 * the pull request are named after it, and the pull request closes it); a Linear issue in full, since the box can't read Linear.
 * Plan first either way: an issue is a request, not a design.
 */
export function issueBrief(i: InboxIssue): string {
  if (i.source === "github") return `${i.url}\n\nRead the code first and propose a plan before changing anything.`;
  const body = i.body.trim();
  return [`Work on Linear issue ${i.ref}: ${i.title}`, body ? `\n${body.slice(0, 6000)}` : "", `\n---\n${i.url}\nRead the code first and propose a plan before changing anything.`].join("\n");
}

/** One line on where an issue stands, for its row. */
export function issueStanding(i: InboxIssue): string {
  const parts: string[] = [];
  if (i.source === "linear") {
    if (i.state) parts.push(i.state);
    if (i.priority && i.priorityLabel && i.priorityLabel !== "No priority") parts.push(i.priorityLabel);
  } else if (i.milestone) parts.push(i.milestone);
  if (i.comments) parts.push(`${i.comments} comment${i.comments === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Searching the inbox: the title, the ref, the labels. */
export function issueMatches(i: InboxIssue, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return `${i.title} ${i.ref} ${i.labels.map((l) => l.name).join(" ")} ${i.state ?? ""}`.toLowerCase().includes(needle);
}
