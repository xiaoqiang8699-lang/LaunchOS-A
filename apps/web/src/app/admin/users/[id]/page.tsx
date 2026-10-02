'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Detail = {
  profile: {
    id: string;
    displayName: string;
    email: string;
    platformRole: 'USER' | 'PLATFORM_ADMIN';
    platformRoleLabel: string;
    accountStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
    accountStatusLabel: string;
    createdAt: string;
    lastLoginAt: string | null;
    onboardingStatus: string;
    adminNote: string | null;
    suspendedAt: string | null;
    suspendedBy: string | null;
    suspendReason: string | null;
    projectCount: number;
  };
  workspaces: Array<{ id: string; name: string; roleLabel: string; members: number; applications: number }>;
  applications: Array<{ id: string; name: string; status: string; publicUrl: string | null; lastLaunchAt: string | null; healthStatus: string }>;
  billing: {
    plan: string;
    status: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    invoices: Array<{ id: string; amount: number; currency: string; status: string; periodStart: string; periodEnd: string }>;
    paymentConnected: boolean;
  };
  security: { lastLoginAt: string | null; sessions: Array<{ id: string; createdAt: string; revokedAt: string | null }> };
  audit: Array<{ id: string; action: string; createdAt: string }>;
  alphaSessions: Array<{ id: string; sessionStatus: string; createdAt: string }>;
};

type Health = {
  firstSeenAt: string;
  lastActiveAt: string;
  projectCount: number;
  deploySuccessCount: number;
  plan: { code: string; name: string };
  healthStatus: 'ACTIVE' | 'NEEDS_ATTENTION' | 'DORMANT';
  healthLabel: string;
  recentEvents: Array<{ id: string; eventType: string; createdAt: string }>;
};

type Lifecycle = {
  statusCode: string;
  statusLabel: string;
  tags: Array<{ id: string; tag: string; source: string; createdAt: string }>;
  reason: string | null;
  plan: { code: string; name: string };
  projectCount: number;
  deploySuccessCount: number;
  lastFailedDeploy: { errorMessage: string | null; failureCode: string | null; createdAt: string } | null;
  timeline: Array<{ id: string; eventType: string; label: string; createdAt: string }>;
  triggeredRules: Array<{
    id: string;
    ruleId: string | null;
    ruleName: string | null;
    actionType: string;
    status: string;
    createdAt: string;
  }>;
};

type AiInsight = {
  profile: {
    type: string;
    plan: string;
    planCode: string;
    projectCount: number;
    deploySuccessCount: number;
    deployFailedCount: number;
    tags: string[];
  };
  currentStage: string;
  risks: Array<{ code: string; title: string; detail?: string }>;
  suggestions: string[];
  note?: string;
};

type ActivationDetail = {
  stage: string;
  stageLabel: string;
  status: string;
  statusLabel: string;
  score: number;
  primaryBlocker: string | null;
  blockerLabel: string | null;
  explanation: unknown;
  timestamps: {
    firstProjectAt: string | null;
    firstDeployStartedAt: string | null;
    firstDeploySucceededAt: string | null;
    firstPublicSuccessAt: string | null;
    activatedAt: string | null;
    lastProgressAt: string | null;
  };
  timeline: Array<{ label: string; stage: string; at: string }>;
  nextActions: Array<{ title: string; href: string | null; reason: string }>;
};

export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);
  const [aiInsight, setAiInsight] = useState<AiInsight | null>(null);
  const [activation, setActivation] = useState<ActivationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [platformRole, setPlatformRole] = useState<'USER' | 'PLATFORM_ADMIN'>('USER');
  const [accountStatus, setAccountStatus] = useState<'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'>('ACTIVE');
  const [adminNote, setAdminNote] = useState('');
  const [deleteEmail, setDeleteEmail] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    void api<Detail>(`/admin/users/${params.id}`)
      .then((payload) => {
        setDetail(payload);
        setDisplayName(payload.profile.displayName);
        setEmail(payload.profile.email);
        setPlatformRole(payload.profile.platformRole);
        setAccountStatus(payload.profile.accountStatus);
        setAdminNote(payload.profile.adminNote ?? '');
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
    void api<Health>(`/admin/users/${params.id}/health`)
      .then(setHealth)
      .catch(() => setHealth(null));
    void api<Lifecycle>(`/admin/users/${params.id}/lifecycle`)
      .then(setLifecycle)
      .catch(() => setLifecycle(null));
    void api<AiInsight>(`/admin/users/${params.id}/ai-insight`)
      .then(setAiInsight)
      .catch(() => setAiInsight(null));
    void api<ActivationDetail>(`/admin/users/${params.id}/activation`)
      .then(setActivation)
      .catch(() => setActivation(null));
  }, [params.id]);

  async function reload(): Promise<void> {
    const payload = await api<Detail>(`/admin/users/${params.id}`);
    setDetail(payload);
  }

  async function save(): Promise<void> {
    setError(null);
    try {
      const payload = await api<Detail>(`/admin/users/${params.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayName, email, platformRole, accountStatus, adminNote }),
      });
      setDetail(payload);
      setMessage('已保存');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    }
  }

  async function resetOnboarding(): Promise<void> {
    if (detail && detail.profile.projectCount > 0 && !window.confirm('该操作仅用于重新体验引导，不会删除已有应用。')) return;
    await api(`/admin/users/${params.id}/reset-onboarding`, { method: 'POST' });
    setMessage('已重置首次引导');
    await reload();
  }

  async function revokeSessions(): Promise<void> {
    await api(`/admin/users/${params.id}/revoke-sessions`, { method: 'POST' });
    setMessage('已退出全部会话');
    await reload();
  }

  async function archive(): Promise<void> {
    await api(`/admin/users/${params.id}/archive`, { method: 'POST' });
    setMessage('已归档');
    await reload();
  }

  async function removeForever(): Promise<void> {
    setError(null);
    try {
      await api(`/admin/users/${params.id}/delete`, {
        method: 'POST',
        body: JSON.stringify({ email: deleteEmail, phrase: '永久删除后无法恢复。' }),
      });
      router.replace('/admin/users');
    } catch (err) {
      setError(err instanceof Error ? err.message : '不能删除');
    }
  }

  if (error && !detail) return <p className="text-sm text-red-600">{error}</p>;
  if (!detail) return <p className="text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="flex flex-col gap-4">
      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link className="text-sm underline" href="/admin/users">
            返回用户列表
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{detail.profile.displayName}</h1>
          <p className="text-sm text-zinc-500">{detail.profile.email}</p>
        </div>
        {detail.workspaces[0] ? (
          <Link
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
            href={`/admin/workspaces/${detail.workspaces[0].id}`}
          >
            查看用户视角（只读 · Workspace 运营详情）
          </Link>
        ) : null}
      </div>
      <section id="edit" className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium">基本信息</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-zinc-600">姓名<input className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label className="text-sm text-zinc-600">邮箱<input className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label className="text-sm text-zinc-600">平台角色
            <select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={platformRole} onChange={(event) => setPlatformRole(event.target.value as 'USER' | 'PLATFORM_ADMIN')}>
              <option value="USER">普通用户</option>
              <option value="PLATFORM_ADMIN">平台管理员</option>
            </select>
          </label>
          <label className="text-sm text-zinc-600">账号状态
            <select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={accountStatus} onChange={(event) => setAccountStatus(event.target.value as 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED')}>
              <option value="ACTIVE">正常</option>
              <option value="SUSPENDED">已停用</option>
              <option value="ARCHIVED">已归档</option>
            </select>
          </label>
        </div>
        <p className="mt-3 text-sm text-zinc-600">注册时间 {new Date(detail.profile.createdAt).toLocaleString()}</p>
        <p className="text-sm text-zinc-600">最近登录 {detail.profile.lastLoginAt ? new Date(detail.profile.lastLoginAt).toLocaleString() : '—'}</p>
        <p className="text-sm text-zinc-600">引导状态 {detail.profile.onboardingStatus}</p>
        {detail.profile.suspendedAt ? <p className="text-sm text-zinc-600">停用于 {new Date(detail.profile.suspendedAt).toLocaleString()} · {detail.profile.suspendedBy ?? '—'} · {detail.profile.suspendReason ?? '无原因'}</p> : null}
        <label className="mt-3 block text-sm text-zinc-600">管理员备注
          <textarea className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={adminNote} onChange={(event) => setAdminNote(event.target.value)} />
        </label>
        <button className="mt-3 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white" type="button" onClick={() => void save()}>保存</button>
      </section>

      {activation ? (
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-medium">激活状态</h2>
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700">
              {activation.status} · {activation.statusLabel} · 分数 {activation.score}
            </span>
          </div>
          <div className="mt-3 grid gap-2 text-sm text-zinc-600 sm:grid-cols-2">
            <p>当前阶段 {activation.stageLabel} ({activation.stage})</p>
            <p>主要阻塞 {activation.blockerLabel || activation.primaryBlocker || '—'}</p>
            <p>首次项目 {activation.timestamps.firstProjectAt ? new Date(activation.timestamps.firstProjectAt).toLocaleString() : '—'}</p>
            <p>首次部署 {activation.timestamps.firstDeployStartedAt ? new Date(activation.timestamps.firstDeployStartedAt).toLocaleString() : '—'}</p>
            <p>首次成功 {activation.timestamps.firstDeploySucceededAt ? new Date(activation.timestamps.firstDeploySucceededAt).toLocaleString() : '—'}</p>
            <p>公网成功 {activation.timestamps.firstPublicSuccessAt ? new Date(activation.timestamps.firstPublicSuccessAt).toLocaleString() : '—'}</p>
          </div>
          {Array.isArray(activation.explanation) && activation.explanation.length > 0 ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-zinc-500">
              {activation.explanation.map((line, i) => (
                <li key={i}>{String(line)}</li>
              ))}
            </ul>
          ) : null}
          <h3 className="mt-4 text-sm font-medium text-zinc-800">激活时间线</h3>
          <ol className="mt-2 space-y-2 border-l border-zinc-200 pl-4">
            {activation.timeline.map((item, i) => (
              <li key={`${item.stage}-${i}`} className="text-sm text-zinc-700">
                <span className="font-medium">{item.label}</span>
                <span className="ml-2 text-xs text-zinc-400">{new Date(item.at).toLocaleString()}</span>
              </li>
            ))}
            {activation.timeline.length === 0 ? <li className="text-sm text-zinc-500">暂无时间线</li> : null}
          </ol>
        </section>
      ) : null}

      {health ? (
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-medium">用户健康</h2>
            <span
              className={
                health.healthStatus === 'ACTIVE'
                  ? 'rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700'
                  : health.healthStatus === 'NEEDS_ATTENTION'
                    ? 'rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700'
                    : 'rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600'
              }
            >
              {health.healthStatus} · {health.healthLabel}
            </span>
          </div>
          <div className="mt-3 grid gap-2 text-sm text-zinc-600 sm:grid-cols-2">
            <p>首次创建时间 {new Date(health.firstSeenAt).toLocaleString()}</p>
            <p>最后活跃时间 {new Date(health.lastActiveAt).toLocaleString()}</p>
            <p>项目数量 {health.projectCount}</p>
            <p>成功部署次数 {health.deploySuccessCount}</p>
            <p>当前套餐 {health.plan.name} ({health.plan.code})</p>
          </div>
          <h3 className="mt-4 text-sm font-medium text-zinc-800">最近行为</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600">
            {health.recentEvents.length === 0 ? (
              <li>暂无 ProductEvent</li>
            ) : (
              health.recentEvents.map((event) => (
                <li key={event.id}>
                  {event.eventType} · {new Date(event.createdAt).toLocaleString()}
                </li>
              ))
            )}
          </ul>
        </section>
      ) : null}

      {lifecycle ? (
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-medium">生命周期状态</h2>
            <span className="rounded-full bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white">
              {lifecycle.statusLabel}
            </span>
          </div>
          <p className="mt-2 text-sm text-zinc-600">
            状态码 {lifecycle.statusCode}
            {lifecycle.reason ? ` · ${lifecycle.reason}` : ''}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {lifecycle.tags.length === 0 ? (
              <span className="text-sm text-zinc-500">暂无标签</span>
            ) : (
              lifecycle.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800"
                >
                  {tag.tag}
                  <span className="ml-1 text-amber-600/70">{tag.source}</span>
                </span>
              ))
            )}
          </div>
          {lifecycle.lastFailedDeploy ? (
            <p className="mt-3 text-sm text-red-700">
              最近失败：{lifecycle.lastFailedDeploy.errorMessage || lifecycle.lastFailedDeploy.failureCode || '未知'}
              {' · '}
              {new Date(lifecycle.lastFailedDeploy.createdAt).toLocaleString()}
            </p>
          ) : null}

          <h3 className="mt-5 text-sm font-medium text-zinc-800">活动时间线</h3>
          <ol className="mt-3 space-y-0">
            {lifecycle.timeline.length === 0 ? (
              <li className="text-sm text-zinc-500">暂无事件</li>
            ) : (
              lifecycle.timeline.map((item, index) => (
                <li key={item.id} className="relative flex gap-3 pb-4 last:pb-0">
                  <div className="flex w-4 flex-col items-center">
                    <span className="mt-1 h-2.5 w-2.5 rounded-full bg-zinc-900" />
                    {index < lifecycle.timeline.length - 1 ? (
                      <span className="mt-1 w-px flex-1 bg-zinc-200" />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-medium text-zinc-900">{item.label}</p>
                    <p className="text-xs text-zinc-500">
                      {item.eventType} · {new Date(item.createdAt).toLocaleString()}
                    </p>
                  </div>
                </li>
              ))
            )}
          </ol>

          <h3 className="mt-5 text-sm font-medium text-zinc-800">触发规则</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600">
            {lifecycle.triggeredRules.length === 0 ? (
              <li>暂无触发记录</li>
            ) : (
              lifecycle.triggeredRules.map((row) => (
                <li key={row.id}>
                  {row.ruleName || row.ruleId || '规则'} · {row.actionType} · {row.status} ·{' '}
                  {new Date(row.createdAt).toLocaleString()}
                </li>
              ))
            )}
          </ul>
        </section>
      ) : null}

      {aiInsight ? (
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="text-lg font-medium">AI 用户分析</h2>
          {aiInsight.note ? <p className="mt-1 text-xs text-zinc-500">{aiInsight.note}</p> : null}
          <div className="mt-3 grid gap-2 text-sm text-zinc-700 sm:grid-cols-2">
            <p>
              用户画像：<span className="font-medium">{aiInsight.profile.type}</span>
            </p>
            <p>
              当前阶段：<span className="font-medium">{aiInsight.currentStage}</span>
            </p>
            <p>
              套餐：{aiInsight.profile.plan} ({aiInsight.profile.planCode})
            </p>
            <p>
              项目 {aiInsight.profile.projectCount} · 成功部署 {aiInsight.profile.deploySuccessCount} ·
              失败 {aiInsight.profile.deployFailedCount}
            </p>
          </div>
          <h3 className="mt-4 text-sm font-medium text-zinc-800">风险</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600">
            {aiInsight.risks.length === 0 ? (
              <li>暂无明显风险</li>
            ) : (
              aiInsight.risks.map((risk) => (
                <li key={risk.code}>
                  {risk.title}
                  {risk.detail ? ` · ${risk.detail}` : ''}
                </li>
              ))
            )}
          </ul>
          <h3 className="mt-4 text-sm font-medium text-zinc-800">建议</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-600">
            {aiInsight.suggestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium">Workspace</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {detail.workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Link className="underline" href={`/admin/workspaces/${workspace.id}`}>{workspace.name}</Link>
              {' '}· {workspace.roleLabel} · {workspace.members} 名成员 · {workspace.applications} 个应用
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium">应用</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {detail.applications.length === 0 ? <li>暂无应用</li> : detail.applications.map((app) => (
            <li key={app.id}>
              <Link className="underline" href={`/admin/apps/${app.id}`}>{app.name}</Link>
              {' '}· {app.status} · {app.publicUrl ?? '无公网地址'} · {app.lastLaunchAt ? new Date(app.lastLaunchAt).toLocaleString() : '未上线'} · {app.healthStatus}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium">订阅与账单</h2>
        <p className="mt-2 text-sm text-zinc-600">当前套餐 {detail.billing.plan} · {detail.billing.status === 'NONE' ? '未订阅' : detail.billing.status}</p>
        <p className="text-sm text-zinc-600">当前周期 {detail.billing.currentPeriodStart ? new Date(detail.billing.currentPeriodStart).toLocaleDateString() : '—'} 至 {detail.billing.currentPeriodEnd ? new Date(detail.billing.currentPeriodEnd).toLocaleDateString() : '—'}</p>
        <p className="mt-2 text-sm text-zinc-500">支付未接入，不能修改账单金额。</p>
        <ul className="mt-2 text-sm text-zinc-600">
          {detail.billing.invoices.length === 0 ? <li>暂无账单</li> : detail.billing.invoices.map((invoice) => (
            <li key={invoice.id}>{invoice.amount} {invoice.currency} · {invoice.status}</li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium">安全</h2>
        <p className="mt-2 text-sm text-zinc-600">最近登录 {detail.security.lastLoginAt ? new Date(detail.security.lastLoginAt).toLocaleString() : '—'}</p>
        <ul className="mt-2 text-sm text-zinc-600">
          {detail.security.sessions.map((session) => (
            <li key={session.id}>{new Date(session.createdAt).toLocaleString()}{session.revokedAt ? ' · 已退出' : ' · 有效'}</li>
          ))}
        </ul>
        <button className="mt-3 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm" type="button" onClick={() => void revokeSessions()}>强制退出全部会话</button>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium">审计</h2>
        <ul className="mt-2 text-sm text-zinc-600">
          {detail.audit.length === 0 ? <li>暂无记录</li> : detail.audit.map((row) => (
            <li key={row.id}>{row.action} · {new Date(row.createdAt).toLocaleString()}</li>
          ))}
        </ul>
      </section>

      <section id="more" className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium">更多</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm" type="button" onClick={() => void resetOnboarding()}>重置首次引导</button>
          <button className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm" type="button" onClick={() => void archive()}>归档</button>
        </div>
        {detail.alphaSessions.length > 0 ? (
          <ul className="mt-3 text-sm">
            {detail.alphaSessions.map((session) => (
              <li key={session.id}><Link className="underline" href={`/admin/beta/sessions/${session.id}`}>查看 Beta Session {session.id.slice(0, 8)}</Link></li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4 rounded-lg border border-red-200 p-3">
          <p className="text-sm text-red-700">永久删除后无法恢复。</p>
          <input className="mt-2 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm" placeholder="输入用户邮箱" value={deleteEmail} onChange={(event) => setDeleteEmail(event.target.value)} />
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            我确认永久删除后无法恢复
          </label>
          <button className="mt-2 rounded-lg bg-red-700 px-3 py-1.5 text-sm text-white disabled:opacity-40" type="button" disabled={!confirmed || deleteEmail.trim().toLowerCase() !== detail.profile.email.toLowerCase()} onClick={() => void removeForever()}>
            永久删除
          </button>
        </div>
      </section>
    </div>
  );
}
