import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerBalance } from "./commands/balance.ts";
import { registerBuy } from "./commands/buy.ts";
import { registerJobs } from "./commands/jobs.ts";
import { registerLogin } from "./commands/login.ts";
import { registerLogout } from "./commands/logout.ts";
import { registerPacks } from "./commands/packs.ts";
import { registerResume } from "./commands/resume.ts";
import { registerTranscribe } from "./commands/transcribe.ts";
import { registerTranscript } from "./commands/transcript.ts";
import { registerTranscripts } from "./commands/transcripts.ts";
import { registerSecret, type Deps, type Globals, type Runtime } from "./context.ts";
import { usageError } from "./errors.ts";
import { Output } from "./output.ts";
import { valueOf } from "./store.ts";

const CLEAN_EXIT = new Set(["commander.helpDisplayed", "commander.version"]);

/** The values of `--token` and `--token=...`, so error output can hide them. */
function tokensIn(argv: readonly string[]): string[] {
  const found: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === "--token") {
      const next = argv[index + 1];
      if (next !== undefined) found.push(next);
    } else if (arg.startsWith("--token=")) {
      found.push(arg.slice("--token=".length));
    }
  });
  return found;
}

function buildProgram(rt: Runtime, program: Command, shown: { text: string }): void {
  program
    .name("hushscript")
    .description("Command line client for the Hushscript transcription API.")
    .version(pkg.version)
    .option("--json", "print one JSON document on stdout; stderr as JSON Lines")
    .option("--token <token>", "API token (default: HUSHSCRIPT_TOKEN, then the one from `login`)")
    .configureOutput({
      // Under --json the help or version text is held back and printed as a JSON document instead.
      writeOut: (text) => {
        if (rt.out.json) shown.text += text;
        else rt.deps.io.stdout(text);
      },
      // Under --json stderr carries only JSON; a bare `hushscript --json` reports its usage error that way.
      writeErr: (text) => {
        if (!rt.out.json) rt.deps.io.stderr(text);
      },
      outputError: () => undefined,
    })
    .exitOverride();
  registerLogin(program, rt);
  registerLogout(program, rt);
  registerBalance(program, rt);
  registerTranscribe(program, rt);
  registerResume(program, rt);
  registerTranscripts(program, rt);
  registerTranscript(program, rt);
  registerJobs(program, rt);
  registerPacks(program, rt);
  registerBuy(program, rt);
}

/** Runs one invocation (arguments after the program name) and returns the exit code. */
export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const secrets: string[] = [];
  for (const token of tokensIn(argv)) registerSecret(secrets, token);
  registerSecret(secrets, deps.env["HUSHSCRIPT_TOKEN"] ?? "");
  const program = new Command();
  const out = new Output(deps.io, argv.includes("--json"), secrets);
  const rt: Runtime = {
    deps,
    out,
    secrets,
    globals: () => {
      const options = program.opts<{ json?: boolean; token?: string }>();
      const globals: Globals = { json: options.json === true, token: valueOf(options.token) };
      return globals;
    },
  };
  const shown = { text: "" };
  buildProgram(rt, program, shown);
  const printShown = (code: string): void => {
    if (!out.json) return;
    out.document(
      code === "commander.version" ? { version: shown.text.trim() } : { help: shown.text },
      "",
    );
  };
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (CLEAN_EXIT.has(error.code)) {
        printShown(error.code);
        return 0;
      }
      if (error.code === "commander.help") {
        // `hushscript help` is a request for help, like --help.
        if (error.exitCode === 0) {
          printShown(error.code);
          return 0;
        }
        // Bare `hushscript`: commander already printed the help, unless --json asked for JSON only.
        if (!out.json) return 2;
        return out.fail(
          usageError("A command is required.", "Run `hushscript --help` to list them."),
        );
      }
      return out.fail(usageError(error.message.replace(/^error: /, "")));
    }
    return out.fail(error);
  }
}
