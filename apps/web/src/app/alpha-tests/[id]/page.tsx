'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';

type TimelineStep = {
  key: string;
  label: string;
  state: 'SUCCESS' | 'FAILED' | 'PENDING';
  durationMs: number | null;
  intervention: boolean;
};

type ChecklistItem = { phase: 'before' | 'during' | 'after'; id: string; label: string; done: boolean | null };

type Detail = {
  session: {
    id: string;
    launchRunId: string | null;
    sessionStatus: string;
    projectType: string | null;
    framework: string | null;
    dependencies: string | null;
    launchSucceeded: boolean | null;
    primaryFailureCode: string | null;
    blockedStage: string | null;
    blockedStep: string | null;
    publicUrl: string | null;
    health10m: string;
    health1h: string;
    health24h: string;
    manualInterventionCount: number;
    startedAt: string | null;
  };
  projectName: string | null;
  firstWave: boolean;
  checklist: ChecklistItem[];
  healthFollowUp: {
    health10mDueAt: string | null;
    health1hDueAt: string | null;
    health24hDueAt: string | null;
  };
  frictions: Array<{ id: string; stage?: string; note?: string }>;
  debrief: {
    biggestFriction?: string;
    confusingCopy?: string;
    explainedTechnicalConcept?: boolean;
    viewedTechnicalDetails?: boolean;
    failureCause?: string | null;
  } | null;
  durations: {
    timeToPlanMs: number | null;
    timeToLaunchMs: number | null;
    timeToPublicUrlMs: number | null;
    totalDurationMs: number | null;
  };
  timeline: TimelineStep[];
  interventions: Array<{
    id: string;
    stage: string;
    reason: string;
    actionTaken: string;
    resolved: boolean;
    severity: string | null;
  }>;
  feedback: {
    knewNextStep: number | null;
    freeFeedback: string | null;
    submittedAt: string | null;
  };
};

const STATE_LABEL = { SUCCESS: '成功', FAILED: '失败', PENDING: '未到' };

function duration(value: number | null): string {
  if (value == null) return '—';
  const minutes = Math.round(value / 60000);
  if (minutes < 1) return `${Math.round(value / 1000)} 秒`;
  return `${minutes} 分钟`;
}

export default function AlphaTestDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState('上线计划');
  const [reason, setReason] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [resolved, setResolved] = useState(false);
  const [category, setCategory] = useState('NEEDS_HELP');
  const [frictionStage, setFrictionStage] = useState('上线计划');
  const [frictionNote, setFrictionNote] = useState('');
  const [biggestFriction, setBiggestFriction] = useState('');
  const [confusingCopy, setConfusingCopy] = useState('');
  const [explainedTechnicalConcept, setExplainedTechnicalConcept] = useState(false);
  const [viewedTechnicalDetails, setViewedTechnicalDetails] = useState(false);
  const [failureCause, setFailureCause] = useState('');
  const [scores, setScores] = useState({
    knewNextStep: 3,
    billingClear: 3,
    failureUnderstandable: 3,
    neededHelp: 3,
    wouldContinue: 3,
  });
  const [freeFeedback, setFreeFeedback] = useState('');

  async function load(): Promise<void> {
    const payload = await api<Detail>(`/alpha-tests/${params.id}`);
    setDetail(payload);
  }

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [params.id, router]);

  async function saveIntervention(): Promise<void> {
    setError(null);
    try {
      await api(`/alpha-tests/${params.id}/interventions`, {
        method: 'POST',
        body: JSON.stringify({ stage, reason, actionTaken, category, resolved }),
      });
      setReason('');
      setActionTaken('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function saveFeedback(): Promise<void> {
    setError(null);
    try {
      await api(`/alpha-tests/${params.id}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ ...scores, freeFeedback }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function markStarted(): Promise<void> {
    setError(null);
    try {
      await api(`/alpha-tests/${params.id}/start`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '开始失败');
    }
  }

  async function saveFriction(): Promise<void> {
    setError(null);
    try {
      await api(`/alpha-tests/${params.id}/friction`, {
        method: 'POST',
        body: JSON.stringify({ stage: frictionStage, note: frictionNote }),
      });
      setFrictionNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function saveDebrief(): Promise<void> {
    setError(null);
    try {
      await api(`/alpha-tests/${params.id}/debrief`, {
        method: 'POST',
        body: JSON.stringify({
          biggestFriction,
          confusingCopy,
          explainedTechnicalConcept,
          viewedTechnicalDetails,
          failureCause: failureCause || null,
        }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function checkHealth(): Promise<void> {
    setError(null);
    try {
      await api(`/alpha-tests/${params.id}/health`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '复查失败');
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <p className="text-sm text-zinc-500">内部 · {detail?.projectName ?? '测试记录'}</p>
          <h1 className="mt-1 text-3xl font-semibold text-zinc-900">用户测试过程</h1>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {detail ? (
          <>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700">
              <p>状态 {detail.session.sessionStatus === 'PLANNED' ? '未开始' : detail.session.sessionStatus === 'IN_PROGRESS' ? '进行中' : detail.session.sessionStatus}</p>
              <p className="mt-1">开始时间 {detail.session.startedAt ?? '用户还没开始'}</p>
              <p className="mt-1">{detail.firstWave ? '在第一批范围内。' : '不在第一批范围。可以记录，但不要据此扩大测试。'}</p>
              {detail.session.sessionStatus === 'PLANNED' ? (
                <button className="mt-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white" type="button" onClick={() => void markStarted()}>
                  用户已开始
                </button>
              ) : null}
            </section>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-medium text-zinc-900">主持人清单</h2>
              <ul className="mt-3 flex flex-col gap-2 text-sm text-zinc-700">
                {detail.checklist.map((item) => (
                  <li key={item.id}>
                    {item.phase === 'before' ? '开始前' : item.phase === 'during' ? '进行中' : '结束后'} · {item.label}
                    {item.done == null ? '' : item.done ? ' · 已满足' : ' · 未满足'}
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-medium text-zinc-900">时间线</h2>
              <ul className="mt-3 flex flex-col gap-2">
                {detail.timeline.map((step) => (
                  <li key={step.key} className="flex items-center justify-between text-sm">
                    <span className="text-zinc-900">{step.label}</span>
                    <span className="text-zinc-600">
                      {STATE_LABEL[step.state]} · {duration(step.durationMs)}
                      {step.intervention ? ' · 有人工帮助' : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-zinc-500">
                到计划 {duration(detail.durations.timeToPlanMs)} · 上线执行 {duration(detail.durations.timeToLaunchMs)} · 到公网{' '}
                {duration(detail.durations.timeToPublicUrlMs)} · 总耗时 {duration(detail.durations.totalDurationMs)}
              </p>
            </section>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700">
              <p>类型 {detail.session.projectType ?? '—'} · 框架 {detail.session.framework ?? '—'} · 依赖 {detail.session.dependencies ?? '—'}</p>
              <p className="mt-1">公网 {detail.session.publicUrl ?? '—'}</p>
              <p className="mt-1">
                健康 10 分钟 {detail.session.health10m}
                {detail.healthFollowUp.health10mDueAt ? `（到期 ${detail.healthFollowUp.health10mDueAt}）` : ''} · 1 小时 {detail.session.health1h}
                {detail.healthFollowUp.health1hDueAt ? `（到期 ${detail.healthFollowUp.health1hDueAt}）` : ''} · 24 小时 {detail.session.health24h}
                {detail.healthFollowUp.health24hDueAt ? `（到期 ${detail.healthFollowUp.health24hDueAt}）` : ''}
              </p>
              <button className="mt-3 rounded-lg border border-zinc-300 px-3 py-1.5" type="button" onClick={() => void checkHealth()}>
                复查健康
              </button>
            </section>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-medium text-zinc-900">体验摩擦</h2>
              <p className="mt-1 text-sm text-zinc-500">用户大约 2 分钟不知道下一步时记录。这不会增加人工介入次数。</p>
              <div className="mt-3 grid gap-2">
                <input className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={frictionStage} onChange={(event) => setFrictionStage(event.target.value)} placeholder="阶段，例如上线计划" />
                <input className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={frictionNote} onChange={(event) => setFrictionNote(event.target.value)} placeholder="观察到什么" />
                <button className="w-fit rounded-lg border border-zinc-300 px-4 py-2 text-sm" type="button" onClick={() => void saveFriction()}>
                  记录摩擦
                </button>
              </div>
              <ul className="mt-3 flex flex-col gap-2 text-sm text-zinc-700">
                {detail.frictions.map((item) => (
                  <li key={item.id}>
                    {item.stage} · {item.note}
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-medium text-zinc-900">人工介入</h2>
              <p className="mt-1 text-sm text-zinc-500">用户大约 5 分钟无法继续，或产品报错阻断时才记录。已记录 {detail.session.manualInterventionCount} 次</p>
              <div className="mt-3 grid gap-2">
                <input className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={stage} onChange={(event) => setStage(event.target.value)} placeholder="阶段" />
                <input className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="原因" />
                <input className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={actionTaken} onChange={(event) => setActionTaken(event.target.value)} placeholder="做了什么" />
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input type="checkbox" checked={resolved} onChange={(event) => setResolved(event.target.checked)} />
                  这次介入后用户可以继续
                </label>
                <select className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={category} onChange={(event) => setCategory(event.target.value)}>
                  <option value="SECURITY">P0 安全</option>
                  <option value="DATA_LEAK">P0 数据泄漏</option>
                  <option value="UNCONFIRMED_BILLING">P0 未确认收费</option>
                  <option value="PRODUCTION_DAMAGE">P0 生产破坏</option>
                  <option value="CANNOT_COMPLETE">P1 无法完成上线</option>
                  <option value="NEEDS_HELP">P2 需要帮助</option>
                  <option value="EXPERIENCE">P3 体验</option>
                  <option value="SUGGESTION">P4 建议</option>
                </select>
                <button className="w-fit rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white" type="button" onClick={() => void saveIntervention()}>
                  记录介入
                </button>
              </div>
              <ul className="mt-3 flex flex-col gap-2 text-sm text-zinc-700">
                {detail.interventions.map((item) => (
                  <li key={item.id}>
                    {item.severity ?? '—'} · {item.stage} · {item.reason} · {item.actionTaken}
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-medium text-zinc-900">结束后的五个问题</h2>
              <div className="mt-3 grid gap-2 text-sm text-zinc-700">
                {(
                  [
                    ['knewNextStep', '你知道下一步该做什么吗？'],
                    ['billingClear', '费用确认是否清楚？'],
                    ['failureUnderstandable', '上线失败时，你看得懂原因吗？'],
                    ['neededHelp', '你是否需要别人帮助才能完成？'],
                    ['wouldContinue', '如果这是正式产品，你愿意继续使用吗？'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      className="ml-2 w-16 rounded border border-zinc-200 px-2 py-1"
                      type="number"
                      min={1}
                      max={5}
                      value={scores[key]}
                      onChange={(event) => setScores({ ...scores, [key]: Number(event.target.value) })}
                    />
                  </label>
                ))}
                <textarea className="rounded-lg border border-zinc-200 px-3 py-2" value={freeFeedback} onChange={(event) => setFreeFeedback(event.target.value)} placeholder="一条自由反馈" />
                <button className="w-fit rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white" type="button" onClick={() => void saveFeedback()}>
                  保存反馈
                </button>
                {detail.feedback.submittedAt ? <p className="text-zinc-500">已提交。{detail.feedback.freeFeedback ?? ''}</p> : null}
              </div>
            </section>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-medium text-zinc-900">主持人补充</h2>
              <div className="mt-3 grid gap-2 text-sm text-zinc-700">
                <input className="rounded-lg border border-zinc-200 px-3 py-2" value={biggestFriction} onChange={(event) => setBiggestFriction(event.target.value)} placeholder="最大卡点" />
                <input className="rounded-lg border border-zinc-200 px-3 py-2" value={confusingCopy} onChange={(event) => setConfusingCopy(event.target.value)} placeholder="最困惑的文案" />
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={explainedTechnicalConcept} onChange={(event) => setExplainedTechnicalConcept(event.target.checked)} />
                  需要向用户解释技术概念
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={viewedTechnicalDetails} onChange={(event) => setViewedTechnicalDetails(event.target.checked)} />
                  需要查看技术详情
                </label>
                <select className="rounded-lg border border-zinc-200 px-3 py-2" value={failureCause} onChange={(event) => setFailureCause(event.target.value)}>
                  <option value="">没有失败，或根因还不确定</option>
                  <option value="PRODUCT">PRODUCT</option>
                  <option value="USER_CODE">USER_CODE</option>
                  <option value="CLOUD_PROVIDER">CLOUD_PROVIDER</option>
                  <option value="PERMISSION">PERMISSION</option>
                  <option value="NETWORK">NETWORK</option>
                  <option value="UNKNOWN">UNKNOWN</option>
                </select>
                <button className="w-fit rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white" type="button" onClick={() => void saveDebrief()}>
                  保存主持人补充
                </button>
                {detail.debrief ? (
                  <p className="text-zinc-500">
                    已记录。最大卡点 {detail.debrief.biggestFriction || '—'} · 困惑文案 {detail.debrief.confusingCopy || '—'} · 根因 {detail.debrief.failureCause || '—'} · 介入 {detail.session.manualInterventionCount} 次
                  </p>
                ) : null}
                {detail.session.launchSucceeded === false ? (
                  <p className="text-zinc-500">
                    失败阶段 {detail.session.blockedStage ?? '—'} · 失败步骤 {detail.session.blockedStep ?? '—'} · {detail.session.primaryFailureCode ?? '—'}
                  </p>
                ) : null}
              </div>
            </section>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-500">
              <h2 className="font-medium text-zinc-900">技术详情</h2>
              <p className="mt-2">LaunchRun {detail.session.launchRunId ?? '—'}</p>
              <p>errorCode {detail.session.primaryFailureCode ?? '—'}</p>
            </section>
          </>
        ) : (
          <p className="text-sm text-zinc-500">加载中…</p>
        )}
      </div>
    </main>
  );
}
