'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { PRODUCT_COPY } from '@/lib/product-language';
import type { AppSettings } from '@/lib/types';

export function CodeSyncSettings(props: { appId: string; settings: AppSettings | null }) {
  const [draft, setDraft] = useState<Pick<AppSettings, 'autoDeployEnabled' | 'branch'> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoDeployEnabled = draft?.autoDeployEnabled ?? props.settings?.autoDeployEnabled ?? false;
  const branch = draft?.branch ?? props.settings?.branch ?? 'main';

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api<AppSettings>(`/apps/${props.appId}/settings`, {
        method: 'POST',
        body: JSON.stringify({ autoDeployEnabled, branch }),
      });
      setDraft({
        autoDeployEnabled: updated.autoDeployEnabled,
        branch: updated.branch,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
      <h2 className="text-sm font-medium text-[var(--los-secondary)]">{PRODUCT_COPY.codeSync}</h2>
      <p className="mt-2 text-sm text-[var(--los-secondary)]">{PRODUCT_COPY.autoSyncHint}</p>
      <label className="mt-4 flex items-center gap-2 text-sm text-[var(--los-text)]">
        <input
          checked={autoDeployEnabled}
          type="checkbox"
          onChange={(event) =>
            setDraft({ autoDeployEnabled: event.target.checked, branch })
          }
        />
        {PRODUCT_COPY.autoSync}
      </label>
      <label className="mt-4 block text-sm text-[var(--los-text)]">
        {PRODUCT_COPY.codeVersion}
        <input
          className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
          value={branch}
          onChange={(event) =>
            setDraft({ autoDeployEnabled, branch: event.target.value })
          }
        />
      </label>
      {error ? <p className="mt-3 text-sm text-[var(--los-error)]">{error}</p> : null}
      {saved ? (
        <p className="mt-3 text-sm text-[var(--los-success)]">{PRODUCT_COPY.settingsSaved}</p>
      ) : null}
      <button
        className="mt-4 rounded-lg bg-[var(--los-action)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        type="button"
        disabled={saving}
        onClick={() => void save()}
      >
        {saving ? PRODUCT_COPY.savingSettings : PRODUCT_COPY.saveSettings}
      </button>
    </section>
  );
}
