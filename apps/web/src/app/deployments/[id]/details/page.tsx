'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { PlanFeatureHint } from '@/components/plan-feature-hint';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_TYPE_LABELS,
  artifactName,
  DEPLOYMENT_STATUS_LABELS,
  DEPLOYMENT_STEP_STATUS_LABELS,
  DIAGNOSIS_CATEGORY_LABELS,
  DIAGNOSIS_SEVERITY_LABELS,
  formatBytes,
  formatDateTime,
  formatDuration,
  REMOTE_DEPLOY_STAGES,
  REMOTE_DEPLOYMENT_STATUS_LABELS,
  remoteDeployStage,
  statusBadgeClass,
} from '@/lib/project-labels';
import { writeClipboard } from '@/lib/clipboard';
import { PRODUCT_COPY } from '@/lib/product-language';
import type {
  Artifact,
  DeploymentDetail,
  DeploymentDiagnosis,
  DeploymentLog,
  RemoteStatusResponse,
} from '@/lib/types';

type AdvancedLogsPayload = {
  ssh: DeploymentLog[];
  upload: DeploymentLog[];
  deploy: DeploymentLog[];
  other: DeploymentLog[];
  routing?: {
    systemDomain: string | null;
    gatewayStatus: string | null;
    dnsStatus: string | null;
    sslStatus: string | null;
    targetServer: string | null;
    targetPort: number | null;
    serviceStatus: string | null;
    routeReady: boolean;
  } | null;
};

export default function DeploymentDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [diagnosis, setDiagnosis] = useState<DeploymentDiagnosis | null>(null);
  const [remote, setRemote] = useState<RemoteStatusResponse | null>(null);
  const [advancedLogs, setAdvancedLogs] = useState<AdvancedLogsPayload | null>(null);
  const [copied, setCopied] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [detail, artifactList, diagnosisPayload, remotePayload, advanced] = await Promise.all([
          api<DeploymentDetail>(`/deployments/${params.id}`),
          api<Artifact[]>(`/deployments/${params.id}/artifacts`).catch(() => []),
          api<{ diagnosis: DeploymentDiagnosis | null }>(`/deployments/${params.id}/diagnosis`).catch(
            () => ({ diagnosis: null }),
          ),
          api<RemoteStatusResponse>(`/deployments/${params.id}/remote-status`).catch(() => ({
            remoteDeployment: null,
            publicUrl: null,
          })),
          api<AdvancedLogsPayload>(`/deployments/${params.id}/advanced-logs`).catch(() => null),
        ]);
        if (!cancelled) {
          setDeployment(detail);
          setArtifacts(artifactList);
          setDiagnosis(diagnosisPayload.diagnosis);
          setRemote(remotePayload);
          setAdvancedLogs(advanced);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        if (err instanceof Error && err.message === 'Deployment not found') {
          setError(err.message);
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
    if (!deployment) {
      return;
    }

    const remoteStatus = remote?.remoteDeployment?.status;
    const shouldPoll =
      ACTIVE_DEPLOYMENT_STATUSES.includes(deployment.status) ||
      remoteStatus === 'PENDING' ||
      remoteStatus === 'CONNECTING' ||
      remoteStatus === 'DEPLOYING' ||
      (deployment.status === 'FAILED' && !diagnosis);
    if (!shouldPoll) {
      return;
    }

    const timer = window.setInterval(() => {
      void api<DeploymentDetail>(`/deployments/${params.id}`)
        .then(setDeployment)
        .catch(() => undefined);
      void api<Artifact[]>(`/deployments/${params.id}/artifacts`)
        .then(setArtifacts)
        .catch(() => undefined);
      void api<{ diagnosis: DeploymentDiagnosis | null }>(`/deployments/${params.id}/diagnosis`)
        .then((payload) => setDiagnosis(payload.diagnosis))
        .catch(() => undefined);
      void api<RemoteStatusResponse>(`/deployments/${params.id}/remote-status`)
        .then(setRemote)
        .catch(() => undefined);
    }, 1500);

    return () => {
      window.clearInterval(timer);
    };
  }, [deployment, diagnosis, params.id, remote]);

  async function copyFixPrompt(): Promise<void> {
    if (!diagnosis) {
      return;
    }
    try {
      await writeClipboard(diagnosis.fixPrompt);
      setError(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('复制失败');
    }
  }

  async function startCloudDeploy(): Promise<void> {
    setCloudBusy(true);
    try {
      const payload = await api<RemoteStatusResponse>(`/deployments/${params.id}/cloud-deploy`, {
        method: 'POST',
      });
      setRemote(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '云上部署失败');
    } finally {
      setCloudBusy(false);
    }
  }

  if (!deployment) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <nav className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
            <Link className="hover:text-zinc-800" href={`/projects/${deployment.projectId}`}>
              ← 返回应用
            </Link>
            <span>·</span>
            <Link className="hover:text-zinc-800" href={`/deployments/${deployment.id}`}>
              上线进度
            </Link>
          </nav>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">技术日志</h1>
          <p className="mt-2 text-sm text-zinc-600">
            这里包含给开发人员排查问题使用的详细信息。
          </p>
          <Link
            className="mt-3 inline-flex rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700"
            href={`/deployments/${deployment.id}`}
          >
            返回问题说明
          </Link>
          <div className="mt-4"><PlanFeatureHint feature="advancedLogs" /></div>
          <p className="mt-1 text-sm text-zinc-500">
            {deployment.environment.name} · {formatDateTime(deployment.createdAt)}
            {deployment.version ? ` · ${deployment.version}` : ''}
          </p>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-500">上线状态</h2>
            <span className={`rounded-full px-2.5 py-1 text-xs ${statusBadgeClass(deployment.status)}`}>
              {DEPLOYMENT_STATUS_LABELS[deployment.status]}
            </span>
          </div>
          <dl className="mt-3 space-y-2 text-sm text-zinc-700">
            <div>
              <dt className="text-zinc-500">开始时间</dt>
              <dd>{deployment.startedAt ? formatDateTime(deployment.startedAt) : '-'}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">结束时间</dt>
              <dd>{deployment.finishedAt ? formatDateTime(deployment.finishedAt) : '-'}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">当前执行次数</dt>
              <dd>{deployment.retryCount}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">最大重试次数</dt>
              <dd>{deployment.maxRetry}</dd>
            </div>
            {deployment.errorMessage ? (
              <div>
                <dt className="text-zinc-500">错误</dt>
                <dd className="text-red-600">{deployment.errorMessage}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-zinc-500">上线方式</dt>
              <dd>
                {deployment.runtime?.mode === 'remote' || deployment.serverInstanceId
                  ? '我的服务器'
                  : 'LaunchOS 自动托管'}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">运行位置</dt>
              <dd>{deployment.runtime?.serverName || deployment.serverInstance?.name || 'LaunchOS 自动托管'}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">应用状态</dt>
              <dd>{deployment.runtime?.containerStatus || '-'}</dd>
            </div>
          </dl>
        </section>

        {advancedLogs?.routing ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-6">
            <h2 className="text-sm font-medium text-zinc-500">Gateway 路由</h2>
            <dl className="mt-3 space-y-2 text-sm text-zinc-700">
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">系统域名</dt>
                <dd>{advancedLogs.routing.systemDomain || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">Gateway 状态</dt>
                <dd>{advancedLogs.routing.gatewayStatus || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">DNS 状态</dt>
                <dd>{advancedLogs.routing.dnsStatus || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">SSL 状态</dt>
                <dd>{advancedLogs.routing.sslStatus || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">目标服务器</dt>
                <dd>{advancedLogs.routing.targetServer || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">目标端口</dt>
                <dd>{advancedLogs.routing.targetPort ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">路由状态</dt>
                <dd>{advancedLogs.routing.routeReady ? '可路由' : '不可路由'}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-zinc-500">AI Diagnosis</h2>
            {diagnosis ? (
              <button
                className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700"
                type="button"
                onClick={() => void copyFixPrompt()}
              >
                {copied ? '已复制' : '复制 Fix Prompt'}
              </button>
            ) : null}
          </div>
          {!diagnosis ? (
            <p className="mt-3 text-sm text-zinc-500">
              {deployment.status === 'FAILED' ? '正在生成诊断…' : '部署失败后会在这里显示 AI 诊断。'}
            </p>
          ) : (
            <dl className="mt-3 space-y-2 text-sm text-zinc-700">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-zinc-500">分类</dt>
                <dd>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClass(diagnosis.severity)}`}>
                    {DIAGNOSIS_SEVERITY_LABELS[diagnosis.severity]}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">错误原因</dt>
                <dd>
                  {DIAGNOSIS_CATEGORY_LABELS[diagnosis.category]} · {diagnosis.title}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">说明</dt>
                <dd>{diagnosis.description}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">解决建议</dt>
                <dd>{diagnosis.solution}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Fix Prompt</dt>
                <dd>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 px-3 py-3 text-xs text-zinc-100">
                    {diagnosis.fixPrompt}
                  </pre>
                </dd>
              </div>
            </dl>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">步骤状态</h2>
          <ol className="mt-3 space-y-2">
            {deployment.steps.map((step) => (
              <li key={step.id} className="rounded-xl border border-zinc-100 px-4 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-zinc-900">
                    {step.order}. {step.name}
                  </p>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClass(step.status)}`}>
                    {DEPLOYMENT_STEP_STATUS_LABELS[step.status]}
                  </span>
                </div>
                <p className="mt-1 text-zinc-500">{step.stepKey}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">{PRODUCT_COPY.advancedRemoteLogs}</h2>
          <p className="mt-1 text-xs text-zinc-500">普通用户可忽略，这里保留连接、上传与部署排查信息。</p>
          <div className="mt-4 space-y-4">
            <AdvancedLogBlock title={PRODUCT_COPY.sshLogs} items={advancedLogs?.ssh ?? []} />
            <AdvancedLogBlock title={PRODUCT_COPY.uploadLogs} items={advancedLogs?.upload ?? []} />
            <AdvancedLogBlock title={PRODUCT_COPY.deployLogs} items={advancedLogs?.deploy ?? []} />
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">Artifact</h2>
          {artifacts.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">暂无制品</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {artifacts.map((artifact) => (
                <li key={artifact.id} className="rounded-xl border border-zinc-100 px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-zinc-900">{artifactName(artifact.storagePath)}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClass(artifact.status)}`}>
                      {ARTIFACT_STATUS_LABELS[artifact.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-zinc-500">{ARTIFACT_TYPE_LABELS[artifact.type]}</p>
                  <p className="text-zinc-500">大小：{formatBytes(artifact.size)}</p>
                  <p className="text-zinc-500">状态：{artifact.status}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-zinc-500">Cloud Deployment</h2>
            <div className="flex items-center gap-2">
              {remote?.remoteDeployment ? (
                <span
                  className={`rounded-full px-2.5 py-1 text-xs ${statusBadgeClass(remote.remoteDeployment.status)}`}
                >
                  {REMOTE_DEPLOYMENT_STATUS_LABELS[remote.remoteDeployment.status]}
                </span>
              ) : null}
              <button
                className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-50"
                type="button"
                disabled={
                  cloudBusy ||
                  remote?.remoteDeployment?.status === 'PENDING' ||
                  remote?.remoteDeployment?.status === 'CONNECTING' ||
                  remote?.remoteDeployment?.status === 'DEPLOYING'
                }
                onClick={() => void startCloudDeploy()}
              >
                {cloudBusy ? '提交中…' : '部署到云服务器'}
              </button>
            </div>
          </div>
          <ol className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">
            {REMOTE_DEPLOY_STAGES.map((item) => {
              const current = remoteDeployStage(
                remote?.remoteDeployment?.status,
                remote?.remoteDeployment?.logs ?? '',
              );
              const order = REMOTE_DEPLOY_STAGES.map((stage) => stage.key);
              const currentIndex = current === 'idle' ? -1 : order.indexOf(current);
              const itemIndex = order.indexOf(item.key);
              const failed = remote?.remoteDeployment?.status === 'FAILED';
              const done = current === 'run' || itemIndex < currentIndex;
              const active = current !== 'run' && itemIndex === currentIndex;
              return (
                <li
                  key={item.key}
                  className={`rounded-xl border px-2 py-3 ${
                    failed && active
                      ? 'border-red-200 bg-red-50 text-red-700'
                      : active
                        ? 'border-blue-200 bg-blue-50 text-blue-700'
                        : done
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-zinc-100 bg-zinc-50 text-zinc-500'
                  }`}
                >
                  {item.label}
                </li>
              );
            })}
          </ol>
          {remote?.publicUrl ? (
            <p className="mt-3 text-sm text-zinc-700">
              公网访问：
              <a className="text-blue-700 underline" href={remote.publicUrl} target="_blank" rel="noreferrer">
                {remote.publicUrl}
              </a>
            </p>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">
              {remote?.remoteDeployment
                ? '正在同步云上部署状态…'
                : '有 RUNNING 的 ECS 后，可将 Artifact 部署到云服务器。'}
            </p>
          )}
          {remote?.remoteDeployment?.logs ? (
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 px-3 py-3 text-xs text-zinc-100">
              {remote.remoteDeployment.logs}
            </pre>
          ) : null}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">Build Logs</h2>
          {deployment.steps.filter((step) => step.stepKey === 'BUILD_APPLICATION').length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">暂无构建日志</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {deployment.steps
                .filter((step) => step.stepKey === 'BUILD_APPLICATION')
                .map((step) => {
                  const output = deployment.logs
                    .filter((log) => log.stepId === step.id)
                    .map((log) => log.message)
                    .join('\n\n');
                  return (
                    <li key={step.id} className="rounded-xl border border-zinc-100 px-4 py-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-zinc-900">{step.command ?? 'npm install && npm run build'}</p>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClass(step.status)}`}>
                          {DEPLOYMENT_STEP_STATUS_LABELS[step.status]}
                        </span>
                      </div>
                      <p className="mt-2 text-zinc-500">执行时间：{formatDuration(step.duration)}</p>
                      {step.exitCode != null ? (
                        <p className="text-zinc-500">exitCode：{step.exitCode}</p>
                      ) : null}
                      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 px-3 py-3 text-xs text-zinc-100">
                        {output || '等待输出…'}
                      </pre>
                    </li>
                  );
                })}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">日志</h2>
          {deployment.logs.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">暂无日志</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {deployment.logs.map((log) => (
                <li key={log.id} className="rounded-xl bg-zinc-50 px-4 py-3 text-zinc-700">
                  <p>{log.message}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {log.level} · {formatDateTime(log.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function AdvancedLogBlock(props: { title: string; items: DeploymentLog[] }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-zinc-700">{props.title}</h3>
      {props.items.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">暂无记录</p>
      ) : (
        <ul className="mt-2 space-y-2 text-sm">
          {props.items.map((log) => (
            <li key={log.id} className="rounded-xl bg-zinc-50 px-4 py-3 text-zinc-700">
              <p className="whitespace-pre-wrap">{log.message}</p>
              <p className="mt-1 text-xs text-zinc-500">{formatDateTime(log.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
