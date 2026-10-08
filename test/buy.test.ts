import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, NetworkError, PaymentMethodRequiredError } from "@hushscript/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/program.ts";
import { installInterrupts } from "../src/signals.ts";
import * as store from "../src/store.ts";
import { harness, TEST_TOKEN, type Harness } from "./helpers.ts";

const NO_REFUND_NOTICE =
  "Minutes are added to your account instantly after payment. All purchases are final and non-refundable.";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hushscript-cli-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function cli(
  options: { stdinIsTTY?: boolean; stderrIsTTY?: boolean; answer?: boolean } = {},
): Harness {
  return harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN }, ...options });
}

describe("buy without --yes", () => {
  it("prints the no-refund notice, asks, and buys after a yes with the acknowledgement", async () => {
    const h = cli({ stdinIsTTY: true, stderrIsTTY: true, answer: true });
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
    const h = cli({ stdinIsTTY: true, stderrIsTTY: true, answer: false });
    expect(await h.run("buy", "300min")).toBe(1);
    expect(h.api.buy).not.toHaveBeenCalled();
    expect(h.stderr()).toContain("Cancelled. Nothing was charged.");
  });

  it("reports a missing token before asking anyone to confirm", async () => {
    const h = harness({ home, stdinIsTTY: true, stderrIsTTY: true, answer: true });
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

  it("exits 2 with nothing sent when stdin is a terminal but stderr is piped", async () => {
    const h = cli({ stdinIsTTY: true, stderrIsTTY: false, answer: true });
    expect(await h.run("buy", "300min")).toBe(2);
    expect(h.stderr()).toContain("Pass --yes");
    expect(h.prompts).toEqual([]);
    expect(h.api.buy).not.toHaveBeenCalled();
    expect(await h.run("buy", "300min", "--yes")).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.api.buy).toHaveBeenCalledTimes(1);
  });

  it("leaves stderr as one JSON document under --json when it cannot ask", async () => {
    const h = cli({ stdinIsTTY: false });
    expect(await h.run("buy", "300min", "--json")).toBe(2);
    expect(JSON.parse(h.stderr())).toMatchObject({ code: "usage_error" });
  });

  it.each(["", "no spaces", "a\nb", "clé", "k".repeat(129)])(
    "rejects invalid key %j before creating a client",
    async (key) => {
      const h = cli({ stdinIsTTY: true, stderrIsTTY: true, answer: true });
      expect(await h.run("buy", "300min", "--key", key, "--json")).toBe(2);
      expect(errorDocument(h)).toMatchObject({
        code: "usage_error",
        message: "--key must be 1 to 128 characters from A-Z, a-z, 0-9, _ and -.",
      });
      expect(h.created).toEqual([]);
      expect(h.prompts).toEqual([]);
      expect(h.api.buy).not.toHaveBeenCalled();
      expect(h.stdout()).toBe("");
    },
  );

  it.each(["k", "k".repeat(128)])("accepts key boundary %j", async (key) => {
    const h = cli();
    expect(await h.run("buy", "300min", "--yes", "--key", key)).toBe(0);
    expect(h.api.buy).toHaveBeenCalledWith("300min", {
      acknowledgeNoRefund: true,
      idempotencyKey: key,
    });
  });

  it("refuses piped stdin even when stderr is a terminal", async () => {
    const h = cli({ stdinIsTTY: false, stderrIsTTY: true, answer: true });
    expect(await h.run("buy", "300min")).toBe(2);
    expect(h.stderr()).toContain("Nothing was sent.");
    expect(h.created).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.api.buy).not.toHaveBeenCalled();
    expect(h.stdout()).toBe("");
  });

  it("reports a declined JSON purchase after its notice without buying", async () => {
    const h = cli({ stdinIsTTY: true, stderrIsTTY: true, answer: false });
    expect(await h.run("buy", "300min", "--json")).toBe(1);
    const reports = h
      .stderr()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(reports).toEqual([
      { type: "notice", code: "no_refund", message: NO_REFUND_NOTICE },
      expect.objectContaining({
        type: "error",
        code: "cancelled",
        message: "Cancelled. Nothing was charged.",
      }),
    ]);
    expect(h.api.buy).not.toHaveBeenCalled();
    expect(h.stdout()).toBe("");
  });

  it.each(["", " 300min", "300MIN", "-300min", "0x5min", "1000000min", "1234567min", "３００min"])(
    "rejects invalid pack %j before creating a client",
    async (pack) => {
      const h = cli();
      expect(await h.run("buy", "--yes", "--json", "--", pack)).toBe(2);
      expect(errorDocument(h)).toMatchObject({
        code: "usage_error",
        message: "The pack must look like 300min; run `hushscript packs` to list them.",
      });
      expect(h.created).toEqual([]);
      expect(h.api.buy).not.toHaveBeenCalled();
      expect(h.stdout()).toBe("");
    },
  );

  it.each(["1min", "999999min"])("accepts pack boundary %j", async (pack) => {
    const h = cli();
    expect(await h.run("buy", pack, "--yes", "--key", "pack-boundary")).toBe(0);
    expect(h.api.buy).toHaveBeenCalledWith(pack, {
      acknowledgeNoRefund: true,
      idempotencyKey: "pack-boundary",
    });
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "exits silently on %s while reading the token before buying",
    async (signal) => {
      const h = cli();
      const listeners = new Map<NodeJS.Signals, () => void>();
      const exit = vi.fn();
      const stdout = vi.fn();
      const stderr = vi.fn();
      const confirm = vi.fn(() => Promise.resolve(true));
      const createClient = vi.fn(() => h.api);
      const interrupts = installInterrupts({
        listen: (name, listener) => listeners.set(name, listener),
        flushStderr: (done) => {
          done();
        },
        exit,
      });
      const token = vi
        .spyOn(store, "resolveToken")
        .mockImplementation(() => new Promise(() => undefined));
      try {
        void run(["buy", "300min"], {
          homedir: home,
          platform: "linux",
          env: {},
          createClient,
          io: {
            stdout,
            stderr,
            stdinIsTTY: true,
            stdoutIsTTY: false,
            stderrIsTTY: true,
            readSecret: () => Promise.resolve(""),
            confirm,
            onInterrupt: interrupts.onInterrupt,
            forceExit: interrupts.forceExit,
          },
        });
        await vi.waitFor(() => {
          expect(token).toHaveBeenCalledTimes(1);
        });
        const received = listeners.get(signal);
        expect(received).toBeTypeOf("function");
        received?.();
        expect(exit).toHaveBeenCalledExactlyOnceWith(130);
        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(createClient).not.toHaveBeenCalled();
        expect(h.api.buy).not.toHaveBeenCalled();
      } finally {
        token.mockRestore();
      }
    },
  );

  it.each(
    (["SIGINT", "SIGTERM", "SIGHUP"] as const).flatMap((signal) =>
      [false, true].map((json) => ({ signal, json })),
    ),
  )(
    "exits silently on $signal during the confirm prompt before buying (json: $json)",
    async ({ signal, json }) => {
      const h = cli();
      const listeners = new Map<NodeJS.Signals, () => void>();
      const exit = vi.fn();
      const stdout = vi.fn();
      const stderr = vi.fn();
      const confirm = vi.fn((prompt: string) => {
        stderr(prompt);
        return new Promise<boolean>(() => undefined);
      });
      const interrupts = installInterrupts({
        listen: (name, listener) => listeners.set(name, listener),
        flushStderr: (done) => {
          done();
        },
        exit,
      });
      void run(json ? ["buy", "300min", "--json"] : ["buy", "300min"], {
        homedir: home,
        platform: "linux",
        env: { HUSHSCRIPT_TOKEN: TEST_TOKEN },
        createClient: () => h.api,
        io: {
          stdout,
          stderr,
          stdinIsTTY: true,
          stdoutIsTTY: false,
          stderrIsTTY: true,
          readSecret: () => Promise.resolve(""),
          confirm,
          onInterrupt: interrupts.onInterrupt,
          forceExit: interrupts.forceExit,
        },
      });
      await vi.waitFor(() => {
        expect(confirm).toHaveBeenCalledExactlyOnceWith(
          "Buy 300min with your saved default card? [y/N] ",
        );
      });
      const received = listeners.get(signal);
      expect(received).toBeTypeOf("function");
      received?.();
      expect(exit).toHaveBeenCalledExactlyOnceWith(130);
      expect(h.api.buy).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls).toEqual([
        [
          json
            ? `${JSON.stringify({ type: "notice", code: "no_refund", message: NO_REFUND_NOTICE })}\n`
            : `${NO_REFUND_NOTICE}\n`,
        ],
        ["Buy 300min with your saved default card? [y/N] "],
      ]);
    },
  );

  it("keeps stdout clean under --json while it asks", async () => {
    const h = cli({ stdinIsTTY: true, stderrIsTTY: true, answer: true });
    expect(await h.run("buy", "300min", "--json")).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual({ seconds: 18_000, minutes: 300 });
    expect(h.stderr()).toContain(NO_REFUND_NOTICE);
  });
});

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/** The last line of stderr: under --yes and --json the notice comes first, the error object last. */
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
    expect(order.map((text) => JSON.parse(text) as unknown)).toEqual([
      { type: "notice", code: "no_refund", message: NO_REFUND_NOTICE },
    ]);
    expect(JSON.parse(h.stdout())).toEqual({ seconds: 2700, minutes: 45 });
  });

  it("mints a key the CLI knows, so a retry can reuse it", async () => {
    const h = cli();
    await h.run("buy", "45min", "--yes");
    const [, options] = h.api.buy.mock.calls[0] ?? [];
    expect(options?.idempotencyKey).toMatch(UUID);
  });

  it("mints a fresh key for every run without --key", async () => {
    const h = cli();
    await h.run("buy", "45min", "--yes");
    await h.run("buy", "45min", "--yes");
    const [first, second] = h.api.buy.mock.calls.map(([, options]) => options?.idempotencyKey);
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(first).not.toBe(second);
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

  it("reports a non-SDK purchase error without retry advice", async () => {
    const h = cli();
    h.api.buy.mockRejectedValue(new TypeError("boom"));
    expect(await h.run("buy", "300min", "--yes", "--key", "unexpected-error")).toBe(1);
    expect(h.stderr()).toBe(`${NO_REFUND_NOTICE}\nError: Unexpected error: boom\n`);
    expect(h.stderr()).not.toContain("Retry with --key");
  });

  it("prints the key and the retry instruction when the outcome is unknown", async () => {
    const h = await failWith(new NetworkError({ message: "The connection dropped." }), "k-1");
    expect(errorDocument(h)).toMatchObject({
      code: "network_error",
      idempotencyKey: "k-1",
      hint: "The purchase may have been sent. Retry with --key k-1: the same key never charges twice.",
    });
  });

  it("keeps the SDK hint and adds the instruction after a 5xx", async () => {
    const h = await failWith(
      new ApiError({ code: "bad_gateway", status: 502, message: "Upstream.", hint: "Try later." }),
      "k-2",
    );
    expect(errorDocument(h)).toMatchObject({
      status: 502,
      hint: "Try later. The purchase may have been sent. Retry with --key k-2: the same key never charges twice.",
    });
  });

  it.each([
    [400, null],
    [402, null],
    [404, null],
    [422, null],
    [403, 4021],
    [403, 4023],
  ])(
    "omits the charge notice for refusal status %i numericCode %s",
    async (status, numericCode) => {
      const h = await failWith(
        new ApiError({ code: "refused", status, numericCode, message: "No." }),
        "k-3",
      );
      expect(errorDocument(h)).toMatchObject({
        status,
        numericCode,
        hint: null,
        idempotencyKey: "k-3",
      });
    },
  );

  it.each([
    [403, null],
    [403, 4022],
    [403, 4024],
    [403, 4030],
    [401, 4021],
    [429, 4023],
    [500, 4021],
    [200, 4023],
    [401, null],
    [429, null],
    [408, null],
    [409, null],
    [410, null],
    [413, null],
    [500, null],
    [503, null],
    [504, null],
    [200, null],
  ])(
    "adds the charge notice for uncertain status %i numericCode %s",
    async (status, numericCode) => {
      const code = status === 200 ? "bad_response" : "refused";
      const h = await failWith(
        new ApiError({ code, status, numericCode, message: "No usable purchase." }),
        "k-5",
      );
      expect(errorDocument(h)).toMatchObject({
        code,
        status,
        numericCode,
        idempotencyKey: "k-5",
        hint: "The purchase may have been sent. Retry with --key k-5: the same key never charges twice.",
      });
    },
  );

  it("says nothing about a charge when the failure came before the send", async () => {
    const h = await failWith(new PaymentMethodRequiredError({ message: "No saved card." }), null);
    const report = errorDocument(h);
    expect(report["idempotencyKey"]).toBeUndefined();
    expect(String(report["hint"])).not.toContain("--key");
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
    await vi.waitFor(() => {
      expect(h.api.buy).toHaveBeenCalledTimes(1);
    });
    h.interrupt();
    expect(h.forcedExits).toEqual([130]);
    expect(h.stderr()).toContain("Idempotency key: k-sig");
    expect(h.stderr()).toContain(
      "The purchase may have been sent. Retry with --key k-sig: the same key never charges twice.",
    );
    release();
    await result;
  });

  it("reports the interrupted purchase as JSON under --json", async () => {
    const h = cli();
    h.api.buy.mockImplementation(() => new Promise(() => undefined));
    void h.run("buy", "300min", "--yes", "--json");
    await vi.waitFor(() => {
      expect(h.api.buy).toHaveBeenCalledTimes(1);
    });
    h.interrupt();
    expect(h.forcedExits).toEqual([130]);
    expect(errorDocument(h)).toMatchObject({
      code: "interrupted",
      idempotencyKey: expect.stringMatching(UUID) as string,
      hint: expect.stringContaining("The purchase may have been sent. Retry with --key") as string,
    });
  });

  it("prints the key with the interrupted error last, after the notice, as JSON Lines", async () => {
    const h = cli();
    h.api.buy.mockImplementation(() => new Promise(() => undefined));
    void h.run("buy", "300min", "--yes", "--key", "k-lines", "--json");
    await vi.waitFor(() => {
      expect(h.api.buy).toHaveBeenCalledTimes(1);
    });
    h.interrupt();
    const lines = h
      .stderr()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line["type"])).toEqual(["notice", "error"]);
    expect(lines[1]).toMatchObject({
      code: "interrupted",
      idempotencyKey: "k-lines",
      hint: "The purchase may have been sent. Retry with --key k-lines: the same key never charges twice.",
    });
  });

  it("stops listening for signals once the purchase is over", async () => {
    const h = cli();
    await h.run("buy", "300min", "--yes");
    h.interrupt();
    expect(h.forcedExits).toEqual([]);
  });

  it("stops listening for signals after a failed purchase", async () => {
    const h = cli();
    h.api.buy.mockRejectedValue(new NetworkError({ message: "Dropped." }));
    expect(await h.run("buy", "300min", "--yes", "--json")).toBe(1);
    const stderr = h.stderr();
    h.interrupt();
    expect(h.forcedExits).toEqual([]);
    expect(h.stderr()).toBe(stderr);
  });

  it("prints the plain-text retry instruction without --json", async () => {
    const h = cli();
    const error = new NetworkError({ message: "The connection dropped." });
    error.idempotencyKey = "k-4";
    h.api.buy.mockRejectedValue(error);
    await h.run("buy", "300min", "--yes");
    expect(h.stderr()).toContain("Idempotency key: k-4");
    expect(h.stderr()).toContain(
      "The purchase may have been sent. Retry with --key k-4: the same key never charges twice.",
    );
  });
});
