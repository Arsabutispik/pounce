import type { z } from "zod";
import { ANY_GROUP } from "./evaluate.js";
import { actions, conditions, Registry, triggers } from "./registry.js";
import { MAX_COOLDOWN_MS, MAX_RULE_NAME, MESSAGE_TRIGGERS, type Block, type Rule } from "./types.js";

export function validateRule(rule: Rule): string[] {
  const errors: string[] = [];
  const name = rule.name?.trim() ?? "";
  if (!name) errors.push("A rule needs a name");
  else if (name.length > MAX_RULE_NAME) errors.push(`Rule name is too long (max ${MAX_RULE_NAME} characters)`);

  const triggerType = rule.trigger.type;
  const triggerDef = triggers.get(triggerType);
  if (!triggerDef) errors.push(`Unknown trigger "${triggerType}"`);
  else {
    const res = triggerDef.schema.safeParse(rule.trigger.params);
    if (!res.success) errors.push(`${triggerType}: ${res.error.issues.map((i) => i.message).join(", ")}`);
  }
  if (rule.actions.length === 0) errors.push("A rule needs at least one action");
  if (rule.cooldownMs !== undefined) {
    if (!Number.isInteger(rule.cooldownMs) || rule.cooldownMs < 1000) errors.push("Cooldown must be at least 1 second");
    else if (rule.cooldownMs > MAX_COOLDOWN_MS) errors.push("Cooldown can be at most 7 days");
  }
  if (rule.cooldownPerUser && !MESSAGE_TRIGGERS.includes(rule.trigger.type)) {
    errors.push('A "per user" cooldown needs a message or reaction rule (scheduled rules have no user)');
  }

  type Def = { schema: z.ZodTypeAny; triggers?: string[]; describe(p: any): string };
  const check = (kind: "condition" | "action", b: Block, reg: Registry<Def>) => {
    const def = reg.get(b.type);
    if (!def) return void errors.push(`Unknown ${kind} "${b.type}"`);
    const res = def.schema.safeParse(b.params);
    if (!res.success) return void errors.push(`${b.type}: ${res.error.issues.map((i) => i.message).join(", ")}`);
    if (def.triggers && !def.triggers.includes(triggerType)) {
      errors.push(`"${def.describe(res.data)}" can't be used with a ${triggerType} trigger (it needs a message)`);
    }
    return res.data;
  };

  const checkCondition = (b: Block): void => {
    if (b.type === ANY_GROUP) {
      const groups = (b.params as { anyOf?: Block[][] }).anyOf;
      if (!Array.isArray(groups) || groups.length < 2) {
        errors.push('"or" needs at least two alternatives');
        return;
      }
      groups.forEach((g) => g.forEach(checkCondition));
      return;
    }
    check("condition", b, conditions);
  };

  rule.conditions.forEach(checkCondition);
  rule.actions.forEach((a, i) => {
    check("action", a, actions);
    const def = actions.get(a.type);
    const parsed = def?.schema.safeParse(a.params);
    const problem = def?.check?.(parsed?.success ? parsed.data : a.params, triggerType, rule.actions, i);
    if (problem) errors.push(problem);
  });
  return errors;
}
