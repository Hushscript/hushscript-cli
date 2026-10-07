import type { Command } from "commander";
import { openClient, type Runtime } from "../context.ts";
import { formatDate } from "../output.ts";

export function registerJobs(program: Command, rt: Runtime): void {
  program
    .command("jobs")
    .description("List jobs, newest first")
    .option("--active", "only jobs that have not finished")
    .action(async (options: { active?: boolean }) => {
      const api = await openClient(rt);
      const jobs = [];
      for await (const job of api.jobs.list({ active: options.active === true })) jobs.push(job);
      const lines = jobs.map((job) => {
        const detail = job.error === null ? "" : `  ${job.error}`;
        return `${job.id}  ${job.state}  ${formatDate(job.createdAt)}  ${job.transcriptId ?? "-"}${detail}`;
      });
      rt.out.document({ jobs }, lines.length === 0 ? "No jobs." : lines.join("\n"));
    });
}
