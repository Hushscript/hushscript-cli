import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkInputFile, checkOutputPath, writeFileAtomic } from "../src/files.ts";

let dir: string;

beforeEach(async () => {
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
