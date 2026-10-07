import { HushscriptError, type Progress, type Transcript } from "@hushscript/sdk";
import { openClient, type Api, type Runtime } from "../context.ts";
import { interrupted } from "../errors.ts";
import { writeFileAtomic } from "../files.ts";
import { renderTranscript } from "../output.ts";
import { shellWord } from "../shell.ts";
import type { Format } from "../validate.ts";

const CLEAR_LINE = "\r\u001b[K";

/** What the SDK call gets from the CLI: the way to stop it, progress, and where the resume token goes. */
interface Hooks {
  signal: AbortSignal;
  onProgress: ((progress: Progress) => void) | undefined;
  onResumeToken: (token: string) => void;
}

/** The flags the user passed, as typed, so a printed command asks for the same job and output again. */
interface PassedFlags {
  language?: string | undefined;
  translate?: string | undefined;
  format?: string | undefined;
  out?: string | undefined;
}

export interface Job {
  file: string;
  /** What `--language`, `--translate`, `--format` and `--out` held, when given; echoed in the hints. */
  passed: PassedFlags;
  format: Format;
  out: string | undefined;
  /** The token already in hand (`resume`), printed again if this run is interrupted too. */
  resumeToken: string | null;
  /** The idempotency key the call was started with, printed on an interrupt; `resume` has none. */
  idempotencyKey: string | null;
  /** Languages `transcribe` asked for, announced once the transcript is ready. */
  translateTo: string[] | undefined;
  start(api: Api, hooks: Hooks): Promise<Transcript>;
}

function progressLine(progress: Progress): string {
  return progress.stage === "uploading"
    ? `Uploading ${String(progress.percent)}%`
    : `Processing (${progress.state})`;
}

function flagWords(passed: PassedFlags, names: readonly (keyof PassedFlags)[]): string {
  return names
    .flatMap((name) => {
      const value = passed[name];
      return value === undefined ? [] : [` --${name} ${shellWord(value)}`];
    })
    .join("");
}

/**
 * With a token the job continues (`resume` takes --format and --out); with only a key the same `transcribe`
 * call is replayed with every option it had, which creates nothing twice and asks for the same job.
 */
function continueHint(token: string | null, key: string | null, job: Job): string | null {
  const file = shellWord(job.file);
  if (token !== null) {
    return `Continue with: hushscript resume ${token} ${file}${flagWords(job.passed, ["format", "out"])}`;
  }
  if (key === null) return null;
  const flags = flagWords(job.passed, ["language", "translate", "format", "out"]);
  return `Retry with: hushscript transcribe --key ${key} ${file}${flags}`;
}

/** Runs a transcription to the end: stops cleanly on a signal and prints the transcript. */
export async function runJob(rt: Runtime, job: Job): Promise<void> {
  const { deps, out } = rt;
  const { io } = deps;
  const api = await openClient(rt);

  const abort = new AbortController();
  let resumeToken = job.resumeToken;
  const drawing = { drawn: false };
  const hooks: Hooks = {
    signal: abort.signal,
    onProgress: undefined,
    onResumeToken: (token) => {
      resumeToken = token;
    },
  };
  if (io.stderrIsTTY && !out.json) {
    hooks.onProgress = (progress) => {
      drawing.drawn = true;
      io.stderr(`${CLEAR_LINE}${progressLine(progress)}`);
    };
  }
  // A function call, so the compiler does not carry the `aborted === false` it saw above into the catch.
  const wasInterrupted = (): boolean => abort.signal.aborted;
  const stop = io.onInterrupt((count) => {
    if (count > 1) {
      // The first signal is still winding the call down; this one ends the process, token first.
      if (drawing.drawn) io.stderr(CLEAR_LINE);
      io.forceExit(
        out.fail(
          interrupted(
            resumeToken,
            job.idempotencyKey,
            continueHint(resumeToken, job.idempotencyKey, job),
          ),
        ),
      );
      return;
    }
    abort.abort();
  });
  let transcript: Transcript;
  try {
    transcript = await job.start(api, hooks);
  } catch (error) {
    if (wasInterrupted()) {
      const known = error instanceof HushscriptError ? error : null;
      const token = known?.resumeToken ?? resumeToken;
      const key = known?.idempotencyKey ?? job.idempotencyKey;
      throw interrupted(token, key, continueHint(token, key, job));
    }
    throw error;
  } finally {
    stop();
    if (drawing.drawn) io.stderr(CLEAR_LINE);
  }

  const content = renderTranscript(transcript, job.format, undefined);
  if (job.out === undefined) {
    out.content(content);
  } else {
    await writeFileAtomic(
      job.out,
      content,
      `The transcript was created; fetch it again with \`hushscript transcript ${transcript.id}\`.`,
    );
    if (out.json) out.document({ id: transcript.id, format: job.format, out: job.out }, "");
    else out.note(`Saved the ${job.format} transcript ${transcript.id} to ${job.out}`);
  }
  if (job.translateTo !== undefined) {
    out.note(
      `Translations are ready (${job.translateTo.join(", ")}). Print one with: hushscript transcript ${transcript.id} --lang ${job.translateTo[0] ?? ""}`,
    );
  }
}
