import { ANY_GROUP } from "./evaluate.js";
import { actions, conditions, triggers } from "./registry.js";
import { formatDuration } from "../shared/time.js";
import type { Block, Rule } from "./types.js";

/** Params with schema defaults applied (so "day is sunday" reads "... in UTC"); raw params if invalid. */
function parsed(schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }, params: unknown) {
  const res = schema.safeParse(params);
  return res.success ? res.data : params;
}

export function describeCondition(b: Block): string {
  let text: string;
  if (b.type === ANY_GROUP) {
    const groups = (b.params as { anyOf?: Block[][] }).anyOf ?? [];
    text = groups.map((g) => (g.length > 1 ? `(${g.map(describeCondition).join(" and ")})` : g.map(describeCondition).join(""))).join(" or ");
  } else {
    const def = conditions.get(b.type);
    text = def ? def.describe(parsed(def.schema, b.params)) : `unknown condition "${b.type}"`;
  }
  return b.not ? `not ${text}` : text;
}

export function describeAction(b: Block): string {
  const def = actions.get(b.type);
  return def ? def.describe(parsed(def.schema, b.params)) : `unknown action "${b.type}"`;
}

export function describeTrigger(b: Block): string {
  const def = triggers.get(b.type);
  return def ? def.describe(parsed(def.schema, b.params)) : `unknown trigger "${b.type}"`;
}

export type RuleSummary = { trigger: string; conditions: string[]; actions: string[]; cooldown?: string };

/** A plain-language view of a rule, for `rule show` and (later) the website. */
export function summarizeRule(rule: Rule): RuleSummary {
  return {
    trigger: describeTrigger(rule.trigger),
    conditions: rule.conditions.map(describeCondition),
    actions: rule.actions.map(describeAction),
    cooldown: rule.cooldownMs
      ? `${formatDuration(rule.cooldownMs)}${rule.cooldownPerUser ? " per user" : ""}`
      : undefined,
  };
}
