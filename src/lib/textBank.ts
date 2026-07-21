// src/lib/textBank.ts

import { getSupabaseAdmin } from './supabaseClient';
import { TEXT_BANKS } from '../config/textBanks';
import type { Brand } from '../types/media';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class EmptyTextBankError extends Error {
  constructor(public readonly brand: Brand) {
    super(`Text bank for brand "${brand}" is empty — add content to src/config/textBanks.ts`);
    this.name = 'EmptyTextBankError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class TextRotationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextRotationStateError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// safeMod — identical to the one in recombination.ts (copied, not imported,
// to keep the two modules independently testable; they share the same logic
// but not a shared import chain that would introduce coupling).
// ---------------------------------------------------------------------------

function safeMod(n: number, d: number): number {
  return ((n % d) + d) % d;
}

// ---------------------------------------------------------------------------
// Rotation state persistence
// ---------------------------------------------------------------------------

async function getTextRotationIndex(brand: Brand): Promise<number> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from('text_rotation_state')
    .select('last_used_index')
    .eq('brand', brand)
    .maybeSingle();

  if (error) {
    throw new TextRotationStateError(
      `Failed to read text_rotation_state for brand "${brand}": ${error.message}`
    );
  }

  // -1 means "nothing has been used yet"; first pick will advance to 0.
  return data?.last_used_index ?? -1;
}

async function advanceTextRotation(brand: Brand, newIndex: number): Promise<void> {
  const db = getSupabaseAdmin();
  const { error } = await db
    .from('text_rotation_state')
    .upsert(
      { brand, last_used_index: newIndex, updated_at: Date.now() },
      { onConflict: 'brand' }
    );

  if (error) {
    throw new TextRotationStateError(
      `Failed to advance text_rotation_state for brand "${brand}": ${error.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// TextBankProvider implementation
// ---------------------------------------------------------------------------

export interface TextBankProvider {
  pick(brand: Brand): Promise<string>;
}

/**
 * Deterministic, rotation-based text bank.
 * Order: index 0, 1, 2, … bank.length-1, then wraps via safeMod.
 * Rotation position is persisted in text_rotation_state so restarts
 * do not repeat lines.
 *
 * Throws EmptyTextBankError if the bank for the brand has no entries.
 */
export const supabaseTextBankProvider: TextBankProvider = {
  async pick(brand: Brand): Promise<string> {
    const bank = TEXT_BANKS[brand];

    if (bank.length === 0) {
      throw new EmptyTextBankError(brand);
    }

    const lastIndex = await getTextRotationIndex(brand);
    const nextIndex = safeMod(lastIndex + 1, bank.length);

    await advanceTextRotation(brand, nextIndex);

    return bank[nextIndex];
  },
};

// ---------------------------------------------------------------------------
// In-memory provider for testing — no Supabase calls.
// ---------------------------------------------------------------------------

export function makeInMemoryTextBankProvider(
  banks: Partial<Record<Brand, string[]>>
): TextBankProvider {
  const state: Partial<Record<Brand, number>> = {};

  return {
    async pick(brand: Brand): Promise<string> {
      const bank = banks[brand] ?? [];
      if (bank.length === 0) throw new EmptyTextBankError(brand);
      const last = state[brand] ?? -1;
      const next = safeMod(last + 1, bank.length);
      state[brand] = next;
      return bank[next];
    },
  };
}
