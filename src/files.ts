import { randomBytes } from "node:crypto";
import { lstat, open, readlink, rename, stat, unlink } from "node:fs/promises";
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

/**
 * The folder the write will land in must exist and the target must not be a folder; checked before any
 * request. A symbolic link is followed, also a dangling one, to the place the write ends up.
 */
export async function checkOutputPath(path: string): Promise<void> {
  let target: string;
  try {
    target = await resolveLinks(path);
  } catch {
    throw usageError(`--out is a loop of symbolic links: ${path}`);
  }
  const folder = await statOrNull(dirname(resolve(target)));
  if (folder?.isDirectory() !== true) {
    throw usageError(`The folder for --out does not exist: ${dirname(target)}`);
  }
  if ((await statOrNull(target))?.isDirectory() === true) {
    throw usageError(`--out is a folder, not a file: ${path}`);
  }
}

const MAX_LINK_HOPS = 40;
const NEW_FILE_MODE = 0o644;

/** Follows symbolic links, also dangling ones, to the path a write should land on. */
async function resolveLinks(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops < MAX_LINK_HOPS; hops += 1) {
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink() !== true) return current;
    current = resolve(dirname(current), await readlink(current));
  }
  throw Object.assign(new Error("Too many levels of symbolic links."), { code: "ELOOP" });
}

/**
 * Writes through a temp file next to the target and a rename, so the target is never half written.
 * An existing target keeps its mode, and a symbolic link is written through to the file it points at.
 */
export async function writeFileAtomic(path: string, content: string, hint: string): Promise<void> {
  let temp: string | null = null;
  try {
    const target = await resolveLinks(path);
    const existing = await statOrNull(target);
    temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    // The temp file starts out with the mode the target will have, so the content is never readable more widely than that.
    const mode = existing === null ? NEW_FILE_MODE : Number(existing.mode) & 0o7777;
    const handle = await open(temp, "wx", mode);
    try {
      // open() applies the umask; an existing target keeps exactly its own bits.
      if (existing !== null) await handle.chmod(mode);
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    if (temp !== null) await unlink(temp).catch(() => undefined);
    const reason = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new CliError({
      code: "write_failed",
      message: `Could not write ${path} (${reason}).`,
      exitCode: 1,
      hint,
    });
  }
}
