import { Injectable } from "stoatx";
import type { Rule } from "../engine/index.js";
import { Database } from "./Database.js";

/** What RulesService needs from storage. Rules are plain JSON, so any backend can implement this. */
export interface RuleStore {
  load(): Promise<Rule[]>;
  save(rule: Rule): Promise<void>;
  remove(id: string): Promise<void>;
  /** Record that a rule fired on a message; false if it already had. Atomic. */
  claimFire(ruleId: string, messageId: string): Promise<boolean>;
  /** Forget every firing of one rule (its trigger changed). */
  clearFires(ruleId: string): Promise<void>;
  /** Forget firings older than `days`. Returns how many were removed. */
  pruneFires(days: number): Promise<number>;

  /** Cooldowns: saved as they start, loaded at startup (only those still running). */
  saveCooldown(ruleId: string, scope: string, until: number): Promise<void>;
  loadCooldowns(): Promise<SavedCooldown[]>;
  pruneCooldowns(): Promise<number>;

  /** Per-server settings. */
  loadSettings(): Promise<ServerSettings[]>;
  setLogChannel(serverId: string, channelId: string | null): Promise<void>;

  /** Rule history. */
  addHistory(entry: HistoryInput): Promise<void>;
  history(serverId: string, opts?: { ruleId?: string; limit?: number }): Promise<HistoryEntry[]>;
  /** The id a rule had when it was called `name` most recently (also for removed rules). */
  ruleIdByPastName(serverId: string, name: string): Promise<string | undefined>;
  /** Forget history older than `days`, but always keep each rule's newest entry. */
  pruneHistory(days: number): Promise<number>;

  /** Rule failures (`rule logs`): one row per rule + error, upserted. */
  saveFailure(f: SavedFailure): Promise<void>;
  /** The newest `perServer` failures of every server. */
  loadFailures(perServer: number): Promise<SavedFailure[]>;
  /** Forget failures not seen for `days`, and all but the newest `perServer` per server. */
  pruneFailures(days: number, perServer: number): Promise<number>;
}

export type SavedFailure = {
  serverId: string; ruleId: string; ruleName: string; error: string; first: number; last: number; count: number;
};

export type SavedCooldown = { ruleId: string; scope: string; until: number };
export type ServerSettings = { serverId: string; logChannelId: string | null };
export type HistoryAction = "added" | "edited" | "renamed" | "enabled" | "disabled" | "removed" | "imported" | "replaced";
export type HistoryInput = {
  serverId: string;
  ruleId: string;
  ruleName: string;
  action: HistoryAction;
  userId?: string;
  detail?: string;
};
export type HistoryEntry = HistoryInput & { at: number };

/** Thrown when a save would take over a rule id that belongs to a different server. */
export class RuleIdTakenError extends Error {}

@Injectable()
export class PostgresRuleStore implements RuleStore {
  constructor(private readonly db: Database) {}

  async load(): Promise<Rule[]> {
    const { rows } = await this.db.query<{ rule: Rule }>("select rule from rules order by created_at, id");
    return rows.map((r) => r.rule);
  }

  /** Insert or update. An existing id may only be updated by the server that owns it. */
  async save(rule: Rule): Promise<void> {
    const res = await this.db.query(
      `insert into rules (id, server_id, name, enabled, schema_version, rule)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (id) do update
         set name = excluded.name,
             enabled = excluded.enabled,
             schema_version = excluded.schema_version,
             rule = excluded.rule,
             updated_at = now()
         where rules.server_id = excluded.server_id`,
      [rule.id, rule.serverId, rule.name, rule.enabled, rule.schemaVersion, JSON.stringify(rule)],
    );
    if (res.rowCount === 0) throw new RuleIdTakenError(`Rule id "${rule.id}" is already used by another server`);
  }

  async remove(id: string): Promise<void> {
    await this.db.query("delete from rules where id = $1", [id]); // its rule_fires go with it (on delete cascade)
  }

  async claimFire(ruleId: string, messageId: string): Promise<boolean> {
    const res = await this.db.query(
      "insert into rule_fires (rule_id, message_id) values ($1, $2) on conflict do nothing",
      [ruleId, messageId],
    );
    return res.rowCount === 1;
  }

  async clearFires(ruleId: string): Promise<void> {
    await this.db.query("delete from rule_fires where rule_id = $1", [ruleId]);
  }

  async pruneFires(days: number): Promise<number> {
    const res = await this.db.query("delete from rule_fires where fired_at < now() - make_interval(days => $1)", [days]);
    return res.rowCount ?? 0;
  }

  async saveCooldown(ruleId: string, scope: string, until: number): Promise<void> {
    await this.db.query(
      `insert into rule_cooldowns (rule_id, scope, until) values ($1, $2, to_timestamp($3 / 1000.0))
       on conflict (rule_id, scope) do update set until = excluded.until`,
      [ruleId, scope, until],
    );
  }

  async loadCooldowns(): Promise<SavedCooldown[]> {
    const { rows } = await this.db.query<{ rule_id: string; scope: string; until_ms: string }>(
      "select rule_id, scope, (extract(epoch from until) * 1000)::bigint as until_ms from rule_cooldowns where until > now()",
    );
    return rows.map((r) => ({ ruleId: r.rule_id, scope: r.scope, until: Number(r.until_ms) }));
  }

  async pruneCooldowns(): Promise<number> {
    return (await this.db.query("delete from rule_cooldowns where until <= now()")).rowCount ?? 0;
  }

  async loadSettings(): Promise<ServerSettings[]> {
    const { rows } = await this.db.query<{ server_id: string; log_channel_id: string | null }>(
      "select server_id, log_channel_id from server_settings",
    );
    return rows.map((r) => ({ serverId: r.server_id, logChannelId: r.log_channel_id }));
  }

  async setLogChannel(serverId: string, channelId: string | null): Promise<void> {
    await this.db.query(
      `insert into server_settings (server_id, log_channel_id) values ($1, $2)
       on conflict (server_id) do update set log_channel_id = excluded.log_channel_id, updated_at = now()`,
      [serverId, channelId],
    );
  }

  async addHistory(e: HistoryInput): Promise<void> {
    await this.db.query(
      "insert into rule_history (server_id, rule_id, rule_name, action, user_id, detail) values ($1, $2, $3, $4, $5, $6)",
      [e.serverId, e.ruleId, e.ruleName, e.action, e.userId ?? null, e.detail ?? null],
    );
  }

  async history(serverId: string, opts: { ruleId?: string; limit?: number } = {}): Promise<HistoryEntry[]> {
    const { rows } = await this.db.query<{
      rule_id: string; rule_name: string; action: HistoryAction; user_id: string | null; detail: string | null; at_ms: string;
    }>(
      `select rule_id, rule_name, action, user_id, detail, (extract(epoch from at) * 1000)::bigint as at_ms
       from rule_history where server_id = $1 and ($2::text is null or rule_id = $2)
       order by at desc, id desc limit $3`,
      [serverId, opts.ruleId ?? null, opts.limit ?? 15],
    );
    return rows.map((r) => ({
      serverId, ruleId: r.rule_id, ruleName: r.rule_name, action: r.action,
      userId: r.user_id ?? undefined, detail: r.detail ?? undefined, at: Number(r.at_ms),
    }));
  }

  async pruneHistory(days: number): Promise<number> {
    const res = await this.db.query(
      `delete from rule_history h
       where h.at < now() - make_interval(days => $1)
         and exists (select 1 from rule_history n where n.rule_id = h.rule_id and (n.at, n.id) > (h.at, h.id))`,
      [days],
    );
    return res.rowCount ?? 0;
  }

  async saveFailure(f: SavedFailure): Promise<void> {
    await this.db.query(
      `insert into rule_failures (server_id, rule_id, rule_name, error, first_at, last_at, count)
       values ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), $7)
       on conflict (rule_id, error) do update
         set rule_name = excluded.rule_name, last_at = excluded.last_at, count = excluded.count`,
      [f.serverId, f.ruleId, f.ruleName, f.error, f.first, f.last, f.count],
    );
  }

  async loadFailures(perServer: number): Promise<SavedFailure[]> {
    const { rows } = await this.db.query<{
      server_id: string; rule_id: string; rule_name: string; error: string; first_ms: string; last_ms: string; count: number;
    }>(
      `select server_id, rule_id, rule_name, error, count,
              (extract(epoch from first_at) * 1000)::bigint as first_ms,
              (extract(epoch from last_at) * 1000)::bigint as last_ms
       from (select *, row_number() over (partition by server_id order by last_at desc) as n from rule_failures) f
       where n <= $1`,
      [perServer],
    );
    return rows.map((r) => ({
      serverId: r.server_id, ruleId: r.rule_id, ruleName: r.rule_name, error: r.error,
      first: Number(r.first_ms), last: Number(r.last_ms), count: r.count,
    }));
  }

  async pruneFailures(days: number, perServer: number): Promise<number> {
    const res = await this.db.query(
      `delete from rule_failures f
       where f.last_at < now() - make_interval(days => $1)
          or (f.rule_id, f.error) in (
            select rule_id, error from (
              select rule_id, error, row_number() over (partition by server_id order by last_at desc) as n from rule_failures
            ) ranked where n > $2)`,
      [days, perServer],
    );
    return res.rowCount ?? 0;
  }

  async ruleIdByPastName(serverId: string, name: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ rule_id: string }>(
      `select rule_id from rule_history where server_id = $1 and lower(btrim(rule_name)) = lower(btrim($2))
       order by at desc, id desc limit 1`,
      [serverId, name],
    );
    return rows[0]?.rule_id;
  }
}
