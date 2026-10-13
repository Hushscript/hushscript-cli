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
async function expectUsage(h: Harness, message: string, ...argv: string[]): Promise<string> {
  expect(await h.run(...argv)).toBe(2);
  expect(h.created).toEqual([]);
  expect(h.stdout()).toBe("");
  expect(h.stderr()).toBe(message);
  return h.stderr();
}

describe("--format", () => {
  it.each([
    ["transcript", "docx"],
    ["transcribe", "pdf"],
  ])("rejects format %s %s before any request", async (command, format) => {
    await expectUsage(
      cli(),
      `Error: option '--format <format>' argument '${format}' is invalid. Allowed choices are srt, vtt, txt, json.\n`,
      command,
      command === "transcript" ? "tr_1" : file,
      "--format",
      format,
    );
  });

  it("reports the error as JSON on stderr under --json", async () => {
    const h = cli();
    const stderr = await expectUsage(
      h,
      `${JSON.stringify({ type: "error", code: "usage_error", numericCode: null, status: null, message: "option '--format <format>' argument 'docx' is invalid. Allowed choices are srt, vtt, txt, json.", hint: null })}\n`,
      "--json",
      "transcript",
      "tr_1",
      "--format",
      "docx",
    );
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
    expect(
      await expectUsage(
        cli(),
        `${JSON.stringify({ type: "error", code: "usage_error", numericCode: null, status: null, message: "--json prints the transcript as JSON; drop --format or use --format json.", hint: null })}\n`,
        "--json",
        "transcript",
        "tr_1",
        "--format",
        "srt",
      ),
    ).toContain("usage_error");
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
  it.each(["english!", ""])("rejects --language %j", async (language) => {
    await expectUsage(
      cli(),
      `Error: --language must be a language code such as en or pt-BR, not "${language}".\n`,
      "transcribe",
      file,
      "--language",
      language,
    );
  });

  it.each([
    ["es,,de", ""],
    ["es,fr de", "fr de"],
    ["", ""],
    ["es,", ""],
  ])("rejects --translate %j", async (value, invalid) => {
    await expectUsage(
      cli(),
      `Error: --translate takes language codes separated by commas, such as es,de; "${invalid}" is not one.\n`,
      "transcribe",
      file,
      "--translate",
      value,
    );
  });

  it("rejects a missing input file", async () => {
    await expectUsage(
      cli(),
      `Error: No such file: ${join(home, "missing.mp3")}\n`,
      "transcribe",
      join(home, "missing.mp3"),
    );
  });

  it("rejects a folder as input", async () => {
    await expectUsage(cli(), `Error: Not a file: ${home}\n`, "transcribe", home);
  });

  it("rejects --out into a missing folder", async () => {
    await expectUsage(
      cli(),
      `Error: The folder for --out does not exist: ${join(home, "nope")}\n`,
      "transcribe",
      file,
      "--out",
      join(home, "nope", "out.txt"),
    );
  });

  it("rejects --out pointing to a folder", async () => {
    await expectUsage(
      cli(),
      `Error: --out is a folder, not a file: ${home}\n`,
      "transcribe",
      file,
      "--out",
      home,
    );
  });

  it.each(["0", "-1", "1.5", "abc", "1000000", " 5", "05", "+5", "1e3", ""])(
    "rejects --limit %j",
    async (limit) => {
      await expectUsage(
        cli(),
        "Error: --limit must be a whole number from 1 to 999999.\n",
        "transcripts",
        "--limit",
        limit,
      );
    },
  );

  it.each(["..", ".", "a/b", "a b", "x".repeat(129), ""])(
    "rejects transcript id %j",
    async (id) => {
      await expectUsage(
        cli(),
        "Error: The transcript id must be 1 to 128 letters, digits, dots, dashes or underscores.\n",
        "transcript",
        id,
      );
    },
  );

  it("rejects an invalid --lang", async () => {
    await expectUsage(
      cli(),
      'Error: --lang must be a translation language code or "cleaned", not "es es".\n',
      "transcript",
      "tr_1",
      "--lang",
      "es es",
    );
  });

  it.each(["es", "original"])("rejects --lang %s with JSON output", async (language) => {
    await expectUsage(
      cli(),
      "Error: --lang does not apply to JSON output, which holds every language.\n",
      "transcript",
      "tr_1",
      "--lang",
      language,
      "--format",
      "json",
    );
  });

  it("rejects an invalid pack", async () => {
    await expectUsage(
      cli(),
      "Error: The pack must look like 300min; run `hushscript packs` to list them.\n",
      "buy",
      "huge",
      "--yes",
    );
  });

  it("rejects an invalid --key", async () => {
    await expectUsage(
      cli(),
      "Error: --key must be 1 to 128 characters from A-Z, a-z, 0-9, _ and -.\n",
      "buy",
      "300min",
      "--yes",
      "--key",
      "bad key",
    );
  });

  it.each([
    [["frobnicate"], "Error: unknown command 'frobnicate'\n"],
    [["balance", "--nope"], "Error: unknown option '--nope'\n"],
    [["transcribe"], "Error: missing required argument 'file'\n"],
    [
      ["balance", "extra"],
      "Error: too many arguments for 'balance'. Expected 0 arguments but got 1: extra.\n",
    ],
  ] as const)("rejects command arguments %j", async (argv, message) => {
    await expectUsage(cli(), message, ...argv);
  });

  it("rejects an unknown option after an equals-form token", async () => {
    await expectUsage(cli(), "Error: unknown option '--nope'\n", `--token=${TEST_TOKEN}`, "--nope");
  });

  it("never echoes a token typed as an unknown option", async () => {
    await expectUsage(
      cli(),
      "Error: unknown option '--tokn=[redacted]'\n",
      `--tokn=${TEST_TOKEN}`,
      "balance",
    );
  });

  it("redacts a space-form token without the SDK token shape in a later error", async () => {
    const secret = "plain-secret-value";
    const h = cli();
    h.api.balance.mockRejectedValue(new Error(`leaked ${secret}`));
    expect(await h.run("--token", secret, "balance")).toBe(1);
    expect(h.stderr()).toBe("Error: Unexpected error: leaked [redacted]\n");
    await expectUsage(cli(), "Error: unknown option '--nope'\n", "--token", secret, "--nope");
  });
});

describe("help and version", () => {
  it("prints the commands for --help and exits 0", async () => {
    const h = cli();
    expect(await h.run("--help")).toBe(0);
    const commandRows = h
      .stdout()
      .split("\n")
      .filter((line) =>
        /^ {2}(?:login|logout|balance|transcribe|resume|transcripts|transcript|jobs|packs|buy|help)(?: |$)/.test(
          line,
        ),
      );
    expect(commandRows.map((line) => line.trim().split(/ {2,}/)[0])).toEqual([
      "login",
      "logout",
      "balance",
      "transcribe [options] <file>",
      "resume [options] <token> <file>",
      "transcripts [options]",
      "transcript [options] <id>",
      "jobs [options]",
      "packs",
      "buy [options] <pack>",
      "help [command]",
    ]);
    expect(h.stdout()).toContain("--json");
    expect(h.stdout()).toContain("--token <token>");
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
