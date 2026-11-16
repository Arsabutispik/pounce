import { z } from "zod";
import { triggers } from "../../engine/index.js";

triggers.register("message.created", {
  schema: z.object({}),
  describe: () => "a message is sent",
  // No syntax: the keyword `when` means "on every new message" (see parser/grammar.ts).
});
