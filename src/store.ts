import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError } from "./errors.ts";

export interface Environment {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
}

/** `$XDG_CONFIG_HOME/hushscript/config.json`, `~/.config/...` without it, `%APPDATA%\hushscript\config.json` on Windows. */
export function configPath({ env, platform, homedir }: Environment): string {
  if (platform === "win32") {
    const base = nonEmpty(env["APPDATA"]) ?? join(homedir, "AppData", "Roaming");
    return join(base, "hushscript", "config.json");
  }
  const base = nonEmpty(env["XDG_CONFIG_HOME"]) ?? join(homedir, ".config");
  return join(base, "hushscript", "config.json");
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function storeError(path: string, problem: string): CliError {
  return new CliError({
    code: "config_invalid",
    message: `The config file at ${path} ${problem}.`,
    exitCode: 1,
    hint: "Run `hushscript login` to write it again, or delete the file.",
  });
}

/** The stored token, or null when nobody logged in. */
export async function readStoredToken(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw storeError(path, "could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw storeError(path, "is not valid JSON");
  }
  const token = (parsed as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token === "") throw storeError(path, "holds no token");
  return token;
}

/** Writes `{"token": ...}` as a 0600 file in a 0700 directory, through a temp file and a rename. */
export async function saveToken(
  path: string,
  token: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const posix = platform !== "win32";
  if (posix) await chmod(dir, 0o700);
  const temp = join(dir, `.config.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ token })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (posix) await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Deletes the stored token; true when there was one. */
export async function removeToken(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export interface TokenSources {
  flag: string | undefined;
  env: Record<string, string | undefined>;
  stored: () => Promise<string | null>;
}

/** `--token`, then `HUSHSCRIPT_TOKEN`, then the stored token. The store is not read when an earlier source answers. */
export async function resolveToken(sources: TokenSources): Promise<string | null> {
  const flag = nonEmpty(sources.flag);
  if (flag !== undefined) return flag;
  const fromEnv = nonEmpty(sources.env["HUSHSCRIPT_TOKEN"]);
  if (fromEnv !== undefined) return fromEnv;
  return await sources.stored();
}
