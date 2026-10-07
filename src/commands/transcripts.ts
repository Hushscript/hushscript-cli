import type { TranscriptSummary } from "@hushscript/sdk";
import type { Command } from "commander";
import { openClient, type Runtime } from "../context.ts";
import { formatDate, formatDuration } from "../output.ts";
import { parseLimit } from "../validate.ts";

const DEFAULT_LIMIT = 20;
const MAX_PAGE_SIZE = 100;

export function registerTranscripts(program: Command, rt: Runtime): void {
  program
    .command("transcripts")
    .description("List finished transcripts, newest first")
    .option("--limit <n>", `how many to list (default ${String(DEFAULT_LIMIT)})`)
    .action(async (options: { limit?: string }) => {
      const limit = options.limit === undefined ? DEFAULT_LIMIT : parseLimit(options.limit);
      const api = await openClient(rt);
      const transcripts: TranscriptSummary[] = [];
      for await (const summary of api.transcripts.list({
        pageSize: Math.min(limit, MAX_PAGE_SIZE),
      })) {
        transcripts.push(summary);
        if (transcripts.length >= limit) break;
      }
      const lines = transcripts.map(
        (row) =>
          `${row.id}  ${formatDate(row.createdAt)}  ${formatDuration(row.durationSeconds)}  ${row.title}`,
      );
      rt.out.document({ transcripts }, lines.length === 0 ? "No transcripts." : lines.join("\n"));
    });
}
