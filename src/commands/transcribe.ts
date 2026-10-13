import { randomUUID } from "node:crypto";
import type { TranscribeOptions } from "@hushscript/sdk";
import { Option, type Command } from "commander";
import { type Runtime } from "../context.ts";
import { checkInputFile, checkOutputPath } from "../files.ts";
import {
  FORMATS,
  parseKey,
  parseLanguage,
  parseTranslate,
  resolveFormat,
  type Format,
} from "../validate.ts";
import { runJob } from "./job.ts";

interface Options {
  language?: string;
  translate?: string;
  format?: Format;
  out?: string;
  key?: string;
}

export function registerTranscribe(program: Command, rt: Runtime): void {
  program
    .command("transcribe")
    .description("Upload a recording and print its transcript")
    .argument("<file>", "audio or video file")
    .option("--language <code>", "force the spoken language (default: detect it)")
    .option("--translate <codes>", "also translate, for example es,de")
    .addOption(new Option("--format <format>", "output format (default txt)").choices(FORMATS))
    .option("--out <path>", "write the transcript to a file instead of stdout")
    .option(
      "--key <key>",
      "idempotency key; pass the one an interrupted run printed to replay it safely",
    )
    .action(async (file: string, options: Options) => {
      const language = options.language === undefined ? undefined : parseLanguage(options.language);
      const translateTo =
        options.translate === undefined ? undefined : parseTranslate(options.translate);
      const format = resolveFormat(rt.globals().json, options.format);
      // Made here, not inside the SDK, so an interrupt can print it before the SDK has anything to report.
      const idempotencyKey = options.key === undefined ? randomUUID() : parseKey(options.key);
      await checkInputFile(file);
      if (options.out !== undefined) await checkOutputPath(options.out);
      await runJob(rt, {
        file,
        passed: {
          language,
          translate: translateTo?.join(","),
          format: options.format,
          out: options.out,
        },
        format,
        out: options.out,
        resumeToken: null,
        idempotencyKey,
        translateTo,
        start: (api, hooks) => {
          const request: TranscribeOptions = {
            signal: hooks.signal,
            onResumeToken: hooks.onResumeToken,
            idempotencyKey,
          };
          if (hooks.onProgress !== undefined) request.onProgress = hooks.onProgress;
          if (language !== undefined) request.language = language;
          if (translateTo !== undefined) request.translateTo = translateTo;
          return api.transcribe(file, request);
        },
      });
    });
}
