import { z } from "zod";
import { triggers } from "../../engine/index.js";
import { DAYS, describeDays, hhmm, localParts, parseDays, toMinutes, tzSchema } from "../../shared/time.js";

/*
  every <days> at HH:MM [in "<timezone>"]

    every sunday at 09:00 in "Europe/Istanbul" do send "Post your small wins!" to <#channel>
    every weekday at 17:30 do send "Stand-up time" to <#channel>

  Fires once per matching minute while the bot is running; nothing is replayed after downtime.
*/
triggers.register("schedule", {
  schema: z.object({ days: z.array(z.enum(DAYS)).min(1), at: hhmm, tz: tzSchema }),
  describe: (p) => `every ${describeDays(p.days)} at ${p.at} (${p.tz})`,
  isDue: (p, ts) => {
    const now = localParts(ts, p.tz);
    return p.days.includes(now.day) && now.minutes === toMinutes(p.at);
  },
  help: {
    usage: 'every <days> at <HH:MM> [in "<timezone>"]',
    about: "Runs at a set time. Days: `sunday`, `mon,wed,fri` (commas, no spaces), `weekday`, `weekend` or `day` (every day). Time is 24h. Timezone is a name like \"Europe/Istanbul\" (default UTC). Runs while the bot is online; missed times aren't made up. There is no message, so `send` must say `to #channel`, and message checks and templates don't apply.",
  },
  syntax: [
    { pattern: ["every", "$word", "at", "$word", "in", "$str"], build: ([d, at, tz]) => ({ days: parseDays(d), at, tz }) },
    { pattern: ["every", "$word", "at", "$word"], build: ([d, at]) => ({ days: parseDays(d), at }) },
  ],
});
