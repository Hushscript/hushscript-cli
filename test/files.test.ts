import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
