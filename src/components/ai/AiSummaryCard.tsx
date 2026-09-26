'use client';

import { useState } from 'react';

interface AiFeatureResult {
  facts: string[];
  summary: string;
  recommendations: string[];
  aiAvailable: boolean;
}

/**
 * The reusable "assistive widget" for every AI analysis feature except the
 * Email Draft Assistant (docs/AI_FEATURES.md "UI integration") — Customer
 * Summary, Sales Summary, Customer Follow-Up Suggestions, Product Sales
 * Analysis, Inventory Warning Explanation, and Invoice/Account Summary all
 * render through this one component, varying only `endpoint`/`payload`.
 *
 * Never auto-generates on mount — an explicit click is required, so a
 * page view never silently spends an AI call. FACTS (always
 * code-computed, never touched by the model) and RECOMMENDATIONS (the
 * model's suggestions) are rendered as clearly separate sections, per the
 * grounding requirement.
 */
export default function AiSummaryCard({
  title,
  endpoint,
  payload,
}: {
  title: string;
  endpoint: string;
  payload: Record<string, unknown>;
}) {
  const [result, setResult] = useState<AiFeatureResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError('Could not generate this summary.');
        return;
      }
      setResult(await res.json());
    } catch {
      setError('Could not generate this summary.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="font-semibold text-slate-800">{title}</h2>
        <button type="button" className="btn-secondary !py-1 !text-xs whitespace-nowrap" onClick={generate} disabled={loading}>
          {loading ? 'Generating...' : result ? 'Regenerate' : 'Generate with AI'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!result && !loading && !error && (
        <p className="text-sm text-slate-400">Generates an AI-assisted summary grounded strictly in this account&apos;s actual data.</p>
      )}

      {result && (
        <div className="text-sm space-y-3">
          {!result.aiAvailable && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              AI summary is unavailable right now — the facts below are still accurate.
            </p>
          )}
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase mb-1">Summary</p>
            <p className="text-slate-700 whitespace-pre-wrap">{result.summary}</p>
          </div>
          {result.recommendations.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase mb-1">Recommendations</p>
              <ul className="list-disc list-inside text-slate-700 space-y-1">
                {result.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          <details>
            <summary className="text-xs text-slate-500 cursor-pointer">Facts used ({result.facts.length})</summary>
            <ul className="list-disc list-inside text-xs text-slate-500 mt-1 space-y-0.5">
              {result.facts.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
