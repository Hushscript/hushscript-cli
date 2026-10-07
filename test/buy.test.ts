import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, NetworkError, PaymentMethodRequiredError } from "@hushscript/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_REFUND_NOTICE } from "../src/commands/buy.ts";
import { harness, TEST_TOKEN, type Harness } from "./helpers.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hushscript-cli-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function cli(options: { stdinIsTTY?: boolean; answer?: boolean } = {}): Harness {
  return harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN }, ...options });
}

describe("buy without --yes", () => {
  it("prints the no-refund notice, asks, and buys after a yes with the acknowledgement", async () => {
    const h = cli({ stdinIsTTY: true, answer: true });
    expect(await h.run("buy", "300min")).toBe(0);
    expect(h.stderr()).toContain(NO_REFUND_NOTICE);
    expect(h.prompts).toEqual(["Buy 300min with your saved default card? [y/N] "]);
    expect(h.api.buy).toHaveBeenCalledWith("300min", {
      acknowledgeNoRefund: true,
      idempotencyKey: expect.stringMatching(UUID) as string,
    });
    expect(h.stdout()).toBe("Bought 300min. Balance: 300 min.\n");
  });

  it("buys nothing after a no", async () => {
    const h = cli({ stdinIsTTY: true, answer: false });
    expect(await h.run("buy", "300min")).toBe(1);
    expect(h.api.buy).not.toHaveBeenCalled();
    expect(h.stderr()).toContain("Cancelled. Nothing was charged.");
  });

  it("reports a missing token before asking anyone to confirm", async () => {
    const h = harness({ home, stdinIsTTY: true, answer: true });
    expect(await h.run("buy", "300min")).toBe(1);
    expect(h.stderr()).toContain("No Hushscript token.");
    expect(h.prompts).toEqual([]);
    expect(h.api.buy).not.toHaveBeenCalled();
  });

  it("exits 2 with nothing sent when there is no terminal", async () => {
    const h = cli({ stdinIsTTY: false });
    expect(await h.run("buy", "300min")).toBe(2);
    expect(h.stderr()).toContain(NO_REFUND_NOTICE);
    expect(h.stderr()).toContain("Pass --yes");
    expect(h.prompts).toEqual([]);
    expect(h.created).toEqual([]);
    expect(h.api.buy).not.toHaveBeenCalled();
    expect(h.api.balance).not.toHaveBeenCalled();
  });

  it("leaves stderr as one JSON document under --json when it cannot ask", async () => {
    const h = cli({ stdinIsTTY: false });
    expect(await h.run("buy", "300min", "--json")).toBe(2);
    expect(JSON.parse(h.stderr())).toMatchObject({ code: "usage_error" });
  });

  it("rejects a key that is not 1 to 128 of A-Za-z0-9_-", async () => {
    const h = cli({ stdinIsTTY: true, answer: true });
    expect(await h.run("buy", "300min", "--key", "no spaces")).toBe(2);
    expect(h.api.buy).not.toHaveBeenCalled();
  });

  it("keeps stdout clean under --json while it asks", async () => {
    const h = cli({ stdinIsTTY: true, answer: true });
    expect(await h.run("buy", "300min", "--json")).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual({ seconds: 18_000, minutes: 300 });
    expect(h.stderr()).toContain(NO_REFUND_NOTICE);
  });
});

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/** The last line of stderr: under --yes the notice comes first, the error document last. */
function errorDocument(h: Harness): Record<string, unknown> {
  const lines = h.stderr().trimEnd().split("\n");
  return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
}

describe("buy --yes", () => {
  it("shows the notice on stderr before the purchase, also under --json", async () => {
    const h = cli();
    const order: string[] = [];
    h.api.buy.mockImplementation(() => {
      order.push(h.stderr());
      return Promise.resolve({ seconds: 2700, minutes: 45 });
    });
    expect(await h.run("buy", "45min", "--yes", "--json")).toBe(0);
    expect(order).toEqual([`${NO_REFUND_NOTICE}\n`]);
    expect(JSON.parse(h.stdout())).toEqual({ seconds: 2700, minutes: 45 });
  });

  it("mints a key the CLI knows, so a retry can reuse it", async () => {
    const h = cli();
    await h.run("buy", "45min", "--yes");
    const [, options] = h.api.buy.mock.calls[0] ?? [];
    expect(options?.idempotencyKey).toMatch(UUID);
  });

  it("does not ask, still shows the notice, and passes --key on", async () => {
    const h = cli();
    expect(await h.run("buy", "45min", "--yes", "--key", "retry_1")).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.stderr()).toContain(NO_REFUND_NOTICE);
    expect(h.api.buy).toHaveBeenCalledWith("45min", {
      acknowledgeNoRefund: true,
      idempotencyKey: "retry_1",
    });
  });
});

describe("a purchase that fails", () => {
  async function failWith(error: Error, key: string | null): Promise<Harness> {
    const h = cli();
    if (key !== null && "idempotencyKey" in error) error.idempotencyKey = key;
    h.api.buy.mockRejectedValue(error);
    expect(await h.run("buy", "300min", "--yes", "--json")).toBe(1);
    return h;
  }

  it("prints the key and the retry instruction when the outcome is unknown", async () => {
    const h = await failWith(new NetworkError({ message: "The connection dropped." }), "k-1");
    expect(errorDocument(h)).toMatchObject({
      code: "network_error",
      idempotencyKey: "k-1",
      hint: "The purchase may have been charged; retry with --key k-1.",
    });
  });

  it("keeps the SDK hint and adds the instruction after a 5xx", async () => {
    const h = await failWith(
      new ApiError({ code: "bad_gateway", status: 502, message: "Upstream.", hint: "Try later." }),
      "k-2",
    );
    expect(errorDocument(h)).toMatchObject({
      status: 502,
      hint: "Try later. The purchase may have been charged; retry with --key k-2.",
    });
  });

  it("says nothing about a charge for statuses that never charge", async () => {
    for (const status of [400, 401, 402, 403, 404, 422, 429]) {
      const h = await failWith(new ApiError({ code: "refused", status, message: "No." }), "k-3");
      const report = errorDocument(h) as { hint: string | null; idempotencyKey: string };
      expect(report.hint).toBeNull();
      expect(report.idempotencyKey).toBe("k-3");
    }
  });

  it("says nothing about a charge when the failure came before the send", async () => {
    const h = await failWith(new PaymentMethodRequiredError({ message: "No saved card." }), null);
    const report = errorDocument(h);
    expect(report["idempotencyKey"]).toBeUndefined();
    expect(String(report["hint"])).not.toContain("--key");
  });

  it("passes other errors through unchanged", async () => {
    const h = cli();
    h.api.buy.mockRejectedValue(new TypeError("boom"));
    expect(await h.run("buy", "300min", "--yes")).toBe(1);
    expect(h.stderr()).toContain("Unexpected error: boom");
  });

  it("prints the key and the retry instruction when a signal arrives mid-purchase", async () => {
    const h = cli();
    let release = (): void => undefined;
    h.api.buy.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ seconds: 1, minutes: 0 });
          };
        }),
    );
    const result = h.run("buy", "300min", "--yes", "--key", "k-sig");
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.interrupt();
    expect(h.forcedExits).toEqual([130]);
    expect(h.stderr()).toContain("Idempotency key: k-sig");
    expect(h.stderr()).toContain("may have been charged; retry with --key k-sig.");
    release();
    await result;
  });

  it("reports the interrupted purchase as JSON under --json", async () => {
    const h = cli();
    h.api.buy.mockImplementation(() => new Promise(() => undefined));
    void h.run("buy", "300min", "--yes", "--json");
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.interrupt();
    expect(h.forcedExits).toEqual([130]);
    expect(errorDocument(h)).toMatchObject({
      code: "interrupted",
      idempotencyKey: expect.stringMatching(UUID) as string,
      hint: expect.stringContaining("may have been charged; retry with --key") as string,
    });
  });

  it("stops listening for signals once the purchase is over", async () => {
    const h = cli();
    await h.run("buy", "300min", "--yes");
    h.interrupt();
    expect(h.forcedExits).toEqual([]);
  });

  it("prints the plain-text retry instruction without --json", async () => {
    const h = cli();
    const error = new NetworkError({ message: "The connection dropped." });
    error.idempotencyKey = "k-4";
    h.api.buy.mockRejectedValue(error);
    await h.run("buy", "300min", "--yes");
    expect(h.stderr()).toContain("Idempotency key: k-4");
    expect(h.stderr()).toContain("may have been charged; retry with --key k-4.");
  });
});
