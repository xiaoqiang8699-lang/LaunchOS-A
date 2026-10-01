'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CodeSyncSettings } from '@/components/code-sync-settings';
import { ControlCenter } from '@/components/control-center';
import { ProjectTabs } from '@/components/control-center/project-tabs';
import { DangerButton, SecondaryButton, SecondaryLink } from '@/components/ui/button';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { ConfirmDialog, useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import { APPLICATION_PURPOSE_LABELS } from '@/lib/project-labels';
import type {
  AppSettings,
  AppSummary,
  ApplicationPurpose,
  ProjectDetail,
} from '@/lib/types';

const PURPOSE_OPTIONS: ApplicationPurpose[] = ['WEBSITE', 'APP_WEBSITE', 'API', 'ADMIN', 'OTHER'];

export default function ProjectSettingsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const toast = useToast();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [app, setApp] = useState<AppSummary | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [purposeDraft, setPurposeDraft] = useState<ApplicationPurpose>('WEBSITE');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'stop' | 'delete' | null>(null);
  const [confirm, setConfirm] = useState<'stop' | 'delete' | null>(null);

  const load = useCallback(async () => {
    const [detail, appDetail, settingsPayload] = await Promise.all([
      api<ProjectDetail>(`/projects/${params.id}`),
      api<AppSummary>(`/apps/${params.id}`).catch(() => null),
      api<AppSettings>(`/apps/${params.id}/settings`).catch(() => null),
    ]);
    setProject(detail);
    setApp(appDetail);
    setSettings(settingsPayload);
    setNameDraft(detail.name);
    setPurposeDraft(detail.applicationPurpose ?? 'WEBSITE');
  }, [params.id]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && /unauthorized|401|token/i.test(err.message)) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        setError(err instanceof Error ? err.message : '加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, router]);

  async function saveBasics(): Promise<void> {
    if (!project) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api<ProjectDetail>(`/projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: nameDraft.trim() || project.name,
          applicationPurpose: purposeDraft,
        }),
      });
      setProject(updated);
      toast.push('设置已保存');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function stopApp(): Promise<void> {
    setBusy('stop');
    setError(null);
    try {
      const updated = await api<AppSummary>(`/apps/${params.id}/stop`, { method: 'POST' });
      setApp(updated);
      toast.push('应用已停止');
    } catch (err) {
      setError(err instanceof Error ? err.message : '停止失败');
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  async function requestDelete(): Promise<void> {
    setBusy('delete');
    setError(null);
    try {
      // Soft path: stop first if running. Permanent delete is not exposed on Beta user API.
      if (app && (app.applicationStatus === 'RUNNING' || app.applicationStatus === 'WARNING')) {
        const updated = await api<AppSummary>(`/apps/${params.id}/stop`, { method: 'POST' });
        setApp(updated);
      }
      setError(
        '自助永久删除暂未开放。应用已停止（如原先在运行）；如需彻底移除，请联系平台支持。',
      );
      toast.push('已停止运行；永久删除请联系支持');
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  if (!project) {
    return (
      <ControlCenter>
        <ProjectTabs projectId={params.id} />
        {error ? (
          <InlineAlert tone="error" title={error} />
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-32" />
          </div>
        )}
      </ControlCenter>
    );
  }

  const running = app?.applicationStatus ?? 'READY';
  const canStop = running === 'RUNNING' || running === 'WARNING';

  return (
    <ControlCenter>
      <nav className="mb-4 text-sm text-[var(--los-secondary)]">
        <Link className="hover:text-[var(--los-text)]" href="/projects">
          我的应用
        </Link>
        <span className="mx-2">›</span>
        <Link className="hover:text-[var(--los-text)]" href={`/projects/${params.id}`}>
          {project.name}
        </Link>
        <span className="mx-2">›</span>
        <span className="text-[var(--los-text)]">设置</span>
      </nav>

      <ProjectTabs projectId={params.id} />

      <PageHeader
        title="设置"
        description="管理应用基本信息、代码同步与危险操作。"
        action={<StatusBadge status={running} />}
      />

      {error ? <InlineAlert className="mb-4" tone="warning" title={error} /> : null}

      <div className="flex flex-col gap-5">
        <Card className="p-5">
          <h2 className="text-[15px] font-semibold text-[var(--los-text)]">基本信息</h2>
          <label className="mt-4 block text-sm text-[var(--los-secondary)]">
            应用名称
            <input
              className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2 text-[var(--los-text)]"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
            />
          </label>
          <label className="mt-3 block text-sm text-[var(--los-secondary)]">
            应用用途
            <select
              className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2 text-[var(--los-text)]"
              value={purposeDraft}
              onChange={(e) => setPurposeDraft(e.target.value as ApplicationPurpose)}
            >
              {PURPOSE_OPTIONS.map((item) => (
                <option key={item} value={item}>
                  {APPLICATION_PURPOSE_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
          <SecondaryButton
            className="mt-4"
            type="button"
            disabled={saving}
            onClick={() => void saveBasics()}
          >
            {saving ? PRODUCT_COPY.savingSettings : PRODUCT_COPY.saveSettings}
          </SecondaryButton>
        </Card>

        <CodeSyncSettings appId={params.id} settings={settings} />

        <Card className="p-5">
          <h2 className="text-[15px] font-semibold text-[var(--los-text)]">域名与访问</h2>
          <p className="mt-1 text-sm text-[var(--los-secondary)]">
            系统域名与自定义域名请在专用页面管理。你不需要把域名写进代码。
          </p>
          <SecondaryLink className="mt-4" href={`/projects/${params.id}/domains`}>
            域名与访问 → 管理
          </SecondaryLink>
        </Card>

        <Card className="border-red-200 bg-[var(--los-error-bg)]/40 p-5">
          <h2 className="text-[15px] font-semibold text-[var(--los-error)]">危险区域</h2>
          <p className="mt-1 text-sm text-[var(--los-secondary)]">
            这些操作会影响线上访问，请确认后再执行。
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--los-text)]">停止应用</p>
              <p className="text-xs text-[var(--los-secondary)]">停止后公网将无法访问，可稍后重新启动。</p>
            </div>
            <DangerButton
              type="button"
              disabled={!canStop || busy === 'stop'}
              onClick={() => setConfirm('stop')}
            >
              {busy === 'stop' ? PRODUCT_COPY.stoppingApp : PRODUCT_COPY.stopApp}
            </DangerButton>
          </div>
          <div className="mt-4 border-t border-red-200/80 pt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--los-text)]">删除应用</p>
              <p className="text-xs text-[var(--los-secondary)]">
                永久删除会移除应用记录。Beta 阶段请先停止；彻底删除需联系支持。
              </p>
            </div>
            <DangerButton type="button" disabled={busy === 'delete'} onClick={() => setConfirm('delete')}>
              删除应用
            </DangerButton>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm === 'stop'}
        title="确定停止应用？"
        description="停止后访问地址将暂时不可用，数据与配置会保留。"
        confirmLabel={PRODUCT_COPY.stopApp}
        danger
        busy={busy === 'stop'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void stopApp()}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="确定删除应用？"
        description="当前 Beta 不会立即永久删除记录：若应用正在运行会先停止。彻底移除请联系平台支持。"
        confirmLabel="停止并继续"
        danger
        busy={busy === 'delete'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void requestDelete()}
      />
    </ControlCenter>
  );
}
