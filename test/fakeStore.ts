import type { Rule } from "../engine/index.js";
import type {
  HistoryEntry, HistoryInput, PostgresRuleStore, RuleStore, SavedCooldown, SavedFailure, ServerSettings,
} from "../db/PostgresRuleStore.js";

/** In-memory RuleStore for tests that don't need Postgres. Mirrors the Postgres store's behaviour. */
export class FakeStore implements RuleStore {
  rules = new Map<string, Rule>();
  fires = new Set<string>();
  clearedFires: string[] = [];
  cooldowns = new Map<string, SavedCooldown>();
  settings = new Map<string, string | null>();
  historyRows: HistoryEntry[] = [];
  failureRows = new Map<string, SavedFailure>(); // "ruleId|error"
  now = () => Date.now();

  /** RulesService is typed against the Postgres store; this fake has the same methods. */
  get asStore() {
    return this as unknown as PostgresRuleStore;
  }

  async load() { return [...this.rules.values()].map((r) => structuredClone(r)); }
  async save(r: Rule) { this.rules.set(r.id, structuredClone(r)); }
  async remove(id: string) {
    this.rules.delete(id); // like "on delete cascade"
    for (const k of this.cooldowns.keys()) if (k.startsWith(`${id}:`)) this.cooldowns.delete(k);
    for (const k of this.fires) if (k.startsWith(`${id}:`)) this.fires.delete(k);
    for (const [k, f] of this.failureRows) if (f.ruleId === id) this.failureRows.delete(k);
  }

  async claimFire(ruleId: string, messageId: string) {
    const k = `${ruleId}:${messageId}`;
    if (this.fires.has(k)) return false;
    this.fires.add(k);
    return true;
  }
  async clearFires(ruleId: string) {
    this.clearedFires.push(ruleId);
    for (const k of this.fires) if (k.startsWith(`${ruleId}:`)) this.fires.delete(k);
  }
  async pruneFires() { return 0; }

  async saveCooldown(ruleId: string, scope: string, until: number) {
    this.cooldowns.set(`${ruleId}:${scope}`, { ruleId, scope, until });
  }
  async loadCooldowns() { return [...this.cooldowns.values()].filter((c) => c.until > this.now()); }
  async pruneCooldowns() {
    let n = 0;
    for (const [k, c] of this.cooldowns) if (c.until <= this.now()) (this.cooldowns.delete(k), n++);
    return n;
  }

  async loadSettings(): Promise<ServerSettings[]> {
    return [...this.settings].map(([serverId, logChannelId]) => ({ serverId, logChannelId }));
  }
  async setLogChannel(serverId: string, channelId: string | null) { this.settings.set(serverId, channelId); }

  async addHistory(e: HistoryInput) { this.historyRows.push({ ...e, at: this.now() }); }
  async history(serverId: string, opts: { ruleId?: string; limit?: number } = {}) {
    return this.historyRows
      .filter((h) => h.serverId === serverId && (!opts.ruleId || h.ruleId === opts.ruleId))
      .reverse()
      .slice(0, opts.limit ?? 15);
  }
  async ruleIdByPastName(serverId: string, name: string) {
    const n = name.trim().toLowerCase();
    return [...this.historyRows].reverse().find((h) => h.serverId === serverId && h.ruleName.trim().toLowerCase() === n)?.ruleId;
  }

  async pruneHistory(days: number) {
    const cutoff = this.now() - days * 86_400_000;
    const newest = new Map<string, HistoryEntry>();
    for (const h of this.historyRows) newest.set(h.ruleId, h); // rows are in insertion order
    const before = this.historyRows.length;
    this.historyRows = this.historyRows.filter((h) => h.at >= cutoff || newest.get(h.ruleId) === h);
    return before - this.historyRows.length;
  }

  async saveFailure(f: SavedFailure) { this.failureRows.set(`${f.ruleId}|${f.error}`, { ...f }); }
  async loadFailures(perServer: number) {
    const byServer = new Map<string, SavedFailure[]>();
    for (const f of this.failureRows.values()) byServer.set(f.serverId, [...(byServer.get(f.serverId) ?? []), { ...f }]);
    return [...byServer.values()].flatMap((list) => list.sort((a, b) => b.last - a.last).slice(0, perServer));
  }
  async pruneFailures(days: number, perServer: number) {
    const keep = new Set((await this.loadFailures(perServer)).filter((f) => f.last >= this.now() - days * 86_400_000).map((f) => `${f.ruleId}|${f.error}`));
    let n = 0;
    for (const k of this.failureRows.keys()) if (!keep.has(k)) (this.failureRows.delete(k), n++);
    return n;
  }
}
