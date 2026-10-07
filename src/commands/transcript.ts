import { Option, type Command } from "commander";
import { openClient, type Runtime } from "../context.ts";
import { usageError } from "../errors.ts";
import { renderTranscript } from "../output.ts";
import { FORMATS, parseId, parseLang, resolveFormat, type Format } from "../validate.ts";

export function registerTranscript(program: Command, rt: Runtime): void {
  program
    .command("transcript")
    .description("Print one finished transcript")
    .argument("<id>", "transcript id")
    .addOption(new Option("--format <format>", "output format (default txt)").choices(FORMATS))
    .option("--lang <code>", 'a translation language code, or "cleaned" for the cleaned body')
    .action(async (idArgument: string, options: { format?: Format; lang?: string }) => {
      const id = parseId(idArgument, "The transcript id");
      const format = resolveFormat(rt.globals().json, options.format);
      const lang = options.lang === undefined ? undefined : parseLang(options.lang);
      if (lang !== undefined && format === "json") {
        throw usageError("--lang does not apply to JSON output, which holds every language.");
      }
      const api = await openClient(rt);
      const transcript = await api.transcripts.get(id);
      if (lang !== undefined && lang !== "original") {
        const known =
          lang === "cleaned" ? transcript.cleaned !== null : transcript.languages.includes(lang);
        if (!known) {
          const available = [
            ...transcript.languages,
            ...(transcript.cleaned === null ? [] : ["cleaned"]),
          ];
          throw usageError(
            `This transcript has no "${lang}" version.`,
            available.length === 0
              ? "It has only the original."
              : `Available: ${available.join(", ")}.`,
          );
        }
      }
      rt.out.content(renderTranscript(transcript, format, lang));
    });
}
