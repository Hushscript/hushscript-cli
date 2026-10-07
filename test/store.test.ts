import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors.ts";
import { configPath, readStoredToken, removeToken, resolveToken, saveToken } from "../src/store.ts";
import { harness, OTHER_TOKEN, TEST_TOKEN } from "./helpers.ts";

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

  it("falls back to ~/.config, also for an empty XDG_CONFIG_HOME", () => {
    expect(configPath({ env: { XDG_CONFIG_HOME: "" }, platform: "linux", homedir: "/h" })).toBe(
      "/h/.config/hushscript/config.json",
    );
  });

  it("uses APPDATA on Windows, with a fallback under the home folder", () => {
    const win = (env: Record<string, string | undefined>): string =>
      configPath({ env, platform: "win32", homedir: "/h" });
    expect(win({ APPDATA: "/ad" })).toBe("/ad/hushscript/config.json");
    expect(win({})).toBe("/h/AppData/Roaming/hushscript/config.json");
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

  it("reads nothing when there is no file", async () => {
    expect(await readStoredToken(join(home, "missing.json"))).toBeNull();
  });

  it("refuses a file that is not JSON, holds no token or cannot be read", async () => {
    const path = join(home, "config.json");
    for (const text of ["not json", "{}", '{"token":""}', "null"]) {
      await writeFile(path, text);
      await expect(readStoredToken(path)).rejects.toBeInstanceOf(CliError);
    }
    await rm(path);
    await mkdir(path);
    await expect(readStoredToken(path)).rejects.toMatchObject({ code: "config_invalid" });
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
    expect(await resolveToken({ flag: "", env: { HUSHSCRIPT_TOKEN: "" }, stored })).toBe("stored");
  });

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

  it("lets --token beat both", async () => {
    const h = harness({ home, env: { HUSHSCRIPT_TOKEN: OTHER_TOKEN } });
    expect(await h.run("balance", "--token", TEST_TOKEN)).toBe(0);
    expect(h.created[0]?.token).toBe(TEST_TOKEN);
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
  });

  it("refuses a token in the wrong format and writes nothing", async () => {
    const h = harness({ home, secret: "not-a-token" });
    expect(await h.run("login")).toBe(1);
    expect(h.stderr()).toContain("doesn't look like a Hushscript token");
    expect(await readStoredToken(file())).toBeNull();
  });

  it("refuses an empty answer with a usage error", async () => {
    const h = harness({ home, secret: "\n" });
    expect(await h.run("login")).toBe(2);
    expect(await readStoredToken(file())).toBeNull();
  });

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
