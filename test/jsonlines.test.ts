import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, NetworkError } from "@hushscript/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { saveToken } from "../src/store.ts";
import { harness, TEST_TOKEN, type Harness } from "./helpers.ts";

const NO_REFUND_NOTICE =
  "Minutes are added to your account instantly after payment. All purchases are final and non-refundable.";

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

function cli(options: { stdinIsTTY?: boolean } = {}): Harness {
  return harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN }, ...options });
}

/** Every stderr line, parsed: under --json stderr is JSON Lines and nothing else. */
function lines(h: Harness): Record<string, unknown>[] {
  const text = h.stderr();
  if (text === "") return [];
  expect(text.endsWith("\n")).toBe(true);
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toBeTypeOf("object");
      return parsed as Record<string, unknown>;
    });
}

function types(h: Harness): unknown[] {
  return lines(h).map((line) => line["type"]);
}

describe("stderr under --json", () => {
  it("is one error object with type error when a command fails", async () => {
    const h = cli();
    h.api.balance.mockRejectedValue(new ApiError({ code: "rate_limited", message: "Slow." }));
    expect(await h.run("balance", "--json")).toBe(1);
    expect(types(h)).toEqual(["error"]);
    expect(Object.keys(lines(h)[0] ?? {})[0]).toBe("type");
  });

  it("carries the no-refund notice as a notice line before a purchase", async () => {
    const h = cli();
    expect(await h.run("buy", "300min", "--yes", "--json")).toBe(0);
    expect(lines(h)).toEqual([{ type: "notice", code: "no_refund", message: NO_REFUND_NOTICE }]);
    expect(JSON.parse(h.stdout())).toEqual({ seconds: 18_000, minutes: 300 });
  });

  it("puts the error object after the notice when the purchase fails", async () => {
    const h = cli();
    h.api.buy.mockRejectedValue(new NetworkError({ message: "Dropped." }));
    expect(await h.run("buy", "300min", "--yes", "--json")).toBe(1);
    expect(types(h)).toEqual(["notice", "error"]);
    expect(h.stdout()).toBe("");
  });

  it("is the error alone when buy cannot ask and nothing could be bought", async () => {
    const h = cli({ stdinIsTTY: false });
    expect(await h.run("buy", "300min", "--json")).toBe(2);
    expect(types(h)).toEqual(["error"]);
  });

  it("carries the login --token warning as a warning line", async () => {
    const h = harness({ home });
    expect(await h.run("login", "--token", TEST_TOKEN, "--json")).toBe(0);
    expect(types(h)).toEqual(["warning"]);
    expect(lines(h)[0]).toMatchObject({ code: "token_on_command_line" });
    expect(lines(h)[0]?.["message"]).toContain("shell history");
    expect(JSON.parse(h.stdout())).toMatchObject({ stored: true });
  });

  it("carries the readable-token-file warning as a warning line, then the result", async () => {
    const h = harness({ home });
    const path = join(home, ".config", "hushscript", "config.json");
    await saveToken(path, TEST_TOKEN, "linux");
    await chmod(path, 0o644);
    expect(await h.run("balance", "--json")).toBe(0);
    expect(types(h)).toEqual(["warning"]);
    expect(lines(h)[0]).toMatchObject({ code: "token_file_shared" });
    expect(JSON.parse(h.stdout())).toMatchObject({ minutes: 300 });
  });

  it("keeps warning, notice and the error object in order, error last", async () => {
    const h = harness({ home });
    const path = join(home, ".config", "hushscript", "config.json");
    await saveToken(path, TEST_TOKEN, "linux");
    await chmod(path, 0o644);
    h.api.buy.mockRejectedValue(new NetworkError({ message: "Dropped." }));
    expect(await h.run("buy", "300min", "--yes", "--json")).toBe(1);
    expect(types(h)).toEqual(["warning", "notice", "error"]);
  });

  it("is JSON for a missing token, a usage error and a bare invocation", async () => {
    const none = harness({ home });
    expect(await none.run("balance", "--json")).toBe(1);
    expect(types(none)).toEqual(["error"]);
    const usage = cli();
    expect(await usage.run("transcript", "tr_1", "--format", "docx", "--json")).toBe(2);
    expect(types(usage)).toEqual(["error"]);
    const bare = cli();
    expect(await bare.run("--json")).toBe(2);
    expect(types(bare)).toEqual(["error"]);
  });

  it("is JSON when a transcription is interrupted", async () => {
    const h = cli();
    h.api.transcribe.mockImplementation(() => new Promise(() => undefined));
    void h.run("transcribe", file, "--json");
    await vi.waitFor(() => {
      expect(h.api.transcribe).toHaveBeenCalledTimes(1);
    });
    h.interrupt();
    h.interrupt();
    expect(h.forcedExits).toEqual([130]);
    expect(types(h)).toEqual(["error"]);
  });

  it("stays empty when a command succeeds", async () => {
    const h = cli();
    expect(await h.run("packs", "--json")).toBe(0);
    expect(h.stderr()).toBe("");
  });
});

describe("--help and --version under --json", () => {
  it("print one JSON document on stdout and nothing on stderr", async () => {
    const version = cli();
    expect(await version.run("--version", "--json")).toBe(0);
    expect(JSON.parse(version.stdout())).toEqual({ version: pkg.version });
    expect(version.stderr()).toBe("");

    for (const argv of [
      ["--help", "--json"],
      ["--json", "help"],
      ["buy", "--help", "--json"],
    ]) {
      const h = cli();
      expect(await h.run(...argv)).toBe(0);
      const document = JSON.parse(h.stdout()) as { help?: unknown };
      expect(document.help).toBeTypeOf("string");
      expect(h.stderr()).toBe("");
    }
    const topic = cli();
    await topic.run("buy", "--help", "--json");
    expect((JSON.parse(topic.stdout()) as { help: string }).help).toContain(
      "Usage: hushscript buy",
    );
  });

  it("stay plain text without --json", async () => {
    const h = cli();
    expect(await h.run("--version")).toBe(0);
    expect(h.stdout()).toBe(`${pkg.version}\n`);
  });
});
