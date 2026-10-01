'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { isBetaEntitlementSource } from '@/lib/plan-prices';

type MemberRow = {
  userId: string;
  email: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  roleLabel: string;
};

type UsageView = {
  source?: string;
  override?: { reason?: string | null } | null;
  usage?: { members: number };
  entitlements?: { maxWorkspaceMembers: number | null };
};

const ROLE_OPTIONS = [
  { value: 'ADMIN', label: '管理员' },
  { value: 'MEMBER', label: '成员' },
  { value: 'VIEWER', label: '只读成员' },
];

export default function TeamPage() {
  const router = useRouter();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  async function load() {
    const [memberPayload, usagePayload] = await Promise.all([
      api<{ canManage: boolean; members: MemberRow[] }>('/account/members'),
      api<UsageView>('/account/usage').catch(() => null),
    ]);
    setCanManage(memberPayload.canManage);
    setMembers(memberPayload.members);
    setUsage(usagePayload);
  }

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void load()
      .then(() => setReady(true))
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : '加载失败'),
      );
  }, [router]);

  const limit = usage?.entitlements?.maxWorkspaceMembers ?? null;
  const used = usage?.usage?.members ?? members.length;
  const atLimit = limit != null && used >= limit;
  const beta = isBetaEntitlementSource(usage?.source, usage?.override?.reason);

  const ownerCount = useMemo(() => members.filter((m) => m.role === 'OWNER').length, [members]);

  async function invite() {
    setError('');
    setMessage('');
    try {
      await api('/account/members', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      setInviteEmail('');
      setMessage('已发送邀请 / 已加入团队');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : '邀请失败');
    }
  }

  async function changeRole(userId: string, role: string) {
    setError('');
    try {
      await api(`/account/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '修改失败');
    }
  }

  async function removeMember(userId: string) {
    setError('');
    try {
      await api(`/account/members/${userId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '移除失败');
    }
  }

  return (
    <ControlCenter>
      <PageHeader title="团队" description="管理成员与协作权限" />

      {!ready ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Card className="mb-5 flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <p className="text-xs text-[var(--los-secondary)]">当前成员</p>
              <p className="mt-1 text-2xl font-semibold">
                {used}
                {limit == null ? '' : ` / ${limit}`}
              </p>
              {beta ? (
                <p className="mt-1 text-xs text-[var(--los-muted)]">Beta 测试额度</p>
              ) : null}
            </div>
            {atLimit ? (
              <div className="max-w-sm">
                <InlineAlert
                  tone="warning"
                  title="团队协作需要更高套餐"
                  description={`当前套餐最多支持 ${limit} 位成员。`}
                  actionLabel="查看套餐"
                  actionHref="/plan"
                />
              </div>
            ) : null}
          </Card>

          {error ? <InlineAlert className="mb-4" tone="error" title={error} /> : null}
          {message ? <InlineAlert className="mb-4" tone="success" title={message} /> : null}

          {canManage ? (
            <Card className="mb-5 p-5">
              <h2 className="text-[15px] font-semibold">邀请成员</h2>
              {atLimit ? (
                <p className="mt-2 text-sm text-[var(--los-secondary)]">
                  当前套餐最多支持 {limit} 位成员。
                  <Link className="ml-2 underline" href="/plan">
                    查看套餐
                  </Link>
                </p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <input
                    className="min-w-[14rem] flex-1 rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
                    placeholder="邮箱"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                  <select
                    className="rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                  >
                    {ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded-lg bg-[var(--los-action)] px-4 py-2 text-sm text-white disabled:opacity-50"
                    disabled={!inviteEmail.trim()}
                    onClick={() => void invite()}
                  >
                    邀请
                  </button>
                </div>
              )}
            </Card>
          ) : (
            <p className="mb-4 text-sm text-[var(--los-secondary)]">你当前为只读或普通成员，无法管理邀请。</p>
          )}

          <Card className="overflow-hidden">
            <div className="border-b border-[var(--los-border)] px-4 py-3 text-sm font-medium">
              成员列表
            </div>
            <ul className="divide-y divide-[var(--los-border)]">
              {members.map((member) => (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-[var(--los-text)]">{member.name || '未命名'}</p>
                    <p className="truncate text-[var(--los-secondary)]">{member.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canManage && member.role !== 'OWNER' ? (
                      <>
                        <select
                          className="rounded-lg border border-[var(--los-border)] px-2 py-1.5 text-sm"
                          value={member.role}
                          onChange={(e) => void changeRole(member.userId, e.target.value)}
                        >
                          {ROLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="rounded-lg border border-red-200 px-2 py-1.5 text-sm text-red-700"
                          onClick={() => void removeMember(member.userId)}
                        >
                          移除
                        </button>
                      </>
                    ) : (
                      <span className="text-[var(--los-secondary)]">{member.roleLabel}</span>
                    )}
                    {member.role === 'OWNER' && ownerCount > 0 ? (
                      <span className="text-xs text-[var(--los-muted)]">所有者</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </ControlCenter>
  );
}
