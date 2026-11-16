import { randomUUID } from "node:crypto";
import { Injectable } from "stoatx";
import "../features/index.js"; // registers all blocks (and their text syntax)
import { PostgresRuleStore, type HistoryEntry, type HistoryInput, type SavedFailure } from "../db/PostgresRuleStore.js";
import { Env, Rule, RuleEngine, RuleEvent, type RunReport, type Simulation } from "../engine/index.js";
import { parseRule } from "../parser/index.js";
import { channelRefs, type PortableRule } from "./ruleFile.js";

export type AddResult = { ok: true; rule: Rule } | { ok: false; error: string };

export type ImportReport = {
  added: string[];
  replaced: string[];
  skipped: { name: string; reason: string }[];
  /** Imported but turned off: they point at channels this server doesn't have. */
  disabled: { name: string; channels: string[] }[];
};

/** A rule that went wrong, for `rule logs` and the log channel. One per rule + error; repeats are counted. */
export type Failure = { ruleId: string; ruleName: string; error: string; first: number; last: number; count: number };
type TrackedFailure = Failure & { savedAt: number };

const PG_UNIQUE_VIOLATION = "23505";
const FAILURES_KEPT = 50; // per server, in memory and in the database
const FAILURES_KEEP_DAYS = 30; // a failure not seen for this long is forgotten
const REPEAT_WINDOW_MS = 10 * 60 * 1000; // a failure is posted again only if it was quiet this long
const FAILURE_SAVE_MS = 60 * 1000; // repeats are written to the database at most this often
const LOG_POSTS_PER_HOUR = 20; // per server, so a broken rule can't flood the log channel
const HISTORY_KEEP_DAYS = 365; // older history is pruned, except each rule's newest entry

/**
 * How long "this reaction rule already fired on this message" is remembered. After that, an old
 * message could fire again (only if its reaction count lands on the threshold again).
 */
const FIRES_KEEP_DAYS = 90;

/**
 * Owns the rule engine and keeps it in sync with the database.
 * Reads come from memory (fast, no DB hit per chat message). Writes also go to the database;
 * if saving fails, the in-memory change is rolled back so memory and DB never disagree.
 */
@Injectable()
export class RulesService {
  private engine?: RuleEngine;
  private env?: Env;
  private initPromise?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;
  private failures = new Map<string, TrackedFailure[]>(); // serverId -> failures (cache of the database)
  private logChannels = new Map<string, string>(); // serverId -> channel id
  private logPosts = new Map<string, { hour: number; count: number }>();

  constructor(private readonly store: PostgresRuleStore) {}

  /** Call once at startup with a platform adapter (send/react/log). Loads every saved rule. */
  async init(env: Env) {
    // Reaction rules fire once per message; the store remembers that across restarts.
    this.env = env;
    this.engine = new RuleEngine(env, undefined, {
      claim: (ruleId, messageId) => this.store.claimFire(ruleId, messageId),
      saveCooldown: (ruleId, scope, until) => this.store.saveCooldown(ruleId, scope, until),
    });
    for (const rule of await this.store.load()) {
      try {
        this.engine.addRule(rule);
      } catch (e) {
        // e.g. a block was removed since the rule was saved. Skip it, don't take the bot down.
        console.error(`Skipping saved rule ${rule.id} (${rule.name}): ${(e as Error).message}`);
      }
    }
    // Cooldowns still running from before the restart, and server settings. Neither is worth failing startup over.
    this.engine.restoreCooldowns(await this.store.loadCooldowns().catch(warn("loading cooldowns", [])));
    for (const s of await this.store.loadSettings().catch(warn("loading server settings", []))) {
      if (s.logChannelId) this.logChannels.set(s.serverId, s.logChannelId);
    }
    for (const f of await this.store.loadFailures(FAILURES_KEPT).catch(warn("loading rule failures", []))) {
      const { serverId, ...failure } = f;
      this.failures.set(serverId, [...(this.failures.get(serverId) ?? []), { ...failure, savedAt: f.last }]);
    }
    console.log(`Loaded ${this.engine.getRules().length} rule(s).`);
  }

  /** Idempotent init: safe to call from several places; only the first call loads rules. */
  ensureInit(env: Env): Promise<void> {
    this.initPromise ??= this.init(env);
    return this.initPromise;
  }

  /**
   * Check for due scheduled rules every 15 seconds (a rule never fires twice in the same minute),
   * and once a day clean up: reaction firings older than FIRES_KEEP_DAYS, cooldowns that have run out,
   * failures not seen for FAILURES_KEEP_DAYS, and history older than HISTORY_KEEP_DAYS.
   */
  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.e
        .tick()
        .then((reports) => this.noteFailures(reports))
        .catch((err) => console.error("scheduler error:", err));
    }, 15_000);
    this.timer.unref();

    const prune = () =>
      Promise.all([
        this.store.pruneFires(FIRES_KEEP_DAYS),
        this.store.pruneCooldowns(),
        this.store.pruneFailures(FAILURES_KEEP_DAYS, FAILURES_KEPT),
        this.store.pruneHistory(HISTORY_KEEP_DAYS),
      ]).catch((err) => console.error("prune error:", err));
    void prune();
    this.pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);
    this.pruneTimer.unref();
  }

  private get e() {
    if (!this.engine) throw new Error("RulesService.init(env) was not called");
    return this.engine;
  }

  /** Called from the bot's event handlers (new message, reaction added). */
  async handleEvent(ev: RuleEvent) {
    const reports = await this.e.handle(ev);
    this.noteFailures(reports);
    return reports;
  }

  // ---------- failures: `rule logs` and the log channel ----------

  /**
   * Remember failed runs (in memory and the database) and post them to the server's log channel:
   * a new failure right away, a repeat only after it was quiet for REPEAT_WINDOW_MS. Never throws.
   */
  private noteFailures(reports: RunReport[]) {
    const now = Date.now();
    for (const report of reports) {
      if (!report.error) continue;
      const rule = this.e.getRules().find((r) => r.id === report.ruleId);
      if (!rule) continue;
      const list = this.failures.get(rule.serverId) ?? [];
      let f = list.find((x) => x.ruleId === rule.id && x.error === report.error);
      const quietSince = f ? now - f.last : Infinity;
      if (f) {
        f.count++;
        f.last = now;
        f.ruleName = rule.name;
      } else {
        f = { ruleId: rule.id, ruleName: rule.name, error: report.error, first: now, last: now, count: 1, savedAt: 0 };
        list.push(f);
        if (list.length > FAILURES_KEPT) list.splice(list.indexOf(list.reduce((a, b) => (a.last <= b.last ? a : b))), 1);
        this.failures.set(rule.serverId, list);
      }
      // Write new failures at once, repeats at most once a minute: a rule failing on every message
      // shouldn't mean a database write per message. (A crash loses at most a minute of counting.)
      if (now - f.savedAt >= FAILURE_SAVE_MS) {
        f.savedAt = now;
        const { savedAt: _, ...failure } = f;
        this.store.saveFailure({ serverId: rule.serverId, ...failure }).catch((e) => console.error("Failed to save rule failure:", e));
      }
      if (quietSince >= REPEAT_WINDOW_MS) void this.postFailure(rule, report.error, now);
    }
  }

  private async postFailure(rule: Rule, error: string, now: number) {
    const channel = this.logChannels.get(rule.serverId);
    if (!channel) return;
    const hour = Math.floor(now / 3_600_000);
    const posts = this.logPosts.get(rule.serverId);
    const count = posts?.hour === hour ? posts.count : 0;
    if (count >= LOG_POSTS_PER_HOUR) return; // still listed in `rule logs`
    this.logPosts.set(rule.serverId, { hour, count: count + 1 });
    const text = `⚠️ Rule **${rule.name}** (\`${rule.id}\`) failed: ${error}`;
    await this.env!.send(channel, text).catch((e) => console.error(`Couldn't post to log channel ${channel}:`, e));
  }

  /** Recent failures in a server, most recent first. Saved, so they survive a restart. */
  recentFailures(serverId: string): Failure[] {
    return (this.failures.get(serverId) ?? [])
      .map(({ savedAt: _, ...f }) => f)
      .sort((a, b) => b.last - a.last);
  }

  logChannel(serverId: string): string | undefined {
    return this.logChannels.get(serverId);
  }

  /** Post rule failures to a channel in this server, or stop (null). */
  async setLogChannel(serverId: string, channelId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
    if (channelId && (await this.env!.channelServerId(channelId)) !== serverId) {
      return { ok: false, error: "That channel isn't in this server." };
    }
    try {
      await this.store.setLogChannel(serverId, channelId);
    } catch (e) {
      console.error("Failed to save log channel:", e);
      return { ok: false, error: "Couldn't save that right now. Please try again." };
    }
    if (channelId) this.logChannels.set(serverId, channelId);
    else this.logChannels.delete(serverId);
    return { ok: true };
  }

  // ---------- history ----------

  /** Record a change. History is a convenience: failing to write it never fails the change itself. */
  private async record(entry: HistoryInput) {
    await this.store.addHistory(entry).catch((e) => console.error("Failed to write rule history:", e));
  }

  /**
   * A server's recent rule changes, or one rule's. `idOrName` may also be the name of a removed rule,
   * or a rule's old name.
   */
  async history(serverId: string, idOrName?: string, limit = 15): Promise<HistoryEntry[] | undefined> {
    if (!idOrName) return this.store.history(serverId, { limit });
    const ruleId = (await this.find(serverId, idOrName))?.id ?? (await this.store.ruleIdByPastName(serverId, idOrName));
    const byId = ruleId ?? idOrName.trim();
    const entries = await this.store.history(serverId, { ruleId: byId, limit });
    return entries.length ? entries : undefined;
  }

  /** True if any loaded rule uses this trigger, so handlers can skip work nobody listens for. */
  hasTrigger(type: string) {
    return this.e.getRules().some((r) => r.trigger.type === type);
  }

  dryRun(ev: RuleEvent) {
    return this.e.handle(ev, { dryRun: true });
  }

  /** Text entry point (chat command). `by` is who's adding it, for the history. */
  async addFromText(serverId: string, text: string, by?: string): Promise<AddResult> {
    const parsed = parseRule(text, { id: randomUUID().slice(0, 8), serverId });
    if (!parsed.ok) return parsed;
    const res = await this.addRule(parsed.rule);
    if (res.ok) await this.record({ serverId, ruleId: res.rule.id, ruleName: res.rule.name, action: "added", userId: by, detail: res.rule.source });
    return res;
  }

  /**
   * Website entry point: POST the JSON rule, same validation path. Also used for edits and renames.
   * Doesn't write history; the callers above it do (they know what kind of change it is, and who made it).
   */
  async addRule(input: Rule): Promise<AddResult> {
    const rule: Rule = { ...input, name: input.name?.trim() };
    // A rule that's on may only use this server's channels (the engine also refuses at run time).
    if (rule.enabled) {
      const foreign = await this.foreignChannels(rule.serverId, rule);
      if (foreign.length) {
        const list = foreign.map((c) => `\`${c}\``).join(", ");
        return { ok: false, error: `This rule uses channels that aren't in this server: ${list}` };
      }
    }
    const previous = this.e.getRules().find((r) => r.id === rule.id);

    try {
      this.e.addRule(rule); // validates blocks, name, limits
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    try {
      await this.store.save(rule);
    } catch (err) {
      // roll the in-memory change back
      this.e.removeRule(rule.id);
      if (previous) this.e.addRule(previous);
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        return { ok: false, error: `A rule named "${rule.name}" already exists in this server` };
      }
      console.error("Failed to save rule:", err);
      return { ok: false, error: "Couldn't save the rule right now. Please try again." };
    }
    return { ok: true, rule };
  }

  /**
   * Add rules from an export file to a server. Each rule is validated like a new one and gets a fresh id.
   * - A rule whose name is taken is skipped, or with `replace`, overwrites the existing rule (keeping its id).
   * - A rule pointing at channels this server doesn't have (e.g. shared from another server) is added
   *   turned off, so it can't misfire before someone fixes it.
   */
  async importRules(
    serverId: string,
    rules: PortableRule[],
    opts: { replace?: boolean; by?: string } = {},
  ): Promise<ImportReport> {
    const report: ImportReport = { added: [], replaced: [], skipped: [], disabled: [] };
    const seen = new Set<string>();
    for (const r of rules) {
      const key = r.name.trim().toLowerCase();
      if (seen.has(key)) {
        report.skipped.push({ name: r.name, reason: "the file has another rule with this name" });
        continue;
      }
      seen.add(key);

      // By name only (not id): ids are per server, so a file's rules never match ours by id.
      const target = this.e.getRules(serverId).find((x) => x.name.trim().toLowerCase() === key);
      if (target && !opts.replace) {
        report.skipped.push({ name: r.name, reason: "a rule with this name already exists" });
        continue;
      }

      const missing = await this.foreignChannels(serverId, r);
      const rule: Rule = {
        ...r,
        id: target?.id ?? randomUUID().slice(0, 8),
        serverId,
        enabled: r.enabled && missing.length === 0,
      };
      const res = await this.addRule(rule);
      if (!res.ok) {
        report.skipped.push({ name: r.name, reason: res.error });
        continue;
      }
      (target ? report.replaced : report.added).push(res.rule.name);
      await this.record({
        serverId, ruleId: res.rule.id, ruleName: res.rule.name, action: target ? "replaced" : "imported",
        userId: opts.by, detail: res.rule.source,
      });
      if (missing.length && r.enabled) report.disabled.push({ name: res.rule.name, channels: missing });
    }
    return report;
  }

  /** Channels a rule points at that aren't in this server (deleted, or another server's). */
  private async foreignChannels(serverId: string, rule: Pick<Rule, "trigger" | "conditions" | "actions">) {
    const ids = channelRefs(rule);
    const owners = await Promise.all(ids.map((id) => this.env!.channelServerId(id)));
    return ids.filter((_, i) => owners[i] !== serverId);
  }

  async removeRule(id: string, by?: string) {
    const rule = this.e.getRules().find((r) => r.id === id);
    await this.store.remove(id); // DB first: if it fails, memory still matches the DB (its failures go too)
    this.e.removeRule(id);
    if (rule) this.failures.set(rule.serverId, (this.failures.get(rule.serverId) ?? []).filter((f) => f.ruleId !== id));
    // The rule's text goes in the history, so a removed rule can still be looked up (and added back).
    if (rule) await this.record({ serverId: rule.serverId, ruleId: id, ruleName: rule.name, action: "removed", userId: by, detail: rule.source });
  }

  /** Find a rule in a server by id or by name (case-insensitive). */
  async find(serverId: string, idOrName: string): Promise<Rule | undefined> {
    const key = idOrName.trim().toLowerCase();
    return this.e
      .getRules(serverId)
      .find((r) => r.id.toLowerCase() === key || r.name.trim().toLowerCase() === key);
  }

  /**
   * Replace what a rule does with new rule text, keeping its id and on/off state. The name stays unless
   * the text starts with a new "name". Changing the trigger also forgets which messages it fired on.
   */
  async editFromText(serverId: string, idOrName: string, text: string, by?: string): Promise<AddResult> {
    const old = await this.find(serverId, idOrName);
    if (!old) return { ok: false, error: "No rule with that id or name in this server." };
    const parsed = parseRule(text, { id: old.id, serverId, defaultName: old.name });
    if (!parsed.ok) return parsed;
    const res = await this.addRule({ ...parsed.rule, enabled: old.enabled });
    if (res.ok && JSON.stringify(old.trigger) !== JSON.stringify(res.rule.trigger)) {
      await this.store.clearFires(old.id).catch((e) => console.error("Couldn't clear fired messages:", e));
    }
    if (res.ok) {
      const renamed = res.rule.name !== old.name ? ` (renamed from "${old.name}")` : "";
      await this.record({ serverId, ruleId: old.id, ruleName: res.rule.name, action: "edited", userId: by, detail: `${res.rule.source ?? ""}${renamed}` });
    }
    return res;
  }

  /** Rename a rule. Goes through the same validation, so duplicates and bad names are rejected. */
  async rename(serverId: string, idOrName: string, newName: string, by?: string): Promise<AddResult> {
    const rule = await this.find(serverId, idOrName);
    if (!rule) return { ok: false, error: "No rule with that id or name in this server." };
    const res = await this.addRule({ ...rule, name: newName });
    if (res.ok && res.rule.name !== rule.name) {
      await this.record({ serverId, ruleId: rule.id, ruleName: res.rule.name, action: "renamed", userId: by, detail: `${rule.name} → ${res.rule.name}` });
    }
    return res;
  }

  async setEnabled(serverId: string, idOrName: string, enabled: boolean, by?: string): Promise<AddResult> {
    const rule = await this.find(serverId, idOrName);
    if (!rule) return { ok: false, error: "No rule with that id or name in this server." };
    const res = await this.addRule({ ...rule, enabled });
    if (res.ok && rule.enabled !== enabled) {
      await this.record({ serverId, ruleId: rule.id, ruleName: rule.name, action: enabled ? "enabled" : "disabled", userId: by });
    }
    return res;
  }

  /** Test a rule against a sample event without acting. Ignores enabled/cooldown. */
  async simulate(
    serverId: string,
    idOrName: string,
    ev: RuleEvent,
  ): Promise<{ ok: true; rule: Rule; result: Simulation } | { ok: false; error: string }> {
    const rule = await this.find(serverId, idOrName);
    if (!rule) return { ok: false, error: "No rule with that id or name in this server." };
    if (rule.trigger.type === "reaction.added" && !ev.reaction) {
      // Test a reaction rule as if the tester reacted to the sample message, at the rule's threshold.
      const p = rule.trigger.params as { emoji?: string; count?: number };
      ev = {
        ...ev,
        type: rule.trigger.type,
        reaction: { emoji: p.emoji ?? "", count: p.count ?? 1, userId: ev.authorId, userName: ev.authorName, userRoles: ev.authorRoles },
      };
    }
    return { ok: true, rule, result: this.e.simulate(rule, ev) };
  }

  async list(serverId: string) {
    return this.e.getRules(serverId);
  }
}

/** For `.catch()` on startup loads: log what failed and carry on with `fallback`. */
function warn<T>(what: string, fallback: T) {
  return (e: unknown) => {
    console.error(`Failed ${what}:`, e);
    return fallback;
  };
}
