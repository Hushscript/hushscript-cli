import type { Io } from "./context.ts";

export const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
export const INTERRUPTED_EXIT = 130;

/** What the interrupt logic needs from the process, so tests can stand in for it. */
export interface Host {
  listen(signal: NodeJS.Signals, listener: () => void): void;
  /** Calls `done` once everything written to stderr so far has been handed to the OS. */
  flushStderr(done: () => void): void;
  exit(code: number): void;
}

export interface Interrupts {
  onInterrupt: Io["onInterrupt"];
  forceExit: Io["forceExit"];
  /** True once `forceExit` ran: the report is out, nothing more may be printed. */
  exiting(): boolean;
  /** The exit code the process must end with: the forced one, else `code`. */
  finalCode(code: number): number;
}

interface Window {
  handler: (count: number) => void;
  count: number;
}

/**
 * Listens for the stop signals for the whole life of the process. While a command has an interrupt
 * window open (`onInterrupt`) its handler decides what happens; with none open, nothing was sent that
 * a report could be about, so the process just ends with the interrupt status.
 */
export function installInterrupts(host: Host): Interrupts {
  let open: Window | null = null;
  let forced: number | null = null;

  const received = (): void => {
    if (forced !== null) {
      host.exit(forced);
      return;
    }
    if (open === null) {
      host.exit(INTERRUPTED_EXIT);
      return;
    }
    open.count += 1;
    open.handler(open.count);
  };
  for (const signal of STOP_SIGNALS) host.listen(signal, received);

  return {
    onInterrupt: (handler) => {
      const window: Window = { handler, count: 0 };
      open = window;
      return () => {
        if (open === window) open = null;
      };
    },
    forceExit: (code) => {
      forced ??= code;
      const final = forced;
      host.flushStderr(() => {
        host.exit(final);
      });
    },
    exiting: () => forced !== null,
    finalCode: (code) => forced ?? code,
  };
}
