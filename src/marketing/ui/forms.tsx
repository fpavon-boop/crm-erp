'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callMarketingApi } from './client-api';

/**
 * Create/edit forms for the marketing UI. Each posts to the Phase 13 API and
 * shows the API's validation message verbatim; the services own every rule.
 */

import { CHANNELS } from './constants';
const VIDEO_PLATFORMS = ['TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'] as const;

export interface Option {
  id: string;
  label: string;
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-sm text-red-600 mt-2">{error}</p> : null;
}

function num(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function Collapsible({ title, children, openLabel }: { title: string; openLabel: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        {openLabel}
      </button>
    );
  return (
    <div className="card p-5 mb-6 w-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-800">{title}</h2>
        <button type="button" className="text-sm text-slate-500 hover:text-slate-800" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {children(() => setOpen(false))}
    </div>
  );
}

// =============================================================================
// Campaign generation
// =============================================================================

export function NewCampaignForm() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [productId, setProductId] = useState('');
  const [budget, setBudget] = useState('');
  const [discount, setDiscount] = useState('');
  const [duration, setDuration] = useState('');
  const [channels, setChannels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await callMarketingApi<{ campaignId: string }>('POST', '/api/marketing/campaigns', {
      prompt,
      productId: productId.trim() || undefined,
      budget: num(budget),
      proposedDiscountPct: num(discount),
      durationDays: num(duration),
      targetChannels: channels.length ? channels : undefined,
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.push(`/marketing/campaigns/${res.data.campaignId}`);
  }

  return (
    <Collapsible title="Generate a campaign" openLabel="New campaign">
      {() => (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Brief</label>
            <textarea className="input" rows={3} required maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Spring promo for our 36-inch pizza oven aimed at restaurant owners" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <label className="label">Product ID (optional)</label>
              <input className="input" value={productId} onChange={(e) => setProductId(e.target.value)} />
            </div>
            <div>
              <label className="label">Budget ($)</label>
              <input className="input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
            <div>
              <label className="label">Discount %</label>
              <input className="input" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </div>
            <div>
              <label className="label">Duration (days)</label>
              <input className="input" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
            </div>
          </div>
          <div>
            <span className="label">Channels</span>
            <div className="flex flex-wrap gap-3">
              {CHANNELS.map((c) => (
                <label key={c} className="inline-flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={channels.includes(c)} onChange={(e) => setChannels((cs) => (e.target.checked ? [...cs, c] : cs.filter((x) => x !== c)))} />
                  {c}
                </label>
              ))}
            </div>
          </div>
          <p className="text-xs text-slate-500">Stock and margin safeguards run before the AI is called. A discount needs a product so margin can be checked. The result is saved as a DRAFT for review.</p>
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Generating… (can take a minute)' : 'Generate draft'}
          </button>
          <ErrorLine error={error} />
        </form>
      )}
    </Collapsible>
  );
}

// =============================================================================
// Content review edit
// =============================================================================

export function ContentEditor({ id, title, body, hashtags, locked }: { id: string; title: string | null; body: string; hashtags: string[]; locked: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState(title ?? '');
  const [b, setB] = useState(body);
  const [h, setH] = useState(hashtags.join(' '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await callMarketingApi('PATCH', `/api/marketing/content/${id}`, {
      title: t.trim() ? t.trim() : null,
      body: b,
      hashtags: h.split(/\s+/).filter(Boolean),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <div>
        {title && <p className="font-medium text-slate-800">{title}</p>}
        <p className="text-sm text-slate-700 whitespace-pre-wrap">{body}</p>
        {hashtags.length > 0 && <p className="text-xs text-brand-700 mt-1">{hashtags.join(' ')}</p>}
        {!locked && (
          <button type="button" className="text-xs text-brand-700 hover:underline mt-2" onClick={() => setEditing(true)}>
            Edit (returns campaign to DRAFT)
          </button>
        )}
      </div>
    );
  }
  return (
    <form onSubmit={save} className="space-y-2">
      <input className="input" placeholder="Title" value={t} onChange={(e) => setT(e.target.value)} maxLength={200} />
      <textarea className="input" rows={6} required value={b} onChange={(e) => setB(e.target.value)} maxLength={10000} />
      <input className="input" placeholder="#hashtags separated by spaces" value={h} onChange={(e) => setH(e.target.value)} />
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

// =============================================================================
// Social posts
// =============================================================================

export function NewPostForm({ accounts, campaigns, contents }: { accounts: Option[]; campaigns: Option[]; contents: Array<Option & { campaignId: string }> }) {
  const router = useRouter();
  const [socialAccountId, setAccount] = useState(accounts[0]?.id ?? '');
  const [campaignId, setCampaign] = useState(campaigns[0]?.id ?? '');
  const [contentId, setContent] = useState('');
  const [caption, setCaption] = useState('');
  const [language, setLanguage] = useState('EN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (accounts.length === 0 || campaigns.length === 0) {
    return <p className="text-sm text-slate-500">{accounts.length === 0 ? 'Register an active social account first (Accounts tab, ADMIN).' : 'Create a campaign first.'}</p>;
  }

  async function submit(e: React.FormEvent, close: () => void) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await callMarketingApi('POST', '/api/marketing/posts', {
      socialAccountId,
      campaignId,
      contentId: contentId || undefined,
      caption: caption.trim() || undefined,
      language,
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setCaption('');
    close();
    router.refresh();
  }

  return (
    <Collapsible title="New social post" openLabel="New post">
      {(close) => (
        <form onSubmit={(e) => submit(e, close)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <label className="label">Account</label>
              <select className="input" value={socialAccountId} onChange={(e) => setAccount(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Campaign</label>
              <select className="input" value={campaignId} onChange={(e) => { setCampaign(e.target.value); setContent(''); }}>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Content (optional)</label>
              <select className="input" value={contentId} onChange={(e) => setContent(e.target.value)}>
                <option value="">—</option>
                {contents.filter((c) => c.campaignId === campaignId).map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Language</label>
              <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="EN">English</option>
                <option value="ES">Español</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Caption (optional; defaults from content)</label>
            <textarea className="input" rows={3} maxLength={10000} value={caption} onChange={(e) => setCaption(e.target.value)} />
          </div>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Create draft post'}</button>
          <ErrorLine error={error} />
        </form>
      )}
    </Collapsible>
  );
}

// =============================================================================
// Video projects
// =============================================================================

export function NewVideoForm({ campaigns }: { campaigns: Option[] }) {
  const router = useRouter();
  const [campaignId, setCampaign] = useState(campaigns[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [platform, setPlatform] = useState<string>('TIKTOK');
  const [language, setLanguage] = useState('EN');
  const [duration, setDuration] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (campaigns.length === 0) return <p className="text-sm text-slate-500">Create a campaign first.</p>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await callMarketingApi<{ id: string }>('POST', '/api/marketing/videos', { campaignId, title, platform, language, targetDurationSec: num(duration) ?? null });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.push(`/marketing/videos/${res.data.id}`);
  }

  return (
    <Collapsible title="New video project" openLabel="New video">
      {() => (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
            <div className="sm:col-span-2">
              <label className="label">Title</label>
              <input className="input" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className="label">Campaign</label>
              <select className="input" value={campaignId} onChange={(e) => setCampaign(e.target.value)}>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Platform</label>
              <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                {VIDEO_PLATFORMS.map((p) => (
                  <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Language</label>
              <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="EN">English</option>
                <option value="ES">Español</option>
              </select>
            </div>
          </div>
          <div className="max-w-xs">
            <label className="label">Target duration (sec)</label>
            <input className="input" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Create project'}</button>
          <ErrorLine error={error} />
        </form>
      )}
    </Collapsible>
  );
}

export function AddSceneForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [onScreenText, setText] = useState('');
  const [voiceover, setVoiceover] = useState('');
  const [visualCue, setCue] = useState('');
  const [durationSec, setDuration] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await callMarketingApi('POST', `/api/marketing/videos/${projectId}/scenes`, {
      scene: {
        onScreenText: onScreenText.trim() || undefined,
        voiceover: voiceover.trim() || undefined,
        visualCue: visualCue.trim() || undefined,
        durationSec: num(durationSec),
      },
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setText('');
    setVoiceover('');
    setCue('');
    setDuration('');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <input className="input" placeholder="On-screen text" value={onScreenText} onChange={(e) => setText(e.target.value)} />
        <input className="input" placeholder="Voiceover" value={voiceover} onChange={(e) => setVoiceover(e.target.value)} />
        <input className="input" placeholder="Visual cue" value={visualCue} onChange={(e) => setCue(e.target.value)} />
        <input className="input" placeholder="Duration (sec, required)" required inputMode="decimal" value={durationSec} onChange={(e) => setDuration(e.target.value)} />
      </div>
      <button className="btn-secondary" disabled={busy}>{busy ? 'Adding…' : 'Add scene (returns project to DRAFT)'}</button>
      <ErrorLine error={error} />
    </form>
  );
}

// =============================================================================
// Audiences
// =============================================================================

const CRITERIA_EXAMPLE = '{\n  "companyTypes": ["CUSTOMER"],\n  "notPurchasedWithinDays": 180\n}';

export function NewAudienceForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [channel, setChannel] = useState('EMAIL');
  const [criteria, setCriteria] = useState(CRITERIA_EXAMPLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent, close: () => void) {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(criteria);
    } catch {
      return setError('Criteria must be valid JSON.');
    }
    setBusy(true);
    setError(null);
    const res = await callMarketingApi('POST', '/api/marketing/audiences', { name, description: description.trim() || undefined, channel, criteria: parsed });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setName('');
    setDescription('');
    close();
    router.refresh();
  }

  return (
    <Collapsible title="New audience (rules only)" openLabel="New audience">
      {(close) => (
        <form onSubmit={(e) => submit(e, close)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="label">Name</label>
              <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label">Channel</label>
              <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="EMAIL">Email</option>
                <option value="WHATSAPP">WhatsApp</option>
              </select>
            </div>
            <div>
              <label className="label">Description</label>
              <input className="input" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Criteria (JSON)</label>
            <textarea className="input font-mono text-xs" rows={6} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
            <p className="text-xs text-slate-500 mt-1">
              Keys: companyTypes, companyIds, industries, states, countries, purchasedProductIds, purchasedWithinDays, notPurchasedWithinDays, includeContactIds, excludeContactIds. Consent is always enforced from the CRM.
            </p>
          </div>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Create audience'}</button>
          <ErrorLine error={error} />
        </form>
      )}
    </Collapsible>
  );
}

interface PreviewResult {
  matched: number;
  eligibleCount: number;
  excluded: Record<string, number>;
  sample: Array<{ contactId: string; firstName: string | null }>;
}

export function AudiencePreview({ id }: { id: string }) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await callMarketingApi<PreviewResult>('GET', `/api/marketing/audiences/${id}/preview`);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setResult(res.data);
  }

  return (
    <div>
      <button type="button" className="btn-secondary" disabled={busy} onClick={run}>
        {busy ? 'Counting…' : result ? 'Recount' : 'Preview recipients'}
      </button>
      <ErrorLine error={error} />
      {result && (
        <div className="text-sm mt-2 space-y-1">
          <p>
            <span className="font-semibold">{result.eligibleCount}</span> eligible of {result.matched} matched contacts
          </p>
          {Object.entries(result.excluded).some(([, n]) => n > 0) && (
            <p className="text-xs text-slate-500">
              Excluded: {Object.entries(result.excluded).filter(([, n]) => n > 0).map(([k, n]) => `${k.replace(/_/g, ' ').toLowerCase()} ${n}`).join(' · ')}
            </p>
          )}
          {result.sample.length > 0 && <p className="text-xs text-slate-500">Sample: {result.sample.map((s) => s.firstName || '(no name)').join(', ')}</p>}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Social accounts (ADMIN)
// =============================================================================

export function NewAccountForm() {
  const router = useRouter();
  const [platform, setPlatform] = useState('FACEBOOK');
  const [externalAccountId, setExternal] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [n8nCredentialRef, setCredRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent, close: () => void) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await callMarketingApi('POST', '/api/marketing/social-accounts', {
      platform,
      externalAccountId,
      handle: handle.trim() || undefined,
      displayName: displayName.trim() || undefined,
      n8nCredentialRef: n8nCredentialRef.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setExternal('');
    setHandle('');
    setDisplayName('');
    setCredRef('');
    close();
    router.refresh();
  }

  return (
    <Collapsible title="Register social account" openLabel="Register account">
      {(close) => (
        <form onSubmit={(e) => submit(e, close)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
            <div>
              <label className="label">Platform</label>
              <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="FACEBOOK">Facebook</option>
                <option value="INSTAGRAM">Instagram</option>
                <option value="TIKTOK">TikTok</option>
              </select>
            </div>
            <div>
              <label className="label">Account / page ID</label>
              <input className="input" required value={externalAccountId} onChange={(e) => setExternal(e.target.value)} />
            </div>
            <div>
              <label className="label">Handle</label>
              <input className="input" value={handle} onChange={(e) => setHandle(e.target.value)} />
            </div>
            <div>
              <label className="label">Display name</label>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div>
              <label className="label">n8n credential name</label>
              <input className="input" value={n8nCredentialRef} onChange={(e) => setCredRef(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-slate-500">Tokens never live in the CRM — enter the NAME of the credential stored in n8n.</p>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Register'}</button>
          <ErrorLine error={error} />
        </form>
      )}
    </Collapsible>
  );
}
