import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkInputFile, checkOutputPath, writeFileAtomic } from "../src/files.ts";

// Wraps open() so a test can see the mode the temp file was created with; everything still runs for real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

/** The mode argument of every temp-file open() so far. */
function tempModes(): unknown[] {
  return vi
    .mocked(open)
    .mock.calls.filter(([path]) => String(path).endsWith(".tmp"))
    .map(([, , mode]) => mode);
}

let dir: string;

beforeEach(async () => {
  vi.mocked(open).mockClear();
  dir = await mkdtemp(join(tmpdir(), "hushscript-cli-"));
});

afterEach(async () => {
  await chmod(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

describe("checkInputFile", () => {
  it("accepts a file and refuses a missing path or a folder", async () => {
    const file = join(dir, "a.mp3");
    await writeFile(file, "x");
    await expect(checkInputFile(file)).resolves.toBeUndefined();
    await expect(checkInputFile(join(dir, "none"))).rejects.toMatchObject({ exitCode: 2 });
    await expect(checkInputFile(dir)).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("checkOutputPath", () => {
  it("accepts a new or existing file in an existing folder", async () => {
    await writeFile(join(dir, "old.txt"), "x");
    await expect(checkOutputPath(join(dir, "new.txt"))).resolves.toBeUndefined();
    await expect(checkOutputPath(join(dir, "old.txt"))).resolves.toBeUndefined();
  });

  it("refuses a missing folder and a folder as the target", async () => {
    await expect(checkOutputPath(join(dir, "nope", "x.txt"))).rejects.toMatchObject({
      exitCode: 2,
    });
    await mkdir(join(dir, "sub"));
    await expect(checkOutputPath(join(dir, "sub"))).rejects.toMatchObject({ exitCode: 2 });
  });

  it("follows a dangling link and refuses it when the folder it points into is missing", async () => {
    const link = join(dir, "out.txt");
    await symlink(join(dir, "missing", "deeper", "out.txt"), link);
    await expect(checkOutputPath(link)).rejects.toMatchObject({
      code: "usage_error",
      exitCode: 2,
    });
    const chain = join(dir, "chain.txt");
    await symlink("out.txt", chain);
    await expect(checkOutputPath(chain)).rejects.toMatchObject({ exitCode: 2 });
  });

  it("accepts a link, dangling or not, that points into an existing folder", async () => {
    await mkdir(join(dir, "real"));
    await symlink(join("real", "later.txt"), join(dir, "dangling.txt"));
    await expect(checkOutputPath(join(dir, "dangling.txt"))).resolves.toBeUndefined();
    await writeFile(join(dir, "real", "now.txt"), "x");
    await symlink(join("real", "now.txt"), join(dir, "live.txt"));
    await expect(checkOutputPath(join(dir, "live.txt"))).resolves.toBeUndefined();
  });

  it("refuses a link to a folder and a loop of links as usage errors", async () => {
    await mkdir(join(dir, "real"));
    await symlink("real", join(dir, "folder-link"));
    await expect(checkOutputPath(join(dir, "folder-link"))).rejects.toMatchObject({ exitCode: 2 });
    await symlink("b.txt", join(dir, "a.txt"));
    await symlink("a.txt", join(dir, "b.txt"));
    await expect(checkOutputPath(join(dir, "a.txt"))).rejects.toMatchObject({
      code: "usage_error",
      exitCode: 2,
    });
  });
});

describe("writeFileAtomic", () => {
  it("replaces the target and leaves no temp file", async () => {
    const target = join(dir, "out.txt");
    await writeFile(target, "old");
    await writeFileAtomic(target, "new", "hint");
    expect(await readFile(target, "utf8")).toBe("new");
    expect(await readdir(dir)).toEqual(["out.txt"]);
  });

  it("keeps the mode of an existing target", async () => {
    for (const mode of [0o600, 0o755]) {
      const target = join(dir, `mode-${mode.toString(8)}.txt`);
      await writeFile(target, "old");
      await chmod(target, mode);
      await writeFileAtomic(target, "new", "hint");
      expect((await stat(target)).mode & 0o7777).toBe(mode);
      expect(await readFile(target, "utf8")).toBe("new");
    }
  });

  it("opens the temp file with the final mode, before anything is written to it", async () => {
    const existing = join(dir, "private.txt");
    await writeFile(existing, "old");
    await chmod(existing, 0o600);
    await writeFileAtomic(existing, "new", "hint");
    expect(tempModes()).toEqual([0o600]);
    await writeFileAtomic(join(dir, "fresh.txt"), "new", "hint");
    expect(tempModes()).toEqual([0o600, 0o644]);
    expect((await stat(existing)).mode & 0o7777).toBe(0o600);
  });

  it("widens nothing for a target the umask would have narrowed", async () => {
    const target = join(dir, "exec.sh");
    await writeFile(target, "old");
    await chmod(target, 0o755);
    const before = process.umask();
    try {
      process.umask(0o077);
      await writeFileAtomic(target, "new", "hint");
    } finally {
      process.umask(before);
    }
    expect((await stat(target)).mode & 0o7777).toBe(0o755);
  });

  it("writes through a symbolic link and leaves the link in place", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    const target = join(real, "out.txt");
    await writeFile(target, "old");
    await chmod(target, 0o640);
    const link = join(dir, "link.txt");
    await symlink(join("real", "out.txt"), link);
    await writeFileAtomic(link, "new", "hint");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(join("real", "out.txt"));
    expect(await readFile(target, "utf8")).toBe("new");
    expect((await stat(target)).mode & 0o7777).toBe(0o640);
    expect((await readdir(real)).sort()).toEqual(["out.txt"]);
    expect((await readdir(dir)).sort()).toEqual(["link.txt", "real"]);
  });

  it("creates the file a dangling link points at and follows a chain of links", async () => {
    const final = join(dir, "later.txt");
    await symlink("later.txt", join(dir, "second.txt"));
    await symlink("second.txt", join(dir, "first.txt"));
    await writeFileAtomic(join(dir, "first.txt"), "made", "hint");
    expect(await readFile(final, "utf8")).toBe("made");
    expect((await lstat(join(dir, "first.txt"))).isSymbolicLink()).toBe(true);
  });

  it("raises a write error for a loop of links", async () => {
    await symlink("b.txt", join(dir, "a.txt"));
    await symlink("a.txt", join(dir, "b.txt"));
    await expect(writeFileAtomic(join(dir, "a.txt"), "x", "hint")).rejects.toMatchObject({
      code: "write_failed",
      message: expect.stringContaining("ELOOP") as string,
    });
  });

  it("raises a write error with the hint when the folder is gone", async () => {
    await expect(
      writeFileAtomic(join(dir, "gone", "out.txt"), "x", "try again"),
    ).rejects.toMatchObject({
      code: "write_failed",
      hint: "try again",
      exitCode: 1,
    });
  });
});
