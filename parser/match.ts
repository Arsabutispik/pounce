import type { Registry, Syntax } from "../engine/index.js";
import type { Block } from "../engine/index.js";
import type { Token } from "./tokenizer.js";

/** One flattened syntax entry, built from a block's own `syntax` declaration. */
export type Entry = { type: string; pattern: string[]; build: Syntax["build"] };

const SLOTS: Record<string, Token["kind"]> = { $str: "str", $chan: "chan", $user: "user", $word: "word" };

/** Collect every block's syntax from a registry. Longest patterns first, so
 *  `send $str to $chan` is tried before `send $str` without hand-ordering. */
export function buildTable<T extends { syntax?: Syntax[] }>(reg: Registry<T>): Entry[] {
  const out: Entry[] = [];
  for (const [type, def] of reg.entries())
    for (const s of def.syntax ?? []) out.push({ type, pattern: s.pattern, build: s.build });
  return out.sort((a, b) => b.pattern.length - a.pattern.length);
}

export function matchAt(tokens: Token[], i: number, table: Entry[]): { block: Block; next: number } | null {
  for (const e of table) {
    const args: string[] = [];
    let ok = true;
    for (let j = 0; j < e.pattern.length; j++) {
      const t = tokens[i + j];
      const p = e.pattern[j];
      if (!t) { ok = false; break; }
      const slot = SLOTS[p];
      if (slot) {
        if (t.kind !== slot) { ok = false; break; }
        args.push(t.v);
      } else if (t.kind !== "word" || t.v.toLowerCase() !== p) {
        ok = false;
        break;
      }
    }
    if (ok) return { block: { type: e.type, params: e.build(args) }, next: i + e.pattern.length };
  }
  return null;
}
