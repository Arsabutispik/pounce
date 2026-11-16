import { z } from "zod";

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** IANA timezone name, defaults to UTC. */
export const tzSchema = z
  .string()
  .default("UTC")
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone (use an IANA name like Europe/Istanbul)");

/** "HH:MM", 24h. */
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM (24h)");

export const toMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/** Weekday + minutes-since-midnight for a timestamp, in the given timezone. */
export function localParts(ts: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    day: get("weekday").toLowerCase().slice(0, 3),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const ALL_DAYS = [...DAYS];
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const WEEKEND = ["sat", "sun"];
const FULL: Record<string, string> = {
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday",
};

/**
 * Text -> day list. Accepts "sunday", "sat,sun" (first 3 letters used), and the groups
 * "day"/"daily", "weekday(s)" and "weekend(s)". Unknown words pass through and fail schema validation.
 */
export function parseDays(s: string): string[] {
  const out = new Set<string>();
  for (const raw of s.split(",")) {
    const d = raw.trim().toLowerCase();
    if (["day", "days", "daily", "everyday"].includes(d)) ALL_DAYS.forEach((x) => out.add(x));
    else if (["weekday", "weekdays"].includes(d)) WEEKDAYS.forEach((x) => out.add(x));
    else if (["weekend", "weekends"].includes(d)) WEEKEND.forEach((x) => out.add(x));
    else out.add(d.slice(0, 3));
  }
  return [...out];
}

/** ["mon",...,"fri"] -> "weekday"; all seven -> "day"; otherwise "Sunday and Monday". */
export function describeDays(days: string[]): string {
  const set = new Set(days);
  const same = (g: string[]) => g.length === set.size && g.every((d) => set.has(d));
  if (same(ALL_DAYS)) return "day";
  if (same(WEEKDAYS)) return "weekday";
  if (same(WEEKEND)) return "weekend day";
  const names = ALL_DAYS.filter((d) => set.has(d)).map((d) => FULL[d]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "?");
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s", "5m", "2h", "1d", or combined like "1h30m" -> milliseconds. Undefined if it isn't a duration. */
export function parseDuration(s: string): number | undefined {
  const m = s.toLowerCase().match(/^(?:\d+[smhd])+$/);
  if (!m) return undefined;
  let total = 0;
  for (const [, n, unit] of s.toLowerCase().matchAll(/(\d+)([smhd])/g)) total += Number(n) * UNIT_MS[unit];
  return total;
}

/** Milliseconds -> "1h30m" (largest units first, zero parts left out). */
export function formatDuration(ms: number): string {
  let rest = Math.round(ms / 1000) * 1000;
  let out = "";
  for (const unit of ["d", "h", "m", "s"]) {
    const n = Math.floor(rest / UNIT_MS[unit]);
    if (n) out += `${n}${unit}`;
    rest -= n * UNIT_MS[unit];
  }
  return out || "0s";
}
