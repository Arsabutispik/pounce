import { Stoat, SimpleCommand, type CommandContext } from "stoatx";
import { PREFIX } from "./config.js";
import { CHANNEL_MAX, findTopic, overview, splitMessage, TOPICS } from "./helpText.js";

/*
  !help            short overview, in the channel
  !help <topic>    a topic: in the channel if it's short, otherwise by DM (with a one-line note in the channel)
  !help all        every topic, by DM

  Used in a DM with the bot, everything is answered right there.
*/
@Stoat()
export class HelpCommands {
  @SimpleCommand({ name: "help", description: "How to use the bot", aliases: ["commands"] })
  async help(ctx: CommandContext): Promise<void> {
    const arg = ctx.content.slice(ctx.prefix.length).trim().split(/\s+/).slice(1).join(" ").toLowerCase();

    if (!arg) {
      await ctx.reply(overview(PREFIX));
      return;
    }
    if (arg === "all") {
      await this.deliver(ctx, "everything", TOPICS.map((t) => t.text(PREFIX)));
      return;
    }
    const topic = findTopic(arg);
    if (!topic) {
      await ctx.reply(`No help topic "${arg.slice(0, 40)}". Topics: ${TOPICS.map((t) => `\`${t.key}\``).join(", ")}, \`all\`.`);
      return;
    }
    await this.deliver(ctx, topic.title, [topic.text(PREFIX)]);
  }

  /** Post short text in place; send long text by DM so the channel isn't flooded. */
  private async deliver(ctx: CommandContext, title: string, pages: string[]) {
    const chunks = pages.flatMap((page) => splitMessage(page)); // each page starts a new message
    const inDm = !ctx.serverId;
    if (inDm || (chunks.length === 1 && chunks[0].length <= CHANNEL_MAX)) {
      for (const c of chunks) await ctx.reply(c);
      return;
    }
    try {
      const dm = await ctx.client.users.createDM(ctx.authorId);
      for (const c of chunks) await dm.send(c);
    } catch {
      await ctx.reply(
        `I couldn't DM you the **${title}** help. Allow DMs from this server's members, or message me \`${PREFIX}help\` directly.`,
      );
      return;
    }
    await ctx.reply(`📬 Sent **${title}** to your DMs.`);
  }
}
