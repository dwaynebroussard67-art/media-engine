// src/lib/oracle/prefilter.ts
// Cheap, synchronous content gate applied before any expensive AI call.
//
// Responsibilities:
//   1. Validate that imageUrl is structurally plausible.
//   2. For items with overlay text, enforce brand theology rules:
//      a. Text must not be empty.
//      b. Text must contain no forbidden keywords (zero tolerance).
//      c. On theology-required lanes, long texts must contain
//         at least one brand voice keyword.
//
// The lane parameter enables rule (c) to be scoped correctly —
// previously the theology check fired on all lanes unconditionally.

import type { OracleResult, Brand, GenerationLane } from '../../types/media';
import {
  DOCTRINE,
  THEOLOGY_REQUIRED_LANES,
  THEOLOGY_WORD_COUNT_THRESHOLD,
} from '../../config/doctrine';

export interface PrefilterInput {
  imageUrl: string;
  brand: Brand;
  lane: GenerationLane;
  overlayText?: string;
}

export function runPrefilter(input: PrefilterInput): OracleResult {
  const reasons: string[] = [];
  const checkedAt = Date.now();

  // ── 1. Image URL structural validation ────────────────────────────────────
  const trimmedUrl = input.imageUrl.trim();
  if (!trimmedUrl || !/^https?:\/\/.+/.test(trimmedUrl)) {
    reasons.push('image_url_empty_or_malformed');
  }

  // ── 2. Brand recognition ──────────────────────────────────────────────────
  const brandDoctrine = DOCTRINE[input.brand];
  if (!brandDoctrine) {
    reasons.push(`unrecognized_brand:${input.brand}`);
    return { passed: false, reasons, checkedAt };
  }

  // ── 3. Overlay text rules (only when text is provided) ────────────────────
  if (input.overlayText !== undefined) {
    const text = input.overlayText.trim();

    if (text.length === 0) {
      reasons.push('text_overlay_empty');
      // No further text checks are meaningful on empty input.
      return { passed: false, reasons, checkedAt };
    }

    const lowerText = text.toLowerCase();

    // 3a. Forbidden keyword scan (zero tolerance, all lanes)
    for (const forbidden of brandDoctrine.forbiddenKeywords) {
      if (lowerText.includes(forbidden.toLowerCase())) {
        reasons.push(`forbidden_keyword_violation:${forbidden}`);
      }
    }

    // 3b. Theology voice-keyword footprint
    //     Only enforced on lanes where theology is required
    //     AND only when the word count exceeds the threshold.
    const isTheologyRequired = (THEOLOGY_REQUIRED_LANES as readonly GenerationLane[])
      .includes(input.lane);

    if (isTheologyRequired) {
      const wordCount = text.split(/\s+/).filter(Boolean).length;

      if (wordCount > THEOLOGY_WORD_COUNT_THRESHOLD) {
        const hasVoiceKeyword = brandDoctrine.voiceKeywords.some((kw) =>
          lowerText.includes(kw.toLowerCase()),
        );

        if (!hasVoiceKeyword) {
          reasons.push('theology_absence_in_long_text');
        }
      }
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
    checkedAt,
  };
}
