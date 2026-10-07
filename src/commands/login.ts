import { Hushscript } from "@hushscript/sdk";
import type { Command } from "commander";
import { storePath, type Runtime } from "../context.ts";
import { usageError } from "../errors.ts";
import { saveToken } from "../store.ts";

export function registerLogin(program: Command, rt: Runtime): void {
  program
    .command("login")
    .description("Store a token for later commands (prompts without echo; reads stdin when piped)")
    .action(async () => {
      const { deps, out } = rt;
      const supplied = rt.globals().token;
      const token = (supplied ?? (await deps.io.readSecret("Hushscript token: "))).trim();
      rt.secrets.push(token);
      if (token === "") throw usageError("No token was entered.");
      if (supplied !== undefined) {
        out.warning(
          "token_on_command_line",
          "a token on the command line can leak through shell history and the process list. Run `hushscript login` without --token to type it, or pipe it on stdin.",
        );
      }
      // The SDK checks the format without sending anything; its error never carries the token.
      new Hushscript({ token });
      const path = storePath(deps);
      await saveToken(path, token, deps.platform);
      out.document({ stored: true, path }, `Token saved to ${path}`);
    });
}
