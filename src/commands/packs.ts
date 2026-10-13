import type { Command } from "commander";
import { openClient, type Runtime } from "../context.ts";

export function registerPacks(program: Command, rt: Runtime): void {
  program
    .command("packs")
    .description("List the minute packs you can buy")
    .action(async () => {
      const api = await openClient(rt);
      const packs = await api.billing.packs();
      const lines = packs.map((pack) => {
        const bonus = pack.bonusMinutes > 0 ? `, +${String(pack.bonusMinutes)} min bonus` : "";
        const locked = pack.available ? "" : " (not available to this account)";
        return `${pack.id}  ${String(pack.minutes)} min  ${pack.price.formatted}${bonus}${locked}`;
      });
      rt.out.document({ packs }, lines.length === 0 ? "No packs." : lines.join("\n"));
    });
}
