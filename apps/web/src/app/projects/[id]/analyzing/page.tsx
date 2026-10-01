'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { canLaunchProject } from '@/lib/launch-readiness';
import { PRODUCT_COPY } from '@/lib/product-language';
import { APPLICATION_PURPOSE_LABELS } from '@/lib/project-labels';
import { goLivePath } from '@/lib/start-deploy';
import {
  DEPLOYABLE_UNIT_TYPE_LABELS,
  FRAMEWORK_LABELS,
  isLaunchableUnit,
  isMobileAnalysisFramework,
  type CodeAnalysisResponse,
  type CodeAnalysisResult,
  type DeployableUnitPublic,
  type ProjectDetail,
} from '@/lib/types';

const PROGRESS_STEPS = [
  PRODUCT_COPY.analyzingReadingCode,
  PRODUCT_COPY.analyzingDetectTech,
  PRODUCT_COPY.analyzingConfirmStart,
  PRODUCT_COPY.analyzingPrepareConfig,
] as const;

export default function AnalyzingPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [payload, setPayload] = useState<CodeAnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressIndex, setProgressIndex] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(() => {
      setProgressIndex((current) => Math.min(current + 1, PROGRESS_STEPS.length - 1));
    }, 900);

    async function run(): Promise<void> {
      try {
        const detail = await api<ProjectDetail>(`/projects/${params.id}`);
        if (cancelled) {
          return;
        }
        setProject(detail);
        if (detail.sources.length === 0) {
          setError(PRODUCT_COPY.connectCodeFirst);
          return;
        }

        const result = await api<CodeAnalysisResponse>(`/projects/${params.id}/code-analysis`, {
          method: 'POST',
        });
        if (!cancelled) {
          setPayload(result);
          setProgressIndex(PROGRESS_STEPS.length - 1);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '检测失败');
        }
      } finally {
        window.clearInterval(timer);
      }
    }

    void run();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [params.id, router]);

  const result = payload?.result ?? null;
  const units = (payload?.units ?? result?.units ?? []).filter(Boolean) as DeployableUnitPublic[];
  const done = Boolean(payload);
  const multi = units.length > 1;
  const single = units.length === 1 ? units[0]! : null;
  const mobile = single
    ? !single.deployable && isMobileAnalysisFramework(single.framework)
    : isMobileAnalysisFramework(result?.framework);
  const canLaunchSimple =
    done &&
    !multi &&
    canLaunchProject({
      hasSource: (project?.sources.length ?? 0) > 0,
      units,
      framework: result?.framework ?? project?.framework,
      analysisSkipped: Boolean(payload?.skipped),
    });
  const purpose = project?.applicationPurpose;
  const purposeLabel = purpose
    ? APPLICATION_PURPOSE_LABELS[purpose]
    : PRODUCT_COPY.purposeUnset;

  async function selectUnit(unit: DeployableUnitPublic): Promise<void> {
    if (!unit.deployable) {
      return;
    }
    setSelectingId(unit.id);
    setError(null);
    try {
      await api(`/projects/${params.id}/deployable-units/${unit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ select: true, status: 'CONFIRMED' }),
      });
      router.push(goLivePath(params.id, unit.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '选择失败');
      setSelectingId(null);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-8 sm:px-6 sm:py-10">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={`/projects/${params.id}`}>
            ← 返回应用
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">
            {done ? PRODUCT_COPY.analyzingDone : PRODUCT_COPY.analyzingTitle}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">{project?.name ?? '正在准备…'}</p>
        </div>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          {!done && !error ? (
            <ul className="space-y-2 text-sm text-zinc-700">
              {PROGRESS_STEPS.map((label, index) => (
                <li
                  key={label}
                  className={index <= progressIndex ? 'text-zinc-900' : 'text-zinc-400'}
                >
                  {index < progressIndex ? '✓ ' : index === progressIndex ? '… ' : '○ '}
                  {label}
                </li>
              ))}
            </ul>
          ) : null}

          {payload?.skipped ? (
            <div className="space-y-2 text-sm text-zinc-700">
              <p className="font-medium text-emerald-700">{PRODUCT_COPY.analyzingDone}</p>
              <p className="text-zinc-500">{PRODUCT_COPY.analyzingSubtitle}</p>
              <p>{PRODUCT_COPY.demoAnalysisSkip}</p>
              <PurposeBlock label={purposeLabel} />
            </div>
          ) : null}

          {result && !payload?.skipped ? (
            multi ? (
              <MultiUnitSummary
                units={units}
                purposeLabel={purposeLabel}
                selectingId={selectingId}
                showAdvanced={showAdvanced}
                onToggleAdvanced={() => setShowAdvanced((v) => !v)}
                onSelect={(unit) => void selectUnit(unit)}
                result={result}
              />
            ) : (
              <AnalysisSummary
                result={result}
                unit={single}
                purposeLabel={purposeLabel}
                showAdvanced={showAdvanced}
                onToggleAdvanced={() => setShowAdvanced((v) => !v)}
              />
            )
          ) : null}
        </section>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {done && !multi ? (
          <div className="flex flex-wrap gap-2">
            {canLaunchSimple && !mobile ? (
              <Link
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
                href={goLivePath(params.id, single?.id)}
              >
                {PRODUCT_COPY.goLiveNow}
              </Link>
            ) : null}
            <Link
              className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
              href={`/projects/${params.id}`}
            >
              {PRODUCT_COPY.goLiveLater}
            </Link>
          </div>
        ) : null}

        {done && multi ? (
          <Link
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
            href={`/projects/${params.id}`}
          >
            {PRODUCT_COPY.goLiveLater}
          </Link>
        ) : null}
      </div>
    </main>
  );
}

function PurposeBlock(props: { label: string }) {
  return (
    <div className="mt-4 rounded-xl bg-zinc-50 px-4 py-3">
      <p className="text-sm text-zinc-500">{PRODUCT_COPY.appPurpose}</p>
      <p className="mt-1 text-base font-medium text-zinc-900">{props.label}</p>
    </div>
  );
}

function frameworkLabel(framework: string | null | undefined): string {
  if (!framework) {
    return '—';
  }
  return FRAMEWORK_LABELS[framework as keyof typeof FRAMEWORK_LABELS] ?? framework;
}

function MultiUnitSummary(props: {
  units: DeployableUnitPublic[];
  purposeLabel: string;
  selectingId: string | null;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  onSelect: (unit: DeployableUnitPublic) => void;
  result: CodeAnalysisResult;
}) {
  return (
    <div className="space-y-4 text-sm text-zinc-700">
      <div>
        <p className="font-medium text-emerald-700">{PRODUCT_COPY.analyzingDone}</p>
        <p className="mt-1 font-medium text-zinc-900">{PRODUCT_COPY.multiTargetTitle}</p>
        <p className="mt-1 text-xs text-zinc-500">{PRODUCT_COPY.multiTargetHint}</p>
      </div>
      <PurposeBlock label={props.purposeLabel} />
      <ul className="space-y-3">
        {props.units.map((unit) => {
          const launchable = isLaunchableUnit(unit);
          return (
            <li
              key={unit.id}
              className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"
            >
              <p className="font-medium text-zinc-900">{unit.name}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {DEPLOYABLE_UNIT_TYPE_LABELS[unit.type] ?? unit.type}
                {' · '}
                {frameworkLabel(unit.framework)}
              </p>
              <p className="mt-2 text-sm">
                {launchable
                  ? PRODUCT_COPY.multiTargetCanLaunch
                  : PRODUCT_COPY.multiTargetNotSupported}
              </p>
              {launchable ? (
                <button
                  className="mt-3 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-60"
                  type="button"
                  disabled={props.selectingId === unit.id}
                  onClick={() => props.onSelect(unit)}
                >
                  {props.selectingId === unit.id
                    ? PRODUCT_COPY.goingLive
                    : PRODUCT_COPY.multiTargetSelect}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button
        className="text-sm text-zinc-500 underline"
        type="button"
        onClick={props.onToggleAdvanced}
      >
        {props.showAdvanced ? PRODUCT_COPY.hideTechDetails : PRODUCT_COPY.techDetails}
      </button>
      {props.showAdvanced ? (
        <pre className="overflow-auto rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
          {JSON.stringify(props.result, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function AnalysisSummary(props: {
  result: CodeAnalysisResult;
  unit: DeployableUnitPublic | null;
  purposeLabel: string;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
}) {
  const { result, purposeLabel, unit } = props;
  const framework = unit?.framework ?? result.framework;
  const mobile = isMobileAnalysisFramework(framework);

  if (mobile) {
    return (
      <div className="space-y-3 text-sm text-zinc-700">
        <p className="font-medium text-emerald-700">{PRODUCT_COPY.analyzingDone}</p>
        <div>
          <p className="text-zinc-500">{PRODUCT_COPY.techType}</p>
          <p className="mt-1 font-medium text-zinc-900">
            {unit?.name || PRODUCT_COPY.iosAppType}
          </p>
          <p className="mt-1 text-xs text-zinc-500">{frameworkLabel(framework)}</p>
        </div>
        <p className="font-medium text-amber-800">{PRODUCT_COPY.iosUnsupportedTitle}</p>
        <p className="whitespace-pre-line text-zinc-600">{PRODUCT_COPY.iosUnsupportedBody}</p>
        <PurposeBlock label={purposeLabel} />
        <button
          className="text-sm text-zinc-500 underline"
          type="button"
          onClick={props.onToggleAdvanced}
        >
          {props.showAdvanced ? PRODUCT_COPY.hideTechDetails : PRODUCT_COPY.techDetails}
        </button>
        {props.showAdvanced ? (
          <pre className="overflow-auto rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
            {JSON.stringify(result, null, 2)}
          </pre>
        ) : null}
      </div>
    );
  }

  if (framework === 'UNSUPPORTED' || (unit && !unit.deployable)) {
    return (
      <div className="space-y-3 text-sm text-zinc-700">
        <p className="font-medium text-amber-800">{PRODUCT_COPY.unsupportedProject}</p>
        <p className="text-zinc-600">{PRODUCT_COPY.unsupportedProjectHint}</p>
        <p className="text-zinc-600">{PRODUCT_COPY.unsupportedCannotLaunch}</p>
        <PurposeBlock label={purposeLabel} />
        <button
          className="text-sm text-zinc-500 underline"
          type="button"
          onClick={props.onToggleAdvanced}
        >
          {props.showAdvanced ? PRODUCT_COPY.hideTechDetails : PRODUCT_COPY.techDetails}
        </button>
        {props.showAdvanced ? (
          <pre className="overflow-auto rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
            {JSON.stringify(result, null, 2)}
          </pre>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm text-zinc-700">
      <div>
        <p className="font-medium text-emerald-700">{PRODUCT_COPY.analyzingDone}</p>
        <p className="mt-1 text-zinc-500">{PRODUCT_COPY.analyzingSubtitle}</p>
      </div>

      <PurposeBlock label={purposeLabel} />

      <div>
        <p className="text-zinc-500">项目类型</p>
        <p className="mt-1 font-medium text-zinc-900">
          {unit?.name || frameworkLabel(framework)}
        </p>
      </div>
      <div>
        <p className="text-zinc-500">推荐运行环境</p>
        <p className="mt-1 font-medium text-zinc-900">已自动选择</p>
      </div>
      <div>
        <p className="text-zinc-500">{PRODUCT_COPY.startMethod}</p>
        <p className="mt-1 font-medium text-zinc-900">已自动配置</p>
      </div>

      <button
        className="text-sm text-zinc-500 underline"
        type="button"
        onClick={props.onToggleAdvanced}
      >
        {props.showAdvanced ? PRODUCT_COPY.hideTechDetails : PRODUCT_COPY.techDetails}
      </button>
      {props.showAdvanced ? (
        <dl className="space-y-2 rounded-xl bg-zinc-50 px-4 py-3 text-xs text-zinc-600">
          <div className="flex justify-between gap-3">
            <dt>安装依赖</dt>
            <dd className="font-mono">{result.installCommand ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>构建命令</dt>
            <dd className="font-mono">{unit?.buildCommand ?? result.buildCommand ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>启动命令</dt>
            <dd className="font-mono">{unit?.startCommand ?? result.startCommand ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>端口</dt>
            <dd>{unit?.port ?? result.port ?? '—'}</dd>
          </div>
          {unit ? (
            <div className="flex justify-between gap-3">
              <dt>代码目录</dt>
              <dd>{unit.rootPath}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
