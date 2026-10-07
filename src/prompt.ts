import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { interrupted } from "./errors.ts";

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
      setRawMode(false);
      input.pause();
      output.write("\n");
      settle();
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
  });
}

/**
 * A yes/no question. EOF and anything but y or yes answer no. The terminal stays in cooked mode, so
 * Ctrl-C reaches the process as SIGINT and ends it with the interrupt status.
 */
export async function confirm(input: Readable, output: Writable, prompt: string): Promise<boolean> {
  const lines = createInterface({ input, output, terminal: false });
  return await new Promise<boolean>((resolve) => {
    lines.once("close", () => {
      resolve(false);
    });
    output.write(prompt);
    lines.once("line", (line) => {
      lines.removeAllListeners("close");
      lines.close();
      resolve(/^\s*y(?:es)?\s*$/i.test(line));
    });
  });
}
