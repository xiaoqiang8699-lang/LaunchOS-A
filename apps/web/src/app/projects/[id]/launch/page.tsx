'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { planNeedsBillingConfirmation, presentLaunchPageError, resolveLaunchPrimaryCta } from '@/lib/launch-confirmation-state';
import { PRODUCT_COPY } from '@/lib/product-language';

type LaunchPlanResponse = {
  launchRunId: string;
  launchRunStatus: string;
  planVersion: string;
  stages: Array<{ stage: string; labelZh: string; decisionSummary: string; status: string }>;
  dependenciesReady: boolean;
  serverReady: boolean;
  apiReady: boolean;
  webReady: boolean;
  publicEntryReady: boolean;
  resourcesToReuse: Array<{ kind: string; labelZh: string }>;
  resourcesToCreate: Array<{ kind: string; labelZh: string }>;
  billableActions: Array<{ labelZh: string; profileHint?: string | null; stepType?: string }>;
  requiresConfirmation: boolean;
  estimatedCostAvailable: boolean;
  executionSteps: string[];
  currentDesiredStateSatisfied: boolean;
  canLaunch: boolean;
  blockers: Array<{ code: string; messageZh: string }>;
  accessEntryStatus?: string | null;
  latestFinishedLaunchStatus?: string | null;
  publicUrl?: string | null;
  progress?: { progressPercent: number };
  confirmDisabledReasonZh?: string;
  realExecutionLocked?: boolean;
  messageZh?: string;
  steps?: Array<{
    stepType: string;
    stage: string;
    decision: string;
    reasonZh: string;
    billable: boolean;
  }>;
};

const PROGRESS_LINES = [
  '正在分析应用',
  '正在准备依赖',
  '正在准备服务器',
  '正在构建应用',
  '正在部署应用',
  '正在配置访问入口',
  '正在进行上线检查',
];

const USER_ERRORS: Record<string, string> = {
  PLAN_STALE: '上线计划发生变化，请重新确认。',
  LAUNCH_ALREADY_RUNNING: '应用正在上线，请稍候。',
  BILLABLE_ACTION_CONFIRMATION_REQUIRED: '需要先确认云资源费用。',
  ALPHA_UNSUPPORTED_APPLICATION: '当前 Alpha 暂不支持这个应用结构。',
};

function filterUserStages(
  stages: LaunchPlanResponse['stages'],
): LaunchPlanResponse['stages'] {
  return stages.filter((s) => {
    if (
      s.stage === 'DEPENDENCIES' &&
      (s.decisionSummary === 'SKIP' || s.decisionSummary === 'REUSE')
    ) {
      return false;
    }
    return true;
  });
}

export default function LaunchPlanPage() {
  return (
    <LaunchPageErrorBoundary>
      <LaunchPlanScreen />
    </LaunchPageErrorBoundary>
  );
}

class LaunchPageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    const view = presentLaunchPageError(this.state.error);
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10">
        <div className="mx-auto max-w-3xl rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>{view.message}</p>
          {view.technical ? <p className="mt-2 text-xs text-amber-800">技术详情：{view.technical}</p> : null}
        </div>
      </main>
    );
  }
}

function LaunchPlanScreen() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [plan, setPlan] = useState<LaunchPlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [techCode, setTechCode] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [confirmedPlanHash, setConfirmedPlanHash] = useState<string | null>(null);
  const [confirmedForPlanVersion, setConfirmedForPlanVersion] = useState<string | null>(null);

  const createPlan = useCallback(async () => {
    setPending(true);
    setError(null);
    setInfo(null);
    setTechCode(null);
    try {
      const result = await api<LaunchPlanResponse>(`/projects/${params.id}/launch/plan`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setPlan(result);
      setConfirmedPlanHash(null);
      setConfirmedForPlanVersion(null);
      setRunStatus(result.launchRunStatus);
      setPublicUrl(result.publicUrl ?? null);
      setProgressPercent(result.progress?.progressPercent ?? 0);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearAccessToken();
        router.replace('/login');
        return;
      }
      const view = presentLaunchPageError(err);
      setTechCode(view.technical);
      setError(view.message);
    } finally {
      setPending(false);
    }
  }, [params.id, router]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void createPlan();
  }, [createPlan, router]);

  async function confirmBilling(): Promise<void> {
    if (!plan) return;
    setPending(true);
    setError(null);
    try {
      const result = await api<{
        confirmed: boolean;
        confirmedPlanHash: string;
        messageZh?: string;
      }>(`/projects/${params.id}/launch/${plan.launchRunId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ planVersion: plan.planVersion, acceptance: true }),
      });
      setConfirmedPlanHash(result.confirmedPlanHash);
      setConfirmedForPlanVersion(plan.planVersion);
      setInfo(result.messageZh ?? '费用已确认');
    } catch (err) {
      setError(err instanceof Error ? err.message : '确认失败');
    } finally {
      setPending(false);
    }
  }

  async function startOrGate(): Promise<void> {
    if (!plan || needsBilling) return;
    setPending(true);
    setError(null);
    setTechCode(null);
    setInfo(null);
    try {
      const result = await api<{
        launchRunId: string;
        status: string;
        currentStage?: string | null;
        progressPercent?: number;
        messageZh?: string;
        publicUrl?: string | null;
      }>(`/projects/${params.id}/launch/${plan.launchRunId}/execute`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setRunStatus(result.status);
      setProgressPercent(result.progressPercent ?? 10);
      if (result.publicUrl) setPublicUrl(result.publicUrl);
      setInfo(result.messageZh ?? '正在进行上线检查');
      await pollRun(result.launchRunId);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setTechCode(code ?? null);
      setError(
        (code && USER_ERRORS[code]) ||
          (err instanceof Error ? err.message : '无法开始上线'),
      );
      setPending(false);
    }
  }

  async function pollRun(launchRunId: string): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
      const run = await api<{
        status: string;
        progressPercent: number;
        currentStage?: string | null;
        userMessage?: string | null;
        failureCode?: string | null;
      }>(`/projects/${params.id}/launch/${launchRunId}`);
      setRunStatus(run.status);
      setProgressPercent(run.progressPercent ?? 0);
      if (run.status === 'SUCCESS') {
        setInfo('应用已上线');
        setPending(false);
        return;
      }
      if (run.status === 'FAILED' || run.status === 'CANCELLED') {
        setTechCode(run.failureCode ?? null);
        setError(run.userMessage || '上线没有完成');
        setPending(false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    setPending(false);
  }

  const billing = plan
    ? planNeedsBillingConfirmation({
        requiresConfirmation: plan.requiresConfirmation,
        billableStepTypes: plan.billableActions.map((action) => action.stepType ?? ''),
        confirmedPlanHash,
        planVersion: plan.planVersion,
        confirmedForPlanVersion,
      })
    : { needsConfirmation: false, blockedReason: null as 'missing' | 'stale' | null };
  const needsBilling = billing.needsConfirmation;
  const accessEntryActive = plan?.accessEntryStatus === 'ACTIVE' || Boolean(plan?.publicEntryReady);
  const showPublished = Boolean(
    publicUrl &&
      (runStatus === 'SUCCESS' ||
        (accessEntryActive && plan?.latestFinishedLaunchStatus === 'SUCCESS')),
  );
  const primaryCta = resolveLaunchPrimaryCta({
    launchRunStatus: runStatus,
    accessEntryActive,
    latestFinishedLaunchStatus: plan?.latestFinishedLaunchStatus ?? null,
    needsBillingConfirmation: needsBilling,
    planStale: billing.blockedReason === 'stale',
    pending,
  });
  const noNewBillable =
    Boolean(plan) &&
    plan!.resourcesToCreate.length === 0 &&
    plan!.billableActions.length === 0;

  const visibleStages = useMemo(
    () => (plan ? filterUserStages(plan.stages) : []),
    [plan],
  );

  const readyItems = useMemo(() => {
    if (!plan) return [];
    const items: Array<{ key: string; label: string; ok: boolean }> = [];
    const depsHidden = !plan.stages.some(
      (s) =>
        s.stage === 'DEPENDENCIES' &&
        s.decisionSummary !== 'SKIP' &&
        s.decisionSummary !== 'REUSE',
    );
    if (!depsHidden) {
      items.push({ key: 'dependenciesReady', label: '数据库 / 依赖', ok: plan.dependenciesReady });
    }
    items.push({ key: 'serverReady', label: '服务器', ok: plan.serverReady });
    const hasApiStep = plan.executionSteps.some((s) => s.includes('API'));
    if (hasApiStep) {
      items.push({ key: 'apiReady', label: 'API', ok: plan.apiReady });
    }
    items.push({ key: 'webReady', label: 'Web', ok: plan.webReady });
    items.push({
      key: 'publicEntryReady',
      label: 'HTTPS / 访问入口',
      ok: plan.publicEntryReady,
    });
    return items;
  }, [plan]);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={`/projects/${params.id}`}>
            ← 返回应用
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">上线应用</h1>
          <p className="mt-1 text-sm text-zinc-500">
            LaunchOS 会生成上线计划：复用已准备好的资源，并在创建云资源前征求确认。
          </p>
        </div>

        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p>{error}</p>
            {techCode ? <p className="mt-2 text-xs text-amber-800">技术详情：{techCode}</p> : null}
          </div>
        ) : null}
        {info ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {info}
          </p>
        ) : null}

        {!plan && !error ? (
          <p className="text-sm text-zinc-500">{pending ? '正在生成上线计划…' : '加载中…'}</p>
        ) : null}

        {plan ? (
          <>
            <section className="rounded-2xl border border-zinc-200 bg-white p-6">
              <h2 className="text-lg font-semibold text-zinc-900">上线计划</h2>
              <p className="mt-1 text-sm text-zinc-500">
                进度约 {plan.progress?.progressPercent ?? 0}% ·{' '}
                {plan.launchRunStatus === 'WAITING_CONFIRMATION' ? '等待确认费用' : '计划已就绪'}
              </p>
              <ul className="mt-4 space-y-2">
                {visibleStages.map((stage) => {
                  const done =
                    stage.decisionSummary === 'REUSE' || stage.decisionSummary === 'SKIP';
                  const running = stage.decisionSummary === 'EXECUTE';
                  const serverReadyLabel =
                    stage.stage === 'INFRASTRUCTURE' && done ? '（已准备）' : '';
                  return (
                    <li
                      key={stage.stage}
                      className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-sm"
                    >
                      <span className="text-zinc-800">
                        {stage.labelZh}
                        {serverReadyLabel}
                      </span>
                      <span className="text-zinc-500">
                        {done ? '✓' : running ? '●' : '○'}{' '}
                        {done ? '已准备好' : running ? '需要执行' : '等待'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="rounded-2xl border border-zinc-200 bg-white p-6">
              <h2 className="text-lg font-semibold text-zinc-900">已经准备好</h2>
              <ul className="mt-3 space-y-2 text-sm text-zinc-700">
                {readyItems.map(({ key, label, ok }) => (
                  <li key={key} className="flex items-center gap-2">
                    <span className={ok ? 'text-emerald-600' : 'text-zinc-400'}>
                      {ok ? '✓' : '○'}
                    </span>
                    {label}
                  </li>
                ))}
              </ul>
            </section>

            {plan.resourcesToCreate.length > 0 ? (
              <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
                <h2 className="text-lg font-semibold text-amber-950">计划确认</h2>
                <p className="mt-1 text-sm text-amber-900">需要创建的资源（云服务商：阿里云）</p>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-900">
                  {plan.resourcesToCreate.map((r, i) => (
                    <li key={`${r.kind}-${i}`}>{r.labelZh}</li>
                  ))}
                </ul>
                {plan.billableActions.some((a) => a.profileHint) ? (
                  <p className="mt-3 text-sm text-amber-900">
                    规格：
                    {plan.billableActions
                      .filter((a) => a.profileHint)
                      .map((a) => a.profileHint)
                      .join('、')}
                  </p>
                ) : null}
                <p className="mt-2 text-sm text-amber-800">
                  预计费用：
                  {plan.estimatedCostAvailable ? '见云账户报价' : '确认时将展示预估（下一阶段完整报价）'}
                </p>
              </section>
            ) : noNewBillable ? (
              <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
                <h2 className="text-lg font-semibold text-emerald-950">资源计划</h2>
                <p className="mt-2 text-sm text-emerald-900">无需创建新的收费云资源</p>
                <p className="mt-1 text-sm text-emerald-800">预计新增云资源：无</p>
              </section>
            ) : null}

            <section className="rounded-2xl border border-zinc-200 bg-white p-6">
              <h2 className="text-lg font-semibold text-zinc-900">
                {showPublished ? '应用已上线' : '上线进度'}
              </h2>
              {showPublished && publicUrl ? (
                <p className="mt-2 text-sm text-zinc-700">
                  访问地址：{' '}
                  <a className="text-zinc-900 underline" href={publicUrl}>
                    {publicUrl}
                  </a>
                </p>
              ) : (
                <ul className="mt-3 space-y-1 text-sm text-zinc-600">
                  {PROGRESS_LINES.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-sm text-zinc-500">进度 {progressPercent}%</p>
              {showPublished && publicUrl ? (
                <div className="mt-4 flex gap-3">
                  <a
                    className="rounded-xl bg-zinc-900 px-4 py-2 text-sm text-white"
                    href={publicUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开应用
                  </a>
                  <Link className="rounded-xl border border-zinc-300 px-4 py-2 text-sm" href={`/projects/${params.id}`}>
                    查看上线详情
                  </Link>
                </div>
              ) : null}
            </section>

            <div className="flex flex-wrap items-center gap-3">
              {billing.blockedReason === 'stale' ? (
                <p className="w-full text-sm text-amber-800">上线计划发生变化，请重新确认。</p>
              ) : null}
              <button
                type="button"
                disabled={primaryCta.disabled}
                onClick={() => {
                  if (primaryCta.action === 'confirm') void confirmBilling();
                  else if (primaryCta.action === 'replan') void createPlan();
                  else void startOrGate();
                }}
                className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              >
                {primaryCta.label}
              </button>
              {primaryCta.action === 'replan' ? null : (
                <button
                  type="button"
                  onClick={() => void createPlan()}
                  disabled={pending}
                  className="rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700"
                >
                  重新生成计划
                </button>
              )}
            </div>

            <div>
              <button
                type="button"
                className="text-sm text-zinc-500 underline"
                onClick={() => setShowDetails((v) => !v)}
              >
                {showDetails ? '隐藏技术详情' : '技术详情 /details'}
              </button>
              {showDetails ? (
                <pre className="mt-3 overflow-auto rounded-xl bg-zinc-900 p-4 text-xs text-zinc-100">
                  {JSON.stringify(
                    {
                      launchRunId: plan.launchRunId,
                      planVersion: plan.planVersion,
                      confirmedPlanHash,
                      requiresConfirmation: plan.requiresConfirmation,
                      executionSteps: plan.executionSteps,
                      realExecutionLocked: false,
                      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
                    },
                    null,
                    2,
                  )}
                </pre>
              ) : null}
            </div>
          </>
        ) : null}

        <p className="text-xs text-zinc-400">{PRODUCT_COPY.goLive}</p>
      </div>
    </main>
  );
}
