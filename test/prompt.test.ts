import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors.ts";
import { confirm, readSecret, type TerminalInput } from "../src/prompt.ts";

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return { stream, text: () => chunks.join("") };
}

function terminal(): { input: PassThrough & TerminalInput; modes: boolean[] } {
  const input: PassThrough & TerminalInput = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (mode: boolean): boolean => {
      modes.push(mode);
      return mode;
    },
  });
  const modes: boolean[] = [];
  return { input, modes };
}

describe("readSecret", () => {
  it("takes the first line of piped stdin", async () => {
    const input = new PassThrough();
    input.end("the-token\nsecond line\n");
    const output = sink();
    expect(await readSecret(input, output.stream, "Token: ")).toBe("the-token");
    expect(output.text()).toBe("");
  });

  it("reads a CRLF token line without the carriage return", async () => {
    const input = new PassThrough();
    input.end("hsr-token\r\nsecond line\r\n");
    const output = sink();
    expect(await readSecret(input, output.stream, "Token: ")).toBe("hsr-token");
    expect(output.text()).toBe("");
  });

  it("answers empty for empty piped stdin", async () => {
    const input = new PassThrough();
    input.end();
    expect(await readSecret(input, sink().stream, "Token: ")).toBe("");
  });

  it("reads raw keys on a terminal without echoing them, and handles backspace", async () => {
    const { input, modes } = terminal();
    const output = sink();
    const answer = readSecret(input, output.stream, "Token: ");
    input.write("abc\u007fd");
    input.write("e\r");
    expect(await answer).toBe("abde");
    expect(modes).toEqual([true, false]);
    expect(output.text()).toBe("Token: \n");
  });

  it("ignores control keys and stops at Ctrl-D", async () => {
    const { input } = terminal();
    const answer = readSecret(input, sink().stream, "Token: ");
    input.write("ab\u001bc\u0004never");
    expect(await answer).toBe("abc");
  });

  it("rejects with the interrupt error on Ctrl-C and restores the terminal", async () => {
    const { input, modes } = terminal();
    const answer = readSecret(input, sink().stream, "Token: ");
    input.write("ab\u0003");
    await expect(answer).rejects.toMatchObject({ code: "interrupted", exitCode: 130 });
    await expect(answer).rejects.toBeInstanceOf(CliError);
    expect(modes).toEqual([true, false]);
  });
});

describe("confirm", () => {
  async function ask(text: string | null): Promise<{ answer: boolean; output: string }> {
    const input = new PassThrough();
    const output = sink();
    const answer = confirm(input, output.stream, "Sure? ");
    if (text === null) input.end();
    else input.write(text);
    return { answer: await answer, output: output.text() };
  }

  it("answers yes for y and yes in any case", async () => {
    for (const text of ["y\n", "Y\n", "yes\n", " YES \n"]) {
      expect((await ask(text)).answer).toBe(true);
    }
  });

  it("answers no for anything else and for EOF", async () => {
    for (const text of ["n\n", "\n", "yep\n", "maybe\n", null]) {
      expect((await ask(text)).answer).toBe(false);
    }
  });

  it("closes its readline interface once after the answer", async () => {
    const input = new PassThrough();
    const output = sink();
    const closed = vi.fn();
    const emit = Reflect.get(readline.Interface.prototype, "emit") as (
      this: readline.Interface,
      event: string | symbol,
      ...args: unknown[]
    ) => boolean;
    const emitSpy = vi.spyOn(readline.Interface.prototype, "emit").mockImplementation(function (
      this: readline.Interface,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === "close") closed();
      return emit.call(this, event, ...args);
    });
    try {
      const answer = confirm(input, output.stream, "Sure? ");
      input.write("yes\n");
      expect(await answer).toBe(true);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      emitSpy.mockRestore();
      input.destroy();
    }
  });

  it("writes the prompt", async () => {
    expect((await ask("y\n")).output).toBe("Sure? ");
  });
});

const LISTENED_EVENTS = ["data", "end", "close", "readable", "keypress", "error"] as const;

function listenerCounts(input: PassThrough): Record<string, number> {
  return Object.fromEntries(LISTENED_EVENTS.map((event) => [event, input.listenerCount(event)]));
}

describe("listeners left on the input", () => {
  it.each([
    ["enter", "abc\r"],
    ["Ctrl-D", "abc\u0004"],
    ["Ctrl-C", "abc\u0003"],
  ])("readSecret on a terminal leaves none after %s", async (_key, keys) => {
    const { input } = terminal();
    const before = listenerCounts(input);
    const answer = readSecret(input, sink().stream, "Token: ");
    expect(input.listenerCount("data")).toBe((before["data"] ?? 0) + 1);
    input.write(keys);
    await answer.catch(() => undefined);
    expect(listenerCounts(input)).toEqual(before);
  });

  it.each([
    ["yes", "y\n", true],
    ["no", "n\n", false],
  ])("confirm leaves none after the answer %s", async (_name, text, expected) => {
    const input = new PassThrough();
    const before = listenerCounts(input);
    const answer = confirm(input, sink().stream, "Sure? ");
    expect(input.listenerCount("data")).toBeGreaterThan(before["data"] ?? 0);
    input.write(text);
    expect(await answer).toBe(expected);
    expect(listenerCounts(input)).toEqual(before);
  });

  it("confirm leaves none after EOF", async () => {
    const input = new PassThrough();
    const before = listenerCounts(input);
    const answer = confirm(input, sink().stream, "Sure? ");
    input.end();
    expect(await answer).toBe(false);
    expect(listenerCounts(input)).toEqual(before);
  });

  it("confirm leaves none after the input is closed without an end", async () => {
    const input = new PassThrough();
    const before = listenerCounts(input);
    const answer = confirm(input, sink().stream, "Sure? ");
    input.destroy();
    expect(await answer).toBe(false);
    expect(listenerCounts(input)).toEqual(before);
  });

  it("confirm answers no and leaves none when the input fails", async () => {
    const input = new PassThrough();
    const before = listenerCounts(input);
    const answer = confirm(input, sink().stream, "Sure? ");
    input.destroy(new Error("boom"));
    expect(await answer).toBe(false);
    expect(listenerCounts(input)).toEqual(before);
  });

  it.each([
    ["ends", (input: PassThrough & TerminalInput) => input.end()],
    ["is destroyed", (input: PassThrough & TerminalInput) => input.destroy()],
  ])(
    "readSecret on a terminal settles as EOF and leaves none when the input %s",
    async (_name, stop) => {
      const { input, modes } = terminal();
      const before = listenerCounts(input);
      const output = sink();
      const answer = readSecret(input, output.stream, "Token: ");
      input.write("ab");
      await new Promise((resolve) => setImmediate(resolve));
      stop(input);
      expect(await answer).toBe("ab");
      expect(modes).toEqual([true, false]);
      expect(output.text()).toBe("Token: \n");
      expect(listenerCounts(input)).toEqual(before);
    },
  );

  it("readSecret on a terminal rejects with a CliError and leaves none when the input fails", async () => {
    const { input, modes } = terminal();
    const before = listenerCounts(input);
    const answer = readSecret(input, sink().stream, "Token: ");
    input.destroy(new Error("boom"));
    const error: unknown = await answer.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: "input_failed",
      message: "Reading from the terminal failed (boom).",
      exitCode: 1,
    });
    expect(modes).toEqual([true, false]);
    expect(listenerCounts(input)).toEqual(before);
  });

  it("readSecret still settles when the terminal can no longer leave raw mode", async () => {
    const input: PassThrough & TerminalInput = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (mode: boolean): boolean => {
        if (!mode) throw new TypeError("handle is closed");
        return mode;
      },
    });
    const answer = readSecret(input, sink().stream, "Token: ");
    input.write("ab");
    await new Promise((resolve) => setImmediate(resolve));
    input.destroy();
    expect(await answer).toBe("ab");
  });
});

describe("confirm on an input that is already over", () => {
  it("answers no at once, without a prompt, on a destroyed input", async () => {
    const input = new PassThrough();
    input.destroy();
    const output = sink();
    expect(await confirm(input, output.stream, "Sure? ")).toBe(false);
    expect(output.text()).toBe("");
  });

  it("answers no at once, without a prompt, on an input that ended", async () => {
    const input = new PassThrough();
    input.resume();
    input.end();
    await new Promise((resolve) => input.once("end", resolve));
    const output = sink();
    expect(await confirm(input, output.stream, "Sure? ")).toBe(false);
    expect(output.text()).toBe("");
  });

  it("answers no at once on an input that failed", async () => {
    const input = new PassThrough();
    input.on("error", () => undefined);
    input.destroy(new Error("boom"));
    expect(await confirm(input, sink().stream, "Sure? ")).toBe(false);
  });
});
