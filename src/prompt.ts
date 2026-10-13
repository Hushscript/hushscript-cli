import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { CliError, interrupted } from "./errors.ts";

export interface TerminalInput extends Readable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = new Set(["\u007f", "\b"]);

async function readAll(input: Readable): Promise<string> {
  let text = "";
  input.setEncoding("utf8");
  for await (const chunk of input) text += String(chunk);
  return text;
}

/**
 * A token without echo. On a terminal the keys are read raw and nothing is printed; piped, the first
 * line of stdin is the answer. Ctrl-C raises the interrupt error.
 */
export async function readSecret(
  input: TerminalInput,
  output: Writable,
  prompt: string,
): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) {
    const text = await readAll(input);
    return text.split(/\r?\n/, 1)[0] ?? "";
  }
  const setRawMode = input.setRawMode.bind(input);
  output.write(prompt);
  input.setEncoding("utf8");
  setRawMode(true);
  input.resume();
  return await new Promise<string>((resolve, reject) => {
    let typed = "";
    const finish = (settle: () => void): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
      try {
        setRawMode(false);
      } catch {
        // A destroyed terminal has no mode left to restore.
      }
      input.pause();
      output.write("\n");
      settle();
    };
    // The input ending or closing under the prompt is an EOF, like Ctrl-D.
    const onEnd = (): void => {
      finish(() => {
        resolve(typed);
      });
    };
    const onError = (error: Error): void => {
      finish(() => {
        reject(
          new CliError({
            code: "input_failed",
            message: `Reading from the terminal failed (${error.message}).`,
            exitCode: 1,
          }),
        );
      });
    };
    const onData = (chunk: string | Buffer): void => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n" || char === CTRL_D) {
          finish(() => {
            resolve(typed);
          });
          return;
        }
        if (char === CTRL_C) {
          finish(() => {
            reject(interrupted(null));
          });
          return;
        }
        if (BACKSPACE.has(char)) typed = typed.slice(0, -1);
        else if (char >= " ") typed += char;
      }
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onError);
  });
}

/**
 * A yes/no question. EOF, a closed, failed, ended or destroyed input and anything but y or yes answer
 * no. The terminal stays in cooked mode, so Ctrl-C reaches the process as SIGINT and ends it with the
 * interrupt status. No listener stays on `input` afterwards: readline removes its own when it closes,
 * so those handlers are left alone.
 */
export async function confirm(input: Readable, output: Writable, prompt: string): Promise<boolean> {
  if (input.destroyed || input.readableEnded) return false;
  const lines = createInterface({ input, output, terminal: false });
  return await new Promise<boolean>((resolve) => {
    let answer = false;
    const onInputClose = (): void => {
      lines.close();
    };
    // Registered after readline's own close handler, so the input is already released when this runs.
    lines.once("close", () => {
      input.off("close", onInputClose);
      resolve(answer);
    });
    // A destroyed input emits close but no end, which readline does not notice.
    input.once("close", onInputClose);
    // readline hands an input error to its interface, where nothing else would take it: uncaught, and no close.
    lines.once("error", onInputClose);
    output.write(prompt);
    lines.once("line", (line) => {
      answer = /^\s*y(?:es)?\s*$/i.test(line);
      lines.close();
    });
  });
}
