import { isLaunchableUnit, isMobileAnalysisFramework, isWebLaunchableFramework } from '@/lib/types';

type LaunchUnit = {
  deployable?: boolean;
  framework?: string | null;
  canLaunch?: boolean;
};

function unitCanLaunch(unit: LaunchUnit): boolean {
  if (isMobileAnalysisFramework(unit.framework)) {
    return false;
  }
  if (typeof unit.canLaunch === 'boolean') {
    return unit.canLaunch;
  }
  return isLaunchableUnit({
    deployable: Boolean(unit.deployable),
    framework: unit.framework ?? null,
  });
}

/**
 * 检测页和详情页共用的“能否上线”结论。
 * 有可上线单元，或已有可上线的分析结果时为 true。
 * 已连接代码、但还没有单元、也没有“无法识别”的分析结果时，视为可以直接上线。
 */
export function canLaunchProject(input: {
  hasSource: boolean;
  units: LaunchUnit[];
  framework?: string | null;
  analysisFramework?: string | null;
  analysisSkipped?: boolean;
}): boolean {
  if (!input.hasSource && !input.analysisSkipped) {
    return false;
  }
  if (input.units.length > 0) {
    return input.units.some(unitCanLaunch);
  }
  if (input.analysisSkipped) {
    return true;
  }
  const framework = input.analysisFramework || input.framework || null;
  if (!framework) {
    return input.hasSource;
  }
  if (framework === 'UNSUPPORTED' || isMobileAnalysisFramework(framework)) {
    return false;
  }
  return isWebLaunchableFramework(framework);
}
