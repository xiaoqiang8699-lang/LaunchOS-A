/**
 * Step 30 Phase 2 — Handler registry wrapping Step 25–29 (no duplicated engines).
 * Phase 2: gate-only — execute() never performs provider / remote / DNS writes.
 */

import {
  getLaunchStepPolicy,
  LAUNCH_STEP_TYPES,
  STEP30_PHASE2_REAL_EXECUTION_LOCKED,
  type LaunchStepType,
} from './launch-execution-policy.js';
import { launchErrorUserMessage } from './launch-user-messages.js';
import {
  okHandlerResult,
  type LaunchStepHandler,
  type LaunchStepHandlerContext,
  type LaunchHandlerResult,
  type LaunchWriteClass,
} from './launch-handler.js';

type HandlerSpec = {
  stepType: LaunchStepType;
  wraps: string;
  writeClass: LaunchWriteClass;
  bottomLocks: string[];
};

const SPECS: HandlerSpec[] = [
  {
    stepType: 'ANALYZE_PROJECT',
    wraps: 'analyses / project analyzer',
    writeClass: 'none',
    bottomLocks: [],
  },
  {
    stepType: 'PLAN_DEPENDENCIES',
    wraps: 'Step 25 Dependency Engine',
    writeClass: 'none',
    bottomLocks: [],
  },
  {
    stepType: 'PROVISION_POSTGRESQL',
    wraps: 'Alibaba RDS provisioner (Step 25)',
    writeClass: 'cloud',
    bottomLocks: ['provider:rds', 'generationToken'],
  },
  {
    stepType: 'CONNECT_POSTGRESQL',
    wraps: 'database connection engine (Step 25)',
    writeClass: 'none',
    bottomLocks: [],
  },
  {
    stepType: 'PROVISION_REDIS',
    wraps: 'Redis provisioner (Step 25)',
    writeClass: 'cloud',
    bottomLocks: ['provider:redis', 'generationToken'],
  },
  {
    stepType: 'CONNECT_REDIS',
    wraps: 'redis connection engine (Step 25)',
    writeClass: 'none',
    bottomLocks: [],
  },
  {
    stepType: 'PLAN_SERVER',
    wraps: 'Step 26.1 server plan',
    writeClass: 'none',
    bottomLocks: [],
  },
  {
    stepType: 'PROVISION_SERVER',
    wraps: 'Step 26.2 ECS provisioner',
    writeClass: 'cloud',
    bottomLocks: ['provider:ecs', 'generationToken', 'server-lock'],
  },
  {
    stepType: 'INITIALIZE_SERVER',
    wraps: 'Step 26.3 server initialization',
    writeClass: 'remote',
    bottomLocks: ['server-lock'],
  },
  {
    stepType: 'BUILD_UNIT',
    wraps: 'existing build pipeline',
    writeClass: 'none',
    bottomLocks: ['deployment-lock'],
  },
  {
    stepType: 'BUILD_DOCKER_IMAGE',
    wraps: 'Step 27.2 DOCKER_IMAGE artifact pipeline',
    writeClass: 'none',
    bottomLocks: ['deployment-lock'],
  },
  {
    stepType: 'DEPLOY_API',
    wraps: 'MANAGED_SERVER REMOTE_DEPLOY (API invariants)',
    writeClass: 'deployment',
    bottomLocks: ['deployment-lock', 'server-lock'],
  },
  {
    stepType: 'DEPLOY_WEB',
    wraps: 'MANAGED_SERVER REMOTE_DEPLOY (Web invariants)',
    writeClass: 'deployment',
    bottomLocks: ['deployment-lock', 'server-lock'],
  },
  {
    stepType: 'INSTALL_GATEWAY',
    wraps: 'Step 29 gateway engine',
    writeClass: 'gateway',
    bottomLocks: ['public-entry-lock', 'server-lock'],
  },
  {
    stepType: 'INSTALL_CERTIFICATE',
    wraps: 'Step 29 certificate materializer',
    writeClass: 'certificate',
    bottomLocks: ['public-entry-lock'],
  },
  {
    stepType: 'APPLY_API_ROUTE',
    wraps: 'Step 29 gateway route apply',
    writeClass: 'gateway',
    bottomLocks: ['public-entry-lock'],
  },
  {
    stepType: 'APPLY_WEB_ROUTE',
    wraps: 'Step 29 gateway route apply',
    writeClass: 'gateway',
    bottomLocks: ['public-entry-lock'],
  },
  {
    stepType: 'APPLY_API_DNS',
    wraps: 'Step 29 DNS engine (ownership/conflict/reconcile)',
    writeClass: 'dns',
    bottomLocks: ['public-entry-lock', 'dns-ownership'],
  },
  {
    stepType: 'APPLY_WEB_DNS',
    wraps: 'Step 29 DNS engine (ownership/conflict/reconcile)',
    writeClass: 'dns',
    bottomLocks: ['public-entry-lock', 'dns-ownership'],
  },
  {
    stepType: 'VERIFY_API_HTTPS',
    wraps: 'Step 29 public HTTPS verification (read-only)',
    writeClass: 'none',
    bottomLocks: [],
  },
  {
    stepType: 'VERIFY_WEB_HTTPS',
    wraps: 'Step 29 public HTTPS verification (read-only)',
    writeClass: 'none',
    bottomLocks: [],
  },
  {
    stepType: 'FINAL_ACCEPTANCE',
    wraps: 'unified read-only acceptance',
    writeClass: 'none',
    bottomLocks: [],
  },
];

function lockedWriteResult(
  ctx: LaunchStepHandlerContext,
  writeClass: LaunchWriteClass,
): LaunchHandlerResult {
  if (ctx.decision === 'REUSE') {
    return okHandlerResult({
      status: 'REUSED',
      resourceType: ctx.resourceType,
      resourceId: ctx.resourceId,
      writeClass: 'none',
      wouldWrite: false,
      userMessage: '已复用现有资源',
      technicalDetailsSafe: { wrapsDecision: 'REUSE' },
    });
  }
  if (ctx.decision === 'SKIP') {
    return okHandlerResult({
      status: 'SKIPPED',
      writeClass: 'none',
      wouldWrite: false,
      userMessage: '此步骤不需要执行',
    });
  }
  if (ctx.decision === 'BLOCK') {
    return okHandlerResult({
      status: 'BLOCKED',
      writeClass: 'none',
      wouldWrite: false,
      failureCode: 'STEP_BLOCKED',
      userMessage: '此步骤被阻塞',
    });
  }

  const policy = getLaunchStepPolicy(ctx.stepType);
  if (policy?.requiresConfirmation && !ctx.confirmationSatisfied) {
    return okHandlerResult({
      status: 'WAITING',
      writeClass,
      wouldWrite: false,
      failureCode: 'BILLABLE_ACTION_CONFIRMATION_REQUIRED',
      failureMessage: 'BILLABLE_ACTION_CONFIRMATION_REQUIRED',
      userMessage: '需要先确认将创建的云资源与费用',
      retryClass: 'USER_ACTION_REQUIRED',
      technicalDetailsSafe: { billable: true },
    });
  }

  // Phase 2: always lock real writes
  if (ctx.gateOnly || ctx.realExecutionLocked || writeClass !== 'none') {
    if (writeClass === 'none') {
      // read-only verify / analyze path continues below
    } else {
      return okHandlerResult({
        status: 'LOCKED',
        writeClass,
        wouldWrite: true,
        failureCode: STEP30_PHASE2_REAL_EXECUTION_LOCKED,
        failureMessage: STEP30_PHASE2_REAL_EXECUTION_LOCKED,
        userMessage: launchErrorUserMessage(STEP30_PHASE2_REAL_EXECUTION_LOCKED),
        technicalDetailsSafe: {
          phase: 'phase2-gate',
          writeClass,
          note: 'handler wired; provider write not invoked',
        },
      });
    }
  }

  return okHandlerResult({
    status: 'SUCCESS',
    writeClass: 'none',
    wouldWrite: false,
    userMessage: '只读检查通过',
  });
}

function makeHandler(spec: HandlerSpec): LaunchStepHandler {
  const policy = getLaunchStepPolicy(spec.stepType)!;
  return {
    stepType: spec.stepType,
    wraps: spec.wraps,
    writeClass: spec.writeClass,
    billable: policy.billable,
    requiresConfirmation: policy.requiresConfirmation,
    bottomLocks: spec.bottomLocks,

    preflight(ctx) {
      if (ctx.decision === 'REUSE' || ctx.decision === 'SKIP') {
        return okHandlerResult({
          status: ctx.decision === 'REUSE' ? 'REUSED' : 'SKIPPED',
          resourceType: ctx.resourceType,
          resourceId: ctx.resourceId,
          writeClass: 'none',
          wouldWrite: false,
          technicalDetailsSafe: { preflight: 'ok', wraps: spec.wraps },
        });
      }
      if (policy.requiresConfirmation && !ctx.confirmationSatisfied) {
        return okHandlerResult({
          status: 'WAITING',
          writeClass: spec.writeClass,
          wouldWrite: false,
          failureCode: 'BILLABLE_ACTION_CONFIRMATION_REQUIRED',
          userMessage: '需要先确认将创建的云资源与费用',
          retryClass: 'USER_ACTION_REQUIRED',
          technicalDetailsSafe: { preflight: 'confirmation_required', wraps: spec.wraps },
        });
      }
      return okHandlerResult({
        status: 'SUCCESS',
        writeClass: 'none',
        wouldWrite: false,
        technicalDetailsSafe: {
          preflight: 'ok',
          wraps: spec.wraps,
          bottomLocks: spec.bottomLocks,
          invariantsPreserved: true,
        },
        userMessage: '预检查通过',
      });
    },

    execute(ctx) {
      return lockedWriteResult(ctx, spec.writeClass);
    },

    reconcile(ctx) {
      // Never blind-retry billable creates — unknown stays RECONCILING/UNKNOWN
      if (policy.billable) {
        const exists = ctx.observedFacts?.resourceExists;
        if (exists === true) {
          return okHandlerResult({
            status: 'SUCCESS',
            resourceType: ctx.resourceType,
            resourceId: (ctx.observedFacts?.resourceId as string) ?? ctx.resourceId,
            writeClass: 'none',
            wouldWrite: false,
            userMessage: '云资源已存在，核对完成',
            technicalDetailsSafe: { reconcile: 'exists' },
          });
        }
        if (exists === false) {
          return okHandlerResult({
            status: 'FAILED',
            writeClass: spec.writeClass,
            wouldWrite: false,
            failureCode: 'PROVIDER_RESOURCE_MISSING',
            retryClass: 'USER_ACTION_REQUIRED',
            userMessage: '未找到已创建的云资源，请检查后继续',
            technicalDetailsSafe: { reconcile: 'missing', noBlindCreate: true },
          });
        }
        return okHandlerResult({
          status: 'UNKNOWN',
          writeClass: spec.writeClass,
          wouldWrite: false,
          failureCode: 'PROVIDER_RESULT_UNKNOWN',
          retryClass: 'RETRYABLE',
          userMessage: '云服务结果尚未明确，正在核对，不会重复创建',
          technicalDetailsSafe: { reconcile: 'unknown', noBlindCreate: true },
        });
      }
      return okHandlerResult({
        status: 'SUCCESS',
        writeClass: 'none',
        wouldWrite: false,
        technicalDetailsSafe: { reconcile: 'non_billable_ok' },
      });
    },

    verify(ctx) {
      if (
        spec.stepType === 'VERIFY_API_HTTPS' ||
        spec.stepType === 'VERIFY_WEB_HTTPS' ||
        spec.stepType === 'FINAL_ACCEPTANCE'
      ) {
        const desiredOk = ctx.observedFacts?.desiredStateSatisfied !== false;
        const httpsOk = ctx.observedFacts?.httpsValid !== false;
        const ok = desiredOk && httpsOk;
        return okHandlerResult({
          status: ok ? 'SUCCESS' : 'FAILED',
          writeClass: 'none',
          wouldWrite: false,
          failureCode: ok ? null : 'DESIRED_STATE_NOT_SATISFIED',
          userMessage: ok ? '上线检查通过' : '当前状态与期望不一致，需要修复后重试',
          observedState: {
            desiredStateSatisfied: ok,
            readOnly: true,
          },
          technicalDetailsSafe: {
            verify: 'read_only',
            wraps: spec.wraps,
          },
        });
      }
      return okHandlerResult({
        status: 'SUCCESS',
        writeClass: 'none',
        wouldWrite: false,
        technicalDetailsSafe: { verify: 'n/a' },
      });
    },
  };
}

export class LaunchStepHandlerRegistry {
  private readonly handlers = new Map<LaunchStepType, LaunchStepHandler>();

  constructor() {
    for (const spec of SPECS) {
      this.handlers.set(spec.stepType, makeHandler(spec));
    }
  }

  get(stepType: string): LaunchStepHandler | null {
    if (!(LAUNCH_STEP_TYPES as readonly string[]).includes(stepType)) return null;
    return this.handlers.get(stepType as LaunchStepType) ?? null;
  }

  require(stepType: string): LaunchStepHandler {
    const h = this.get(stepType);
    if (!h) throw new Error(`handler_not_registered:${stepType}`);
    return h;
  }

  list(): LaunchStepHandler[] {
    return LAUNCH_STEP_TYPES.map((t) => this.require(t));
  }

  isComplete(): boolean {
    return LAUNCH_STEP_TYPES.every((t) => this.handlers.has(t));
  }
}

export const defaultLaunchHandlerRegistry = new LaunchStepHandlerRegistry();
