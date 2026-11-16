import { z } from "zod";
import { conditions, MESSAGE_TRIGGERS } from "../../engine/index.js";

conditions.register("author.has_role", {
  triggers: MESSAGE_TRIGGERS,
  schema: z.object({ role: z.string().min(1) }),
  // Matches the role's name (case-insensitive) or its id.
  test: (ev, p) => {
    const want = p.role.trim().toLowerCase();
    return ev.authorRoles.some((r) => r.id.toLowerCase() === want || r.name.trim().toLowerCase() === want);
  },
  describe: (p) => `author has the role "${p.role}"`,
  help: {
    usage: 'author has role "<role>"',
    about: "The message author has this role (name in any case, or the role id).",
  },
  syntax: [{ pattern: ["author", "has", "role", "$str"], build: ([role]) => ({ role }) }],
});

/*
  author is <@user>       the message was sent by this member (type @ and pick them, or paste their user id)

    when author is <@01J...> do react "👑"
    when message contains "SWS" and not author is <@01J...> do ...
    when author is <@01J...> or author is <@01K...> do ...

  Matches the user id, so it keeps working when they change their name.
*/
const USER_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i; // Stoat user ids are ULIDs

conditions.register("author.is", {
  triggers: MESSAGE_TRIGGERS,
  schema: z.object({
    user: z
      .string()
      .trim()
      .regex(USER_ID, "Pick the user with @ (or paste their user id)")
      .transform((id) => id.toUpperCase()),
  }),
  test: (ev, p) => ev.authorId.toUpperCase() === p.user,
  // An id, not a <@mention>: `rule show` would otherwise ping the person every time.
  describe: (p) => `author is the user \`${p.user}\``,
  help: {
    usage: "author is @user",
    about: "The message was sent by this member: type `@` and pick them (or paste their user id). Matches the account, so name changes don't matter. Use `or` for several people, `not` for everyone but them.",
  },
  syntax: [
    { pattern: ["author", "is", "$user"], build: ([user]) => ({ user }) },
    { pattern: ["author", "is", "$word"], build: ([user]) => ({ user }) },
  ],
});
