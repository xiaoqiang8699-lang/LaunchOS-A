'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppComposition } from '@/components/app-composition';
import { CodeSyncSettings } from '@/components/code-sync-settings';
import { ControlCenter } from '@/components/control-center';
import { ProjectTabs } from '@/components/control-center/project-tabs';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { writeClipboard } from '@/lib/clipboard';
import { canLaunchProject } from '@/lib/launch-readiness';
import { PRODUCT_COPY } from '@/lib/product-language';
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  APP_RUNNING_STATUS_LABELS,
  APPLICATION_PURPOSE_LABELS,
  SOURCE_TYPE_LABELS,
  formatDateTime,
} from '@/lib/project-labels';
import type {
  AiAnalysis,
  AppHealth,
  AppIssue,
  AppSettings,
  AppSummary,
  ApplicationPurpose,
  ApplicationVersion,
  DeployableUnitCard,
  DeploymentDetail,
  DeploymentPlan,
  CodeAnalysisResponse,
  DeploymentSummary,
  ProjectDetail,
  ServiceInstance,
} from '@/lib/types';
import { FRAMEWORK_LABELS, isLaunchableUnit, isMobileAnalysisFramework } from '@/lib/types';

const PURPOSE_OPTIONS: ApplicationPurpose[] = ['WEBSITE', 'APP_WEBSITE', 'API', 'ADMIN', 'OTHER'];

type PrimaryAction = 'goLive' | 'redeploy' | 'start' | 'stop' | null;

export default function ProjectDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [app, setApp] = useState<AppSummary | null>(null);
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const [servicePort, setServicePort] = useState<number | null>(null);
  const [serviceRuntime, setServiceRuntime] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<PrimaryAction>(null);
  const [copied, setCopied] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [versions, setVersions] = useState<ApplicationVersion[]>([]);
  const [issues, setIssues] = useState<AppIssue[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [editingPurpose, setEditingPurpose] = useState(false);
  const [purposeDraft, setPurposeDraft] = useState<ApplicationPurpose>('WEBSITE');
  const [savingPurpose, setSavingPurpose] = useState(false);
  const [units, setUnits] = useState<DeployableUnitCard[] | null>(null);
  const [analysisFramework, setAnalysisFramework] = useState<string | null>(null);
  const [unitsLoading, setUnitsLoading] = useState(true);
  const [aggregateLabel, setAggregateLabel] = useState<string | null>(null);
  const [securitySummary, setSecuritySummary] = useState<{
    sensitiveTotal: number;
    appliedCount: number;
    pendingRedeployCount: number;
    overdueOrDueSoonCount: number;
    missingCount: number;
  } | null>(null);
  const [dependencySummary, setDependencySummary] = useState<{
    required: number;
    connected: number;
    missing: number;
    status: string;
    statusLabel: string;
  } | null>(null);
  const [serverPlanSummary, setServerPlanSummary] = useState<{
    needServer: boolean;
    readinessLabel: string;
    existingServer: { name: string; host: string } | null;
    recommendation: {
      profileLabel: string;
      vcpu: number;
      memoryGb: number;
      regionId: string;
      priceEstimate: {
        available: boolean;
        currency: string | null;
        monthlyEquivalent: string | null;
      } | null;
    };
  } | null>(null);
  const [databaseSummary, setDatabaseSummary] = useState<{
    needsDatabase: boolean;
    missingRequired: boolean;
    connection: {
      name: string;
      status: string;
      lastTestedAt: string | null;
      engine: string;
    } | null;
  } | null>(null);
  const [redisSummary, setRedisSummary] = useState<{
    needsRedis: boolean;
    missingRequired: boolean;
    connection: {
      name: string;
      status: string;
      lastTestedAt: string | null;
    } | null;
  } | null>(null);
  const [preferredVisitUrl, setPreferredVisitUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [
          detail,
          history,
          appDetail,
          latest,
          services,
          healthPayload,
          logsPayload,
          versionList,
          issueList,
          settingsPayload,
          unitsPayload,
          securityPayload,
          databasePayload,
          redisPayload,
          dependencyPayload,
          serverPlanPayload,
          codeAnalysisPayload,
          domainList,
        ] = await Promise.all([
          api<ProjectDetail>(`/projects/${params.id}`),
          api<DeploymentSummary[]>(`/projects/${params.id}/deployments`),
          api<AppSummary>(`/apps/${params.id}`).catch(() => null),
          api<{ analysis: AiAnalysis | null; plan: DeploymentPlan | null }>(
            `/projects/${params.id}/ai/analysis`,
          ).catch(() => ({ analysis: null, plan: null })),
          api<ServiceInstance[]>(`/projects/${params.id}/services`).catch(() => []),
          api<AppHealth>(`/apps/${params.id}/runtime?refreshPublic=1`).catch(() => null),
          api<{ logs: string }>(`/apps/${params.id}/logs?tail=200`).catch(() => null),
          api<ApplicationVersion[]>(`/apps/${params.id}/versions`).catch(() => []),
          api<AppIssue[]>(`/apps/${params.id}/issues`).catch(() => []),
          api<AppSettings>(`/apps/${params.id}/settings`).catch(() => null),
          api<{ units: DeployableUnitCard[]; aggregateLabel?: string }>(
            `/projects/${params.id}/deployable-units`,
          ).catch(() => ({ units: [], aggregateLabel: undefined })),
          api<{
            sensitiveTotal: number;
            appliedCount: number;
            pendingRedeployCount: number;
            overdueOrDueSoonCount: number;
            missingCount: number;
          }>(`/projects/${params.id}/config/security-summary`).catch(() => null),
          api<{
            needsDatabase: boolean;
            missingRequired: boolean;
            connection: {
              name: string;
              status: string;
              lastTestedAt: string | null;
              engine: string;
            } | null;
          }>(`/projects/${params.id}/database-connections/summary`).catch(() => null),
          api<{
            needsRedis: boolean;
            missingRequired: boolean;
            connection: {
              name: string;
              status: string;
              lastTestedAt: string | null;
            } | null;
          }>(`/projects/${params.id}/redis-connections/summary`).catch(() => null),
          api<{
            project: {
              required: number;
              connected: number;
              missing: number;
              status: string;
              statusLabel: string;
            };
          }>(`/projects/${params.id}/dependencies`).catch(() => null),
          api<{
            needServer: boolean;
            readinessLabel: string;
            existingServer: { name: string; host: string } | null;
            recommendation: {
              profileLabel: string;
              vcpu: number;
              memoryGb: number;
              regionId: string;
              priceEstimate: {
                available: boolean;
                currency: string | null;
                monthlyEquivalent: string | null;
              } | null;
            };
          }>(`/projects/${params.id}/server-plan`).catch(() => null),
          api<CodeAnalysisResponse>(`/projects/${params.id}/code-analysis`).catch(() => null),
          api<Array<{ domain: string; type: string; status: string }>>(
            `/projects/${params.id}/domains`,
          ).catch(() => []),
        ]);
        if (cancelled) {
          return;
        }
        setProject(detail);
        setDeployments(history);
        setApp(appDetail);
        const activeCustom = domainList.find(
          (item) => item.type === 'CUSTOM' && item.status === 'ACTIVE',
        );
        setPreferredVisitUrl(
          activeCustom ? `https://${activeCustom.domain}` : appDetail?.visitUrl ?? null,
        );
        setHealth(healthPayload);
        setLogs(logsPayload?.logs ?? null);
        setVersions(versionList);
        setIssues(issueList);
        setSettings(settingsPayload);
        setUnits(unitsPayload.units ?? []);
        setAnalysisFramework(
          codeAnalysisPayload?.result?.framework ?? codeAnalysisPayload?.analysis?.framework ?? null,
        );
        setAggregateLabel(unitsPayload.aggregateLabel ?? appDetail?.aggregateLabel ?? null);
        setSecuritySummary(securityPayload);
        setDatabaseSummary(databasePayload);
        setRedisSummary(redisPayload);
        setDependencySummary(dependencyPayload?.project ?? null);
        setServerPlanSummary(serverPlanPayload);
        setUnitsLoading(false);
        setHasAnalysis(Boolean(latest.analysis && latest.plan));
        setServicePort(services[0]?.port ?? latest.plan?.port ?? null);
        setServiceRuntime(services[0]?.runtime ?? latest.plan?.runtime ?? null);
      } catch (err) {
        if (cancelled) {
          return;
        }
        if (err instanceof Error && /Project not found|应用不存在|项目不存在/i.test(err.message)) {
          setError(PRODUCT_COPY.appNotFound);
          return;
        }
        clearAccessToken();
        setError(err instanceof Error ? err.message : '加载失败');
        router.replace('/login');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [params.id, router]);

  useEffect(() => {
    if (!project) {
      return;
    }
    const shouldPoll = deployments.some((item) => ACTIVE_DEPLOYMENT_STATUSES.includes(item.status));
    if (!shouldPoll) {
      return;
    }
    const timer = window.setInterval(() => {
      void Promise.all([
        api<DeploymentSummary[]>(`/projects/${params.id}/deployments`),
        api<AppSummary>(`/apps/${params.id}`).catch(() => null),
        api<ApplicationVersion[]>(`/apps/${params.id}/versions`).catch(() => []),
      ])
        .then(([history, appDetail, versionList]) => {
          setDeployments(history);
          if (appDetail) {
            setApp(appDetail);
          }
          setVersions(versionList);
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [deployments, params.id, project]);

  useEffect(() => {
    if (!project) {
      return;
    }
    const timer = window.setInterval(() => {
      void Promise.all([
        api<AppSummary>(`/apps/${params.id}`),
        api<AppHealth>(`/apps/${params.id}/runtime`),
      ])
        .then(([appDetail, healthPayload]) => {
          setApp(appDetail);
          setHealth(healthPayload);
        })
        .catch(() => undefined);
    }, 60_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [project, params.id]);

  const loadLogs = useCallback(async (): Promise<void> => {
    setLoadingLogs(true);
    try {
      const payload = await api<{ logs: string }>(`/apps/${params.id}/logs?tail=200`);
      setLogs(payload.logs);
    } catch {
      setLogs('');
    } finally {
      setLoadingLogs(false);
    }
  }, [params.id]);

  function goLive(): void {
    router.push(`/projects/${params.id}/launch`);
  }

  async function redeploy(): Promise<void> {
    if (busy) return;
    setBusy('redeploy');
    setError(null);
    setActionFeedback(null);
    try {
      const created = await api<DeploymentDetail>(`/apps/${params.id}/redeploy`, {
        method: 'POST',
      });
      setActionFeedback('正在重新上线…');
      router.push(`/deployments/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新上线失败');
      setBusy(null);
    }
  }

  async function runAction(action: 'start' | 'stop'): Promise<void> {
    if (busy) return;
    setBusy(action);
    setError(null);
    setActionFeedback(null);
    try {
      const updated = await api<AppSummary>(`/apps/${params.id}/${action}`, { method: 'POST' });
      setApp(updated);
      setActionFeedback(action === 'start' ? '已启动' : '已停止');
      await loadLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(null);
    }
  }

  async function copyVisitUrl(url: string): Promise<void> {
    try {
      await writeClipboard(url);
      setCopied(true);
      setActionFeedback('访问地址已复制');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('复制失败');
    }
  }

  async function savePurpose(): Promise<void> {
    if (!project) {
      return;
    }
    setSavingPurpose(true);
    setError(null);
    try {
      const updated = await api<ProjectDetail>(`/projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ applicationPurpose: purposeDraft }),
      });
      setProject((current) =>
        current ? { ...current, applicationPurpose: updated.applicationPurpose } : current,
      );
      setEditingPurpose(false);
      setActionFeedback(PRODUCT_COPY.purposeSaved);
      window.setTimeout(() => setActionFeedback(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存用途失败');
    } finally {
      setSavingPurpose(false);
    }
  }

  if (!project) {
    return (
      <ControlCenter>
        <p className="text-sm text-[var(--los-secondary)]">{error ?? '加载中…'}</p>
      </ControlCenter>
    );
  }

  const running = app?.applicationStatus ?? 'READY';
  const visitUrl = preferredVisitUrl || app?.visitUrl;
  const systemVisitUrl = app?.visitUrl;
  const canVisit = Boolean(app?.visitUrlReady && visitUrl) && running === 'RUNNING';
  const hasSource = project.sources.length > 0;
  const source = project.sources[0];
  const latest = deployments[0];
  const currentVersion = versions.find((item) => item.isCurrent) ?? versions[0] ?? null;
  const purposeLabel = project.applicationPurpose
    ? APPLICATION_PURPOSE_LABELS[project.applicationPurpose]
    : PRODUCT_COPY.purposeUnset;
  const frameworkLabel = project.framework
    ? (FRAMEWORK_LABELS[project.framework as keyof typeof FRAMEWORK_LABELS] ?? project.framework)
    : serviceRuntime;
  const secureAccess =
    Boolean(visitUrl?.startsWith('https://')) &&
    (app?.dnsStatus === 'ACTIVE' || app?.visitUrlReady);
  const healthLabel = productHealthLabel(health?.status ?? app?.healthStatus);
  const healthChecked = relativeCheckLabel(health?.lastCheckedAt ?? app?.lastHealthCheckAt);
  const canManage = Boolean(app?.canManage);
  const isViewerLimited = !canManage && running !== 'READY';
  const unitList = units ?? [];
  const mobileBlocked =
    unitList.length === 0
      ? isMobileAnalysisFramework(project.framework)
      : unitList.every((unit) => !isLaunchableUnit(unit));
  const canGoLive = canLaunchProject({
    hasSource,
    units: unitList,
    framework: project.framework,
    analysisFramework,
  });
  const statusLabel = aggregateLabel || app?.aggregateLabel || APP_RUNNING_STATUS_LABELS[running];

  return (
    <ControlCenter>
      <div className="flex flex-col gap-5">
        <nav className="text-sm text-[var(--los-secondary)]">
          <Link className="hover:text-[var(--los-text)]" href="/projects">
            我的应用
          </Link>
          <span className="mx-2">›</span>
          <span className="text-[var(--los-text)]">{project.name}</span>
        </nav>

        <ProjectTabs projectId={params.id} />

        {/* 1. Overview + primary actions */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[26px] font-semibold tracking-tight text-[var(--los-text)]">
                  {project.name}
                </h1>
                {project.isDemo ? (
                  <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-700">
                    {PRODUCT_COPY.demoBadge}
                  </span>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--los-secondary)]">
                <span>
                  {frameworkLabel || purposeLabel}
                  {hasSource ? ' · 代码已连接' : ''}
                </span>
                <StatusBadge status={running} label={statusLabel.replace(/^🟢\s*/, '')} />
                {versions[0]?.version ? (
                  <span>
                    {String(versions[0].version).startsWith('v')
                      ? versions[0].version
                      : `v${versions[0].version}`}
                  </span>
                ) : null}
                {(running === 'RUNNING' || running === 'WARNING') && healthChecked ? (
                  <span>最近检查 {healthChecked}</span>
                ) : null}
              </div>
              {canVisit && visitUrl ? (
                <p className="mt-2 truncate text-sm text-[var(--los-text)]">{visitUrl}</p>
              ) : null}
              {editingPurpose ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm"
                    value={purposeDraft}
                    onChange={(event) => setPurposeDraft(event.target.value as ApplicationPurpose)}
                  >
                    {PURPOSE_OPTIONS.map((item) => (
                      <option key={item} value={item}>
                        {APPLICATION_PURPOSE_LABELS[item]}
                      </option>
                    ))}
                  </select>
                  <button
                    className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-60"
                    type="button"
                    disabled={savingPurpose}
                    onClick={() => void savePurpose()}
                  >
                    {savingPurpose ? PRODUCT_COPY.savingSettings : PRODUCT_COPY.savePurpose}
                  </button>
                </div>
              ) : null}
              {mobileBlocked ? (
                <p className="mt-2 text-sm text-amber-800">{PRODUCT_COPY.iosUnsupportedTitle}</p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <PrimaryActions
                running={running}
                hasSource={hasSource}
                canVisit={canVisit}
                visitUrl={visitUrl}
                canGoLive={canGoLive}
                mobileBlocked={mobileBlocked}
                busy={busy}
                onGoLive={() => router.push(`/projects/${params.id}/go-live`)}
                onRedeploy={() => void redeploy()}
                onStart={() => void runAction('start')}
                onOpenMore={() => setShowMore((v) => !v)}
              />
            </div>
          </div>
          {showMore ? (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--los-border)] pt-3">
              <button
                type="button"
                className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                onClick={() => {
                  setPurposeDraft(project.applicationPurpose ?? 'WEBSITE');
                  setEditingPurpose(true);
                  setShowMore(false);
                }}
              >
                编辑用途
              </button>
              {running === 'RUNNING' || running === 'WARNING' ? (
                <button
                  type="button"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700"
                  disabled={busy === 'stop'}
                  onClick={() => void runAction('stop')}
                >
                  {busy === 'stop' ? '处理中…' : '停止应用'}
                </button>
              ) : null}
              <Link
                className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                href={`/projects/${params.id}/settings`}
              >
                设置
              </Link>
            </div>
          ) : null}
        </section>

        {/* Hosting — PLATFORM_MANAGED friendly */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <h2 className="text-[15px] font-semibold text-[var(--los-text)]">运行环境</h2>
          {(() => {
            const selfHosted = Boolean(
              serverPlanSummary?.needServer && serverPlanSummary?.existingServer,
            );
            const awaitingServer = Boolean(
              serverPlanSummary?.needServer &&
                !serverPlanSummary?.existingServer &&
                running === 'READY',
            );
            if (selfHosted) {
              return (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-[var(--los-secondary)]">
                    {serverPlanSummary!.existingServer!.name} · {serverPlanSummary!.readinessLabel}
                  </p>
                  <Link
                    className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                    href={`/projects/${project.id}/server`}
                  >
                    查看
                  </Link>
                </div>
              );
            }
            if (awaitingServer) {
              return (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-[var(--los-warning)]">需要准备运行环境</p>
                  <Link
                    className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                    href={`/projects/${project.id}/server`}
                  >
                    查看
                  </Link>
                </div>
              );
            }
            return (
              <div className="mt-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-[var(--los-text)]">LaunchOS 自动托管</p>
                  <StatusBadge status={running === 'RUNNING' ? 'HEALTHY' : running} />
                </div>
                <p className="mt-1 text-xs text-[var(--los-muted)]">
                  无需自行购买或管理服务器。
                </p>
              </div>
            );
          })()}
        </section>

        {/* Database semantics */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <h2 className="text-[15px] font-semibold">数据库</h2>
          {!databaseSummary?.needsDatabase ? (
            <p className="mt-2 text-sm text-[var(--los-secondary)]">
              当前应用未检测到数据库需求
            </p>
          ) : databaseSummary.missingRequired ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-[var(--los-warning)]">需要配置 DATABASE_URL</p>
              <Link
                className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                href={`/projects/${project.id}/config`}
              >
                配置
              </Link>
            </div>
          ) : (
            <p className="mt-2 text-sm text-[var(--los-secondary)]">
              已配置{databaseSummary.connection ? ` · ${databaseSummary.connection.engine}` : ''}
            </p>
          )}
        </section>

        {/* Config summary */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold">运行配置</h2>
              <p className="mt-1 text-sm text-[var(--los-secondary)]">
                {securitySummary
                  ? securitySummary.missingCount > 0
                    ? `${securitySummary.appliedCount} / ${securitySummary.sensitiveTotal || securitySummary.appliedCount + securitySummary.missingCount} 已完成 · ${securitySummary.missingCount} 项需要处理`
                    : `${securitySummary.appliedCount} / ${securitySummary.sensitiveTotal || securitySummary.appliedCount} 已完成`
                  : '查看环境变量与密钥'}
              </p>
            </div>
            <Link
              className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
              href={`/projects/${project.id}/config`}
            >
              {securitySummary?.missingCount ? '补充配置' : '配置'}
            </Link>
          </div>
        </section>

        {/* Current status */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <h2 className="text-[15px] font-semibold text-[var(--los-text)]">当前状态</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[var(--los-secondary)]">运行状态</dt>
              <dd className="mt-0.5 font-medium text-[var(--los-text)]">
                <StatusBadge status={running} label={statusLabel.replace(/^🟢\s*/, '')} />
              </dd>
            </div>
            <div>
              <dt className="text-[var(--los-secondary)]">公网访问</dt>
              <dd className="mt-0.5 font-medium text-[var(--los-text)]">
                {canVisit ? '正常' : healthLabel ?? (app?.visitUrlPreparing ? '准备中' : '待确认')}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--los-secondary)]">当前版本</dt>
              <dd className="mt-0.5 font-medium text-[var(--los-text)]">
                {currentVersion?.version ?? versions[0]?.version ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--los-secondary)]">最近检查</dt>
              <dd className="mt-0.5 font-medium text-[var(--los-text)]">
                {healthChecked ?? '—'}
              </dd>
            </div>
          </dl>
        </section>

          {/* Visit URL */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <h2 className="text-[15px] font-semibold text-[var(--los-text)]">访问地址</h2>
          <p className="mt-1 text-xs text-[var(--los-muted)]">
            你不需要把域名写进代码。如需自定义域名，请前往「域名与访问」。
          </p>
          {app?.visitEntries && app.visitEntries.length > 1 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {app.visitEntries.map((entry) => (
                <li key={entry.unitId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{entry.name}</span>
                  {entry.visitUrlReady && entry.visitUrl ? (
                    <a className="break-all text-[var(--los-secondary)] underline" href={entry.visitUrl} target="_blank" rel="noreferrer">
                      {entry.visitUrl}
                    </a>
                  ) : (
                    <span className="text-[var(--los-muted)]">暂无地址</span>
                  )}
                </li>
              ))}
            </ul>
          ) : app?.visitUrlPreparing && !visitUrl ? (
            <p className="mt-2 text-sm text-[var(--los-secondary)]">访问地址准备中…</p>
          ) : visitUrl ? (
            <>
              <p className="mt-2 break-all text-sm font-medium text-[var(--los-text)]">{visitUrl}</p>
              {systemVisitUrl && preferredVisitUrl && preferredVisitUrl !== systemVisitUrl ? (
                <p className="mt-1 break-all text-xs text-[var(--los-muted)]">
                  系统备用地址：{systemVisitUrl}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {canVisit ? (
                  <a
                    className="rounded-lg bg-[var(--los-action)] px-3 py-1.5 text-sm font-medium text-white"
                    href={visitUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开应用
                  </a>
                ) : null}
                <button
                  className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                  type="button"
                  onClick={() => void copyVisitUrl(visitUrl)}
                >
                  {copied ? '已复制' : '复制'}
                </button>
                <Link
                  className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                  href={`/projects/${params.id}/domains`}
                >
                  域名与访问
                </Link>
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-[var(--los-secondary)]">完成上线后即可获得访问地址。</p>
          )}
        </section>

        {dependencySummary && dependencySummary.required > 0 ? (
          <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-semibold">应用依赖</h2>
                <p className="mt-1 text-sm text-[var(--los-secondary)]">
                  {dependencySummary.required} 个依赖 · {dependencySummary.statusLabel}
                  {dependencySummary.missing > 0 ? ` · ${dependencySummary.missing} 个需要处理` : ''}
                </p>
              </div>
              <Link
                className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                href={`/projects/${project.id}/dependencies`}
              >
                管理依赖
              </Link>
            </div>
          </section>
        ) : null}

        <AppComposition
          projectId={project.id}
          units={units}
          loading={unitsLoading}
          ready={canGoLive}
          canManage={canManage}
          compact
          onChanged={() => {
            void api<{ units: DeployableUnitCard[]; aggregateLabel?: string }>(
              `/projects/${project.id}/deployable-units`,
            )
              .then((payload) => {
                setUnits(payload.units ?? []);
                setAggregateLabel(payload.aggregateLabel ?? null);
              })
              .catch(() => undefined);
            void api<AppSummary>(`/apps/${project.id}`)
              .then(setApp)
              .catch(() => undefined);
          }}
        />

        {/* Recent deploys */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold">最近上线</h2>
            <Link
              className="text-sm text-[var(--los-secondary)] underline"
              href={`/projects/${params.id}/deployments`}
            >
              查看全部上线记录
            </Link>
          </div>
          {deployments.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--los-secondary)]">还没有上线记录。</p>
          ) : (
            <ul className="mt-3 divide-y divide-[var(--los-border)]">
              {deployments.slice(0, 3).map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.version ?? '上线'}</span>
                    <StatusBadge status={d.status} />
                    {d.id === currentVersion?.deploymentId ? (
                      <span className="text-xs text-[var(--los-muted)]">当前运行</span>
                    ) : null}
                  </div>
                  <span className="text-[var(--los-secondary)]">{formatDateTime(d.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Code source */}
        <section id="code-source" className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <h2 className="text-[15px] font-semibold">代码来源</h2>
          {!source ? (
            <p className="mt-2 text-sm text-[var(--los-secondary)]">请先连接代码仓库</p>
          ) : (
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-[var(--los-secondary)]">来源</dt>
                <dd className="font-medium">{SOURCE_TYPE_LABELS[source.type]}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-[var(--los-secondary)]">仓库</dt>
                <dd className="break-all">{source.fullName || simplifyRepoUrl(source.url)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-[var(--los-secondary)]">分支</dt>
                <dd>{source.branch || 'main'}</dd>
              </div>
              {source.isPrivate && source.authStatus === 'NEEDS_REAUTH' ? (
                <p className="text-sm text-[var(--los-warning)]">
                  GitHub 连接已失效，请{' '}
                  <Link className="underline" href="/code-platforms">
                    重新授权
                  </Link>
                </p>
              ) : null}
            </dl>
          )}
        </section>

        {issues.length > 0 || running === 'WARNING' || running === 'FAILED' ? (
          <section id="issues" className="rounded-xl border border-[var(--los-border)] bg-white p-5">
            <h2 className="text-[15px] font-semibold">需要关注</h2>
            <div className="mt-3 space-y-2">
              {running === 'WARNING' && issues.length === 0 ? (
                <p className="text-sm text-amber-800">应用可访问，但最近检测发现异常。</p>
              ) : null}
              {issues.slice(0, 3).map((issue) => (
                <div key={issue.id} className="rounded-lg border border-[var(--los-border)] px-3 py-2">
                  <p className="text-sm font-medium">{issue.title}</p>
                  <p className="mt-0.5 text-xs text-[var(--los-secondary)]">{issue.cause}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Advanced (collapsed) */}
        <section className="rounded-xl border border-dashed border-[var(--los-border)] bg-white p-5">
          <button
            className="flex w-full items-center justify-between text-left"
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <div>
              <h2 className="text-sm font-medium text-[var(--los-secondary)]">高级</h2>
              <p className="mt-0.5 text-xs text-[var(--los-muted)]">技术排查工具，日常不必使用。</p>
            </div>
            <span className="text-[var(--los-muted)]">{showAdvanced ? '收起' : '展开'}</span>
          </button>
          {showAdvanced ? (
            <div className="mt-4 space-y-3 border-t border-[var(--los-border)] pt-4">
              <div className="flex flex-wrap gap-2">
                <Link className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm" href={`/projects/${project.id}/analyze`}>
                  代码检测
                </Link>
                <Link className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm" href={`/projects/${project.id}/runtime`}>
                  运行状态
                </Link>
                <Link className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm" href={`/projects/${project.id}/versions`}>
                  版本
                </Link>
              </div>
              <CodeSyncSettings appId={params.id} settings={settings} />
            </div>
          ) : null}
        </section>

      </div>
    </ControlCenter>
  );
}

function PrimaryActions(props: {
  running: AppSummary['applicationStatus'];
  hasSource: boolean;
  canVisit: boolean;
  visitUrl: string | null | undefined;
  canGoLive: boolean;
  mobileBlocked?: boolean;
  busy: PrimaryAction;
  onGoLive: () => void;
  onRedeploy: () => void;
  onStart: () => void;
  onOpenMore: () => void;
}) {
  const disabled = Boolean(props.busy);

  if (!props.hasSource) {
    return null;
  }

  if (props.mobileBlocked) {
    return null;
  }

  if (props.running === 'READY') {
    return (
      <>
        <button
          className="rounded-lg bg-[var(--los-action)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          type="button"
          disabled={disabled || !props.canGoLive}
          onClick={props.onGoLive}
        >
          {props.busy === 'goLive' ? '处理中…' : '立即上线'}
        </button>
        <button
          className="rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
          type="button"
          onClick={props.onOpenMore}
        >
          更多
        </button>
      </>
    );
  }

  if (props.running === 'STOPPED' || props.running === 'FAILED') {
    return (
      <>
        {props.canVisit && props.visitUrl ? (
          <a
            className="rounded-lg bg-[var(--los-action)] px-4 py-2 text-sm font-medium text-white"
            href={props.visitUrl}
            target="_blank"
            rel="noreferrer"
          >
            打开应用
          </a>
        ) : null}
        <button
          className="rounded-lg border border-[var(--los-border)] px-4 py-2 text-sm disabled:opacity-60"
          type="button"
          disabled={disabled}
          onClick={props.running === 'STOPPED' ? props.onStart : props.onRedeploy}
        >
          {props.running === 'STOPPED'
            ? props.busy === 'start'
              ? '启动中…'
              : '启动'
            : props.busy === 'redeploy'
              ? '处理中…'
              : '重新上线'}
        </button>
        <button
          className="rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
          type="button"
          onClick={props.onOpenMore}
        >
          更多
        </button>
      </>
    );
  }

  return (
    <>
      <a
        className="rounded-lg bg-[var(--los-action)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        href={props.canVisit && props.visitUrl ? props.visitUrl : undefined}
        target="_blank"
        rel="noreferrer"
        aria-disabled={!props.canVisit || !props.visitUrl}
        onClick={(e) => {
          if (!props.canVisit || !props.visitUrl) e.preventDefault();
        }}
      >
        打开应用
      </a>
      {props.canGoLive ? (
        <button
          className="rounded-lg border border-[var(--los-border)] px-4 py-2 text-sm disabled:opacity-60"
          type="button"
          disabled={disabled}
          onClick={props.onRedeploy}
        >
          {props.busy === 'redeploy' ? '处理中…' : '重新上线'}
        </button>
      ) : null}
      <button
        className="rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
        type="button"
        onClick={props.onOpenMore}
      >
        更多
      </button>
    </>
  );
}

function simplifyRepoUrl(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/^github\.com\//, '');
}

function productHealthLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  if (status === 'HEALTHY') return PRODUCT_COPY.healthOk;
  if (status === 'UNHEALTHY') return PRODUCT_COPY.healthBad;
  return PRODUCT_COPY.healthUnknown;
}

function relativeCheckLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return PRODUCT_COPY.lastCheckedJustNow;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return PRODUCT_COPY.lastCheckedJustNow;
  if (minutes < 60) return `${minutes}${PRODUCT_COPY.lastCheckedMinutes}`;
  return formatDateTime(iso);
}
