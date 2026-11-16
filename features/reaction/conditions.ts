import { z } from "zod";
import { conditions } from "../../engine/index.js";

/*
  reactor has role "<role>"     who added the reaction has this role (name, case-insensitive, or id)

    on reaction "✅" when reactor has role "Mod" do send "{message}" to <#approved> with masquerade and files
*/
conditions.register("reaction.reactor_has_role", {
  triggers: ["reaction.added"],
  schema: z.object({ role: z.string().min(1) }),
  test: (ev, p) => {
    const want = p.role.trim().toLowerCase();
    return !!ev.reaction?.userRoles.some((r) => r.id.toLowerCase() === want || r.name.trim().toLowerCase() === want);
  },
  describe: (p) => `the person reacting has the role "${p.role}"`,
  help: {
    usage: 'reactor has role "<role>"',
    about: "Reaction rules only: the person who reacted has this role (name in any case, or the role id).",
  },
  syntax: [{ pattern: ["reactor", "has", "role", "$str"], build: ([role]) => ({ role }) }],
});
