import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbortError, ApiError, type TranscribeOptions } from "@hushscript/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

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
    expect(requestOf(h).idempotencyKey).toMatch(UUID);
    expect(requestOf(h).onProgress).toBeUndefined();
    expect(h.stderr()).toContain("hushscript transcript tr_test_0001 --lang es");
  });

  it("mints a fresh key for every run without --key", async () => {
    const h = cli();
    await h.run("transcribe", file);
    await h.run("transcribe", file);
    const [first, second] = h.api.transcribe.mock.calls.map(
      ([, options]) => options?.idempotencyKey,
    );
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(first).not.toBe(second);
  });

  it("passes --key to the SDK as the idempotency key", async () => {
    const h = cli();
    expect(await h.run("transcribe", file, "--key", "replay_1-a")).toBe(0);
    expect(requestOf(h).idempotencyKey).toBe("replay_1-a");
  });

  it.each(["a".repeat(129), "", "no spaces", "line\nbreak", "café"])(
    "rejects invalid --key %j before creating a client",
    async (key) => {
      const h = cli();
      expect(await h.run("transcribe", file, "--key", key)).toBe(2);
      expect(h.stderr()).toBe(
        "Error: --key must be 1 to 128 characters from A-Z, a-z, 0-9, _ and -.\n",
      );
      expect(h.created).toEqual([]);
      expect(h.api.transcribe).not.toHaveBeenCalled();
    },
  );

  it("sends no language or translation unless asked", async () => {
    const h = cli();
    await h.run("transcribe", file);
    expect(requestOf(h).language).toBeUndefined();
    expect(requestOf(h).translateTo).toBeUndefined();
    expect(h.stderr()).toBe("");
  });

  it("exits 2 before any request when --out is a link into a missing folder", async () => {
    const link = join(home, "out.srt");
    await symlink(join(home, "missing", "out.srt"), link);
    const h = cli();
    expect(await h.run("transcribe", file, "--out", link)).toBe(2);
    expect(h.created).toEqual([]);
    expect(h.api.transcribe).not.toHaveBeenCalled();
    const again = cli();
    expect(await again.run("resume", "rt-9", file, "--out", link)).toBe(2);
    expect(again.api.resume).not.toHaveBeenCalled();
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

  it("prints the complete recovery hint when the output folder disappears after transcription", async () => {
    const h = cli();
    const out = join(home, "missing-output.txt");
    await writeFile(out, "old");
    h.api.transcribe.mockImplementation(async () => {
      await rm(home, { recursive: true, force: true });
      return transcript();
    });
    expect(await h.run("transcribe", file, "--out", out, "--json")).toBe(1);
    const report = JSON.parse(h.stderr()) as { code: string; hint: string };
    expect(report.code).toBe("write_failed");
    expect(report.hint).toBe(
      "The transcript was created; fetch it again with `hushscript transcript tr_test_0001`.",
    );
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
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    expect(await result).toBe(130);
    expect(h.stderr()).toContain("Resume token: rt-1");
    expect(h.stdout()).toBe("");
  });

  it("reports it as JSON under --json", async () => {
    const h = cli();
    hang(h, "rt-2", null);
    const result = h.run("transcribe", file, "--json");
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
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
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    expect(await result).toBe(130);
    expect(h.stderr()).toMatch(
      /^Error: Interrupted\.\nHint: Retry with: .*\nIdempotency key: [\da-f-]{36}\n$/,
    );
  });

  it("names the replay command with the key and the file when there is no token", async () => {
    const h = cli();
    hang(h, null, null);
    const result = h.run("transcribe", file, "--key", "replay_2");
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    expect(await result).toBe(130);
    expect(h.stderr()).toBe(
      `Error: Interrupted.\nHint: Retry with: hushscript transcribe --key replay_2 ${file}\nIdempotency key: replay_2\n`,
    );
  });

  it("names the replay command in the JSON hint, and the resume command once a token exists", async () => {
    const noToken = cli();
    hang(noToken, null, null);
    const first = noToken.run("transcribe", file, "--key", "replay_3", "--json");
    await vi.waitFor(() => {
      expect(noToken.api.transcribe).toHaveBeenCalled();
    });
    noToken.interrupt();
    expect(await first).toBe(130);
    expect(JSON.parse(noToken.stderr())).toMatchObject({
      idempotencyKey: "replay_3",
      hint: `Retry with: hushscript transcribe --key replay_3 ${file}`,
    });
    const withToken = cli();
    hang(withToken, "rt-8", "rt-8");
    const second = withToken.run("transcribe", file, "--key", "replay_3", "--json");
    await vi.waitFor(() => {
      expect(withToken.api.transcribe).toHaveBeenCalled();
    });
    withToken.interrupt();
    expect(await second).toBe(130);
    expect(JSON.parse(withToken.stderr())).toMatchObject({
      resumeToken: "rt-8",
      hint: `Continue with: hushscript resume rt-8 ${file}`,
    });
  });

  it("names the resume command with the file next to the token", async () => {
    const h = cli();
    hang(h, "rt-1", "rt-1");
    const result = h.run("transcribe", file);
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    await result;
    expect(h.stderr()).toContain(`Hint: Continue with: hushscript resume rt-1 ${file}`);
  });

  it("carries every option into the replay hint, quoted where the shell needs it", async () => {
    const out = join(home, "my call's.srt");
    const h = cli();
    hang(h, null, null);
    const result = h.run(
      "transcribe",
      file,
      "--key",
      "replay_4",
      "--language",
      "pt-BR",
      "--translate",
      "es,de",
      "--format",
      "srt",
      "--out",
      out,
    );
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    expect(await result).toBe(130);
    expect(h.stderr()).toContain(
      `Hint: Retry with: hushscript transcribe --key replay_4 ${file} --language pt-BR --translate es,de --format srt --out '${home}/my call'\\''s.srt'\n`,
    );
  });

  it("leaves the flags the user did not pass out of the replay hint", async () => {
    const h = cli();
    hang(h, null, null);
    const result = h.run("transcribe", file, "--key", "replay_5", "--format", "vtt");
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    expect(await result).toBe(130);
    expect(h.stderr()).toContain(
      `Hint: Retry with: hushscript transcribe --key replay_5 ${file} --format vtt\n`,
    );
  });

  it("carries only --format and --out into the resume hint, quoted", async () => {
    const out = join(home, "two words.txt");
    const h = cli();
    hang(h, "rt-6", "rt-6");
    const result = h.run(
      "transcribe",
      file,
      "--language",
      "en",
      "--translate",
      "es",
      "--format",
      "json",
      "--out",
      out,
    );
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    expect(await result).toBe(130);
    expect(h.stderr()).toContain(
      `Hint: Continue with: hushscript resume rt-6 ${file} --format json --out '${out}'\n`,
    );
  });

  it("keeps --format and --out in the hint of an interrupted resume, and omits them when not passed", async () => {
    const out = join(home, "it's here.txt");
    const hang2 = (h: Harness): void => {
      h.api.resume.mockImplementation(
        (token, _file, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new AbortError({ message: "Aborted.", resumeToken: token }));
            });
          }),
      );
    };
    const full = cli();
    hang2(full);
    const first = full.run("resume", "rt-7", file, "--format", "vtt", "--out", out);
    await vi.waitFor(() => {
      expect(full.api.resume).toHaveBeenCalled();
    });
    full.interrupt();
    expect(await first).toBe(130);
    expect(full.stderr()).toContain(
      `Hint: Continue with: hushscript resume rt-7 ${file} --format vtt --out '${home}/it'\\''s here.txt'\n`,
    );
    const bare = cli();
    hang2(bare);
    const second = bare.run("resume", "rt-7", file);
    await vi.waitFor(() => {
      expect(bare.api.resume).toHaveBeenCalled();
    });
    bare.interrupt();
    expect(await second).toBe(130);
    expect(bare.stderr()).toContain(`Hint: Continue with: hushscript resume rt-7 ${file}\n`);
  });

  it("quotes a file name the shell would split", async () => {
    const spaced = join(home, "my call.mp3");
    await writeFile(spaced, "audio");
    const h = cli();
    hang(h, "rt-1", "rt-1");
    const result = h.run("transcribe", spaced);
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    await result;
    expect(h.stderr()).toContain(`hushscript resume rt-1 '${spaced}'`);
  });

  it("keeps the idempotency key the SDK error carries", async () => {
    const h = cli();
    h.api.transcribe.mockImplementation(
      (_file, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new AbortError({ message: "Aborted.", resumeToken: "rt-4" });
            error.idempotencyKey = "key-4";
            reject(error);
          });
        }),
    );
    const result = h.run("transcribe", file, "--json");
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    expect(await result).toBe(130);
    expect(JSON.parse(h.stderr())).toMatchObject({ resumeToken: "rt-4", idempotencyKey: "key-4" });
  });

  it("falls back to the key the CLI minted when the SDK error has none", async () => {
    const h = cli();
    hang(h, "rt-6", null);
    const result = h.run("transcribe", file, "--json");
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    expect(await result).toBe(130);
    expect(JSON.parse(h.stderr())).toMatchObject({ idempotencyKey: requestOf(h).idempotencyKey });
  });

  it("keeps the key on a second Ctrl-C, the one the call was started with", async () => {
    const h = cli();
    hang(h, "rt-7", "rt-7");
    const result = h.run("transcribe", file, "--json");
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    h.interrupt();
    expect(h.forcedExits).toEqual([130]);
    const report = JSON.parse(h.stderr().split("\n")[0] ?? "") as Record<string, unknown>;
    expect(report).toMatchObject({
      resumeToken: "rt-7",
      idempotencyKey: requestOf(h).idempotencyKey,
    });
    expect(report["idempotencyKey"]).toMatch(UUID);
    await result;
  });

  it("prints the resume token and forces the exit on a second Ctrl-C", async () => {
    const h = cli();
    hang(h, "rt-3", "rt-3");
    const result = h.run("transcribe", file);
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    h.interrupt();
    // Synchronously after the signal: the exit must not wait for the call to wind down.
    expect(h.forcedExits).toEqual([130]);
    expect(h.stderr()).toContain("Resume token: rt-3");
    expect(h.stderr()).toContain("hushscript resume rt-3");
    await result;
  });

  it("forces the exit as JSON under --json", async () => {
    const h = cli();
    hang(h, "rt-5", "rt-5");
    const result = h.run("transcribe", file, "--json");
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    h.interrupt();
    expect(h.forcedExits).toEqual([130]);
    expect(JSON.parse(h.stderr().split("\n")[0] ?? "")).toMatchObject({
      code: "interrupted",
      resumeToken: "rt-5",
    });
    await result;
  });

  it("stops listening once the call is over", async () => {
    const h = cli();
    await h.run("transcribe", file);
    h.interrupt();
    expect(h.forcedExits).toEqual([]);
  });
});

describe("resume", () => {
  it("finishes the job from the token and prints the transcript", async () => {
    const h = cli();
    expect(await h.run("resume", "rt-9", file, "--format", "srt")).toBe(0);
    expect(h.stdout()).toBe(transcript().toSRT());
    const [token, resumed] = h.api.resume.mock.calls[0] ?? [];
    expect([token, resumed]).toEqual(["rt-9", file]);
    expect(h.api.transcribe).not.toHaveBeenCalled();
  });

  it("writes --out and reports it as JSON under --json", async () => {
    const h = cli();
    const out = join(home, "again.json");
    expect(await h.run("resume", "rt-9", file, "--json", "--out", out)).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual({ id: "tr_test_0001", format: "json", out });
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ id: "tr_test_0001" });
  });

  it("exits 2 for a missing file or a --format that contradicts --json, sending nothing", async () => {
    const missing = cli();
    expect(await missing.run("resume", "rt-9", join(home, "none.mp3"))).toBe(2);
    const clash = cli();
    expect(await clash.run("resume", "rt-9", file, "--json", "--format", "srt")).toBe(2);
    expect(missing.api.resume).not.toHaveBeenCalled();
    expect(clash.api.resume).not.toHaveBeenCalled();
  });

  it("needs both arguments", async () => {
    expect(await cli().run("resume", "rt-9")).toBe(2);
  });

  it("prints the token it was given when interrupted again, before the SDK reports one", async () => {
    const h = cli();
    h.api.resume.mockImplementation(
      (_token, _file, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new AbortError({ message: "Aborted.", resumeToken: null }));
          });
        }),
    );
    const result = h.run("resume", "rt-9", file);
    await vi.waitFor(() => {
      expect(h.api.resume).toHaveBeenCalled();
    });
    h.interrupt();
    expect(await result).toBe(130);
    expect(h.stderr()).toContain("Resume token: rt-9");
    expect(h.stderr()).toContain(`hushscript resume rt-9 ${file}`);
  });

  it("draws progress on a terminal", async () => {
    const h = cli({ stderrIsTTY: true });
    h.api.resume.mockImplementation((_token, _file, options) => {
      options?.onProgress?.({ stage: "processing", state: "queued" });
      return Promise.resolve(transcript());
    });
    await h.run("resume", "rt-9", file);
    expect(h.stderr()).toContain("Processing (queued)");
  });
});

describe("job failures and boundaries", () => {
  it.each(["a", "a".repeat(128)])("accepts the --key boundary %j unchanged", async (key) => {
    const h = cli();
    expect(await h.run("transcribe", file, "--key", key)).toBe(0);
    expect(requestOf(h).idempotencyKey).toBe(key);
  });

  it.each([
    ["transcribe", false],
    ["transcribe", true],
    ["resume", false],
    ["resume", true],
  ] as const)("preserves both SDK error fields for %s (json=%s)", async (command, json) => {
    const h = cli();
    const error = new ApiError({
      code: "server_error",
      status: 503,
      message: "Try later.",
    });
    error.resumeToken = "rt-failure";
    error.idempotencyKey = "key-failure";
    h.api[command].mockRejectedValue(error);
    const args = command === "resume" ? [command, "rt-input", file] : [command, file];
    expect(await h.run(...args, ...(json ? ["--json"] : []))).toBe(1);
    expect(h.stdout()).toBe("");
    if (json) {
      expect(JSON.parse(h.stderr())).toEqual({
        type: "error",
        code: "server_error",
        numericCode: null,
        status: 503,
        message: "Try later.",
        hint: null,
        resumeToken: "rt-failure",
        idempotencyKey: "key-failure",
      });
    } else {
      expect(h.stderr()).toBe(
        "Error: Try later.\nIdempotency key: key-failure\nResume token: rt-failure\n",
      );
    }
  });

  it.each(["transcribe", "resume"] as const)(
    "closes the %s interrupt window after failure",
    async (command) => {
      const h = cli();
      h.api[command].mockRejectedValue(new ApiError({ code: "server_error", message: "No." }));
      const args = command === "resume" ? [command, "rt-input", file] : [command, file];
      expect(await h.run(...args)).toBe(1);
      const before = h.stderr();
      h.interrupt();
      h.interrupt();
      expect(h.stderr()).toBe(before);
      expect(h.forcedExits).toEqual([]);
    },
  );

  it("suppresses the translation note under --json", async () => {
    const h = cli();
    expect(await h.run("transcribe", file, "--translate", "es", "--json")).toBe(0);
    expect(requestOf(h).translateTo).toEqual(["es"]);
    expect(JSON.parse(h.stdout())).toMatchObject({ id: "tr_test_0001" });
    expect(h.stderr()).toBe("");
  });

  it.each(["transcribe", "resume"] as const)(
    "forces a second signal during %s before a new token arrives",
    async (command) => {
      const h = cli();
      h.api.transcribe.mockImplementation(
        (_file, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new AbortError({ message: "Aborted." }));
            });
          }),
      );
      h.api.resume.mockImplementation(
        (_token, _file, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new AbortError({ message: "Aborted." }));
            });
          }),
      );
      const args =
        command === "resume" ? [command, "rt-input", file] : [command, file, "--key", "key-input"];
      const result = h.run(...args, "--json");
      await vi.waitFor(() => {
        expect(h.api[command]).toHaveBeenCalled();
      });
      h.interrupt();
      h.interrupt();
      expect(h.forcedExits).toEqual([130]);
      const report = JSON.parse(h.stderr().split("\n")[0] ?? "") as Record<string, unknown>;
      expect(report).toMatchObject({
        code: "interrupted",
        hint:
          command === "resume"
            ? `Continue with: hushscript resume rt-input ${file}`
            : `Retry with: hushscript transcribe --key key-input ${file}`,
      });
      if (command === "resume") {
        expect(report["resumeToken"]).toBe("rt-input");
        expect(report).not.toHaveProperty("idempotencyKey");
      } else {
        expect(report["idempotencyKey"]).toBe("key-input");
        expect(report).not.toHaveProperty("resumeToken");
      }
      expect(h.stdout()).toBe("");
      await result;
    },
  );

  it("clears a drawn progress line before the second-signal report", async () => {
    const h = cli({ stderrIsTTY: true });
    h.api.transcribe.mockImplementation(
      (_file, options) =>
        new Promise((_resolve, reject) => {
          options?.onResumeToken?.("rt-progress");
          options?.onProgress?.({ stage: "processing", state: "queued" });
          options?.signal?.addEventListener("abort", () => {
            reject(new AbortError({ message: "Aborted." }));
          });
        }),
    );
    const result = h.run("transcribe", file, "--key", "key-progress");
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalled();
    });
    h.interrupt();
    h.interrupt();
    expect(h.forcedExits).toEqual([130]);
    expect(h.stderr()).toBe(
      `\r\u001b[KProcessing (queued)\r\u001b[KError: Interrupted.\nHint: Continue with: hushscript resume rt-progress ${file}\nIdempotency key: key-progress\nResume token: rt-progress\n`,
    );
    await result;
  });
});
