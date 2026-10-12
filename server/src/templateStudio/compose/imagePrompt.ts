import type { ConceptPlan, StyleProfile, SubjectAnalysis } from "../contracts/ai.js";
import type { BrandRules } from "../contracts/brand.js";
import type { FramingRules } from "./framing.js";
import { canvasToSource, sceneCrop, type OutputFormat } from "./formats.js";
import type { PlannedBackdrop } from "./framing.js";
import { BACKDROP_GUIDE, guideColour, guideHasSupports } from "./layoutGuide.js";
import { IMAGE_PROMPT } from "../prompts.js";
import type { CopyFieldId } from "./overlay.js";

export interface ManifestEntry {
  index: number;
  assetId: string;
  role: "style_reference" | "subject_identity" | "layout_guide";
  label: string;
  subjectId: string | null;
}

export interface CompileInput {
  plan: ConceptPlan;
  profile: StyleProfile;
  clusterId: string | null;
  format: OutputFormat;
  manifest: ManifestEntry[];
  subjects: { subjectId: string; name: string; analysis: SubjectAnalysis | null }[];
  brand: BrandRules | null;
  textFields: CopyFieldId[];
  fidelityMode: "match" | "adapt" | "explore";
  framing: FramingRules;
  /** Backdrop box in generated-image coordinates, sized from the products. */
  backdrop?: PlannedBackdrop | null;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const region = (r: { x: number; y: number; width: number; height: number }) =>
  `x ${pct(r.x)}–${pct(r.x + r.width)}, y ${pct(r.y)}–${pct(r.y + r.height)}`;

const MODE_TEXT = {
  match: "Recreate the style reference's scene: the same background treatment and colours, the same backdrop shape, podiums, pedestals and props in the same arrangement, the same floor or surface, camera angle, framing and lighting. Change only what the new subjects and the campaign theme require.",
  adapt: "Keep the style reference's visual language but recompose freely around the new subjects.",
  explore: "Use the style reference as loose inspiration; take more creative liberty with environment and composition while keeping the core visual language.",
};

/** Recorded with every generation attempt: the Generator's prompt version plus the FrameFlow mode rules. */
export const imagePromptVersion = (mode: CompileInput["fidelityMode"]) => `${IMAGE_PROMPT.version}+fidelity/1:${mode}`;

/**
 * FrameFlow addition for Match Reference: what the scene must keep from the template, taken from the stored style
 * profile (measured backdrop, staging, background, lighting, palette, invariants).
 */
function keepFromReference(profile: StyleProfile): string[] {
  const c = profile.composition;
  const lines: string[] = [];
  if (profile.backgroundTreatment) lines.push(`- Background: ${profile.backgroundTreatment}`);
  if (c?.backdrop) lines.push(`- Backdrop: ${c.backdrop.description}; products ${c.backdrop.productRelation}.`);
  if (c) lines.push(`- Staging: ${c.staging} Hero: ${c.heroPlacement}`);
  if (profile.lighting) lines.push(`- Lighting: ${profile.lighting}`);
  if (profile.materials) lines.push(`- Materials and surfaces: ${profile.materials}`);
  const colours = profile.palette?.colors ?? [];
  if (colours.length) lines.push(`- Palette: ${colours.map((p) => `${p.hex} (${p.role})`).join(", ")}`);
  for (const inv of profile.sharedInvariants ?? []) lines.push(`- ${inv}`);
  return lines;
}

export const NO_TEXT_RULE =
  "ABSOLUTE RULE: the image must contain NO text of any kind: no letters, words, numbers, prices, symbols used as text, signs, labels, banners, watermarks or logos. All copy and logos are added later as separate layers. Only printing that physically exists on the supplied product may appear, exactly as on the product.";

/** Deterministic: the same inputs always produce the same prompt. */
export function compileImagePrompt(input: CompileInput): string {
  const { plan, profile, format, brand } = input;
  const { source, crop } = sceneCrop(format);
  const cluster = profile.referenceClusters.find((c) => c.id === input.clusterId) ?? profile.referenceClusters[0];
  const croppedNote =
    crop.width === source.width && crop.height === source.height
      ? "The whole image is used."
      : `Only the centred ${crop.width}×${crop.height} area is used in the final poster; the outer bands are cropped away, so keep them as plain continuation of the background with nothing important in them.`;

  const lines: string[] = [];
  lines.push(NO_TEXT_RULE);
  const theme = plan.theme ?? null;
  const oldContent = profile.contentToReplace
    .filter((c) => ["product", "person", "logo", "offer", "price", "occasion"].includes(c.kind))
    .filter((c) => !(c.kind === "occasion" && theme && c.description.toLowerCase().includes(theme.occasion.toLowerCase())))
    .map((c) => c.description);
  const match = input.fidelityMode === "match";
  lines.push(
    match
      ? `DO NOT COPY the style reference's products, people, text, numbers, logos or offers${oldContent.length ? ` (${oldContent.slice(0, 6).join("; ")})` : ""}. Its backdrop, supports, props, surface, camera and lighting are to be KEPT.`
      : `DO NOT COPY: the style reference is for look and feel only. None of its objects may appear${oldContent.length ? ` (${oldContent.slice(0, 6).join("; ")})` : ""}.`,
  );
  if (input.subjects.length === 0) {
    lines.push("NO PRODUCTS: this is a text-led poster. Do not draw any product, device, gadget, appliance, package, card machine or person. Use only background, light, abstract shapes and decorative elements.");
  }
  if (theme) {
    lines.push(
      `THEME: this is a ${theme.occasion} poster and must read as ${theme.occasion} at a glance. Show these clearly in the scene, styled to fit the template: ${theme.visualCues.join("; ")}.${theme.paletteAccents.length ? ` Accent colours: ${theme.paletteAccents.join(", ")}.` : ""}${theme.avoidCues.length ? ` Do NOT show: ${theme.avoidCues.join("; ")}.` : ""} The theme overrides the style reference's own seasonal decorations and colours.`,
    );
  } else {
    lines.push("THEME: no festival or occasion. Do not add festival decorations from the style reference.");
  }
  lines.push("");
  lines.push(
    `OUTPUT: ${plan.scene.medium} advertising scene for a ${format.width}:${format.height} poster (${format.label}), generated at ${source.width}×${source.height}. ${croppedNote} ${plan.scene.composition}.`,
  );

  lines.push("", "REFERENCE MANIFEST (images in the order attached):");
  for (const m of input.manifest) {
    lines.push(
      m.role === "style_reference"
        ? match
          ? `- Image ${m.index}: STYLE AND SCENE REFERENCE. Rebuild this scene around the new products: the same background, backdrop shape, podiums, pedestals and props, floor or surface, camera angle, lighting and palette. Do not copy its products, people, text, numbers, logos or offers.`
          : `- Image ${m.index}: STYLE REFERENCE ONLY. Match its visual language. Do not copy its products, people, text, numbers, logos or offers.`
        : m.role === "layout_guide"
          ? `- Image ${m.index}: LAYOUT GUIDE (a flat wireframe of THIS poster, not a style). Each coloured block marks exactly where one product goes and how big it is${guideHasSupports(input.framing) ? "; grey blocks under them mark the supports the products stand on (shape and material as described in the scene)" : ""}${input.backdrop ? `; the ${BACKDROP_GUIDE.name} area marks the backdrop shape behind the products` : ""}; white dashed areas must stay calm, empty background for the text and logo. Build the scene on this layout: each product must fill its block, with the same position and the same size, never larger. Never draw the blocks, flat colours, outlines or dashes.`
          : `- Image ${m.index}: SUBJECT IDENTITY for "${m.label}". Reproduce this exact product faithfully: shape, proportions, colours, materials, details and any printed labels.`,
    );
  }

  lines.push("", "STYLE:", `- ${profile.summary}`);
  if (cluster) lines.push(`- Direction: ${cluster.label}. ${cluster.description}`);
  for (const inv of profile.sharedInvariants.slice(0, 8)) lines.push(`- ${inv}`);
  lines.push(`- Background treatment: ${profile.backgroundTreatment}`);
  if (profile.lighting) lines.push(`- Lighting language: ${profile.lighting}`);
  lines.push(`- ${MODE_TEXT[input.fidelityMode]}`);
  if (match) lines.push("", "KEEP FROM THE STYLE REFERENCE (same design family; only the products change):", ...keepFromReference(profile));
  if (brand) {
    const palette = [...brand.palette.core, ...brand.palette.accent].filter((c) => c.hex).map((c) => `${c.name} ${c.hex}`).join(", ");
    lines.push(`- Brand palette to draw on for backgrounds and graphic elements: ${palette}.`);
    lines.push(`- Brand look: ${brand.aesthetic.summary}`);
  }

  lines.push("", "SCENE:");
  lines.push(`- Environment: ${plan.scene.environment}`);
  lines.push(`- Background: ${plan.scene.background} (complexity: ${plan.scene.backgroundComplexity})`);
  lines.push(`- Colours: ${plan.scene.palette.join(", ")}`);
  if (plan.scene.lighting) lines.push(`- Lighting: ${plan.scene.lighting}`);
  lines.push(`- Camera: ${plan.scene.camera}`);
  lines.push(`- Mood: ${plan.scene.mood}`);
  for (const s of plan.scene.supportingElements) lines.push(`- Supporting element: ${s.element} (${s.purpose})`);

  const hasGuide = input.manifest.some((m) => m.role === "layout_guide");
  if (plan.subjects.length) {
    const f = input.framing;
    lines.push("", "COMPOSITION:");
    lines.push(`- Staging: ${f.staging} Hero: ${f.heroPlacement}`);
    lines.push(
      `- Keep the whole product group compact: at most ${pct(f.maxGroupWidth)} of the width and ${pct(f.maxGroupHeight)} of the height, at least ${pct(f.minTop)} open background above it, room below for supports and floor, and at least ${pct(f.minSide)} clear on the left and right. Nothing touches the image edges.`,
    );
    lines.push(`- Products overlap: ${f.overlap}. Open, uncluttered background around the group is part of the style.`);
    if (!f.supports) lines.push("- No plinths, podiums, steps or stands under the products: they rest directly on the surface or float as in the style reference.");
    const bd = input.backdrop;
    if (bd) {
      lines.push(
        `- Backdrop: ${bd.description}, occupying exactly ${region(bd.region)}${hasGuide ? ` (the ${BACKDROP_GUIDE.name} area in the layout guide)` : ""}, no bigger. Products: ${bd.productRelation}. Keep this size ratio between products and backdrop.${bd.textOnlyFeatures ? ` Leave out ${bd.textOnlyFeatures}: they only held the reference's text.` : ""}`,
      );
    }
    lines.push("", "SUBJECTS (positions are in this generated image):");
    for (const [i, s] of plan.subjects.entries()) {
      const subject = input.subjects.find((x) => x.subjectId === s.subjectId);
      const image = input.manifest.find((m) => m.role === "subject_identity" && m.subjectId === s.subjectId);
      lines.push(
        `- "${subject?.name ?? s.subjectId}"${image ? ` (image ${image.index})` : ""}${hasGuide ? ` = the ${guideColour(i).name} block in the layout guide` : ""}: ${s.placement}; area ${region(canvasToSource(format, s.region))}; ${s.prominence}; scale: ${s.scaleBasis}; support: ${s.support}.`,
      );
    }
  } else {
    lines.push("", "SUBJECTS: none. This is a text-led poster: do not add products or people.");
  }

  lines.push("", "LAYOUT (leave these areas as calm, low-detail, EMPTY background; the text and logo are added later as separate layers, so draw nothing that looks like text there):");
  for (const t of plan.texts.filter((t) => input.textFields.includes(t.field as CopyFieldId))) {
    lines.push(`- ${t.field} text area: ${region(canvasToSource(format, t))}`);
  }
  lines.push(`- Logo area: ${plan.logo.corner.replace("_", "-")} corner, clean and simple behind it.`);

  lines.push("", "PRESERVE:");
  for (const s of input.subjects) {
    const details = s.analysis?.definingDetails.slice(0, 5).join("; ");
    if (details) lines.push(`- "${s.name}": ${details}`);
  }
  lines.push("- Product identity takes priority over style.");

  lines.push("", "EXCLUDE:");
  lines.push("- Any text, letters, words, numbers, prices, percentages, captions, signage, banners, price tags, watermarks, logos or brand marks anywhere in the image. The only exception is printing that physically exists on the supplied product itself.");
  const replace = [...profile.contentToReplace].sort((a, b) => Number(b.kind === "occasion") - Number(a.kind === "occasion"));
  for (const c of replace.slice(0, 12)) {
    // An occasion matching the new theme (e.g. a Diwali reference for a Diwali poster) is welcome, not excluded.
    if (c.kind === "occasion" && theme && c.description.toLowerCase().includes(theme.occasion.toLowerCase())) continue;
    lines.push(`- ${c.kind} from the reference: ${c.description}`);
  }
  lines.push("- Any product that is not one of the listed subjects.");
  if (input.backdrop?.textOnlyFeatures) lines.push(`- ${input.backdrop.textOnlyFeatures} (they only held the reference's text; draw the backdrop as one clean shape).`);
  for (const a of [...plan.avoid, ...profile.excludedDirections].slice(0, 12)) lines.push(`- ${a}`);

  lines.push("", "DELIVER: the visual scene only, with no campaign typography or brand overlays.", "", NO_TEXT_RULE);
  return lines.join("\n");
}
