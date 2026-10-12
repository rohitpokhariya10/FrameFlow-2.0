import type { ServerEnv } from "../config.js";
import { estimateImageCall, estimateTextCall, formatInr, formatUsd, type CostEstimate } from "./estimate.js";

/**
 * Limits every provider call will be made with. They are the same numbers the
 * pipeline stages pass to the API (max_output_tokens etc.), so estimates here
 * are true upper bounds for those calls, not marketing figures.
 */
export const CALL_LIMITS = {
  templateAnalysis: { maxOutputTokens: 12_000, promptChars: 18_000, imageDetail: "high" as const },
  structureRepair: { maxOutputTokens: 8_000, promptChars: 30_000 },
  subjectAnalysis: { maxOutputTokens: 4_000, promptChars: 6_000, imageDetail: "high" as const, maxImagesPerSubject: 2 },
  planning: { maxOutputTokens: 12_000, promptChars: 24_000, imageDetail: "high" as const, styleReferences: 2 },
  imagePrompt: { promptChars: 5_500, styleReferences: 1, layoutGuide: 1 },
  review: { maxOutputTokens: 6_000, promptChars: 12_000 },
} as const;

/** Analysis derivatives are at most 1536px on the long edge (see assets/ingest.ts). */
const ANALYSIS_IMAGE = { width: 1536, height: 1024 };
const SUBJECT_IMAGE = { width: 1536, height: 1536 };

export interface WorkflowEstimate {
  label: string;
  calls: { stage: string; estimate: CostEstimate }[];
  totalMicroUsd: number;
  capMicroUsd: number;
  withinCap: boolean;
}

function workflow(label: string, calls: WorkflowEstimate["calls"], capUsd: number): WorkflowEstimate {
  const total = calls.reduce((s, c) => s + c.estimate.microUsd, 0);
  const cap = Math.round(capUsd * 1_000_000);
  return { label, calls, totalMicroUsd: total, capMicroUsd: cap, withinCap: total <= cap };
}

export function estimateTemplateCreation(env: ServerEnv, referenceCount = 3): WorkflowEstimate {
  const L = CALL_LIMITS;
  const images = Array.from({ length: referenceCount }, () => ANALYSIS_IMAGE);
  const analysis = estimateTextCall({
    model: env.OPENAI_ANALYSIS_MODEL,
    promptChars: L.templateAnalysis.promptChars,
    images,
    imageDetail: L.templateAnalysis.imageDetail,
    maxOutputTokens: L.templateAnalysis.maxOutputTokens,
  });
  // At most one bounded structure-repair request (text only).
  const repair = estimateTextCall({
    model: env.OPENAI_ANALYSIS_MODEL,
    promptChars: L.structureRepair.promptChars,
    images: [],
    imageDetail: "low",
    maxOutputTokens: L.structureRepair.maxOutputTokens,
  });
  return workflow(
    `Create a template (${referenceCount} reference${referenceCount === 1 ? "" : "s"})`,
    [
      { stage: "Reference analysis", estimate: analysis },
      { stage: "Structure repair (only if needed)", estimate: repair },
    ],
    env.MAX_TEMPLATE_BUDGET_USD,
  );
}

export function estimatePoster(
  env: ServerEnv,
  opts: { subjects: number; size?: string; quality?: "low" | "medium" | "high"; uncachedSubjects?: number },
): WorkflowEstimate {
  const L = CALL_LIMITS;
  const quality = opts.quality ?? env.IMAGE_QUALITY;
  const size = opts.size ?? "1024x1536";
  const subjectImages = Array.from({ length: opts.subjects }, () => SUBJECT_IMAGE);
  const calls: WorkflowEstimate["calls"] = [];

  const uncached = opts.uncachedSubjects ?? opts.subjects;
  if (uncached > 0) {
    const one = estimateTextCall({
      model: env.OPENAI_ANALYSIS_MODEL,
      promptChars: L.subjectAnalysis.promptChars,
      images: Array.from({ length: L.subjectAnalysis.maxImagesPerSubject }, () => SUBJECT_IMAGE),
      imageDetail: L.subjectAnalysis.imageDetail,
      maxOutputTokens: L.subjectAnalysis.maxOutputTokens,
    });
    calls.push({
      stage: `Subject analysis ×${uncached} (first use only; cached after)`,
      estimate: { ...one, microUsd: one.microUsd * uncached },
    });
  }

  calls.push({
    stage: "Art direction (planner)",
    estimate: estimateTextCall({
      model: env.OPENAI_PLANNER_MODEL,
      promptChars: L.planning.promptChars,
      images: [...Array.from({ length: L.planning.styleReferences }, () => ANALYSIS_IMAGE), ...subjectImages],
      imageDetail: L.planning.imageDetail,
      maxOutputTokens: L.planning.maxOutputTokens,
    }),
  });

  calls.push({
    stage: `Scene image (${quality}, ${size})`,
    estimate: estimateImageCall({
      model: env.OPENAI_IMAGE_MODEL,
      quality,
      size,
      promptChars: L.imagePrompt.promptChars,
      referenceImages: L.imagePrompt.styleReferences + opts.subjects + L.imagePrompt.layoutGuide,
    }),
  });

  calls.push({
    stage: "Visual review",
    estimate: estimateTextCall({
      model: env.OPENAI_REVIEW_MODEL,
      promptChars: L.review.promptChars,
      // Final poster, raw scene and up to three template examples; all counted at high detail to stay an upper bound.
      images: [{ width: 1024, height: 1536 }, { width: 1024, height: 1536 }, ANALYSIS_IMAGE, ANALYSIS_IMAGE, ANALYSIS_IMAGE, ...subjectImages],
      imageDetail: "high",
      maxOutputTokens: L.review.maxOutputTokens,
    }),
  });

  return workflow(
    `Generate a poster (${opts.subjects} product${opts.subjects === 1 ? "" : "s"}, ${quality} quality)`,
    calls,
    env.MAX_JOB_BUDGET_USD,
  );
}

/** Money for display: rupees at the configured rate (env.fx says which), never a live exchange rate. */
export function describeMoney(microUsd: number, env: Pick<ServerEnv, "USD_INR_RATE">) {
  return { usd: formatUsd(microUsd), inr: formatInr(microUsd, env.USD_INR_RATE), microUsd };
}
