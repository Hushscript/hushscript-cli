import { randomUUID } from "node:crypto";
import { HushscriptError } from "@hushscript/sdk";
import type { Command } from "commander";
import { openClient, type Runtime } from "../context.ts";
import { CliError, interrupted, usageError } from "../errors.ts";
import { parseKey, parsePack } from "../validate.ts";

export const NO_REFUND_NOTICE =
  "Minutes are added to your account instantly after payment. All purchases are final and non-refundable.";

// A purchase refused with one of these statuses was never charged; any other failure after the send may have been.
// 401 and 429 are not here: the server answers them before it replays a completed purchase, so after the SDK's
// one retry they can follow a charged first attempt. 402 is answered after that replay, so it proves nothing was charged.
const NEVER_CHARGED: ReadonlySet<number> = new Set([400, 402, 403, 404, 422]);

function chargeNotice(key: string): string {
  return `The purchase may have been sent. Retry with --key ${key}: the same key never charges twice.`;
}

function withChargeNotice(error: unknown): unknown {
  if (!(error instanceof HushscriptError)) return error;
  const key = error.idempotencyKey;
  if (key === null || (error.status !== null && NEVER_CHARGED.has(error.status))) return error;
  const notice = chargeNotice(key);
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
      // The key is made here, not inside the SDK, so a signal that arrives mid-purchase can still print it.
      const key = options.key === undefined ? randomUUID() : parseKey(options.key);
      const confirmed = options.yes === true;
      if (!confirmed && !(io.stdinIsTTY && io.stderrIsTTY)) {
        // Under --json the error object is the only stderr line: nothing could be bought, so there is no notice to give.
        if (!out.json) out.notice("no_refund", NO_REFUND_NOTICE);
        throw usageError(
          "Buying needs your confirmation, and there is no terminal to ask on. Nothing was sent.",
          "Pass --yes to confirm the purchase.",
        );
      }
      // A missing token is reported before anyone is asked to confirm.
      const api = await openClient(rt);
      // Shown whenever a purchase can follow, also with --yes and under --json.
      out.notice("no_refund", NO_REFUND_NOTICE);
      if (!confirmed && !(await io.confirm(`Buy ${pack} with your saved default card? [y/N] `))) {
        throw new CliError({
          code: "cancelled",
          message: "Cancelled. Nothing was charged.",
          exitCode: 1,
        });
      }
      // From here the request may be on its way: a signal ends the process at once, with the key to retry.
      const stop = io.onInterrupt(() => {
        io.forceExit(out.fail(interrupted(null, key, chargeNotice(key))));
      });
      let purchase;
      try {
        purchase = await api.buy(pack, { acknowledgeNoRefund: true, idempotencyKey: key });
      } catch (error) {
        throw withChargeNotice(error);
      } finally {
        stop();
      }
      out.document(purchase, `Bought ${pack}. Balance: ${String(purchase.minutes)} min.`);
    });
}
