import { homedir } from "node:os";
import { Hushscript } from "@hushscript/sdk";
import type { Deps, Io } from "./context.ts";
import { confirm, readSecret } from "./prompt.ts";
import { run } from "./program.ts";

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) =>
    stream.write("", () => {
      resolve();
    }),
  );
}

const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const io: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdinIsTTY: process.stdin.isTTY,
  stdoutIsTTY: process.stdout.isTTY,
  stderrIsTTY: process.stderr.isTTY,
  readSecret: (prompt) => readSecret(process.stdin, process.stderr, prompt),
  confirm: (prompt) => confirm(process.stdin, process.stderr, prompt),
  onInterrupt: (handler) => {
    let count = 0;
    const listener = (): void => {
      count += 1;
      handler(count);
    };
    for (const signal of STOP_SIGNALS) process.on(signal, listener);
    return () => {
      for (const signal of STOP_SIGNALS) process.off(signal, listener);
    };
  },
  // eslint-disable-next-line n/no-process-exit -- an interrupted purchase and a second Ctrl-C must end the process at once
  forceExit: (code) => process.exit(code),
};

const deps: Deps = {
  io,
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  createClient: ({ token, baseUrl }) => new Hushscript({ token, baseUrl }),
};

const code = await run(process.argv.slice(2), deps);
await Promise.all([flush(process.stdout), flush(process.stderr)]);
// Output is flushed above; open handles (keep-alive sockets) must not delay the exit.
// eslint-disable-next-line n/no-process-exit -- the exit code is the CLI's contract
process.exit(code);
