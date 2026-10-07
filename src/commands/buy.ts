import { HushscriptError } from "@hushscript/sdk";
import type { Command } from "commander";
import { openClient, type Runtime } from "../context.ts";
import { CliError, usageError } from "../errors.ts";
import { parseKey, parsePack } from "../validate.ts";

export const NO_REFUND_NOTICE =
  "Minutes are added to your account instantly after payment. All purchases are final and non-refundable.";

// A purchase refused with one of these statuses was never charged; any other failure after the send may have been.
const NEVER_CHARGED: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 422, 429]);

function withChargeNotice(error: unknown): unknown {
  if (!(error instanceof HushscriptError)) return error;
  const key = error.idempotencyKey;
  if (key === null || (error.status !== null && NEVER_CHARGED.has(error.status))) return error;
  const notice = `The purchase may have been charged; retry with --key ${key}.`;
  return new CliError({
    code: error.code,
    numericCode: error.numericCode,
    status: error.status,
    message: error.message,
    hint: error.hint === null ? notice : `${error.hint} ${notice}`,
    exitCode: 1,
    idempotencyKey: key,
  });
}

export function registerBuy(program: Command, rt: Runtime): void {
  program
    .command("buy")
    .description("Buy a minute pack with your saved default card")
    .argument("<pack>", "pack id, for example 300min (see `hushscript packs`)")
    .option("--yes", "confirm the purchase without asking")
    .option(
      "--key <key>",
      "idempotency key; pass the one a failed purchase printed to retry it safely",
    )
    .action(async (packArgument: string, options: { yes?: boolean; key?: string }) => {
      const { deps, out } = rt;
      const { io } = deps;
      const pack = parsePack(packArgument);
      const key = options.key === undefined ? undefined : parseKey(options.key);
      const asking = options.yes !== true && io.stdinIsTTY;
      // Under --json stderr carries only the error document, so the notice is shown when someone is about to confirm it.
      if (!out.json || asking) io.stderr(`${NO_REFUND_NOTICE}\n`);
      if (options.yes !== true) {
        if (!io.stdinIsTTY) {
          throw usageError(
            "Buying needs your confirmation, and there is no terminal to ask on. Nothing was sent.",
            "Pass --yes to confirm the purchase.",
          );
        }
        if (!(await io.confirm(`Buy ${pack} with your saved default card? [y/N] `))) {
          throw new CliError({
            code: "cancelled",
            message: "Cancelled. Nothing was charged.",
            exitCode: 1,
          });
        }
      }
      const api = await openClient(rt);
      let purchase;
      try {
        purchase = await api.buy(pack, {
          acknowledgeNoRefund: true,
          ...(key === undefined ? {} : { idempotencyKey: key }),
        });
      } catch (error) {
        throw withChargeNotice(error);
      }
      out.document(purchase, `Bought ${pack}. Balance: ${String(purchase.minutes)} min.`);
    });
}
