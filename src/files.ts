import { randomBytes } from "node:crypto";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CliError, usageError } from "./errors.ts";

async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** The input file must exist and be a regular file; checked before any request. */
export async function checkInputFile(path: string): Promise<void> {
  const info = await statOrNull(path);
  if (info === null) throw usageError(`No such file: ${path}`);
  if (!info.isFile()) throw usageError(`Not a file: ${path}`);
}

/** The folder of `--out` must exist and the target must not be a folder; checked before any request. */
export async function checkOutputPath(path: string): Promise<void> {
  const folder = await statOrNull(dirname(resolve(path)));
  if (folder?.isDirectory() !== true) {
    throw usageError(`The folder for --out does not exist: ${dirname(path)}`);
  }
  if ((await statOrNull(path))?.isDirectory() === true) {
    throw usageError(`--out is a folder, not a file: ${path}`);
  }
}

/** Writes through a temp file in the same folder and a rename, so the target is never half written. */
export async function writeFileAtomic(path: string, content: string, hint: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, content, { flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    const reason = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new CliError({
      code: "write_failed",
      message: `Could not write ${path} (${reason}).`,
      exitCode: 1,
      hint,
    });
  }
}
