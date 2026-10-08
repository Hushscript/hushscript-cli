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
