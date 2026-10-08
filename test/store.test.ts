import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath, readStoredToken, removeToken, resolveToken, saveToken } from "../src/store.ts";
import { harness, OTHER_TOKEN, TEST_TOKEN } from "./helpers.ts";

/** Every kind of "not set": empty, ASCII whitespace, and the Unicode spaces String.prototype.trim removes. */
const BLANKS = [
  "",
  " ",
  "   ",
  "\t",
  "\n",
  "\u00a0",
  "\u2003",
  "\u3000",
  "\ufeff",
  "\u2028",
  " \t\n\u00a0 ",
];

const MISSING_TOKEN_REPORT = {
  type: "error",
  code: "config_invalid",
  numericCode: null,
  status: null,
  message: "No Hushscript token.",
  hint: "Run `hushscript login`, set HUSHSCRIPT_TOKEN, or pass --token. Create a token in the Hushscript app under Account, Connected apps.",
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hushscript-cli-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("configPath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(
      configPath({ env: { XDG_CONFIG_HOME: "/x/cfg" }, platform: "linux", homedir: "/h" }),
    ).toBe("/x/cfg/hushscript/config.json");
  });

  it.each(BLANKS)("falls back to ~/.config for XDG_CONFIG_HOME %j", (blank) => {
    expect(configPath({ env: { XDG_CONFIG_HOME: blank }, platform: "linux", homedir: "/h" })).toBe(
      "/h/.config/hushscript/config.json",
    );
  });

  it("uses APPDATA on Windows, with a fallback under the home folder", () => {
    const win = (env: Record<string, string | undefined>): string =>
      configPath({ env, platform: "win32", homedir: "/h" });
    expect(win({ APPDATA: "/ad" })).toBe("/ad/hushscript/config.json");
    expect(win({})).toBe("/h/AppData/Roaming/hushscript/config.json");
    for (const blank of BLANKS) {
      expect(win({ APPDATA: blank })).toBe("/h/AppData/Roaming/hushscript/config.json");
    }
  });
});

describe("the token file", () => {
  it("is written as 0600 in a 0700 folder", async () => {
    const path = join(home, "cfg", "hushscript", "config.json");
    await saveToken(path, TEST_TOKEN, "linux");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "cfg", "hushscript"))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ token: TEST_TOKEN });
    expect(await readStoredToken(path)).toBe(TEST_TOKEN);
  });

  it("tightens a looser file and folder and leaves no temp file behind", async () => {
    const folder = join(home, "hushscript");
    const path = join(folder, "config.json");
    await mkdir(folder, { mode: 0o755 });
    await writeFile(path, "{}", { mode: 0o644 });
    await saveToken(path, OTHER_TOKEN, "linux");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(await readdir(folder)).toEqual(["config.json"]);
    expect(await readStoredToken(path)).toBe(OTHER_TOKEN);
  });

  it("cleans up its temp file when the rename fails", async () => {
    const folder = join(home, "hushscript");
    await mkdir(join(folder, "config.json"), { recursive: true });
    await expect(saveToken(join(folder, "config.json"), TEST_TOKEN, "linux")).rejects.toThrow();
    expect(await readdir(folder)).toEqual(["config.json"]);
  });

  it("refuses a symbolic link as the config folder and changes nothing it points at", async () => {
    const real = join(home, "dotfiles");
    await mkdir(real, { mode: 0o755 });
    await chmod(real, 0o755);
    const folder = join(home, "hushscript");
    await symlink(real, folder);
    await expect(saveToken(join(folder, "config.json"), TEST_TOKEN, "linux")).rejects.toMatchObject(
      { code: "config_invalid", exitCode: 1 },
    );
    expect((await stat(real)).mode & 0o777).toBe(0o755);
    expect(await readdir(real)).toEqual([]);
  });

  it("refuses a dangling symbolic link as the config folder too", async () => {
    const folder = join(home, "hushscript");
    await symlink(join(home, "nowhere"), folder);
    await expect(saveToken(join(folder, "config.json"), TEST_TOKEN, "linux")).rejects.toMatchObject(
      { code: "config_invalid" },
    );
  });

  it("login reports a symlinked config folder with exit 1", async () => {
    const h = harness({ home, secret: TEST_TOKEN });
    await mkdir(join(home, ".config"));
    await mkdir(join(home, "dotfiles"));
    await symlink(join(home, "dotfiles"), join(home, ".config", "hushscript"));
    expect(await h.run("login")).toBe(1);
    expect(h.stderr()).toContain("symbolic link");
    expect(h.stderr()).not.toContain(TEST_TOKEN);
  });

  it.each([0o640, 0o604, 0o644, 0o660, 0o666])(
    "warns when mode %o lets group or others read the token file",
    async (mode) => {
      const path = join(home, "config.json");
      await saveToken(path, TEST_TOKEN, "linux");
      const warnings: string[] = [];
      const warn = (text: string): void => {
        warnings.push(text);
      };
      expect(await readStoredToken(path, { platform: "linux", warn })).toBe(TEST_TOKEN);
      expect(warnings).toEqual([]);
      await chmod(path, mode);
      expect(await readStoredToken(path, { platform: "linux", warn })).toBe(TEST_TOKEN);
      expect(warnings).toEqual([
        `${path} can be read by other users (mode ${mode.toString(8).padStart(4, "0")}). Run: chmod 600 ${path}`,
      ]);
      warnings.length = 0;
      await readStoredToken(path, { platform: "win32", warn });
      expect(warnings).toEqual([]);
    },
  );

  it("shows that warning once, on stderr, in a real command that uses the stored token", async () => {
    const h = harness({ home });
    const path = join(home, ".config", "hushscript", "config.json");
    await saveToken(path, TEST_TOKEN, "linux");
    await chmod(path, 0o644);
    expect(await h.run("balance", "--json")).toBe(0);
    expect(JSON.parse(h.stderr())).toEqual({
      type: "warning",
      code: "token_file_shared",
      message: `${path} can be read by other users (mode 0644). Run: chmod 600 ${path}`,
    });
    const plain = harness({ home });
    expect(await plain.run("balance")).toBe(0);
    expect(plain.stderr()).toBe(
      `Warning: ${path} can be read by other users (mode 0644). Run: chmod 600 ${path}\n`,
    );
    expect(JSON.parse(h.stdout())).toMatchObject({ minutes: 300 });
  });

  it("reads nothing when there is no file", async () => {
    expect(await readStoredToken(join(home, "missing.json"))).toBeNull();
  });

  it("refuses a file that is not JSON, holds no token string or cannot be read", async () => {
    const path = join(home, "config.json");
    const cases: [string, string][] = [
      ["not json", "is not valid JSON"],
      ["{}", "holds no token"],
      ["null", "holds no token"],
      ['{"token":5}', "holds no token"],
      ['{"token":null}', "holds no token"],
    ];
    for (const [text, problem] of cases) {
      await writeFile(path, text);
      await expect(readStoredToken(path)).rejects.toMatchObject({
        name: "CliError",
        code: "config_invalid",
        message: `The config file at ${path} ${problem}.`,
      });
    }
    await rm(path);
    await mkdir(path);
    await expect(readStoredToken(path)).rejects.toMatchObject({
      code: "config_invalid",
      message: `The config file at ${path} could not be read.`,
    });
  });

  it.each(BLANKS)("reads an empty or whitespace-only stored token %j as not set", async (blank) => {
    const path = join(home, "config.json");
    await writeFile(path, JSON.stringify({ token: blank }));
    expect(await readStoredToken(path)).toBeNull();
  });

  it("is deleted by removeToken, which says whether there was one", async () => {
    const path = join(home, "config.json");
    await saveToken(path, TEST_TOKEN, "win32");
    expect(await removeToken(path)).toBe(true);
    expect(await removeToken(path)).toBe(false);
  });

  it("surfaces other delete failures", async () => {
    const path = join(home, "folder");
    await mkdir(join(path, "inner"), { recursive: true });
    await expect(removeToken(path)).rejects.toThrow();
  });
});

describe("token precedence", () => {
  const stored = (): Promise<string | null> => Promise.resolve("stored");

  it("takes --token, then HUSHSCRIPT_TOKEN, then the stored token", async () => {
    const env = { HUSHSCRIPT_TOKEN: "from-env" };
    expect(await resolveToken({ flag: "from-flag", env, stored })).toBe("from-flag");
    expect(await resolveToken({ flag: undefined, env, stored })).toBe("from-env");
    expect(await resolveToken({ flag: undefined, env: { HUSHSCRIPT_TOKEN: "" }, stored })).toBe(
      "stored",
    );
  });

  it.each(BLANKS)("skips a blank --token %j and takes HUSHSCRIPT_TOKEN", async (blank) => {
    expect(await resolveToken({ flag: blank, env: { HUSHSCRIPT_TOKEN: "from-env" }, stored })).toBe(
      "from-env",
    );
  });

  it.each(BLANKS)("skips a blank HUSHSCRIPT_TOKEN %j and takes the stored token", async (blank) => {
    expect(await resolveToken({ flag: undefined, env: { HUSHSCRIPT_TOKEN: blank }, stored })).toBe(
      "stored",
    );
  });

  it.each(BLANKS)("falls to the stored token when flag and env are both %j", async (blank) => {
    expect(await resolveToken({ flag: blank, env: { HUSHSCRIPT_TOKEN: blank }, stored })).toBe(
      "stored",
    );
  });

  it("resolves to null when every source is blank or missing", async () => {
    const none = (): Promise<string | null> => Promise.resolve(null);
    expect(
      await resolveToken({ flag: " ", env: { HUSHSCRIPT_TOKEN: "\t" }, stored: none }),
    ).toBeNull();
    expect(await resolveToken({ flag: undefined, env: {}, stored: none })).toBeNull();
  });

  it("returns a real token untouched, including spaces around it", async () => {
    expect(await resolveToken({ flag: " from-flag ", env: {}, stored })).toBe(" from-flag ");
    expect(await resolveToken({ flag: undefined, env: { HUSHSCRIPT_TOKEN: " e " }, stored })).toBe(
      " e ",
    );
  });

  it.each(BLANKS)(
    "a blank --token %j in a real command falls back to the environment",
    async (blank) => {
      const h = harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN } });
      await saveToken(join(home, ".config", "hushscript", "config.json"), OTHER_TOKEN, "linux");
      expect(await h.run("balance", "--token", blank)).toBe(0);
      expect(h.created).toEqual([{ token: TEST_TOKEN, baseUrl: undefined }]);
    },
  );

  it("treats --token= as not set", async () => {
    const h = harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN } });
    expect(await h.run("balance", "--token=")).toBe(0);
    expect(h.created).toEqual([{ token: TEST_TOKEN, baseUrl: undefined }]);
  });

  it.each(BLANKS)(
    "a blank HUSHSCRIPT_TOKEN %j in a real command falls back to the store",
    async (blank) => {
      const h = harness({ home, env: { HUSHSCRIPT_TOKEN: blank } });
      await saveToken(join(home, ".config", "hushscript", "config.json"), OTHER_TOKEN, "linux");
      expect(await h.run("balance")).toBe(0);
      expect(h.created).toEqual([{ token: OTHER_TOKEN, baseUrl: undefined }]);
    },
  );

  it.each(BLANKS)(
    "a blank stored token %j means not set, so the missing-token error follows",
    async (blank) => {
      await mkdir(join(home, ".config", "hushscript"), { recursive: true });
      await writeFile(
        join(home, ".config", "hushscript", "config.json"),
        JSON.stringify({ token: blank }),
      );
      const h = harness({ home });
      expect(await h.run("balance", "--json")).toBe(1);
      expect(JSON.parse(h.stderr())).toEqual(MISSING_TOKEN_REPORT);
      expect(h.created).toEqual([]);
    },
  );

  it.each(BLANKS)(
    "blank flag, env and stored token %j report the missing token with its hint",
    async (blank) => {
      await mkdir(join(home, ".config", "hushscript"), { recursive: true });
      await writeFile(
        join(home, ".config", "hushscript", "config.json"),
        JSON.stringify({ token: blank }),
      );
      const h = harness({ home, env: { HUSHSCRIPT_TOKEN: blank } });
      expect(await h.run("balance", "--token", blank)).toBe(1);
      expect(h.stderr()).toBe(
        "Error: No Hushscript token.\nHint: Run `hushscript login`, set HUSHSCRIPT_TOKEN, or pass --token. Create a token in the Hushscript app under Account, Connected apps.\n",
      );
      expect(h.created).toEqual([]);
    },
  );

  it.each(
    [
      ["transcribe", "recording.mp3"],
      ["resume", "resume-token", "recording.mp3"],
      ["buy", "300min", "--yes"],
      ["transcripts"],
      ["transcript", "tr_1"],
      ["jobs"],
      ["packs"],
      ["balance"],
    ].flatMap((command) => ["", "  ", "\u00a0\u3000"].map((flag) => ({ command, flag }))),
  )(
    "a blank --token $flag does not stop $command.0, which uses the environment token",
    async ({ command, flag }) => {
      await writeFile(join(home, "recording.mp3"), "audio");
      const argv = command.map((arg) => (arg === "recording.mp3" ? join(home, arg) : arg));
      const h = harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN } });
      expect(await h.run(...argv, "--token", flag, "--json")).toBe(0);
      expect(h.created).toEqual([{ token: TEST_TOKEN, baseUrl: undefined }]);
    },
  );

  it("does not read the store when an earlier source answers", async () => {
    const read = vi.fn(stored);
    await resolveToken({ flag: undefined, env: { HUSHSCRIPT_TOKEN: "from-env" }, stored: read });
    expect(read).not.toHaveBeenCalled();
  });

  it("gives HUSHSCRIPT_TOKEN precedence over the stored token in a real command", async () => {
    const h = harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN } });
    await saveToken(join(home, ".config", "hushscript", "config.json"), OTHER_TOKEN, "linux");
    expect(await h.run("balance")).toBe(0);
    expect(h.created).toEqual([{ token: TEST_TOKEN, baseUrl: undefined }]);
  });

  it("uses the stored token when nothing else is set, and passes HUSHSCRIPT_BASE_URL on", async () => {
    const h = harness({ home, env: { HUSHSCRIPT_BASE_URL: "http://127.0.0.1:4010" } });
    await saveToken(join(home, ".config", "hushscript", "config.json"), OTHER_TOKEN, "linux");
    expect(await h.run("balance")).toBe(0);
    expect(h.created).toEqual([{ token: OTHER_TOKEN, baseUrl: "http://127.0.0.1:4010" }]);
  });

  it.each(BLANKS)("passes no base URL when HUSHSCRIPT_BASE_URL is %j", async (blank) => {
    const h = harness({ home, env: { HUSHSCRIPT_TOKEN: TEST_TOKEN, HUSHSCRIPT_BASE_URL: blank } });
    expect(await h.run("balance")).toBe(0);
    expect(h.created).toEqual([{ token: TEST_TOKEN, baseUrl: undefined }]);
  });

  it("passes a real HUSHSCRIPT_BASE_URL on untouched", async () => {
    const h = harness({
      home,
      env: { HUSHSCRIPT_TOKEN: TEST_TOKEN, HUSHSCRIPT_BASE_URL: " http://127.0.0.1:4010 " },
    });
    expect(await h.run("balance")).toBe(0);
    expect(h.created).toEqual([{ token: TEST_TOKEN, baseUrl: " http://127.0.0.1:4010 " }]);
  });

  it("lets --token beat both", async () => {
    const h = harness({ home, env: { HUSHSCRIPT_TOKEN: OTHER_TOKEN } });
    expect(await h.run("balance", "--token", TEST_TOKEN)).toBe(0);
    expect(h.created[0]?.token).toBe(TEST_TOKEN);
  });

  it("redacts an SDK-echoed stored token by its token shape", async () => {
    await saveToken(join(home, ".config", "hushscript", "config.json"), TEST_TOKEN, "linux");
    const h = harness({ home });
    h.api.balance.mockRejectedValue(new Error(`leaked ${TEST_TOKEN}`));
    expect(await h.run("balance")).toBe(1);
    expect(h.stderr()).toBe("Error: Unexpected error: leaked [redacted]\n");
    expect(h.stdout()).toBe("");
  });

  it("exits 1 with a hint when there is no token anywhere", async () => {
    const h = harness({ home });
    expect(await h.run("balance")).toBe(1);
    expect(h.stderr()).toContain("No Hushscript token.");
    expect(h.stderr()).toContain("hushscript login");
    expect(h.created).toEqual([]);
  });
});

describe("login and logout", () => {
  const file = (): string => join(home, ".config", "hushscript", "config.json");

  it("stores the token that was typed, as a 0600 file, and prints no token", async () => {
    const h = harness({ home, secret: `  ${TEST_TOKEN}  \n` });
    expect(await h.run("login")).toBe(0);
    expect(h.secretPrompts).toEqual(["Hushscript token: "]);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(await readStoredToken(file())).toBe(TEST_TOKEN);
    expect(h.stdout()).toContain(file());
    expect(h.stdout() + h.stderr()).not.toContain(TEST_TOKEN);
  });

  it("takes --token without prompting and reports JSON under --json", async () => {
    const h = harness({ home });
    expect(await h.run("login", "--token", TEST_TOKEN, "--json")).toBe(0);
    expect(h.secretPrompts).toEqual([]);
    expect(JSON.parse(h.stdout())).toEqual({ stored: true, path: file() });
    expect(h.stderr()).toContain("shell history and the process list");
    expect(h.stderr()).toContain("pipe it on stdin");
    expect(h.stderr()).not.toContain(TEST_TOKEN);
  });

  it("does not warn about the command line when the token was typed", async () => {
    const h = harness({ home, secret: TEST_TOKEN });
    await h.run("login");
    expect(h.stderr()).toBe("");
  });

  it("refuses a token in the wrong format and writes nothing", async () => {
    const h = harness({ home, secret: "not-a-token" });
    expect(await h.run("login")).toBe(1);
    expect(h.stderr()).toContain("doesn't look like a Hushscript token");
    expect(await readStoredToken(file())).toBeNull();
  });

  it("does not prompt when stdin is a terminal but stderr is piped", async () => {
    const h = harness({ home, stdinIsTTY: true, stderrIsTTY: false, secret: TEST_TOKEN });
    expect(await h.run("login")).toBe(2);
    expect(h.secretPrompts).toEqual([]);
    expect(h.stderr()).toContain("no terminal to ask");
    expect(await readStoredToken(file())).toBeNull();
    expect(await h.run("login", "--token", TEST_TOKEN)).toBe(0);
    expect(await readStoredToken(file())).toBe(TEST_TOKEN);
  });

  it("refuses an empty answer with a usage error", async () => {
    const h = harness({ home, secret: "\n" });
    expect(await h.run("login")).toBe(2);
    expect(await readStoredToken(file())).toBeNull();
  });

  it.each(["hsr-token\0hidden", "hsr-token\nhidden"])(
    "rejects embedded control characters in a login token %j",
    async (secret) => {
      const h = harness({ home, secret });
      expect(await h.run("login", "--json")).toBe(1);
      expect(JSON.parse(h.stderr())).toMatchObject({
        code: "config_invalid",
        message:
          "The token has spaces, control characters or non-ASCII characters in it; check how it was copied.",
      });
      expect(h.stdout()).toBe("");
      expect(await readStoredToken(file())).toBeNull();
    },
  );

  it("rejects EOF without a login token", async () => {
    const h = harness({ home, secret: "" });
    expect(await h.run("login", "--json")).toBe(2);
    expect(JSON.parse(h.stderr())).toMatchObject({
      code: "usage_error",
      message: "No token was entered.",
    });
    expect(h.stdout()).toBe("");
    expect(await readStoredToken(file())).toBeNull();
  });

  it("a second login replaces the token and tightens the file and folder modes", async () => {
    expect(await harness({ home, secret: TEST_TOKEN }).run("login")).toBe(0);
    await chmod(file(), 0o666);
    await chmod(join(home, ".config", "hushscript"), 0o777);
    expect(await harness({ home, secret: OTHER_TOKEN }).run("login")).toBe(0);
    expect(await readStoredToken(file())).toBe(OTHER_TOKEN);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".config", "hushscript"))).mode & 0o777).toBe(0o700);
  });

  it("scrubs a typed token from a later login error", async () => {
    const secret = "hsr-typed-secret-value";
    const base = join(home, secret);
    await mkdir(base);
    await mkdir(join(home, "target"));
    await symlink(join(home, "target"), join(base, "hushscript"));
    const h = harness({ home, secret, env: { XDG_CONFIG_HOME: base } });
    expect(await h.run("login", "--json")).toBe(1);
    expect(JSON.parse(h.stderr())).toMatchObject({
      code: "config_invalid",
      message: `The config folder ${join(home, "[redacted]", "hushscript")} is a symbolic link, so the token was not stored.`,
    });
    expect(h.stdout()).toBe("");
    expect(h.stderr()).not.toContain(secret);
  });

  it.each(BLANKS)(
    "login with a blank --token %j prompts as if the flag were absent",
    async (blank) => {
      const h = harness({ home, secret: TEST_TOKEN });
      expect(await h.run("login", "--token", blank, "--json")).toBe(0);
      expect(h.secretPrompts).toEqual(["Hushscript token: "]);
      expect(h.stderr()).toBe("");
      expect(await readStoredToken(file())).toBe(TEST_TOKEN);
    },
  );

  it.each(BLANKS)(
    "logout with a blank --token %j ignores it and deletes the stored token",
    async (blank) => {
      await harness({ home, secret: TEST_TOKEN }).run("login");
      const again = harness({ home });
      expect(await again.run("logout", "--token", blank, "--json")).toBe(0);
      expect(JSON.parse(again.stdout())).toEqual({ removed: true });
      expect(await readStoredToken(file())).toBeNull();
    },
  );

  it("logout deletes the token and says so, also when there was none", async () => {
    const h = harness({ home, secret: TEST_TOKEN });
    await h.run("login");
    expect(await h.run("logout")).toBe(0);
    expect(h.stdout()).toContain("deleted");
    expect(await readStoredToken(file())).toBeNull();
    const again = harness({ home });
    expect(await again.run("logout", "--json")).toBe(0);
    expect(JSON.parse(again.stdout())).toEqual({ removed: false });
    const plain = harness({ home });
    await plain.run("logout");
    expect(plain.stdout()).toBe("No stored token.\n");
  });
});
