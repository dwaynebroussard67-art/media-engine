// src/config/doctrine.ts
// Brand theology parameters consumed by the oracle and renderers.
// This is configuration — not business logic. Keep it data-only.

import type { Brand, GenerationLane } from '../types/media';

export interface BrandTypographyStyle {
  readonly fontFamily: string;
  readonly fontSize: number;       // px
  readonly fontWeight: number;
  readonly color: string;          // hex
  readonly backgroundColor: string | null;
  readonly opacity: number;        // 0–1 applied to background layer
  readonly padding: number;        // px
}

interface BrandDoctrine {
  readonly theology: string;
  readonly voiceKeywords: readonly string[];
  readonly forbiddenKeywords: readonly string[];
}

export const DOCTRINE: Readonly<Record<Brand, BrandDoctrine>> = {
  misfit: {
    theology: `
      Misfit Psych Ward exists for the ones who never fit the mold.
      Every post must carry weight — grief, grit, or grace, never fluff.
      Scripture is anchor. Authenticity is non-negotiable.
      The brand does not perform wellness; it witnesses survival.
    `.trim(),
    voiceKeywords: ['raw', 'honest', 'gritty', 'grace', 'survival', 'real'],
    forbiddenKeywords: ['hustle', 'grind', 'motivate', 'positivity', 'blessed'],
  },
  forge: {
    theology: `
      Forge is built for makers, builders, and those who finish what they start.
      Every post must be useful or earned — no inspiration porn.
      Craft is the sermon. Work is the worship.
      The brand respects the reader's time and intelligence.
    `.trim(),
    voiceKeywords: ['craft', 'build', 'finish', 'make', 'earn', 'work'],
    forbiddenKeywords: ['hustle', 'passion', 'dream', 'manifest', 'vibe'],
  },
} as const;

export const BRAND_TYPOGRAPHY: Readonly<Record<Brand, BrandTypographyStyle>> = {
  misfit: {
    fontFamily: 'Space Grotesk, system-ui, sans-serif',
    fontSize: 28,
    fontWeight: 700,
    color: '#FFFFFF',
    backgroundColor: '#000000',
    opacity: 0.72,
    padding: 24,
  },
  forge: {
    fontFamily: 'IBM Plex Mono, monospace',
    fontSize: 24,
    fontWeight: 600,
    color: '#F5F0E8',
    backgroundColor: '#1A1A1A',
    opacity: 0.85,
    padding: 20,
  },
} as const;

// Lanes on which theology keyword presence is required
// for long overlay texts (word count > THEOLOGY_WORD_COUNT_THRESHOLD).
export const THEOLOGY_REQUIRED_LANES: readonly GenerationLane[] = [
  'fresh_text_card',
  'recombination',
];

// Word count above which theology keyword absence is flagged.
export const THEOLOGY_WORD_COUNT_THRESHOLD = 10;
