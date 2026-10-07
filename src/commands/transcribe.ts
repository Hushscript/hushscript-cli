import {
  HushscriptError,
  type Progress,
  type TranscribeOptions,
  type Transcript,
} from "@hushscript/sdk";
import { Option, type Command } from "commander";
import { openClient, type Runtime } from "../context.ts";
import { interrupted } from "../errors.ts";
import { checkInputFile, checkOutputPath, writeFileAtomic } from "../files.ts";
import { renderTranscript } from "../output.ts";
import { FORMATS, parseLanguage, parseTranslate, resolveFormat, type Format } from "../validate.ts";

interface Options {
  language?: string;
  translate?: string;
  format?: Format;
  out?: string;
}

const CLEAR_LINE = "\r\u001b[K";

function progressLine(progress: Progress): string {
  return progress.stage === "uploading"
    ? `Uploading ${String(progress.percent)}%`
    : `Processing (${progress.state})`;
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
    .action(async (file: string, options: Options) => {
      const { deps, out } = rt;
      const { io } = deps;
      const language = options.language === undefined ? undefined : parseLanguage(options.language);
      const translateTo =
        options.translate === undefined ? undefined : parseTranslate(options.translate);
      const format = resolveFormat(rt.globals().json, options.format);
      await checkInputFile(file);
      if (options.out !== undefined) await checkOutputPath(options.out);
      const api = await openClient(rt);

      const abort = new AbortController();
      let resumeToken: string | null = null;
      const drawing = { drawn: false };
      const showProgress = io.stderrIsTTY && !out.json;
      const request: TranscribeOptions = {
        signal: abort.signal,
        onResumeToken: (token) => {
          resumeToken = token;
        },
      };
      if (language !== undefined) request.language = language;
      if (translateTo !== undefined) request.translateTo = translateTo;
      if (showProgress) {
        request.onProgress = (progress) => {
          drawing.drawn = true;
          io.stderr(`${CLEAR_LINE}${progressLine(progress)}`);
        };
      }
      // A function call, so the compiler does not carry the `aborted === false` it saw above into the catch.
      const wasInterrupted = (): boolean => abort.signal.aborted;
      const stop = io.onInterrupt((count) => {
        if (count > 1) io.forceExit(130);
        abort.abort();
      });
      let transcript: Transcript;
      try {
        transcript = await api.transcribe(file, request);
      } catch (error) {
        if (wasInterrupted()) {
          throw interrupted(
            (error instanceof HushscriptError ? error.resumeToken : null) ?? resumeToken,
          );
        }
        throw error;
      } finally {
        stop();
        if (drawing.drawn) io.stderr(CLEAR_LINE);
      }

      const content = renderTranscript(transcript, format, undefined);
      if (options.out === undefined) {
        out.content(content);
      } else {
        await writeFileAtomic(
          options.out,
          content,
          `The transcript was created; fetch it again with \`hushscript transcript ${transcript.id}\`.`,
        );
        if (out.json) out.document({ id: transcript.id, format, out: options.out }, "");
        else out.note(`Saved the ${format} transcript ${transcript.id} to ${options.out}`);
      }
      if (translateTo !== undefined) {
        out.note(
          `Translations are ready (${translateTo.join(", ")}). Print one with: hushscript transcript ${transcript.id} --lang ${translateTo[0] ?? ""}`,
        );
      }
    });
}
