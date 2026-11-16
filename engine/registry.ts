import { z } from "zod";
import type { Block, Env, RuleEvent, RunState } from "./types.js";

/**
 * Text syntax for a block, declared next to the block itself.
 * Slots: "$str" (quoted string), "$chan" (<#id>), "$user" (<@id>), "$word" (bare word).
 * Anything else in `pattern` is a literal keyword. `build` returns the block's params.
 */
export type Syntax = {
  pattern: string[];
  build: (args: string[]) => Record<string, unknown>;
};

/**
 * What `!help` shows for a block. `usage` is the syntax with <placeholders> and [optional parts];
 * `about` explains it for someone writing rules. Every block with `syntax` needs one (a test checks).
 */
export type BlockHelp = { usage: string; about: string };

type BlockDef = {
  schema: z.ZodTypeAny;
  syntax?: Syntax[];
  help?: BlockHelp;
  /** Trigger types this block works with. Omit for "all". Message blocks say MESSAGE_TRIGGERS. */
  triggers?: string[];
  /** Human-readable one-liner, used by `rule show` / `rule test` and dry runs. */
  describe(params: any): string;
};

export type ConditionDef = BlockDef & {
  test(ev: RuleEvent, params: any): boolean;
};

export type ActionDef = BlockDef & {
  /** `run` is this rule run's shared state (e.g. the message an earlier `send` posted). */
  run(ev: RuleEvent, params: any, env: Env, run: RunState): Promise<unknown>;
  /**
   * Extra check when a rule is added; return an error message to reject it.
   * `actions` is the rule's full action list and `index` is this action's position in it,
   * for checks that depend on what runs before (e.g. "react to sent" needs an earlier send).
   */
  check?(params: any, trigger: string, actions: Block[], index: number): string | undefined;
};

export type TriggerDef = {
  schema: z.ZodTypeAny;
  syntax?: Syntax[];
  help?: BlockHelp;
  describe(params: any): string;
  /** Time-based triggers only: true if this trigger should fire during the minute containing `ts`. */
  isDue?(params: any, ts: number): boolean;
  /** Event triggers with params: does this event match (e.g. the right emoji)? Omit to match every event of the type. */
  matches?(params: any, ev: RuleEvent): boolean;
  /** Fire at most once per rule per message (e.g. a reaction threshold reached again after an unreact). */
  oncePerMessage?: boolean;
};

export class Registry<T> {
  private items = new Map<string, T>();
  register(type: string, def: T) {
    this.items.set(type, def);
  }
  get(type: string) {
    return this.items.get(type);
  }
  entries() {
    return [...this.items.entries()];
  }
}

export const conditions = new Registry<ConditionDef>();
export const actions = new Registry<ActionDef>();
export const triggers = new Registry<TriggerDef>();
