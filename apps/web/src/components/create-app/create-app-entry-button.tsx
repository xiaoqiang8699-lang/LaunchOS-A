'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/toast';
import { PrimaryButton } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type UsageView = {
  usage?: { projects?: number };
  entitlements?: { maxProjects?: number | null };
};

export type ProjectQuotaGate = {
  atLimit: boolean;
  used: number;
  limit: number | null;
  message: string;
};

export async function checkProjectCreateQuota(): Promise<ProjectQuotaGate> {
  const usage = await api<UsageView>('/account/usage');
  const used = usage.usage?.projects ?? 0;
  const limit = usage.entitlements?.maxProjects ?? null;
  const atLimit = limit != null && used >= limit;
  return {
    atLimit,
    used,
    limit,
    message:
      limit == null
        ? '当前套餐额度不足，请升级套餐后再创建应用。'
        : `你的套餐最多可创建 ${limit} 个应用。请升级套餐后再试。`,
  };
}

/**
 * Primary entry to create an app. Checks plan project quota on click;
 * if at limit, shows a modal instead of navigating into the create flow.
 */
export function CreateAppEntryButton({
  href = '/projects/new',
  label = '创建应用',
  className,
  variant = 'primary',
}: {
  href?: string;
  label?: string;
  className?: string;
  variant?: 'primary' | 'link-style';
}) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitMessage, setLimitMessage] = useState('');

  async function onClick() {
    if (checking) return;
    setChecking(true);
    try {
      const gate = await checkProjectCreateQuota();
      if (gate.atLimit) {
        setLimitMessage(gate.message);
        setLimitOpen(true);
        return;
      }
      router.push(href);
    } catch {
      // If usage API fails, still allow entry — server will enforce on create.
      router.push(href);
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      {variant === 'primary' ? (
        <PrimaryButton type="button" className={className} disabled={checking} onClick={() => void onClick()}>
          {checking ? '检查中…' : label}
        </PrimaryButton>
      ) : (
        <button
          type="button"
          className={cn('text-sm font-medium underline', className)}
          disabled={checking}
          onClick={() => void onClick()}
        >
          {checking ? '检查中…' : label}
        </button>
      )}
      <ConfirmDialog
        open={limitOpen}
        title="无法创建更多应用"
        description={limitMessage}
        confirmLabel="查看套餐"
        cancelLabel="知道了"
        onConfirm={() => {
          setLimitOpen(false);
          router.push('/plan');
        }}
        onCancel={() => setLimitOpen(false)}
      />
    </>
  );
}
