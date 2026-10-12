import type { StudioJob } from "@frameflow/shared";
import type { ServerEnv } from "../config.js";
import { costSummary } from "../costs/summary.js";
import type { JobRecord, StudioStore } from "../store.js";
import { isTerminal } from "./queue.js";

const STAGE_LABELS: Record<string, string> = {
  analyse_references: "Studying the reference posters",
  analyse_subjects: "Looking at your products",
  plan: "Art direction",
  generate_scene: "Generating the image",
  compose: "Adding text and logo",
  review: "Quality review",
  segment: "Finding the product (SAM-3 mask)",
};

export function toJobDto(db: StudioStore, env: ServerEnv, job: JobRecord): StudioJob {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    terminal: isTerminal(job.state),
    currentStage: job.currentStage,
    cancelRequested: job.cancelRequested,
    attemptCount: job.attemptCount,
    error: job.error,
    result: job.result,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    stages: db.stages
      .filter((s) => s.jobId === job.id)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((s) => ({ stage: s.stage, label: STAGE_LABELS[s.stage] ?? s.stage, status: s.status, paid: s.paid, durationMs: s.durationMs })),
    cost: costSummary(db.usage.filter((u) => u.jobId === job.id), env),
  };
}
