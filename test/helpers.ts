import { Transcript, type components } from "@hushscript/sdk";
import { vi, type Mock } from "vitest";
import type { Api, ClientOptions, Deps, Io } from "../src/context.ts";
import { run } from "../src/program.ts";

export const TEST_TOKEN = `hsr1:eu:pat.${"0123456789abcdef".repeat(2)}.${"fedcba9876543210".repeat(4)}`;
export const OTHER_TOKEN = `hsr1:eu:pat.${"abcdef0123456789".repeat(2)}.${"0123456789fedcba".repeat(4)}`;

type Body = components["schemas"]["TranscriptDetail"];

function utterances(texts: string[]): Body["body"]["original"] {
  return {
    utterances: texts.map((text, index) => ({
      speaker: "A",
      start_ms: index * 2000,
      end_ms: index * 2000 + 1500,
      text,
    })),
  };
}

const TRANSCRIPT_BODY: Body = {
  id: "tr_test_0001",
  title: "Planning call",
  language_detected: "en",
  duration_seconds: 24,
  speaker_names: {},
  tags: [],
  created_at: 1_760_000_000,
  updated_at: 1_760_000_000,
  auto_delete_at: null,
  edited: false,
  matter_code: null,
  client_code: null,
  body: {
    version: 1,
    original: utterances(["Welcome to the call.", "Let's begin."]),
    translations: {
      es: utterances(["Bienvenidos a la llamada.", "Empecemos."]),
      cleaned: utterances(["Welcome to the call.", "Let us begin."]),
    },
  },
};

export function transcript(overrides: Partial<Body> = {}): Transcript {
  return Transcript.fromApi({ ...TRANSCRIPT_BODY, ...overrides });
}

interface FakeApi {
  balance: Mock<Api["balance"]>;
  transcribe: Mock<Api["transcribe"]>;
  resume: Mock<Api["resume"]>;
  buy: Mock<Api["buy"]>;
  transcripts: { list: Mock<Api["transcripts"]["list"]>; get: Mock<Api["transcripts"]["get"]> };
  jobs: { list: Mock<Api["jobs"]["list"]> };
  billing: { packs: Mock<Api["billing"]["packs"]> };
}

function fakeApi(): FakeApi {
  return {
    balance: vi.fn<Api["balance"]>(() =>
      Promise.resolve({
        seconds: 18_000,
        minutes: 300,
        heldSeconds: 0,
        expiresAt: null,
        purchasesRemaining: null,
      }),
    ),
    transcribe: vi.fn<Api["transcribe"]>(() => Promise.resolve(transcript())),
    resume: vi.fn<Api["resume"]>(() => Promise.resolve(transcript())),
    buy: vi.fn<Api["buy"]>(() => Promise.resolve({ seconds: 18_000, minutes: 300 })),
    transcripts: {
      list: vi.fn<Api["transcripts"]["list"]>(() => rows([])),
      get: vi.fn<Api["transcripts"]["get"]>(() => Promise.resolve(transcript())),
    },
    jobs: { list: vi.fn<Api["jobs"]["list"]>(() => rows([])) },
    billing: { packs: vi.fn<Api["billing"]["packs"]>(() => Promise.resolve([])) },
  };
}

export async function* rows<T>(items: T[]): AsyncGenerator<T> {
  await Promise.resolve();
  for (const item of items) yield item;
}

export interface Options {
  env?: Record<string, string | undefined>;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  secret?: string;
  answer?: boolean;
  home: string;
  platform?: NodeJS.Platform;
  /** Stands in for the fake API, to run a command against the real SDK client. */
  client?: (options: ClientOptions) => Api;
}

export interface Harness {
  api: FakeApi;
  stdout: () => string;
  stderr: () => string;
  created: ClientOptions[];
  interrupt: () => void;
  forcedExits: number[];
  prompts: string[];
  secretPrompts: string[];
  /** Runs the CLI with `argv` and returns the exit code. */
  run: (...argv: string[]) => Promise<number>;
}

/** The CLI wired to a fake client and fake streams; nothing touches the network or the real terminal. */
export function harness(options: Options): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const handlers: ((count: number) => void)[] = [];
  const forcedExits: number[] = [];
  const prompts: string[] = [];
  const secretPrompts: string[] = [];
  const created: ClientOptions[] = [];
  const api = fakeApi();
  let interrupts = 0;
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    stdinIsTTY: options.stdinIsTTY ?? false,
    stdoutIsTTY: options.stdoutIsTTY ?? false,
    stderrIsTTY: options.stderrIsTTY ?? false,
    readSecret: (prompt) => {
      secretPrompts.push(prompt);
      return Promise.resolve(options.secret ?? "");
    },
    confirm: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(options.answer ?? false);
    },
    onInterrupt: (handler) => {
      handlers.push(handler);
      return () => {
        handlers.splice(handlers.indexOf(handler), 1);
      };
    },
    forceExit: (code) => forcedExits.push(code),
  };
  const deps: Deps = {
    io,
    env: options.env ?? {},
    platform: options.platform ?? "linux",
    homedir: options.home,
    createClient: (clientOptions) => {
      created.push(clientOptions);
      return options.client === undefined ? api : options.client(clientOptions);
    },
  };
  return {
    api,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    created,
    interrupt: () => {
      interrupts += 1;
      for (const handler of [...handlers]) handler(interrupts);
    },
    forcedExits,
    prompts,
    secretPrompts,
    run: (...argv) => run(argv, deps),
  };
}
