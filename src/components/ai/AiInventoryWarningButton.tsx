'use client';

import { useState } from 'react';

interface AiFeatureResult {
  summary: string;
  recommendations: string[];
  aiAvailable: boolean;
}

/**
 * Compact inline "Explain" trigger for one low-stock (productVariant,
 * warehouse) row — docs/AI_FEATURES.md "Inventory Warning Explanations".
 * Only rendered by the caller when that row is actually at/below its
 * reorder point. Caches its result so toggling the row open/closed after
 * the first explain never spends a second AI call.
 */
export default function AiInventoryWarningButton({ productVariantId, warehouseId }: { productVariantId: string; warehouseId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiFeatureResult | null>(null);

  async function explain() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (result) return;
    setLoading(true);
    try {
      const res = await fetch('/api/ai/inventory-warning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productVariantId, warehouseId }),
      });
      if (res.ok) setResult(await res.json());
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn-secondary !py-0.5 !px-2 !text-xs" onClick={explain}>
        {open ? 'Hide' : 'Explain'}
      </button>
      {open && (
        <div className="mt-2 text-xs text-slate-600 max-w-md space-y-1">
          {loading && <p className="text-slate-400">Generating explanation...</p>}
          {result && (
            <>
              {!result.aiAvailable && <p className="text-amber-700">AI explanation unavailable right now.</p>}
              <p>{result.summary}</p>
              {result.recommendations.length > 0 && (
                <ul className="list-disc list-inside">
                  {result.recommendations.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
