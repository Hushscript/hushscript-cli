import type { Command } from "commander";
import { openClient, type Runtime } from "../context.ts";
import { formatDate } from "../output.ts";

export function registerBalance(program: Command, rt: Runtime): void {
  program
    .command("balance")
    .description("Show the minutes you can spend")
    .action(async () => {
      const api = await openClient(rt);
      const balance = await api.balance();
      const lines = [`Balance: ${String(balance.minutes)} min (${String(balance.seconds)} s)`];
      if (balance.heldSeconds > 0) {
        lines.push(`Held for running jobs: ${String(Math.trunc(balance.heldSeconds / 60))} min`);
      }
      if (balance.expiresAt !== null) lines.push(`Expires: ${formatDate(balance.expiresAt)}`);
      rt.out.document(balance, lines.join("\n"));
    });
}
