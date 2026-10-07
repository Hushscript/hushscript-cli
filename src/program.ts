import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerBalance } from "./commands/balance.ts";
import { registerBuy } from "./commands/buy.ts";
import { registerJobs } from "./commands/jobs.ts";
import { registerLogin } from "./commands/login.ts";
import { registerLogout } from "./commands/logout.ts";
import { registerPacks } from "./commands/packs.ts";
import { registerTranscribe } from "./commands/transcribe.ts";
import { registerTranscript } from "./commands/transcript.ts";
import { registerTranscripts } from "./commands/transcripts.ts";
import type { Deps, Globals, Runtime } from "./context.ts";
import { usageError } from "./errors.ts";
import { Output } from "./output.ts";

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

function buildProgram(rt: Runtime, program: Command): void {
  program
    .name("hushscript")
    .description("Command line client for the Hushscript transcription API.")
    .version(pkg.version)
    .option("--json", "print one JSON document on stdout; errors as JSON on stderr")
    .option("--token <token>", "API token (default: HUSHSCRIPT_TOKEN, then the one from `login`)")
    .configureOutput({
      writeOut: (text) => {
        rt.deps.io.stdout(text);
      },
      writeErr: (text) => {
        rt.deps.io.stderr(text);
      },
      outputError: () => undefined,
    })
    .exitOverride();
  registerLogin(program, rt);
  registerLogout(program, rt);
  registerBalance(program, rt);
  registerTranscribe(program, rt);
  registerTranscripts(program, rt);
  registerTranscript(program, rt);
  registerJobs(program, rt);
  registerPacks(program, rt);
  registerBuy(program, rt);
}

/** Runs one invocation (arguments after the program name) and returns the exit code. */
export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const secrets = [...tokensIn(argv)];
  const envToken = deps.env["HUSHSCRIPT_TOKEN"];
  if (envToken !== undefined && envToken !== "") secrets.push(envToken);
  const program = new Command();
  const out = new Output(deps.io, argv.includes("--json"), secrets);
  const rt: Runtime = {
    deps,
    out,
    secrets,
    globals: () => {
      const options = program.opts<{ json?: boolean; token?: string }>();
      const globals: Globals = { json: options.json === true, token: options.token };
      return globals;
    },
  };
  buildProgram(rt, program);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (CLEAN_EXIT.has(error.code)) return 0;
      // Bare `hushscript`: commander already printed the help.
      if (error.code === "commander.help") return 2;
      return out.fail(usageError(error.message.replace(/^error: /, "")));
    }
    return out.fail(error);
  }
}
