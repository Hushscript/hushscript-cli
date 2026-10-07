import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, ConfigurationError } from "@hushscript/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.ts";
import { describeError, formatDuration, scrub } from "../src/output.ts";
import { harness, rows, TEST_TOKEN, type Harness } from "./helpers.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hushscript-cli-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function cli(): Harness {
  return harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN } });
}

describe("--json", () => {
  it("prints exactly one JSON document on stdout and nothing on stderr", async () => {
    const h = cli();
    expect(await h.run("balance", "--json")).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual({
      seconds: 18_000,
      minutes: 300,
      heldSeconds: 0,
      expiresAt: null,
      purchasesRemaining: null,
    });
    expect(h.stdout().endsWith("}\n")).toBe(true);
    expect(h.stderr()).toBe("");
  });

  it("reports an SDK error as JSON on stderr, with the documented keys, and nothing on stdout", async () => {
    const h = cli();
    const error = new ApiError({
      code: "rate_limited",
      numericCode: 4291,
      status: 429,
      message: "Slow down.",
      hint: "Wait a minute.",
    });
    error.idempotencyKey = "key-1";
    error.resumeToken = "resume-1";
    h.api.balance.mockRejectedValue(error);
    expect(await h.run("--json", "balance")).toBe(1);
    expect(h.stdout()).toBe("");
    const lines = h.stderr().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      code: "rate_limited",
      numericCode: 4291,
      status: 429,
      message: "Slow down.",
      hint: "Wait a minute.",
      idempotencyKey: "key-1",
      resumeToken: "resume-1",
    });
  });

  it("leaves idempotencyKey and resumeToken out when the error has none", async () => {
    const h = cli();
    h.api.balance.mockRejectedValue(new ApiError({ code: "bad_request", message: "No." }));
    await h.run("balance", "--json");
    const report = JSON.parse(h.stderr()) as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual([
      "code",
      "hint",
      "message",
      "numericCode",
      "status",
    ]);
  });

  it("prints a plain message on stderr without --json", async () => {
    const h = cli();
    const error = new ApiError({
      code: "rate_limited",
      status: 429,
      message: "Slow down.",
      hint: "Wait.",
    });
    error.idempotencyKey = "key-1";
    h.api.balance.mockRejectedValue(error);
    expect(await h.run("balance")).toBe(1);
    expect(h.stderr()).toBe("Error: Slow down.\nHint: Wait.\nIdempotency key: key-1\n");
  });

  it("wraps list results in an object", async () => {
    const h = cli();
    const summary = {
      id: "tr_1",
      title: "Call",
      language: "en",
      durationSeconds: 61,
      createdAt: new Date(1_760_000_000_000),
      autoDeleteAt: null,
      tags: [],
    };
    h.api.transcripts.list.mockReturnValue(rows([summary]));
    await h.run("transcripts", "--json");
    expect(JSON.parse(h.stdout())).toEqual({
      transcripts: [{ ...summary, createdAt: "2025-10-09T08:53:20.000Z" }],
    });
  });
});

describe("human output", () => {
  it("prints the balance with held minutes and expiry", async () => {
    const h = cli();
    h.api.balance.mockResolvedValue({
      seconds: 3_700,
      minutes: 61,
      heldSeconds: 600,
      expiresAt: new Date(1_800_000_000_000),
      purchasesRemaining: null,
    });
    await h.run("balance");
    expect(h.stdout()).toBe(
      "Balance: 61 min (3700 s)\nHeld for running jobs: 10 min\nExpires: 2027-01-15T08:00:00.000Z\n",
    );
  });

  it("lists transcripts, jobs and packs one per line", async () => {
    const h = cli();
    h.api.transcripts.list.mockReturnValue(
      rows([
        {
          id: "tr_1",
          title: "Call one",
          language: "en",
          durationSeconds: 3_725,
          createdAt: new Date(1_760_000_000_000),
          autoDeleteAt: null,
          tags: [],
        },
      ]),
    );
    h.api.jobs.list.mockReturnValue(
      rows([
        {
          id: "jb_1",
          state: "failed",
          transcriptId: null,
          error: "unreadable",
          failureKind: null,
          mode: "standard",
          declaredSeconds: null,
          verifiedSeconds: null,
          actualSeconds: null,
          billableSeconds: null,
          retryOf: null,
          createdAt: new Date(1_760_000_000_000),
          options: {
            languageCode: null,
            speakerDetection: true,
            medicalMode: false,
            multichannel: false,
            translationTargets: [],
            keyterms: false,
            prompt: false,
            autoGenerateInsights: null,
          },
        },
      ]),
    );
    h.api.billing.packs.mockResolvedValue([
      {
        id: "300min",
        seconds: 18_000,
        minutes: 300,
        price: { amount: 1999, currency: "usd", formatted: "$19.99" },
        bonusMinutes: 10,
        available: true,
      },
      {
        id: "6000min",
        seconds: 360_000,
        minutes: 6000,
        price: { amount: 99_900, currency: "usd", formatted: "$999.00" },
        bonusMinutes: 0,
        available: false,
      },
    ]);
    await h.run("transcripts");
    await h.run("jobs");
    await h.run("packs");
    expect(h.stdout()).toBe(
      [
        "tr_1  2025-10-09T08:53:20.000Z  1:02:05  Call one",
        "jb_1  failed  2025-10-09T08:53:20.000Z  -  unreadable",
        "300min  300 min  $19.99, +10 min bonus",
        "6000min  6000 min  $999.00 (not available to this account)",
        "",
      ].join("\n"),
    );
  });

  it("says so when a list is empty", async () => {
    const h = cli();
    await h.run("transcripts");
    await h.run("jobs");
    await h.run("packs");
    expect(h.stdout()).toBe("No transcripts.\nNo jobs.\nNo packs.\n");
  });

  it("stops listing at --limit and asks for pages of at most 100", async () => {
    const h = cli();
    const row = (id: string) => ({
      id,
      title: id,
      language: null,
      durationSeconds: 1,
      createdAt: new Date(0),
      autoDeleteAt: null,
      tags: [],
    });
    h.api.transcripts.list.mockReturnValue(rows([row("a"), row("b"), row("c")]));
    await h.run("transcripts", "--limit", "2", "--json");
    expect((JSON.parse(h.stdout()) as { transcripts: unknown[] }).transcripts).toHaveLength(2);
    expect(h.api.transcripts.list).toHaveBeenCalledWith({ pageSize: 2 });
    const big = cli();
    await big.run("transcripts", "--limit", "500");
    expect(big.api.transcripts.list).toHaveBeenCalledWith({ pageSize: 100 });
  });

  it("passes --active to the jobs list and defaults to all jobs", async () => {
    const h = cli();
    await h.run("jobs");
    expect(h.api.jobs.list).toHaveBeenCalledWith({ active: false });
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(59.6)).toBe("1:00");
    expect(formatDuration(3_725)).toBe("1:02:05");
  });
});

describe("error reporting", () => {
  it("exits 1 for SDK errors and unexpected errors, and uses the error's own code for CLI errors", async () => {
    const sdk = cli();
    sdk.api.balance.mockRejectedValue(ConfigurationError.missingToken());
    expect(await sdk.run("balance")).toBe(1);
    const odd = cli();
    odd.api.balance.mockRejectedValue(new TypeError("boom"));
    expect(await odd.run("balance", "--json")).toBe(1);
    expect(JSON.parse(odd.stderr())).toMatchObject({
      code: "unexpected_error",
      message: "Unexpected error: boom",
    });
    const bare = cli();
    bare.api.balance.mockRejectedValue("a string");
    expect(await bare.run("balance", "--json")).toBe(1);
    expect(JSON.parse(bare.stderr())).toMatchObject({ message: "The CLI failed unexpectedly." });
  });

  it("hides the token wherever it shows up", async () => {
    const h = cli();
    h.api.balance.mockRejectedValue(
      new CliError({
        code: "x",
        message: `leaked ${TEST_TOKEN} and hsr9:zz:other.${"a".repeat(20)}`,
        exitCode: 1,
        hint: `again ${TEST_TOKEN}`,
      }),
    );
    expect(await h.run("balance", "--json")).toBe(1);
    expect(h.stderr()).not.toContain(TEST_TOKEN);
    expect(h.stderr()).not.toContain("other.");
    expect(h.stderr()).toContain("[redacted]");
  });

  it("scrubs only secrets long enough to be one", () => {
    expect(scrub("a short secret: abc", ["abc"])).toBe("a short secret: abc");
    expect(scrub("the secret-value here", ["secret-value"])).toBe("the [redacted] here");
    expect(describeError(new Error(""), []).message).toBe("The CLI failed unexpectedly.");
  });
});
