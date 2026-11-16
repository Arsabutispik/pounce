# Adding blocks to the rule engine

A **block** is one building piece of a rule: a condition (`message contains "x"`), an action (`reply "y"`), or a trigger. Each block lives in one place and declares everything about itself: its params schema, its logic, and its text syntax. The engine, the parser and the website never need to change when you add one.

```
rule  =  trigger  +  conditions (all must pass)  +  actions (run in order)
```

## How the pieces connect

| Piece | Where | Job |
|---|---|---|
| `engine/registry.ts` | `conditions`, `actions`, `triggers` registries | Holds every registered block |
| `features/<area>/…` | your block files | Register blocks (`register(type, def)`) |
| `features/index.ts` | one import per feature | Makes sure the block files actually run |
| `parser/` | reads each block's `syntax` | Turns text rules into the same JSON the website sends |
| `engine/validate.ts` | zod schemas | Rejects bad params when a rule is added |

Rules are plain JSON (`{ type, params, not? }` blocks), so the text parser and the website both produce the same thing. A block that works from one works from the other.

## Adding a condition

A condition is a pure yes/no check on the event. No network calls, no side effects.

```ts
// features/message/conditions.ts
import { z } from "zod";
import { conditions } from "../../engine/index.js";

conditions.register("message.longer_than", {
  triggers: MESSAGE_TRIGGERS,                     // needs a message; omit if it works with every trigger
  schema: z.object({ n: z.number().int().min(1) }),
  test: (ev, p) => ev.content.length > p.n,
  describe: (p) => `message is longer than ${p.n} characters`,   // shown by `rule show` / `rule test`
  syntax: [
    { pattern: ["message", "longer", "than", "$word"], build: ([n]) => ({ n: Number(n) }) },
  ],
});
```

Text: `when message longer than 500 do ...`

- `type` is `area.name`, lowercase with underscores. It is stored in saved rules, so renaming it later breaks existing rules.
- `test` receives `params` already parsed by `schema`, so defaults (like `tz = "UTC"`) are applied.
- `describe` is required: it is how `rule show` and `rule test` explain the rule in plain language.
- `triggers` lists the trigger types the block works with. A rule that pairs it with a different trigger (say, a message condition on a scheduled rule) is rejected when added. Leave it out for blocks that only use the timestamp, like the time conditions.
- `not` works on every condition for free (`when not message longer than 500`).

## Adding an action

An action does something in the world. It can be async and may throw; the engine stops the rule at the first failure and logs it.

```ts
// features/message/actions.ts
actions.register("message.delete", {
  schema: z.object({}),
  run: (ev, _p, env) => env.delete(ev.channelId, ev.messageId),
  describe: () => "delete the message",   // shown in dry runs and `rule test`
  triggers: MESSAGE_TRIGGERS,             // there is no message to delete on a scheduled rule
  syntax: [{ pattern: ["delete", "message"], build: () => ({}) }],
});
```

If an action works with some trigger types but needs extra input for others, add `check(params, trigger, actions, index)` and return an error message. `message.send` uses it: on a scheduled rule there is no "same channel", so it must say `to <#channel>`. `actions` is the rule's whole action list and `index` is this action's position in it, for checks that depend on what runs earlier (see `react ... to sent` below).

`run` gets a fourth argument, `run: RunState`: state shared by the actions of one rule run, in order, and created fresh for every run. Today it holds `sent`, the `{ channelId, messageId }` of the most recent message this run posted with `message.send`. Never keep per-run data on `RuleEvent` or in module variables.

- `describe` is required. It is what dry runs print instead of acting.
- String params get template expansion before `run`: `{author}`, `{channel}`, `{message}`, `{message.id}`. Templates are validated after expansion, so a `max(2000)` limit applies to the final text.
- Anything the action needs from the platform goes through `env`, never through direct client calls. That keeps the engine free of stoatx and testable.

### Example: `send` with masquerade and files

`message.send` shows how an action takes optional parts. Its syntax patterns are generated, so one action covers every spelling:

```
send "{message}" to <#channel> with masquerade and files
```

- `with masquerade` posts under the original author's name and avatar (the bot needs the Masquerade permission in that channel; names are cut to 32 characters).
- `with files` re-uploads the original message's attachments (max 5 files, 20 MB each; files that can't be copied are listed in a note on the message).
- Both copy from the triggering message, so `check` rejects them on scheduled rules.
- The platform side is `SendOptions` in `engine/types.ts`, passed as the third argument of `env.send(channelId, text, opts)` and implemented in `makeEnv` (`bot/events.ts`) and `bot/files.ts`.
- `env.send` returns `{ channelId, messageId }` of the posted message. `message.send` stores it in `run.sent`.

### Example: reacting to the message the rule sent

```
when message contains "SWS" do send "{message}" to <#chan> with masquerade and files then react "🎉" then react "🎉" to sent
```

- `react "🎉"` reacts to the triggering message (params `{ emoji }`, `target` defaults to `"message"`).
- `react "🎉" to sent` reacts to the most recent message this run posted with `send` (params `{ emoji, target: "sent" }`). `reply` does not count.
- `check` rejects `to sent` unless a `message.send` comes earlier in the same rule. It also rejects plain `react` on a scheduled rule (there is no message), while `to sent` works there. That is why `message.react` has no `triggers` list: the restriction depends on `target`.
- If nothing was sent when it runs, the action throws, and the engine logs it like any other failure. A failed send already stops the rule before it gets there.
- Emoji: a single unicode emoji (`"🎉"`) or a Stoat custom emoji id (`"01J9Z8…"`, optionally as `":01J9Z8…:"`). Anything else is rejected when the rule is added.
- The bot needs the React permission in the channel it reacts in. Dry runs and `rule test` print `react with 🎉 to the sent message` and never call `env`.

### When an action needs a new platform capability

`message.delete` above needs `env.delete`, which does not exist yet. Add it in three places:

1. `engine/types.ts`: add `delete(channelId: string, messageId: string): Promise<void>;` to `Env`.
2. `bot/events.ts`, in `makeEnv`: implement it with the real client, e.g. `(await channel.messages.fetch(messageId)).delete()`.
3. `test/smoke.ts` and `test/store.ts`: add a `delete` stub to the fake `Env`s, or TypeScript will fail the build. (Fake `send`s must return a `{ channelId, messageId }`.)

## Syntax patterns

`pattern` is a list of tokens matched left to right:

| Token | Matches | Gives `build` |
|---|---|---|
| any plain word (`"message"`, `"to"`) | that keyword, case-insensitive | nothing |
| `"$str"` | a quoted string `"like this"` | the text, unquoted |
| `"$chan"` | a channel mention `<#id>` | the channel id |
| `"$word"` | one bare word | the word |

`build` gets the captured values as strings, in order, and returns the block's `params`.

- **Several forms:** give several patterns. The parser tries longer patterns first on its own, so `send $str to $chan` always beats `send $str`. You do not order them by hand.
- **Numbers:** there is no number slot. Capture `$word` and convert in `build` (`Number(n)`). The schema's `z.number()` rejects `abc` when the rule is added.
- **Lists:** capture one `$word` and split it, like `day is sat,sun`.
- **Optional parts:** write two patterns, one with the extra tokens (like `in "<tz>"`) and one without.
- **New slot types:** add the token kind in `parser/tokenizer.ts` and a line in `SLOTS` in `parser/match.ts`. Existing slots: `$str`, `$chan` (`<#id>`), `$user` (`<@id>`), `$word`.
- **Avoid collisions:** two blocks must not start with identical token sequences, or the earlier one wins. Check existing patterns before choosing words.

## Adding a whole feature area

Use a folder when blocks belong together (`features/member/`, `features/reaction/`).

```
features/member/
  conditions.ts
  actions.ts
  index.ts        →  import "./conditions.js"; import "./actions.js";
```

Then add one line to `features/index.ts`:

```ts
import "./member/index.js";
```

Shared helpers (timezone schema, regex escaping) go in `shared/`, but only once a second feature needs them.

## Adding a new trigger

Triggers live in their own registry, so a trigger is a block like the others.

```ts
// features/schedule/triggers.ts  (the built-in weekly/daily trigger)
triggers.register("schedule", {
  schema: z.object({ days: z.array(z.enum(DAYS)).min(1), at: hhmm, tz: tzSchema }),
  describe: (p) => `every ${describeDays(p.days)} at ${p.at} (${p.tz})`,
  isDue: (p, ts) => { /* true during the minute this trigger should fire */ },
  syntax: [
    { pattern: ["every", "$word", "at", "$word", "in", "$str"], build: ([d, at, tz]) => ({ days: parseDays(d), at, tz }) },
    { pattern: ["every", "$word", "at", "$word"], build: ([d, at]) => ({ days: parseDays(d), at }) },
  ],
});
```

Text: `every sunday at 09:00 in "Europe/Istanbul" do send "..." to <#channel>`

There are two kinds:

- **Time-based** (like `schedule`): give it `isDue`. The bot calls `engine.tick()` every 15 seconds, and a rule fires at most once per minute. Nothing is replayed after downtime. The event has no message, so message fields are empty (`""`, `[]`, `0`) and message blocks are rejected on these rules by their `triggers` list.
- **Event-based** (like `reaction.added`, or a member joining): the bot emits it. Add an `@On(...)` handler in `bot/events.ts` that builds a `RuleEvent` with your new `type` and calls `rules.handleEvent(ev)`. If the event carries data the current `RuleEvent` lacks, add an optional field to it (`engine/types.ts`), as `reaction` does. Two optional hooks:
  - `matches(params, ev)`: does this event fit the rule's trigger params (e.g. the right emoji, the threshold count)? Without it, every event of the type matches.
  - `oncePerMessage: true`: the engine fires each rule at most once per message id. The engine's optional `FiredLog` (the `rule_fires` table, via `PostgresRuleStore.claimFire`) remembers this across restarts, with an in-memory cache in front. The claim happens only once conditions and cooldown pass, and if the database is down the engine falls back to memory instead of dropping the event. Rows older than 90 days are pruned daily.

  If your event is about a message (content, author and attachments are filled in), add its type to `MESSAGE_TRIGGERS` in `engine/types.ts` so message conditions and actions work with it.

### Example: `reaction.added`

`features/reaction/triggers.ts`: `on reaction "⭐" reaches 3`. `bot/toEvent.ts` (`toReactionEvent`) turns the reacted message into the event's message and puts who reacted in `ev.reaction`, so `send "{message}" ... with masquerade and files` reposts the starred message, and `{reactor}` / `reactor has role "Mod"` look at the person reacting. Reactions on bot messages and reactions by bots are dropped there, so a starboard never stars its own reposts.

The grammar already understands any trigger that declares `syntax`: a rule may start with `when` (every new message) or with a trigger's own keyword, optionally followed by `when <conditions>`.

## Testing a block

Add a case to `test/smoke.ts`, or a new file next to it:

```ts
const p = parseRule(`when message longer than 5 do delete message`, { id: "a", serverId: "s" });
assert(p.ok, p.ok ? "" : p.error);
engine.addRule(p.rule);
await engine.handle(ev({ content: "this is long" }));
assert.deepEqual(deleted, ["c/m"]);
```

- Fake the clock with the `timestamp` field on the event (and pass a time to `engine.tick(now)` for scheduled rules); never call `Date.now()` inside a block.
- Use `{ dryRun: true }` or `engine.simulate(rule, ev)` to check what a rule would do without a real client. Simulation also reports which conditions passed, which is what `rule test` shows.
- Run `mise run check` (typecheck, then tests).

## Rules of thumb

- **Conditions are pure.** No I/O, no state. If you need state (a counter, a cooldown), it belongs in the engine or a service, not in `test`.
- **Params are the contract.** The website sends JSON that must pass the same zod schema, so keep schemas strict and error messages human-readable (they are shown to users).
- **Never change a published `type`.** Add a new block and keep the old one working.
- **Limits live in the engine** (`maxActions`, `maxRulesPerServer`, the per-server rate limit `burst` / `perSecond`, cooldowns). Actions get a guarded `env`: every `send` / `react` is charged to the rule's server and may only target that server's channels, so a new action that posts somewhere inherits both checks for free. Do not add your own loops inside actions. Cooldown is a rule setting, not a block: the grammar reads `with cooldown 5m [per user]` after the last action into `rule.cooldownMs` / `rule.cooldownPerUser`.
- **Imports end in `.js`.** The project compiles to ESM, even though the files are `.ts`.
- **User-supplied regexes need a guard.** `message.matches` uses `regexProblem()` (`shared/text.ts`). It is best-effort, not a proof; do not accept patterns elsewhere without it.

## Checklist

- [ ] `register(type, { schema, test|run, describe, syntax, triggers?, check? })` in a feature file
- [ ] The file is imported from the feature's `index.ts`, and the feature from `features/index.ts`
- [ ] If it needs the platform: `Env` updated in `engine/types.ts`, `bot/events.ts`, and the test fake
- [ ] A text syntax example works end to end
- [ ] A test covers the match, a non-match, and a bad param
- [ ] `mise run check` passes
