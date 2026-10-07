import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbortError, ApiError, type TranscribeOptions } from "@hushscript/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, transcript, TEST_TOKEN, type Harness } from "./helpers.ts";

let home: string;
let file: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hushscript-cli-"));
  file = join(home, "call.mp3");
  await writeFile(file, "audio");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function cli(options: { stderrIsTTY?: boolean } = {}): Harness {
  return harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN }, ...options });
}

function requestOf(h: Harness): TranscribeOptions {
  const [, options] = h.api.transcribe.mock.calls[0] ?? [];
  if (options === undefined) throw new Error("transcribe was not called");
  return options;
}

describe("transcribe", () => {
  it("prints the txt transcript by default and passes the options on", async () => {
    const h = cli();
    expect(await h.run("transcribe", file, "--language", "en", "--translate", "es,de,es")).toBe(0);
    expect(h.stdout()).toBe(transcript().toText());
    expect(h.api.transcribe.mock.calls[0]?.[0]).toBe(file);
    expect(requestOf(h)).toMatchObject({ language: "en", translateTo: ["es", "de"] });
    expect(requestOf(h).onProgress).toBeUndefined();
    expect(h.stderr()).toContain("hushscript transcript tr_test_0001 --lang es");
  });

  it("sends no language or translation unless asked", async () => {
    const h = cli();
    await h.run("transcribe", file);
    expect(requestOf(h).language).toBeUndefined();
    expect(requestOf(h).translateTo).toBeUndefined();
    expect(h.stderr()).toBe("");
  });

  it("prints srt as the SDK renders it", async () => {
    const h = cli();
    await h.run("transcribe", file, "--format", "srt");
    expect(h.stdout()).toBe(transcript().toSRT());
  });

  it("writes --out through a temp file and keeps stdout empty", async () => {
    const h = cli();
    const out = join(home, "meeting.srt");
    expect(await h.run("transcribe", file, "--format", "srt", "--out", out)).toBe(0);
    expect(await readFile(out, "utf8")).toBe(transcript().toSRT());
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toContain(`Saved the srt transcript tr_test_0001 to ${out}`);
    expect((await readdir(home)).sort()).toEqual(["call.mp3", "meeting.srt"]);
  });

  it("reports the written file as the one JSON document under --json", async () => {
    const h = cli();
    const out = join(home, "meeting.json");
    expect(await h.run("transcribe", file, "--json", "--out", out)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual({ id: "tr_test_0001", format: "json", out });
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ id: "tr_test_0001" });
    expect(h.stderr()).toBe("");
  });

  it("prints the transcript JSON under --json without --out", async () => {
    const h = cli();
    await h.run("transcribe", file, "--json");
    expect(JSON.parse(h.stdout())).toMatchObject({ id: "tr_test_0001" });
  });

  it("names the transcript id when the output file cannot be written", async () => {
    const h = cli();
    const out = join(home, "locked.txt");
    await writeFile(out, "old");
    h.api.transcribe.mockImplementation(async () => {
      await rm(home, { recursive: true, force: true });
      return transcript();
    });
    expect(await h.run("transcribe", file, "--out", out, "--json")).toBe(1);
    const report = JSON.parse(h.stderr()) as { code: string; hint: string };
    expect(report.code).toBe("write_failed");
    expect(report.hint).toContain("hushscript transcript tr_test_0001");
  });

  it("shows progress on stderr only on a terminal and not under --json", async () => {
    const tty = cli({ stderrIsTTY: true });
    tty.api.transcribe.mockImplementation((_file, options) => {
      options?.onProgress?.({ stage: "uploading", percent: 40, bytesSent: 4, bytesTotal: 10 });
      options?.onProgress?.({ stage: "processing", state: "queued" });
      return Promise.resolve(transcript());
    });
    await tty.run("transcribe", file);
    expect(tty.stderr()).toContain("Uploading 40%");
    expect(tty.stderr()).toContain("Processing (queued)");
    expect(tty.stderr().endsWith("\r\u001b[K")).toBe(true);
    expect(tty.stdout()).toBe(transcript().toText());

    const json = cli({ stderrIsTTY: true });
    await json.run("transcribe", file, "--json");
    expect(requestOf(json).onProgress).toBeUndefined();
    expect(json.stderr()).toBe("");
  });

  it("passes SDK errors through with exit 1", async () => {
    const h = cli();
    h.api.transcribe.mockRejectedValue(new ApiError({ code: "unsupported_media", message: "No." }));
    expect(await h.run("transcribe", file)).toBe(1);
    expect(h.stderr()).toContain("Error: No.");
  });
});

describe("Ctrl-C during transcribe", () => {
  /** A transcribe call that reports its resume token, then waits for the abort signal. */
  function hang(h: Harness, token: string | null, errorToken: string | null): void {
    h.api.transcribe.mockImplementation(
      (_file, options) =>
        new Promise((_resolve, reject) => {
          if (token !== null) options?.onResumeToken?.(token);
          options?.signal?.addEventListener("abort", () => {
            reject(new AbortError({ message: "Aborted.", resumeToken: errorToken }));
          });
        }),
    );
  }

  it("prints the resume token and exits 130", async () => {
    const h = cli();
    hang(h, "rt-1", "rt-1");
    const result = h.run("transcribe", file);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.interrupt();
    expect(await result).toBe(130);
    expect(h.stderr()).toContain("Resume token: rt-1");
    expect(h.stdout()).toBe("");
  });

  it("reports it as JSON under --json", async () => {
    const h = cli();
    hang(h, "rt-2", null);
    const result = h.run("transcribe", file, "--json");
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.interrupt();
    expect(await result).toBe(130);
    expect(JSON.parse(h.stderr())).toMatchObject({
      code: "interrupted",
      numericCode: null,
      status: null,
      resumeToken: "rt-2",
    });
  });

  it("exits 130 without a token when the job did not exist yet", async () => {
    const h = cli();
    hang(h, null, null);
    const result = h.run("transcribe", file);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.interrupt();
    expect(await result).toBe(130);
    expect(h.stderr()).toBe("Error: Interrupted.\n");
  });

  it("forces the exit on a second Ctrl-C", async () => {
    const h = cli();
    hang(h, "rt-3", "rt-3");
    const result = h.run("transcribe", file);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.interrupt();
    h.interrupt();
    expect(h.forcedExits).toEqual([130]);
    await result;
  });

  it("stops listening once the call is over", async () => {
    const h = cli();
    await h.run("transcribe", file);
    h.interrupt();
    expect(h.forcedExits).toEqual([]);
  });
});
