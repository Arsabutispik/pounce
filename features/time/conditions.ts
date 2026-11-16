import { z } from "zod";
import { conditions } from "../../engine/index.js";
import { DAYS, describeDays, hhmm, localParts, parseDays, toMinutes, tzSchema } from "../../shared/time.js";

// These work with every trigger: they only look at the event's timestamp.

conditions.register("time.day_is", {
  schema: z.object({ days: z.array(z.enum(DAYS)).min(1), tz: tzSchema }),
  test: (ev, p) => p.days.includes(localParts(ev.timestamp, p.tz).day),
  describe: (p) => {
    const d = describeDays(p.days);
    return `the day is ${/^(day|weekday|weekend day)$/.test(d) ? `a ${d}` : d} (${p.tz})`;
  },
  help: {
    usage: 'day is <days> [in "<timezone>"]',
    about: "Same day words as schedules (`saturday`, `sat,sun`, `weekday`, `weekend`). Works with every trigger.",
  },
  syntax: [
    { pattern: ["day", "is", "$word", "in", "$str"], build: ([d, tz]) => ({ days: parseDays(d), tz }) },
    { pattern: ["day", "is", "$word"], build: ([d]) => ({ days: parseDays(d) }) },
  ],
});

conditions.register("time.between", {
  schema: z.object({ from: hhmm, to: hhmm, tz: tzSchema }),
  test: (ev, p) => {
    const { minutes } = localParts(ev.timestamp, p.tz);
    const [a, b] = [toMinutes(p.from), toMinutes(p.to)];
    return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b; // supports overnight windows
  },
  describe: (p) => `time is between ${p.from} and ${p.to} (${p.tz})`,
  help: {
    usage: 'time between "<HH:MM>" to "<HH:MM>" [in "<timezone>"]',
    about: `24h times; the end minute isn't included. Overnight works: "22:00" to "06:00". Works with every trigger.`,
  },
  syntax: [
    { pattern: ["time", "between", "$str", "to", "$str", "in", "$str"], build: ([from, to, tz]) => ({ from, to, tz }) },
    { pattern: ["time", "between", "$str", "to", "$str"], build: ([from, to]) => ({ from, to }) },
  ],
});
