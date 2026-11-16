import { AttachmentBuilder, type CommandContext, type TextChannel } from "stoatx";
import { PREFIX } from "../config.js";
import { downloadFiles } from "../files.js";
import { exportRules, MAX_IMPORT_BYTES, parseImport } from "../ruleFile.js";
import type { ImportReport } from "../RulesService.js";
import { argsAfterSub, NO_SUCH_RULE, replyChunks, wholeTarget, type Sub } from "./shared.js";

/*
  Moving rules between servers, and backups:  rule export [<rule>], rule import [replace]
  The file format lives in bot/ruleFile.ts.
*/

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "rule";

const exportCmd: Sub = async ({ ctx, rules, serverId, rest }) => {
  const { target } = wholeTarget(rest);
  const one = target ? await rules.find(serverId, target) : undefined;
  if (target && !one) {
    await ctx.reply(NO_SUCH_RULE);
    return;
  }
  const picked = one ? [one] : await rules.list(serverId);
  if (!picked.length) {
    await ctx.reply("No rules to export yet.");
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const fileName = target ? `rule-${slug(picked[0].name)}-${date}.json` : `rules-${date}.json`;
  const channel = (await ctx.client.channels.fetch(ctx.channelId)) as TextChannel;
  await channel.send({
    content:
      `Exported ${picked.length === 1 ? `**${picked[0].name}**` : `${picked.length} rules`}. ` +
      `To load ${picked.length === 1 ? "it" : "them"} into a server, attach this file to \`${PREFIX}rule import\`.`,
    attachments: [new AttachmentBuilder(Buffer.from(exportRules(picked)), fileName)],
    replies: [{ id: ctx.message.id, mention: false }],
  });
};

const importCmd: Sub = async ({ ctx, rules, serverId }) => {
  const raw = argsAfterSub(ctx, true).trim(); // raw: pasted JSON may contain curly quotes on purpose
  const replace = /^replace\b/i.test(raw);
  const pasted = replace ? raw.replace(/^replace\b/i, "").trim() : raw;
  const text = await readImport(ctx, pasted);
  if (!text.ok) {
    await ctx.reply(text.error);
    return;
  }
  const parsed = parseImport(text.text);
  if (!parsed.ok) {
    await ctx.reply(`Couldn't import: ${parsed.error}.`);
    return;
  }
  const report = await rules.importRules(serverId, parsed.rules, { replace, by: ctx.authorId });
  await replyChunks(ctx, importSummary(report, replace));
};

/** The JSON to import: the attached file, or JSON pasted after the command. */
async function readImport(ctx: CommandContext, pasted: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const file = ctx.message.attachments?.[0];
  if (!file) {
    if (pasted) return { ok: true, text: pasted };
    return { ok: false, error: `Attach a rules file (from \`${PREFIX}rule export\`) to the \`${PREFIX}rule import\` message.` };
  }
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: `That file is too big (max ${MAX_IMPORT_BYTES / 1024} KB).` };
  const { builders, skipped } = await downloadFiles(
    [{ name: file.filename, url: file.url, size: file.size }],
    { maxBytes: MAX_IMPORT_BYTES },
  );
  if (!builders.length) return { ok: false, error: `Couldn't read the file: ${skipped[0] ?? "unknown error"}.` };
  return { ok: true, text: Buffer.from(builders[0].file as Buffer).toString("utf8") };
}

function importSummary(r: ImportReport, replace: boolean): string {
  const names = (list: string[]) => list.map((n) => `**${n}**`).join(", ");
  const lines: string[] = [];
  if (r.added.length) lines.push(`✅ Imported ${r.added.length}: ${names(r.added)}`);
  if (r.replaced.length) lines.push(`♻️ Replaced ${r.replaced.length}: ${names(r.replaced)}`);
  if (r.disabled.length) {
    lines.push(
      "⚠️ Imported but **turned off**, because they use channels this server doesn't have:",
      ...r.disabled.map((d) => `• **${d.name}**: ${d.channels.map((c) => `\`${c}\``).join(", ")}`),
      `Fix the channel ids in the file and import it again with \`${PREFIX}rule import replace\`, or remove the rule and add it again.`,
    );
  }
  if (r.skipped.length) {
    lines.push(`⏭️ Skipped ${r.skipped.length}:`, ...r.skipped.map((s) => `• **${s.name}**: ${s.reason}`));
    if (!replace && r.skipped.some((s) => s.reason.includes("already exists"))) {
      lines.push(`To overwrite rules with the same name, use \`${PREFIX}rule import replace\`.`);
    }
  }
  return lines.join("\n") || "Nothing was imported.";
}

export const transferCommands: Record<string, Sub> = { export: exportCmd, import: importCmd };
