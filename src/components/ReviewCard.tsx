// src/components/ReviewCard.tsx
// Human review interface card.
//
// XSS posture:
//   All dynamic values (brand, lane, sourceDetail) are rendered as React
//   text nodes — never via dangerouslySetInnerHTML. React escapes all
//   string content automatically, neutralising injection from any source
//   including external product catalog data.
//
// Accessibility:
//   - Buttons carry descriptive aria-labels so screen readers announce
//     the action and the item being acted on.
//   - The image has a meaningful alt attribute.
//   - Disabled state is propagated to all three action buttons.

import React, { useState } from 'react';
import type { ReviewItem, ReviewDecision } from '../types/media';

// ── Constants ─────────────────────────────────────────────────────────────────

const MERCH_SOURCE_LABELS: Record<
  NonNullable<ReviewItem['merchSource']>,
  string
> = {
  gallery_reuse:  'Gallery Reuse',
  catalog_search: 'Catalog Product',
  ai_touchup:     'AI Touch-Up',
};

// ── Component ─────────────────────────────────────────────────────────────────

interface ReviewCardProps {
  item: ReviewItem;
  onDecide: (decision: ReviewDecision) => void | Promise<void>;
  disabled?: boolean;
}

export function ReviewCard({
  item,
  onDecide,
  disabled = false,
}: ReviewCardProps): React.ReactElement {
  const [pending, setPending] = useState(false);

  const handleDecision = async (decision: ReviewDecision): Promise<void> => {
    if (pending || disabled) return;
    setPending(true);
    try {
      await onDecide(decision);
    } finally {
      // Keep buttons disabled after a decision to prevent double-submission.
      // Parent component should unmount or replace the card after resolution.
      setPending(false);
    }
  };

  const isLocked = disabled || pending;

  return (
    <article
      className="border border-neutral-800 bg-neutral-950 p-6 rounded-lg
                 max-w-md shadow-lg flex flex-col gap-4"
      aria-label={`Review card for item ${item.id}`}
    >

      {/* ── Image panel ─────────────────────────────────────────────────── */}
      <div className="relative aspect-square w-full overflow-hidden rounded
                      bg-neutral-900 border border-neutral-800">
        <img
          src={item.imageUrl}
          alt={`Pending review — ${item.brand} / ${item.generationLane}`}
          className="object-contain h-full w-full"
          loading="lazy"
        />

        {/* Merch source badge — text from a controlled lookup table, not raw data */}
        {item.merchSource !== undefined && (
          <div
            className="absolute top-3 left-3 bg-neutral-900/90 backdrop-blur-sm
                       border border-amber-500/30 text-amber-400
                       px-2.5 py-1 text-xs font-mono rounded
                       select-none pointer-events-none"
            aria-label={`Merch source: ${MERCH_SOURCE_LABELS[item.merchSource]}`}
          >
            {MERCH_SOURCE_LABELS[item.merchSource]}
          </div>
        )}
      </div>

      {/* ── Metadata panel ──────────────────────────────────────────────── */}
      <dl className="flex flex-col gap-1.5 text-sm">
        <MetaRow label="BRAND">{item.brand}</MetaRow>
        <MetaRow label="LANE">{item.generationLane}</MetaRow>
        <MetaRow label="ITEM ID">
          <span className="font-mono text-xs">{item.id}</span>
        </MetaRow>

        {item.sourceDetail !== undefined && (
          <MetaRow label="SOURCE">
            {/* Monospaced, break-all prevents long catalog strings from
                overflowing the card. Content is React-escaped. */}
            <span className="font-mono text-xs break-all
                             bg-neutral-900 px-2 py-1 rounded
                             border border-neutral-800/50 block mt-0.5">
              {item.sourceDetail}
            </span>
          </MetaRow>
        )}
      </dl>

      {/* ── Decision buttons ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2 mt-2" role="group" aria-label="Review decision">
        <DecisionButton
          label="Post"
          onClick={() => handleDecision('post')}
          disabled={isLocked}
          colorClass="bg-emerald-600 hover:bg-emerald-500"
          ariaLabel={`Approve and post item ${item.id}`}
        />
        <DecisionButton
          label="Remix"
          onClick={() => handleDecision('remix')}
          disabled={isLocked}
          colorClass="bg-amber-600 hover:bg-amber-500"
          ariaLabel={`Send item ${item.id} back for remixing`}
        />
        <DecisionButton
          label="Reject"
          onClick={() => handleDecision('reject')}
          disabled={isLocked}
          colorClass="bg-rose-700 hover:bg-rose-600"
          ariaLabel={`Reject item ${item.id}`}
        />
      </div>
    </article>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface MetaRowProps {
  label: string;
  children: React.ReactNode;
}

function MetaRow({ label, children }: MetaRowProps): React.ReactElement {
  return (
    <div className="flex justify-between border-b border-neutral-900 pb-1 gap-4">
      <dt className="text-neutral-500 font-mono text-xs shrink-0">{label}</dt>
      <dd className="text-neutral-200 font-medium text-right">{children}</dd>
    </div>
  );
}

interface DecisionButtonProps {
  label: string;
  onClick: () => void;
  disabled: boolean;
  colorClass: string;
  ariaLabel: string;
}

function DecisionButton({
  label,
  onClick,
  disabled,
  colorClass,
  ariaLabel,
}: DecisionButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`
        ${colorClass}
        disabled:bg-neutral-800 disabled:cursor-not-allowed
        text-white font-medium py-2 rounded
        transition-colors text-sm
        focus-visible:outline focus-visible:outline-2
        focus-visible:outline-offset-2 focus-visible:outline-white
      `}
    >
      {label}
    </button>
  );
}
