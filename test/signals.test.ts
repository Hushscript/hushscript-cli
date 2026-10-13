import { AbortError } from "@hushscript/sdk";
import { runJob, type Job } from "../src/commands/job.ts";
import type { Deps, Runtime } from "../src/context.ts";
import { Output } from "../src/output.ts";
import { harness, TEST_TOKEN } from "./helpers.ts";
import { describe, expect, it, vi } from "vitest";
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
    expect([...fake.listeners.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
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

describe("runJob with the real signal hub", () => {
  it.each(["SIGTERM", "SIGHUP"] as const)(
    "aborts the SDK call and reports its token on %s",
    async (signal) => {
      const fake = fakeHost();
      const interrupts = installInterrupts(fake.host);
      const h = harness({ home: "/tmp", env: { HUSHSCRIPT_TOKEN: TEST_TOKEN } });
      const stderr: string[] = [];
      const stdout: string[] = [];
      const start = vi.fn<Job["start"]>(
        (_api, hooks) =>
          new Promise((_resolve, reject) => {
            hooks.onResumeToken("rt-signal");
            hooks.signal.addEventListener("abort", () => {
              reject(new AbortError({ message: "Aborted." }));
            });
          }),
      );
      const deps: Deps = {
        env: { HUSHSCRIPT_TOKEN: TEST_TOKEN },
        homedir: "/tmp",
        platform: "linux",
        createClient: () => h.api,
        io: {
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
          stdinIsTTY: false,
          stdoutIsTTY: false,
          stderrIsTTY: false,
          readSecret: () => Promise.resolve(""),
          confirm: () => Promise.resolve(false),
          onInterrupt: interrupts.onInterrupt,
          forceExit: interrupts.forceExit,
        },
      };
      const out = new Output(deps.io, true, []);
      const rt: Runtime = {
        deps,
        out,
        secrets: [],
        globals: () => ({ json: true, token: undefined }),
      };
      const result = runJob(rt, {
        file: "recording.mp3",
        passed: {},
        format: "json",
        out: undefined,
        resumeToken: null,
        idempotencyKey: "key-signal",
        translateTo: undefined,
        start,
      }).catch((error: unknown) => out.fail(error));
      await vi.waitFor(() => {
        expect(start).toHaveBeenCalledOnce();
      });
      fake.send(signal);
      expect(start.mock.calls[0]?.[1].signal.aborted).toBe(true);
      expect(await result).toBe(130);
      expect(JSON.parse(stderr.join(""))).toMatchObject({
        code: "interrupted",
        resumeToken: "rt-signal",
        idempotencyKey: "key-signal",
        hint: "Continue with: hushscript resume rt-signal recording.mp3",
      });
      expect(stdout).toEqual([]);
      expect(fake.exits).toEqual([]);
      fake.send(signal);
      expect(fake.exits).toEqual([130]);
    },
  );

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "exits silently on %s during token resolution before job.start",
    async (signal) => {
      const fake = fakeHost();
      const interrupts = installInterrupts(fake.host);
      const terminated = new Error("simulated process exit");
      fake.host.exit = (code) => {
        fake.exits.push(code);
        throw terminated;
      };
      const stdout = vi.fn();
      const stderr = vi.fn();
      const createClient = vi.fn<Deps["createClient"]>();
      const start = vi.fn<Job["start"]>();
      const env: Record<string, string | undefined> = {
        get HUSHSCRIPT_TOKEN(): string {
          fake.send(signal);
          return TEST_TOKEN;
        },
      };
      const deps: Deps = {
        env,
        homedir: "/tmp",
        platform: "linux",
        createClient,
        io: {
          stdout,
          stderr,
          stdinIsTTY: false,
          stdoutIsTTY: false,
          stderrIsTTY: false,
          readSecret: () => Promise.resolve(""),
          confirm: () => Promise.resolve(false),
          onInterrupt: interrupts.onInterrupt,
          forceExit: interrupts.forceExit,
        },
      };
      const rt: Runtime = {
        deps,
        out: new Output(deps.io, false, []),
        secrets: [],
        globals: () => ({ json: false, token: undefined }),
      };
      await expect(
        runJob(rt, {
          file: "recording.mp3",
          passed: {},
          format: "txt",
          out: undefined,
          resumeToken: null,
          idempotencyKey: "key-early",
          translateTo: undefined,
          start,
        }),
      ).rejects.toBe(terminated);
      expect(fake.exits).toEqual([130]);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );
});
