import { describeCondition } from "./describe.js";
import { evalCondition } from "./evaluate.js";
import { actions, triggers } from "./registry.js";
import { renderParams } from "./template.js";
import type { Env, Rule, RuleEvent, RuleMemory, RunState } from "./types.js";
import { validateRule } from "./validate.js";

export type RunReport = { ruleId: string; matched: boolean; steps: string[]; error?: string };

/** Result of testing one rule against a sample event, without acting. */
export type Simulation = {
  matched: boolean;
  conditions: { text: string; passed: boolean }[];
  steps: string[]; // what the actions would do
};

export class RuleEngine {
  private byTrigger = new Map<string, Rule[]>();
  private cooldownUntil = new Map<string, number>(); // "ruleId:" or "ruleId:userId" -> epoch ms (cache of memory)
  private firedOn = new Map<string, Set<string>>(); // oncePerMessage triggers: ruleId -> message ids (cache of memory)
  private lastMinute = new Map<string, number>(); // scheduled rules: never fire twice in one minute
  private budgets = new Map<string, { tokens: number; at: number }>(); // per-server rate limit (token bucket)

  /**
   * `burst` / `perSecond`: how many platform calls (sends + reacts) one server's rules may make: up to
   * `burst` at once, refilling at `perSecond`. This bounds any loop or amplification (50 rules x 5 actions)
   * no matter how it's triggered, and keeps one server from using up the bot's API rate limit for all.
   */
  constructor(
    private env: Env,
    private limits = { maxActions: 5, maxRulesPerServer: 50, burst: 30, perSecond: 3 },
    /** Optional durable store (fired messages, cooldowns); without it, memory only (forgotten on restart). */
    private memory?: RuleMemory,
  ) {}

  addRule(rule: Rule) {
    const errors = validateRule(rule);
    if (rule.actions.length > this.limits.maxActions) errors.push(`Max ${this.limits.maxActions} actions per rule`);
    const others = [...this.byTrigger.values()].flat().filter((r) => r.serverId === rule.serverId && r.id !== rule.id);
    if (others.length >= this.limits.maxRulesPerServer) errors.push("Too many rules in this server");
    const taken = others.some((r) => r.name.trim().toLowerCase() === rule.name?.trim().toLowerCase());
    if (taken) errors.push(`A rule named "${rule.name.trim()}" already exists in this server`);
    if (errors.length) throw new Error(errors.join("; "));

    // An edit that changes the trigger starts fresh: "already fired on this message" was about the old one.
    const previous = this.getRules().find((r) => r.id === rule.id);
    if (previous && JSON.stringify(previous.trigger) !== JSON.stringify(rule.trigger)) this.firedOn.delete(rule.id);

    this.removeRule(rule.id);
    const list = this.byTrigger.get(rule.trigger.type) ?? [];
    list.push(rule);
    this.byTrigger.set(rule.trigger.type, list);
  }

  /** Rules currently loaded in memory, optionally for one server. */
  getRules(serverId?: string): Rule[] {
    const all = [...this.byTrigger.values()].flat();
    return serverId ? all.filter((r) => r.serverId === serverId) : all;
  }

  removeRule(id: string) {
    for (const [k, list] of this.byTrigger) this.byTrigger.set(k, list.filter((r) => r.id !== id));
  }

  /**
   * Record that a once-per-message rule fires on this message. False if it already did (here or,
   * via `memory`, before a restart). The cache is marked before any await, so concurrent events in this
   * process can't both win. If the store is down, the cache alone decides: better than dropping the event.
   */
  private async claimMessage(ruleId: string, messageId: string): Promise<boolean> {
    const set = this.firedOn.get(ruleId) ?? new Set<string>();
    if (set.has(messageId)) return false;
    set.add(messageId);
    if (set.size > 1000) set.delete(set.values().next().value!); // Sets keep insertion order: drop the oldest
    this.firedOn.set(ruleId, set);
    if (!this.memory) return true;
    try {
      return await this.memory.claim(ruleId, messageId);
    } catch (e) {
      this.env.log(`[rule ${ruleId}] couldn't record firing (${(e as Error).message}); using memory only`);
      return true;
    }
  }

  /** Take one platform call from a server's budget; false if it's used up. */
  private spend(serverId: string, now: number): boolean {
    const { burst, perSecond } = this.limits;
    const b = this.budgets.get(serverId) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (Math.max(0, now - b.at) / 1000) * perSecond);
    b.at = Math.max(b.at, now);
    this.budgets.set(serverId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /**
   * The env a rule's actions get: every send/react is charged to the rule's server, and may only
   * target channels in that server. Enforced here, at run time, so it holds for every rule however it
   * was added (text, import, website, or edited in the database).
   */
  private guardedEnv(rule: Rule, ev: RuleEvent): Env {
    const check = async (channelId: string) => {
      if (!this.spend(rule.serverId, ev.timestamp)) throw new Error("rate limited: this server's rules are sending too much");
      if (channelId === ev.channelId && ev.serverId === rule.serverId) return; // where the event happened
      if ((await this.env.channelServerId(channelId)) !== rule.serverId) {
        throw new Error(`channel ${channelId} isn't in this server`);
      }
    };
    return {
      ...this.env,
      send: async (c, t, o) => (await check(c), this.env.send(c, t, o)),
      react: async (c, m, e) => (await check(c), this.env.react(c, m, e)),
    };
  }

  /** "" for a whole-rule cooldown, the author's id for "per user". */
  private cooldownScope = (rule: Rule, ev: RuleEvent) => (rule.cooldownPerUser ? ev.authorId : "");

  private onCooldown(rule: Rule, ev: RuleEvent): boolean {
    return !!rule.cooldownMs && (this.cooldownUntil.get(`${rule.id}:${this.cooldownScope(rule, ev)}`) ?? 0) > ev.timestamp;
  }

  private startCooldown(rule: Rule, ev: RuleEvent) {
    if (!rule.cooldownMs) return;
    if (this.cooldownUntil.size > 10_000) {
      for (const [k, until] of this.cooldownUntil) if (until <= ev.timestamp) this.cooldownUntil.delete(k);
    }
    const scope = this.cooldownScope(rule, ev);
    const until = ev.timestamp + rule.cooldownMs;
    this.cooldownUntil.set(`${rule.id}:${scope}`, until);
    // Saved in the background: a slow or failed write never delays or blocks the rule.
    this.memory?.saveCooldown?.(rule.id, scope, until).catch((e) =>
      this.env.log(`[rule ${rule.id}] couldn't save cooldown (${(e as Error).message}); it lasts until a restart`),
    );
  }

  /** Put back cooldowns saved before a restart (call after the rules are added). */
  restoreCooldowns(saved: { ruleId: string; scope: string; until: number }[]) {
    for (const c of saved) {
      const key = `${c.ruleId}:${c.scope}`;
      this.cooldownUntil.set(key, Math.max(this.cooldownUntil.get(key) ?? 0, c.until));
    }
  }

  /** Run every rule listening for this event (e.g. a new message). */
  async handle(ev: RuleEvent, opts: { dryRun?: boolean } = {}): Promise<RunReport[]> {
    // Loop protection: never react to bots (including ourselves). The per-server rate limit is the backstop.
    if (ev.authorIsBot) return [];

    const def = triggers.get(ev.type);
    const reports: RunReport[] = [];
    for (const rule of this.byTrigger.get(ev.type) ?? []) {
      if (rule.serverId !== ev.serverId) continue;
      if (def?.matches && !def.matches(def.schema.parse(rule.trigger.params), ev)) continue;
      const once = !!def?.oncePerMessage;
      if (once && this.firedOn.get(rule.id)?.has(ev.messageId)) continue; // fast path, no DB
      const report = await this.runRule(rule, ev, opts.dryRun ?? false, once);
      if (report) reports.push(report);
    }
    return reports;
  }

  /**
   * Run scheduled rules that are due. Call about every 15-30 seconds; a rule fires at most once per minute.
   * Anything missed while the bot was offline is not replayed.
   */
  async tick(now = Date.now()): Promise<RunReport[]> {
    const minute = Math.floor(now / 60_000);
    const reports: RunReport[] = [];
    for (const [type, list] of this.byTrigger) {
      const def = triggers.get(type);
      if (!def?.isDue) continue;
      for (const rule of list) {
        if (!rule.enabled || !def.isDue(def.schema.parse(rule.trigger.params), now)) continue;
        if (this.lastMinute.get(rule.id) === minute) continue;
        this.lastMinute.set(rule.id, minute);
        const report = await this.runRule(rule, scheduledEvent(rule, now), false);
        if (report) reports.push(report);
      }
    }
    return reports;
  }

  /** "Would this rule fire for this event, and why / why not?" Never acts, ignores enabled and cooldown. */
  simulate(rule: Rule, ev: RuleEvent): Simulation {
    const conds = rule.conditions.map((c) => ({ text: describeCondition(c), passed: evalCondition(c, ev) }));
    const steps = rule.actions.map((a) => {
      const def = actions.get(a.type);
      if (!def) return `unknown action "${a.type}"`;
      try {
        return def.describe(def.schema.parse(renderParams(a.params, ev)));
      } catch (e) {
        return `${a.type}: invalid (${(e as Error).message})`;
      }
    });
    return { matched: conds.every((c) => c.passed), conditions: conds, steps };
  }

  private async runRule(rule: Rule, ev: RuleEvent, dryRun: boolean, oncePerMessage = false): Promise<RunReport | null> {
    if (!rule.enabled) return null;
    if (!rule.conditions.every((c) => evalCondition(c, ev))) return null;
    if (this.onCooldown(rule, ev)) return null;
    if (!dryRun) {
      // Claim only once the rule would really run, so a message skipped by a condition or cooldown can fire later.
      if (oncePerMessage && !(await this.claimMessage(rule.id, ev.messageId))) return null;
      this.startCooldown(rule, ev);
    }

    const report: RunReport = { ruleId: rule.id, matched: true, steps: [] };
    const state: RunState = {}; // per run: e.g. the message `send` posted, for `react ... to sent`
    const env = this.guardedEnv(rule, ev);
    for (const a of rule.actions) {
      const def = actions.get(a.type)!;
      try {
        // render templates first, then validate (applies defaults, enforces limits on the final text)
        const params = def.schema.parse(renderParams(a.params, ev));
        if (dryRun) report.steps.push(def.describe(params));
        else {
          await def.run(ev, params, env, state);
          report.steps.push(`ran ${a.type}`);
        }
      } catch (e) {
        report.error = `${a.type} failed: ${(e as Error).message}`;
        break; // stop the rule on first failure
      }
    }
    this.env.log(`[rule ${rule.id}] ${report.steps.join(" | ")}${report.error ? " ERROR " + report.error : ""}`);
    return report;
  }
}

/** The event a scheduled rule runs with: no message, no author. */
function scheduledEvent(rule: Rule, now: number): RuleEvent {
  return {
    type: rule.trigger.type,
    serverId: rule.serverId,
    channelId: "",
    messageId: "",
    authorId: "",
    authorIsBot: false,
    content: "",
    mentionedChannelIds: [],
    authorName: "",
    attachments: [],
    authorRoles: [],
    timestamp: now,
  };
}
