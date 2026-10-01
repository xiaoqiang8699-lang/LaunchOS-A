'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { PRODUCT_COPY } from '@/lib/product-language';
import { goLivePath } from '@/lib/start-deploy';
import {
  FRAMEWORK_LABELS,
  type DeployableUnitCard,
  type DeploymentDetail,
} from '@/lib/types';

function relativeCheckLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return PRODUCT_COPY.lastCheckedJustNow;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return PRODUCT_COPY.lastCheckedJustNow;
  return `${minutes}${PRODUCT_COPY.lastCheckedMinutes}`;
}

function frameworkLabel(framework: string | null | undefined): string {
  if (!framework) return '—';
  return FRAMEWORK_LABELS[framework as keyof typeof FRAMEWORK_LABELS] ?? framework;
}

export function AppComposition(props: {
  projectId: string;
  units: DeployableUnitCard[] | null;
  canManage: boolean;
  /** 与检测页相同的结论：没有单元数据时，是否仍然可以直接上线。 */
  ready?: boolean;
  loading?: boolean;
  /** Overview compact: hide duplicate project-level primary actions */
  compact?: boolean;
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  if (props.loading) {
    return (
      <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
        <h2 className="text-[15px] font-semibold text-[var(--los-text)]">服务</h2>
        <p className="mt-3 text-sm text-[var(--los-secondary)]">{PRODUCT_COPY.appCompositionScanning}</p>
      </section>
    );
  }

  if (!props.units) {
    return null;
  }

  if (props.units.length === 0) {
    if (props.ready) {
      return props.compact ? null : (
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <h2 className="text-[15px] font-semibold">服务</h2>
          <p className="mt-2 text-sm text-[var(--los-secondary)]">上线配置已准备完成</p>
        </section>
      );
    }

    return (
      <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
        <h2 className="text-[15px] font-semibold">服务</h2>
        <p className="mt-2 text-sm text-[var(--los-secondary)]">暂时没有找到可上线内容</p>
        <Link
          className="mt-3 inline-flex rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
          href={`/projects/${props.projectId}/analyzing`}
        >
          重新检测
        </Link>
      </section>
    );
  }

  const singleUnit = props.units.length === 1;
  const hideUnitPrimary = Boolean(props.compact && singleUnit);

  async function runUnitAction(
    unit: DeployableUnitCard,
    action: 'redeploy' | 'start' | 'stop',
  ): Promise<void> {
    const key = `${unit.id}:${action}`;
    setBusyKey(key);
    setError(null);
    setFeedback(null);
    const label = unit.displayName || unit.name;
    try {
      if (action === 'redeploy') {
        setFeedback(`正在上线${label}…`);
        const created = await api<DeploymentDetail>(
          `/projects/${props.projectId}/deployable-units/${unit.id}/redeploy`,
          { method: 'POST' },
        );
        setFeedback(`${label}已开始上线`);
        router.push(`/deployments/${created.id}`);
        return;
      }
      setFeedback(action === 'start' ? `正在启动${label}…` : `正在停止${label}…`);
      await api(`/projects/${props.projectId}/deployable-units/${unit.id}/${action}`, {
        method: 'POST',
      });
      setFeedback(action === 'start' ? `${label}启动成功` : `${label}已停止`);
      props.onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label}操作失败`);
    } finally {
      setBusyKey(null);
    }
  }

  async function saveName(unit: DeployableUnitCard): Promise<void> {
    const next = nameDraft.trim();
    if (!next) return;
    setBusyKey(`${unit.id}:rename`);
    setError(null);
    try {
      await api(`/projects/${props.projectId}/deployable-units/${unit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: next }),
      });
      setEditingId(null);
      setFeedback('名称已更新');
      props.onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
      <h2 className="text-[15px] font-semibold text-[var(--los-text)]">
        {props.compact ? '服务' : PRODUCT_COPY.appComposition}
      </h2>
      {!singleUnit ? (
        <p className="mt-1 text-sm text-[var(--los-secondary)]">{PRODUCT_COPY.appCompositionHint}</p>
      ) : null}

      {feedback ? (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {feedback}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <ul className={props.compact ? 'mt-3 divide-y divide-[var(--los-border)]' : 'mt-4 space-y-3'}>
        {props.units.map((unit) => {
          const launchable = Boolean(unit.canLaunch ?? unit.deployable);
          const title = unit.displayName || unit.name;
          const checked = relativeCheckLabel(unit.lastHealthCheckAt);
          return (
            <li
              key={unit.id}
              className={
                props.compact
                  ? 'flex flex-wrap items-center justify-between gap-2 py-2.5'
                  : 'rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3'
              }
            >
              <div
                className={
                  props.compact
                    ? 'flex w-full flex-wrap items-center justify-between gap-2'
                    : 'flex w-full flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'
                }
              >
                <div className="min-w-0">
                  {editingId === unit.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm"
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                      />
                      <button
                        className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-60"
                        type="button"
                        disabled={busyKey === `${unit.id}:rename`}
                        onClick={() => void saveName(unit)}
                      >
                        保存
                      </button>
                      <button
                        className="text-sm text-zinc-500 underline"
                        type="button"
                        onClick={() => setEditingId(null)}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-[var(--los-text)]">{title}</p>
                      <span className="text-sm text-[var(--los-secondary)]">
                        {frameworkLabel(unit.framework)}
                      </span>
                      {unit.healthLabel || unit.productStatusLabel ? (
                        <span className="text-xs text-[var(--los-secondary)]">
                          ● {unit.healthLabel || unit.productStatusLabel}
                        </span>
                      ) : null}
                      {!props.compact && props.canManage ? (
                        <button
                          className="text-xs text-zinc-500 underline"
                          type="button"
                          onClick={() => {
                            setEditingId(unit.id);
                            setNameDraft(title);
                          }}
                        >
                          重命名
                        </button>
                      ) : null}
                    </div>
                  )}
                  {!props.compact && launchable ? (
                    <div className="mt-2 space-y-1 text-sm text-zinc-600">
                      <p>
                        {PRODUCT_COPY.visitUrl}：
                        {unit.visitUrlReady && unit.visitUrl ? (
                          <a
                            className="ml-1 text-zinc-900 underline"
                            href={unit.visitUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {unit.visitUrl}
                          </a>
                        ) : (
                          <span className="ml-1">{PRODUCT_COPY.appCompositionNoUrl}</span>
                        )}
                      </p>
                      {unit.currentVersion ? (
                        <p>
                          {PRODUCT_COPY.currentVersion}：{unit.currentVersion}
                        </p>
                      ) : null}
                      {unit.healthLabel ? (
                        <p>
                          {PRODUCT_COPY.healthStatus}：{unit.healthLabel}
                          {checked ? ` · ${PRODUCT_COPY.lastHealthCheck} ${checked}` : ''}
                        </p>
                      ) : null}
                      {unit.codeUpdatePending ? (
                        <p className="text-amber-800">{PRODUCT_COPY.unitCodeUpdated}</p>
                      ) : null}
                      {unit.runtimeConfig && unit.runtimeConfig.total > 0 ? (
                        <p
                          className={
                            unit.runtimeConfig.missingRequired > 0
                              ? 'text-amber-800'
                              : 'text-zinc-600'
                          }
                        >
                          运行配置：
                          {unit.runtimeConfig.missingRequired > 0
                            ? `还缺少 ${unit.runtimeConfig.missingRequired} 项`
                            : `${unit.runtimeConfig.completed} 项已完成`}
                          {unit.runtimeConfig.pendingApply
                            ? ' · 运行配置已更新，等待重新上线'
                            : ''}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {!hideUnitPrimary && launchable ? (
                  <div className="flex flex-wrap gap-2">
                    <Link
                      className="rounded-lg border border-[var(--los-border)] bg-white px-3 py-1.5 text-sm"
                      href={`/projects/${props.projectId}/units/${unit.id}/config`}
                    >
                      配置
                    </Link>
                    {unit.visitUrlReady && unit.visitUrl ? (
                      <a
                        className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                        href={unit.visitUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开
                      </a>
                    ) : null}
                    {props.canManage && !props.compact ? (
                      <>
                        <Link
                          className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700"
                          href={goLivePath(props.projectId, unit.id)}
                        >
                          {unit.canManage || unit.currentVersion
                            ? PRODUCT_COPY.goLiveAgain
                            : PRODUCT_COPY.goLive}
                        </Link>
                        {unit.canManage ? (
                          <>
                            <button
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-60"
                              type="button"
                              disabled={Boolean(busyKey)}
                              onClick={() => void runUnitAction(unit, 'start')}
                            >
                              {busyKey === `${unit.id}:start`
                                ? PRODUCT_COPY.startingApp
                                : PRODUCT_COPY.startApp}
                            </button>
                            <button
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-60"
                              type="button"
                              disabled={Boolean(busyKey)}
                              onClick={() => void runUnitAction(unit, 'stop')}
                            >
                              {busyKey === `${unit.id}:stop`
                                ? PRODUCT_COPY.stoppingApp
                                : PRODUCT_COPY.stopApp}
                            </button>
                            <button
                              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-60"
                              type="button"
                              disabled={Boolean(busyKey)}
                              onClick={() => void runUnitAction(unit, 'redeploy')}
                            >
                              {busyKey === `${unit.id}:redeploy`
                                ? PRODUCT_COPY.goingLive
                                : PRODUCT_COPY.goLiveAgain}
                            </button>
                          </>
                        ) : null}
                      </>
                    ) : props.canManage && props.compact && !singleUnit ? (
                      <details className="relative">
                        <summary className="cursor-pointer list-none rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm">
                          更多
                        </summary>
                        <div className="absolute right-0 z-10 mt-1 flex min-w-[8rem] flex-col rounded-lg border border-[var(--los-border)] bg-white p-1 shadow-sm">
                          <button
                            className="rounded px-3 py-1.5 text-left text-sm hover:bg-zinc-50"
                            type="button"
                            disabled={Boolean(busyKey)}
                            onClick={() => void runUnitAction(unit, 'redeploy')}
                          >
                            重新上线
                          </button>
                          <button
                            className="rounded px-3 py-1.5 text-left text-sm hover:bg-zinc-50"
                            type="button"
                            disabled={Boolean(busyKey)}
                            onClick={() => void runUnitAction(unit, 'stop')}
                          >
                            停止
                          </button>
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : !launchable ? (
                  <Link
                    className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                    href={`/projects/${props.projectId}/analyzing`}
                  >
                    {PRODUCT_COPY.viewDetectResult}
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
