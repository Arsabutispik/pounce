import { conditions } from "./registry.js";
import type { Block, RuleEvent } from "./types.js";

/** "group.any" = OR of AND-groups: params.anyOf = [[a, b], [c]] means (a AND b) OR c */
export const ANY_GROUP = "group.any";

export function evalCondition(c: Block, ev: RuleEvent): boolean {
  let ok: boolean;
  if (c.type === ANY_GROUP) {
    const groups = (c.params as { anyOf: Block[][] }).anyOf;
    ok = groups.some((g) => g.every((x) => evalCondition(x, ev)));
  } else {
    const def = conditions.get(c.type)!;
    // parse() applies schema defaults (e.g. tz = "UTC"), which raw params don't have
    ok = def.test(ev, def.schema.parse(c.params));
  }
  return c.not ? !ok : ok;
}
