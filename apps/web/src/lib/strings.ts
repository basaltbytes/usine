import { BrainSpec } from "@usine/core/agent/brain";
import type { BillingPool } from "@usine/core/agent/session";
import type { LoopView } from "@usine/orchestrator/operator";

export const brainLine = (brain: BrainSpec): string =>
  `${brain.harness} · ${brain.model} · ${brain.effort}`;

/** Returns the label of a Loop trigger, using the Item kind names from Board cards. */
export const triggerLabel = (trigger: LoopView["trigger"]): string => {
  switch (trigger) {
    case "issue":
      return "Issue";
    case "pr":
      return "PR";
    case "schedule":
      return "Schedule";
    default:
      return trigger;
  }
};

/** Returns the time since `since` in the largest whole unit: `now`, `12m`, `3h`, or `2d`. */
export const elapsedLabel = (since: string, now: number = Date.now()): string => {
  const elapsed = Math.max(0, now - Date.parse(since));
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
};

/** Returns the time since `instant` as a phrase: `just now` or `12m ago`. */
export const agoLabel = (instant: string, now: number): string => {
  const elapsed = elapsedLabel(instant, now);
  return elapsed === "now" ? "just now" : `${elapsed} ago`;
};

/** Returns `instant` as a local date and minute, for example `2026-10-18 17:27`. */
export const timestampLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Returns `instant` as a local day and minute, for example `15 Oct 19:30`. */
export const dayTimeLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

/** Returns the local day of `date`, for example `22 Oct`. */
export const dayLabel = (date: Date): string => `${date.getDate()} ${MONTHS[date.getMonth()]}`;

/** Returns the local time of `instant` to the second, for example `19:31:03`. */
export const clockLabel = (instant: string): string => {
  const date = new Date(instant);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
};

/** Returns a duration in its largest useful units: `25s`, `22 min`, or `1 h 4 min`. */
export const durationLabel = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0
    ? `${Math.floor(minutes / 60)} h`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/** Returns a token count in compact notation: `950`, `27.3K`, or `1.2M`. */
export const tokensLabel = (tokens: number): string =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens);

/** Returns dollars to the cent, for example `$1.25`, or `under $0.01` for less than a cent. */
export const usdLabel = (usd: number): string =>
  usd > 0 && usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`;

export const harnessLabel = (harness: BrainSpec["harness"]): string =>
  ({ claude: "Claude Code", codex: "Codex", pi: "Pi" })[harness];

export const poolLabel = (pool: BillingPool): string =>
  ({ apiKeys: "API keys", claudePlan: "Claude plan", chatgptPlan: "ChatGPT plan" })[pool];

/** Returns the length of a rate-limit window, for example `7-day` or `5-hour`. */
export const windowLabel = (minutes: number): string =>
  minutes % 1440 === 0
    ? `${minutes / 1440}-day`
    : minutes % 60 === 0
      ? `${minutes / 60}-hour`
      : `${minutes}-minute`;

export const loadingPage = "Loading…";
export const pageUnavailable = "Could not load the page";
export const tryAgain = "Try again";

export const membersLabel = "Members";
export const tokensPageLabel = "Tokens";
export const signOutLabel = "Sign out";

export const repositoryFilterLabel = "Repository";
export const allRepositoriesLabel = "All repositories";
export const repositoryCountLabel = (count: number): string => `${count} repositories`;
