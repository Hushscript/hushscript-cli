import type {
  Balance,
  Job,
  Pack,
  Purchase,
  BuyOptions,
  ResumeOptions,
  TranscribeOptions,
  Transcript,
  TranscriptSummary,
} from "@hushscript/sdk";
import { CliError } from "./errors.ts";
import type { Output } from "./output.ts";
import { configPath, readStoredToken, resolveToken, valueOf, type Environment } from "./store.ts";

/** The part of the SDK client the commands use; `Hushscript` satisfies it. */
export interface Api {
  balance(): Promise<Balance>;
  transcribe(file: string, options?: TranscribeOptions): Promise<Transcript>;
  resume(token: string, file?: string, options?: ResumeOptions): Promise<Transcript>;
  buy(packId: string, options?: BuyOptions): Promise<Purchase>;
  readonly transcripts: {
    list(options?: { pageSize?: number | undefined }): AsyncIterable<TranscriptSummary>;
    get(id: string): Promise<Transcript>;
  };
  readonly jobs: {
    list(options?: { active?: boolean | undefined }): AsyncIterable<Job>;
  };
  readonly billing: {
    packs(): Promise<Pack[]>;
  };
}

export interface ClientOptions {
  token: string;
  baseUrl: string | undefined;
}

/** Everything the CLI takes from the process, so tests can stand in for it. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  /** Reads a token without echo from a terminal, or one line from piped stdin. */
  readSecret(prompt: string): Promise<string>;
  /** Asks a yes/no question on the terminal; false for anything but yes. */
  confirm(prompt: string): Promise<boolean>;
  /** Registers a handler for SIGINT, SIGTERM and SIGHUP; the number is how many signals have arrived. Returns the unsubscribe. */
  onInterrupt(handler: (count: number) => void): () => void;
  forceExit(code: number): void;
}

export interface Deps extends Environment {
  io: Io;
  createClient(options: ClientOptions): Api;
}

export interface Globals {
  json: boolean;
  token: string | undefined;
}

export interface Runtime {
  deps: Deps;
  out: Output;
  /** Every secret seen so far; error output replaces them. */
  secrets: string[];
  globals(): Globals;
}

export function storePath(deps: Deps): string {
  return configPath(deps);
}

export async function openClient(rt: Runtime): Promise<Api> {
  const { deps } = rt;
  const token = await resolveToken({
    flag: rt.globals().token,
    env: deps.env,
    stored: () =>
      readStoredToken(storePath(deps), {
        platform: deps.platform,
        warn: (text) => {
          rt.out.warning("token_file_shared", text);
        },
      }),
  });
  if (token === null) {
    throw new CliError({
      code: "config_invalid",
      message: "No Hushscript token.",
      exitCode: 1,
      hint: "Run `hushscript login`, set HUSHSCRIPT_TOKEN, or pass --token. Create a token in the Hushscript app under Account, Connected apps.",
    });
  }
  return deps.createClient({ token, baseUrl: valueOf(deps.env["HUSHSCRIPT_BASE_URL"]) });
}
