import {
  Stoat,
  SimpleCommand,
  Arg,
  MissingArgumentError,
  type CommandContext,
  type CommandValidationError,
} from "stoatx";
import { PREFIX } from "./config.js";
import { RulesService } from "./RulesService.js";
import { auditCommands } from "./rule/audit.js";
import { manageCommands } from "./rule/manage.js";
import { argsAfterSub, type Sub } from "./rule/shared.js";
import { transferCommands } from "./rule/transfer.js";

/*
  The `rule` command: routes `rule <sub> ...` to its handler. The handlers live in bot/rule/:
    manage.ts    add, list, show, test, enable, disable, edit, rename, remove
    audit.ts     history, logs, logs channel
    transfer.ts  export, import
  Adding a subcommand: write a `Sub` in one of those files (or a new one), add it to that file's map,
  and to USAGE below (and to the `commands` topic in bot/helpText.ts).

  Usage (needs the Manage Server permission). <rule> is a rule's id or name. Names with spaces need "quotes" only
  in test and rename, where more text follows; curly quotes (“ ”) count as quotes.

    !rule add ["Name"] when <conditions> do <actions>
    !rule add ["Name"] every sunday at 09:00 in "Europe/Istanbul" do send "..." to <#channel>
    !rule add ["Name"] on reaction "⭐" reaches 3 do send "{message}" to <#channel> with masquerade and files
    Any rule can end with: with cooldown 5m [per user]
    !rule list
    !rule show <rule>
    !rule test <rule> <sample message>
    !rule enable <rule>      !rule disable <rule>
    !rule edit <rule> <new rule text>  keeps id, on/off and (unless the text has a new "name") name
    !rule rename <rule> New name here
    !rule remove <rule>
    !rule history [<rule>]            who changed what (also for removed rules)
    !rule logs                        recent rule failures
    !rule logs channel #channel|off   also post new failures in a channel
    !rule export [<rule>]             all rules (or one) as a .json file
    !rule import [replace]            attach an exported file (or paste its JSON)
*/

const SUBCOMMANDS: Record<string, Sub> = { ...manageCommands, ...auditCommands, ...transferCommands };

const USAGE = [
  '`rule add ["name"] <rule>`',
  "`rule list`",
  "`rule show <rule>`",
  "`rule test <rule> <sample message>`",
  "`rule enable <rule>` / `rule disable <rule>`",
  "`rule edit <rule> <new rule text>`",
  "`rule rename <rule> <new name>`",
  "`rule remove <rule>`",
  "`rule history [<rule>]` / `rule logs` / `rule logs channel #channel|off`",
  "`rule export [<rule>]` / `rule import [replace]` (attach the file)",
].join("\n") + `\nHow rules work, with examples: \`${PREFIX}help\``;

@Stoat()
export class RuleCommands {
  constructor(private readonly rules: RulesService) {}

  @SimpleCommand({
    name: "rule",
    description: "Manage automation rules",
    permissions: ["ManageServer"],
  })
  async rule(@Arg({ required: true }) action: string, ctx: CommandContext): Promise<void> {
    const serverId = ctx.serverId;
    if (!serverId) {
      await ctx.reply("Rules only work inside a server.");
      return;
    }
    const sub = action.toLowerCase();
    const handler = Object.hasOwn(SUBCOMMANDS, sub) ? SUBCOMMANDS[sub] : undefined;
    if (!handler) {
      await ctx.reply(`Commands:\n${USAGE}`);
      return;
    }
    await handler({ ctx, rules: this.rules, serverId, sub, rest: argsAfterSub(ctx) });
  }

  async onValidationError(ctx: CommandContext, error: CommandValidationError): Promise<void> {
    if (error instanceof MissingArgumentError) {
      await ctx.reply(`Missing required argument: \`<${error.paramName}>\`\n${USAGE}`);
      return;
    }
    await ctx.reply(`⚠️ ${error.message}`);
  }

  async onError(ctx: CommandContext, error: Error): Promise<void> {
    console.error(error);
    await ctx.reply("Something went wrong. Please try again later.");
  }
}
