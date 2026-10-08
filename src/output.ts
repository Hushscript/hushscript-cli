import type { Transcript } from "@hushscript/sdk";
import { HushscriptError } from "@hushscript/sdk";
import { CliError } from "./errors.ts";
import type { Io } from "./context.ts";
import type { Format } from "./validate.ts";

export interface ErrorReport {
  code: string;
  numericCode: number | null;
  status: number | null;
  message: string;
  hint: string | null;
  idempotencyKey?: string;
  resumeToken?: string;
}

// A token looks like hsr1:eu:pat.<hex>.<hex>; this catches one that was never registered as a secret.
const TOKEN_SHAPE = /\bhsr\w*:[\w:.-]+/g;

/** Every registered secret is replaced, whatever its length; a blank one would match between every character, so it is skipped. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim() !== "") out = out.replaceAll(secret, "[redacted]");
  }
  return out.replace(TOKEN_SHAPE, "[redacted]");
}

export function describeError(error: unknown, secrets: readonly string[]): ErrorReport {
  const clean = (text: string): string => scrub(text, secrets);
  const cleanOrNull = (text: string | null): string | null => (text === null ? null : clean(text));
  const base = (source: {
    code: string;
    numericCode: number | null;
    status: number | null;
    message: string;
    hint: string | null;
    idempotencyKey: string | null;
    resumeToken: string | null;
  }): ErrorReport => {
    const report: ErrorReport = {
      code: source.code,
      numericCode: source.numericCode,
      status: source.status,
      message: clean(source.message),
      hint: cleanOrNull(source.hint),
    };
    if (source.idempotencyKey !== null) report.idempotencyKey = source.idempotencyKey;
    if (source.resumeToken !== null) report.resumeToken = source.resumeToken;
    return report;
  };
  if (error instanceof CliError || error instanceof HushscriptError) return base(error);
  const message = error instanceof Error ? error.message : "";
  return base({
    code: "unexpected_error",
    numericCode: null,
    status: null,
    message: message === "" ? "The CLI failed unexpectedly." : `Unexpected error: ${message}`,
    hint: null,
    idempotencyKey: null,
    resumeToken: null,
  });
}

function exitCodeOf(error: unknown): number {
  return error instanceof CliError ? error.exitCode : 1;
}

function endWithNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** What a command prints: one JSON document on stdout under --json, and JSON Lines (notice, warning, then the error object) on stderr. */
export class Output {
  readonly json: boolean;
  readonly #io: Io;
  readonly #secrets: readonly string[];

  constructor(io: Io, json: boolean, secrets: readonly string[]) {
    this.#io = io;
    this.json = json;
    this.#secrets = secrets;
  }

  /** The command's result: `value` as JSON under --json, else `human`. */
  document(value: unknown, human: string): void {
    this.#io.stdout(this.json ? `${JSON.stringify(value, null, 2)}\n` : endWithNewline(human));
  }

  /** Content that is already formatted (a transcript): written byte for byte, plus a final newline on a terminal so the prompt starts on its own line. */
  content(text: string): void {
    this.#io.stdout(this.#io.stdoutIsTTY ? endWithNewline(text) : text);
  }

  /** Something worth knowing before the command goes on: a line of text, or under --json a `notice` object. */
  notice(code: string, message: string): void {
    this.#line("notice", code, message, message);
  }

  /** A problem that does not stop the command: `Warning: ...`, or under --json a `warning` object. */
  warning(code: string, message: string): void {
    this.#line("warning", code, message, `Warning: ${message}`);
  }

  #line(type: "notice" | "warning", code: string, message: string, human: string): void {
    const clean = scrub(message, this.#secrets);
    if (this.json) this.#io.stderr(`${JSON.stringify({ type, code, message: clean })}\n`);
    else this.#io.stderr(endWithNewline(scrub(human, this.#secrets)));
  }

  /** A line for a person on stderr; silent under --json. */
  note(message: string): void {
    if (!this.json) this.#io.stderr(endWithNewline(message));
  }

  /** Prints the error and returns the exit code. */
  fail(error: unknown): number {
    const report = describeError(error, this.#secrets);
    if (this.json) {
      this.#io.stderr(`${JSON.stringify({ type: "error", ...report })}\n`);
    } else {
      const lines = [`Error: ${report.message}`];
      if (report.hint !== null) lines.push(`Hint: ${report.hint}`);
      if (report.idempotencyKey !== undefined)
        lines.push(`Idempotency key: ${report.idempotencyKey}`);
      if (report.resumeToken !== undefined) lines.push(`Resume token: ${report.resumeToken}`);
      this.#io.stderr(`${lines.join("\n")}\n`);
    }
    return exitCodeOf(error);
  }
}

/** The transcript in `format`; `language` picks a translation or "cleaned" for srt, vtt and txt. */
export function renderTranscript(
  transcript: Transcript,
  format: Format,
  language: string | undefined,
): string {
  switch (format) {
    case "srt":
      return transcript.toSRT({ language });
    case "vtt":
      return transcript.toVTT({ language });
    case "txt":
      return transcript.toText({ language });
    case "json":
      return `${JSON.stringify(transcript.toJSON(), null, 2)}\n`;
  }
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(rest)}`
    : `${String(minutes)}:${pad(rest)}`;
}

export function formatDate(date: Date): string {
  return date.toISOString();
}
