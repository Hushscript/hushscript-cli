import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, NetworkError } from "@hushscript/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, transcript, TEST_TOKEN, type Harness } from "./helpers.ts";

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

describe("transcript --lang", () => {
  it("prints a translation and the cleaned body", async () => {
    const t = transcript();
    const es = cli();
    await es.run("transcript", "tr_1", "--lang", "es", "--format", "srt");
    expect(es.stdout()).toBe(t.toSRT({ language: "es" }));
    const cleaned = cli();
    await cleaned.run("transcript", "tr_1", "--lang", "cleaned");
    expect(cleaned.stdout()).toBe(t.toText({ language: "cleaned" }));
    const original = cli();
    await original.run("transcript", "tr_1", "--lang", "original");
    expect(original.stdout()).toBe(t.toText());
  });

  it("exits 2 and lists what exists when the version is missing", async () => {
    const h = cli();
    expect(await h.run("transcript", "tr_1", "--lang", "de")).toBe(2);
    expect(h.stderr()).toContain('no "de" version');
    expect(h.stderr()).toContain("Available: es, cleaned.");
  });

  it("says there is only the original for a transcript without translations", async () => {
    const h = cli();
    h.api.transcripts.get.mockResolvedValue(
      transcript({
        body: { version: 1, original: transcript().toJSON().body.original, translations: {} },
      }),
    );
    expect(await h.run("transcript", "tr_1", "--lang", "cleaned")).toBe(2);
    expect(h.stderr()).toContain("It has only the original.");
  });

  it("requests the id it was given", async () => {
    const h = cli();
    await h.run("transcript", "tr_1");
    expect(h.api.transcripts.get).toHaveBeenCalledWith("tr_1");
  });
  it("accepts a 128-character transcript id", async () => {
    const h = cli();
    const id = "x".repeat(128);
    expect(await h.run("transcript", id)).toBe(0);
    expect(h.api.transcripts.get).toHaveBeenCalledWith(id);
    expect(h.stdout()).toBe(transcript().toText());
    expect(h.stderr()).toBe("");
  });

  it.each([
    [
      new ApiError({ code: "not_found", status: 404, message: "Missing." }),
      "not_found",
      404,
      "Missing.",
    ],
    [new NetworkError({ message: "Offline." }), "network_error", null, "Offline."],
  ] as const)("reports a get failure as JSON: %s", async (error, code, status, message) => {
    const h = cli();
    h.api.transcripts.get.mockRejectedValue(error);
    expect(await h.run("transcript", "tr_1", "--json")).toBe(1);
    expect(h.stdout()).toBe("");
    expect(JSON.parse(h.stderr())).toEqual({
      type: "error",
      code,
      numericCode: null,
      status,
      message,
      hint: null,
    });
  });

  it.each([
    ["srt", false, ""],
    ["srt", true, "\n"],
    ["vtt", false, "WEBVTT\n\n\n"],
    ["vtt", true, "WEBVTT\n\n\n"],
    ["txt", false, ""],
    ["txt", true, "\n"],
  ] as const)(
    "preserves empty %s bytes with stdoutIsTTY=%s",
    async (format, stdoutIsTTY, expected) => {
      const t = transcript({
        body: { version: 1, original: { utterances: [] }, translations: {} },
      });
      const h = harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN }, stdoutIsTTY });
      h.api.transcripts.get.mockResolvedValue(t);
      expect(await h.run("transcript", "tr_1", "--format", format)).toBe(0);
      expect(h.stdout()).toBe(expected);
      expect(h.stderr()).toBe("");
    },
  );
});
