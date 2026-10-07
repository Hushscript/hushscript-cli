import { describe, expect, it } from "vitest";
import { installInterrupts, STOP_SIGNALS, type Host } from "../src/signals.ts";

function fakeHost(): {
  host: Host;
  send: (signal: NodeJS.Signals) => void;
  exits: number[];
  flush: () => void;
  listeners: Map<NodeJS.Signals, (() => void)[]>;
} {
  const listeners = new Map<NodeJS.Signals, (() => void)[]>();
  const exits: number[] = [];
  const pending: (() => void)[] = [];
  return {
    host: {
      listen: (signal, listener) => {
        listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
      },
      flushStderr: (done) => pending.push(done),
      exit: (code) => exits.push(code),
    },
    send: (signal) => {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
    exits,
    flush: () => {
      for (const done of pending.splice(0)) done();
    },
    listeners,
  };
}

describe("installInterrupts", () => {
  it("listens for SIGINT, SIGTERM and SIGHUP from the start", () => {
    const fake = fakeHost();
    installInterrupts(fake.host);
    expect([...fake.listeners.keys()].sort()).toEqual([...STOP_SIGNALS].sort());
  });

  it("ends the process with 130 when a signal arrives and no window is open", () => {
    const fake = fakeHost();
    installInterrupts(fake.host);
    for (const signal of STOP_SIGNALS) fake.send(signal);
    expect(fake.exits).toEqual([130, 130, 130]);
  });

  it("hands the signals to the open window with a running count, and does not exit itself", () => {
    const fake = fakeHost();
    const interrupts = installInterrupts(fake.host);
    const counts: number[] = [];
    interrupts.onInterrupt((count) => counts.push(count));
    fake.send("SIGINT");
    fake.send("SIGTERM");
    expect(counts).toEqual([1, 2]);
    expect(fake.exits).toEqual([]);
  });

  it("goes back to the plain exit once the window is closed", () => {
    const fake = fakeHost();
    const interrupts = installInterrupts(fake.host);
    const stop = interrupts.onInterrupt(() => undefined);
    stop();
    fake.send("SIGHUP");
    expect(fake.exits).toEqual([130]);
  });

  it("counts from one again in a new window, and an old window's close leaves the new one open", () => {
    const fake = fakeHost();
    const interrupts = installInterrupts(fake.host);
    const first: number[] = [];
    const second: number[] = [];
    const stopFirst = interrupts.onInterrupt((count) => first.push(count));
    fake.send("SIGINT");
    interrupts.onInterrupt((count) => second.push(count));
    stopFirst();
    fake.send("SIGINT");
    expect(first).toEqual([1]);
    expect(second).toEqual([1]);
    expect(fake.exits).toEqual([]);
  });

  it("forceExit does not exit before stderr is flushed, and reports it is exiting at once", () => {
    const fake = fakeHost();
    const interrupts = installInterrupts(fake.host);
    expect(interrupts.exiting()).toBe(false);
    expect(interrupts.finalCode(0)).toBe(0);
    interrupts.forceExit(130);
    expect(interrupts.exiting()).toBe(true);
    expect(fake.exits).toEqual([]);
    fake.flush();
    expect(fake.exits).toEqual([130]);
  });

  it("makes the forced code win over a code the command returns while the flush is pending", () => {
    const fake = fakeHost();
    const interrupts = installInterrupts(fake.host);
    interrupts.forceExit(130);
    expect(interrupts.finalCode(0)).toBe(130);
    expect(interrupts.finalCode(1)).toBe(130);
  });

  it("exits at once on a signal that arrives after the exit was forced", () => {
    const fake = fakeHost();
    const interrupts = installInterrupts(fake.host);
    const counts: number[] = [];
    interrupts.onInterrupt((count) => counts.push(count));
    interrupts.forceExit(130);
    fake.send("SIGINT");
    expect(counts).toEqual([]);
    expect(fake.exits).toEqual([130]);
  });
});
