import type { Command } from "commander";
import { storePath, type Runtime } from "../context.ts";
import { rejectEmptyTokenFlag, removeToken } from "../store.ts";

export function registerLogout(program: Command, rt: Runtime): void {
  program
    .command("logout")
    .description("Delete the stored token")
    .action(async () => {
      rejectEmptyTokenFlag(rt.globals().token);
      const removed = await removeToken(storePath(rt.deps));
      rt.out.document(
        { removed },
        removed ? "Logged out; the stored token was deleted." : "No stored token.",
      );
    });
}
