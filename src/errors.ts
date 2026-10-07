export type ExitCode = 1 | 2 | 130;

export interface CliErrorInit {
  code: string;
  message: string;
  exitCode: ExitCode;
  numericCode?: number | null | undefined;
  status?: number | null | undefined;
  hint?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  resumeToken?: string | null | undefined;
}

/** An error the CLI raises itself: a bad invocation, a missing token, an interrupt, an output file that cannot be written. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly numericCode: number | null;
  readonly status: number | null;
  readonly hint: string | null;
  readonly idempotencyKey: string | null;
  readonly resumeToken: string | null;

  constructor(init: CliErrorInit) {
    super(init.message);
    this.name = "CliError";
    this.code = init.code;
    this.exitCode = init.exitCode;
    this.numericCode = init.numericCode ?? null;
    this.status = init.status ?? null;
    this.hint = init.hint ?? null;
    this.idempotencyKey = init.idempotencyKey ?? null;
    this.resumeToken = init.resumeToken ?? null;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError({ code: "usage_error", message, exitCode: 2, hint });
}

export function interrupted(resumeToken: string | null): CliError {
  return new CliError({ code: "interrupted", message: "Interrupted.", exitCode: 130, resumeToken });
}
