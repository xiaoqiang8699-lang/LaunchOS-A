import { Injectable } from '@nestjs/common';
import {
  ACTIVATION_STAGE_BASE_SCORE,
  ONBOARDING_THRESHOLDS,
  STAGE_LABELS,
  stageRank,
} from './onboarding-thresholds';

export type ScoreResult = {
  score: number;
  stage: string;
  status: string;
  blockers: Array<{ category: string; title: string; detail?: string }>;
  recommendedNextAction: {
    title: string;
    href: string | null;
    reason: string;
  };
  explanation: string[];
};

@Injectable()
export class UserActivationScoreService {
  calculateFromFacts(facts: {
    stage: string;
    status: string;
    primaryBlocker?: string | null;
    blockerCategory?: string | null;
    failedDeployCount?: number;
    hoursSinceProgress?: number | null;
    missingRequiredConfig?: boolean;
    preflightHigh?: boolean;
    projectId?: string | null;
  }): ScoreResult {
    const explanation: string[] = [];
    let score = ACTIVATION_STAGE_BASE_SCORE[facts.stage] ?? 10;
    explanation.push(`阶段「${STAGE_LABELS[facts.stage] || facts.stage}」基础分 ${score}`);

    const blockers: ScoreResult['blockers'] = [];
    if (facts.missingRequiredConfig) {
      blockers.push({ category: 'CONFIG', title: '缺少运行配置', detail: '必填环境变量未完成' });
      score = Math.max(0, score - 8);
      explanation.push('必填配置缺失 −8');
    }
    if (facts.preflightHigh) {
      blockers.push({ category: 'PREFLIGHT', title: '预检高风险', detail: '存在 HIGH 预检项未解决' });
      score = Math.max(0, score - 10);
      explanation.push('预检 HIGH −10');
    }
    if ((facts.failedDeployCount || 0) >= ONBOARDING_THRESHOLDS.consecutiveFailuresForBlocked) {
      blockers.push({
        category: 'BUILD',
        title: '连续部署失败',
        detail: `连续失败 ${facts.failedDeployCount} 次`,
      });
      score = Math.max(0, score - 12);
      explanation.push(`连续失败 ${facts.failedDeployCount} 次 −12`);
    }
    if (facts.primaryBlocker && blockers.length === 0) {
      blockers.push({
        category: facts.blockerCategory || 'UNKNOWN',
        title: facts.primaryBlocker,
      });
    }

    const hours = facts.hoursSinceProgress;
    if (hours != null && hours >= ONBOARDING_THRESHOLDS.hoursAfterProjectWithoutSource && stageRank(facts.stage) < stageRank('ACTIVATED')) {
      score = Math.max(0, score - Math.min(15, Math.floor(hours / 24) * 3));
      explanation.push(`停滞约 ${Math.floor(hours)} 小时风险扣分`);
    }

    if (facts.status === 'ACTIVATED' || facts.stage === 'ACTIVATED' || facts.stage === 'PUBLIC_ENTRY_READY') {
      score = 100;
      explanation.push('已达成首次公网上线，满分 100');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    const next = recommendNext(facts.stage, blockers[0]?.category, facts.projectId || null);

    return {
      score,
      stage: facts.stage,
      status: facts.status,
      blockers,
      recommendedNextAction: next,
      explanation,
    };
  }
}

function recommendNext(
  stage: string,
  blockerCategory: string | null | undefined,
  projectId: string | null,
): ScoreResult['recommendedNextAction'] {
  const p = projectId;
  if (blockerCategory === 'CONFIG' && p) {
    return { title: '完成运行配置', href: `/projects/${p}/config`, reason: '缺少运行配置' };
  }
  if (blockerCategory === 'PREFLIGHT' && p) {
    return { title: '查看预检', href: `/projects/${p}/deployments/preflight`, reason: '预检存在高风险项' };
  }
  if (blockerCategory === 'BUILD' && p) {
    return { title: '查看部署诊断', href: `/projects/${p}`, reason: '最近部署失败，可查看 AI 诊断' };
  }
  if (blockerCategory === 'DOMAIN' && p) {
    return { title: '查看公网访问', href: `/projects/${p}/domains`, reason: '公网入口尚未就绪' };
  }
  if (blockerCategory === 'RUNTIME' && p) {
    return { title: '查看运行状态', href: `/projects/${p}/runtime`, reason: '运行健康异常' };
  }

  switch (stage) {
    case 'REGISTERED':
    case 'WORKSPACE_READY':
      return { title: '创建应用', href: '/projects/new', reason: '尚未创建应用' };
    case 'PROJECT_CREATED':
      return { title: '继续连接代码', href: p ? `/projects/${p}` : '/projects', reason: '尚未连接代码源' };
    case 'SOURCE_CONNECTED':
    case 'ANALYSIS_COMPLETED':
      return { title: '完成运行配置', href: p ? `/projects/${p}/config` : '/projects', reason: '继续完善配置' };
    case 'CONFIG_COMPLETED':
      return { title: '查看预检', href: p ? `/projects/${p}/go-live` : '/projects', reason: '准备上线预检' };
    case 'PREFLIGHT_PASSED':
      return { title: '继续上线', href: p ? `/projects/${p}/go-live` : '/projects', reason: '可以发起首次部署' };
    case 'FIRST_DEPLOY_STARTED':
      return { title: '查看部署进度', href: p ? `/projects/${p}` : '/projects', reason: '首次部署进行中或失败' };
    case 'FIRST_DEPLOY_SUCCEEDED':
      return { title: '查看公网访问', href: p ? `/projects/${p}/domains` : '/projects', reason: '等待公网入口就绪' };
    default:
      return { title: '查看概览', href: '/overview', reason: '已完成首次上线价值路径' };
  }
}
