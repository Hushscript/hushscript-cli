import { homedir } from "node:os";
import { Hushscript } from "@hushscript/sdk";
import type { Deps, Io } from "./context.ts";
import { confirm, readSecret } from "./prompt.ts";
import { run } from "./program.ts";
import { installInterrupts } from "./signals.ts";

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) =>
    stream.write("", () => {
      resolve();
    }),
  );
}

// The stop signals are listened for from the start, so one that arrives outside a command's window ends the process with 130.
const interrupts = installInterrupts({
  listen: (signal, listener) => process.on(signal, listener),
  flushStderr: (done) => process.stderr.write("", done),
  // eslint-disable-next-line n/no-process-exit -- an interrupted purchase and a second Ctrl-C must end the process at once
  exit: (code) => process.exit(code),
});

// Once the exit is forced the report is out; whatever the interrupted command would still print is dropped.
const io: Io = {
  stdout: (text) => {
    if (!interrupts.exiting()) process.stdout.write(text);
  },
  stderr: (text) => {
    if (!interrupts.exiting()) process.stderr.write(text);
  },
  stdinIsTTY: process.stdin.isTTY,
  stdoutIsTTY: process.stdout.isTTY,
  stderrIsTTY: process.stderr.isTTY,
  readSecret: (prompt) => readSecret(process.stdin, process.stderr, prompt),
  confirm: (prompt) => confirm(process.stdin, process.stderr, prompt),
  onInterrupt: interrupts.onInterrupt,
  forceExit: interrupts.forceExit,
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
process.exit(interrupts.finalCode(code));
