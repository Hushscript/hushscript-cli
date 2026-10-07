import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { harness, rows, transcript, TEST_TOKEN, type Harness } from "./helpers.ts";

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

function cli(): Harness {
  return harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN } });
}

/** An invocation that must fail as a usage error before anything is sent. */
async function expectUsage(h: Harness, ...argv: string[]): Promise<string> {
  expect(await h.run(...argv)).toBe(2);
  expect(h.created).toEqual([]);
  expect(h.stdout()).toBe("");
  return h.stderr();
}

describe("--format", () => {
  it("accepts srt, vtt, txt and json", async () => {
    for (const format of ["srt", "vtt", "txt", "json"]) {
      const h = cli();
      expect(await h.run("transcript", "tr_1", "--format", format)).toBe(0);
      expect(h.stdout()).not.toBe("");
    }
  });

  it("rejects anything else on transcript and transcribe, with exit 2 and no request", async () => {
    expect(await expectUsage(cli(), "transcript", "tr_1", "--format", "docx")).toContain(
      "Allowed choices are srt, vtt, txt, json",
    );
    await expectUsage(cli(), "transcribe", file, "--format", "pdf");
  });

  it("reports the error as JSON on stderr under --json", async () => {
    const h = cli();
    const stderr = await expectUsage(h, "--json", "transcript", "tr_1", "--format", "docx");
    expect(JSON.parse(stderr)).toMatchObject({
      code: "usage_error",
      numericCode: null,
      status: null,
      hint: null,
    });
  });

  it("renders each format from the SDK's own formatters", async () => {
    const t = transcript();
    const render = async (format: string): Promise<string> => {
      const h = cli();
      h.api.transcripts.get.mockResolvedValue(t);
      await h.run("transcript", "tr_1", "--format", format);
      return h.stdout();
    };
    expect(await render("srt")).toBe(t.toSRT());
    expect(await render("vtt")).toBe(t.toVTT());
    expect(await render("txt")).toBe(t.toText());
    expect(await render("json")).toBe(`${JSON.stringify(t.toJSON(), null, 2)}\n`);
  });

  it("adds a final newline only on a terminal, so a pipe gets the SDK's bytes", async () => {
    const piped = cli();
    await piped.run("transcript", "tr_1", "--format", "srt");
    expect(piped.stdout().endsWith("\n")).toBe(false);
    const tty = harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN }, stdoutIsTTY: true });
    await tty.run("transcript", "tr_1", "--format", "srt");
    expect(tty.stdout()).toBe(`${transcript().toSRT()}\n`);
  });

  it("defaults to txt", async () => {
    const h = cli();
    await h.run("transcript", "tr_1");
    expect(h.stdout()).toBe(transcript().toText());
  });

  it("conflicts with --json unless it is json", async () => {
    expect(await expectUsage(cli(), "--json", "transcript", "tr_1", "--format", "srt")).toContain(
      "usage_error",
    );
    const h = cli();
    expect(await h.run("--json", "transcript", "tr_1", "--format", "json")).toBe(0);
    expect(JSON.parse(h.stdout())).toMatchObject({ id: "tr_test_0001" });
  });

  it("prints JSON for --json alone", async () => {
    const h = cli();
    expect(await h.run("transcript", "tr_1", "--json")).toBe(0);
    expect(JSON.parse(h.stdout())).toMatchObject({ id: "tr_test_0001" });
  });
});

describe("flag and argument validation, before any request", () => {
  it("checks --language, --translate and the input file", async () => {
    await expectUsage(cli(), "transcribe", file, "--language", "english!");
    await expectUsage(cli(), "transcribe", file, "--translate", "es,,de");
    await expectUsage(cli(), "transcribe", file, "--translate", "es,fr de");
    await expectUsage(cli(), "transcribe", join(home, "missing.mp3"));
    await expectUsage(cli(), "transcribe", home);
  });

  it("checks --out", async () => {
    await expectUsage(cli(), "transcribe", file, "--out", join(home, "nope", "out.txt"));
    await expectUsage(cli(), "transcribe", file, "--out", home);
  });

  it("checks --limit", async () => {
    for (const limit of ["0", "-1", "1.5", "abc", "1000000"]) {
      await expectUsage(cli(), "transcripts", "--limit", limit);
    }
  });

  it("checks transcript ids and --lang", async () => {
    for (const id of ["..", ".", "a/b", "a b", "x".repeat(129)]) {
      await expectUsage(cli(), "transcript", id);
    }
    await expectUsage(cli(), "transcript", "tr_1", "--lang", "es es");
    await expectUsage(cli(), "transcript", "tr_1", "--lang", "es", "--format", "json");
  });

  it("checks the pack and --key", async () => {
    await expectUsage(cli(), "buy", "huge", "--yes");
    await expectUsage(cli(), "buy", "300min", "--yes", "--key", "bad key");
  });

  it("rejects unknown commands and options, missing arguments and extra arguments", async () => {
    await expectUsage(cli(), "frobnicate");
    await expectUsage(cli(), "balance", "--nope");
    await expectUsage(cli(), "transcribe");
    await expectUsage(cli(), "balance", "extra");
  });

  it("never echoes a token typed as an unknown option", async () => {
    const stderr = await expectUsage(cli(), `--token=${TEST_TOKEN}`, "--nope");
    expect(stderr).not.toContain(TEST_TOKEN);
    const mistyped = await expectUsage(cli(), `--tokn=${TEST_TOKEN}`, "balance");
    expect(mistyped).not.toContain(TEST_TOKEN);
  });
});

describe("help and version", () => {
  it("prints the commands for --help and exits 0", async () => {
    const h = cli();
    expect(await h.run("--help")).toBe(0);
    for (const command of [
      "login",
      "logout",
      "balance",
      "transcribe",
      "resume",
      "transcripts",
      "transcript",
      "jobs",
      "packs",
      "buy",
      "--json",
      "--token",
    ]) {
      expect(h.stdout()).toContain(command);
    }
  });

  it("prints the version for --version", async () => {
    const h = cli();
    expect(await h.run("--version")).toBe(0);
    expect(h.stdout()).toBe(`${pkg.version}\n`);
  });

  it("shows the help on stderr and exits 2 for a bare invocation", async () => {
    const h = cli();
    expect(await h.run()).toBe(2);
    expect(h.stderr()).toContain("Usage: hushscript");
  });

  it("treats `help` like --help: the help on stdout and exit 0", async () => {
    const h = cli();
    expect(await h.run("help")).toBe(0);
    expect(h.stdout()).toContain("Usage: hushscript");
    expect(h.stderr()).toBe("");
    const topic = cli();
    expect(await topic.run("help", "buy")).toBe(0);
    expect(topic.stdout()).toContain("Usage: hushscript buy");
  });

  it("reports a bare --json invocation as a JSON usage error and no help text", async () => {
    const h = cli();
    expect(await h.run("--json")).toBe(2);
    expect(JSON.parse(h.stderr())).toMatchObject({ code: "usage_error" });
    expect(h.stderr()).not.toContain("Usage:");
    expect(h.stdout()).toBe("");
  });

  it("accepts the global flags after the command", async () => {
    const h = cli();
    h.api.jobs.list.mockReturnValue(rows([]));
    expect(await h.run("jobs", "--json", "--active")).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual({ jobs: [] });
    expect(h.api.jobs.list).toHaveBeenCalledWith({ active: true });
  });
});
