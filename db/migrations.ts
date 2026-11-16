/**
 * Ordered, append-only list of schema migrations. Never edit one that has shipped:
 * add a new entry instead. Kept as TypeScript strings so no .sql files need copying into dist/.
 */
export type Migration = { id: string; sql: string };

export const MIGRATIONS: Migration[] = [
  {
    id: "001_rules",
    sql: `
      create table rules (
        id             text primary key,
        server_id      text not null,
        name           text not null,
        enabled        boolean not null default true,
        schema_version integer not null,
        -- the full rule (trigger, conditions, actions, ...) is the source of truth;
        -- the columns above are copies kept for indexing and querying
        rule           jsonb not null,
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now()
      );

      create index rules_server_idx on rules (server_id);

      -- rule names are unique per server, case-insensitive (the engine checks this too)
      create unique index rules_server_name_uq on rules (server_id, lower(btrim(name)));
    `,
  },
  {
    id: "002_rule_fires",
    sql: `
      -- which messages a once-per-message rule (e.g. a reaction trigger) already fired on,
      -- so a restart doesn't repost a starred message
      create table rule_fires (
        rule_id    text not null references rules (id) on delete cascade,
        message_id text not null,
        fired_at   timestamptz not null default now(),
        primary key (rule_id, message_id)
      );

      create index rule_fires_fired_at_idx on rule_fires (fired_at);
    `,
  },
  {
    id: "003_rule_cooldowns",
    sql: `
      -- active cooldowns, so a restart doesn't let a "24h per user" rule run again early.
      -- scope is '' for a whole-rule cooldown, or the user id for "per user"
      create table rule_cooldowns (
        rule_id    text not null references rules (id) on delete cascade,
        scope      text not null,
        until      timestamptz not null,
        primary key (rule_id, scope)
      );

      create index rule_cooldowns_until_idx on rule_cooldowns (until);
    `,
  },
  {
    id: "004_server_settings",
    sql: `
      create table server_settings (
        server_id      text primary key,
        log_channel_id text, -- where rule failures are posted; null = don't post
        updated_at     timestamptz not null default now()
      );
    `,
  },
  {
    id: "005_rule_history",
    sql: `
      -- who changed which rule, and when. No foreign key: history outlives removed rules.
      create table rule_history (
        id        bigserial primary key,
        server_id text not null,
        rule_id   text not null,
        rule_name text not null,         -- the name at the time
        action    text not null,         -- added, edited, renamed, enabled, disabled, removed, imported, replaced
        user_id   text,                  -- who did it (null if unknown)
        detail    text,                  -- e.g. the new rule text, or "Old → New" for a rename
        at        timestamptz not null default now()
      );

      create index rule_history_server_idx on rule_history (server_id, at desc);
      create index rule_history_rule_idx on rule_history (rule_id, at desc);
    `,
  },
  {
    id: "006_rule_failures",
    sql: `
      -- recent rule failures for \`rule logs\`: one row per rule and error, repeats counted
      create table rule_failures (
        server_id text not null,
        rule_id   text not null references rules (id) on delete cascade,
        rule_name text not null,
        error     text not null,
        first_at  timestamptz not null,
        last_at   timestamptz not null,
        count     integer not null,
        primary key (rule_id, error)
      );

      create index rule_failures_server_idx on rule_failures (server_id, last_at desc);
    `,
  },
];
