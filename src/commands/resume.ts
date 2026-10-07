import { Option, type Command } from "commander";
import { type Runtime } from "../context.ts";
import { checkInputFile, checkOutputPath } from "../files.ts";
import { FORMATS, resolveFormat, type Format } from "../validate.ts";
import { runJob } from "./job.ts";

interface Options {
  format?: Format;
  out?: string;
}

export function registerResume(program: Command, rt: Runtime): void {
  program
    .command("resume")
    .description("Finish a transcription that `transcribe` left behind when it was interrupted")
    .argument("<token>", "the resume token `transcribe` printed")
    .argument("<file>", "the same recording")
    .addOption(new Option("--format <format>", "output format (default txt)").choices(FORMATS))
    .option("--out <path>", "write the transcript to a file instead of stdout")
    .action(async (token: string, file: string, options: Options) => {
      const format = resolveFormat(rt.globals().json, options.format);
      await checkInputFile(file);
      if (options.out !== undefined) await checkOutputPath(options.out);
      await runJob(rt, {
        file,
        format,
        out: options.out,
        resumeToken: token,
        idempotencyKey: null,
        translateTo: undefined,
        start: (api, hooks) =>
          api.resume(token, file, { signal: hooks.signal, onProgress: hooks.onProgress }),
      });
    });
}
