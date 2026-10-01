import {
  PrismaClient,

  RuntimeConfigInjectionPhase,

  RuntimeConfigScopeType,

} from '@launchos/database';

import { decryptCredential } from '@launchos/shared';

import {

  buildUnitEffectiveFingerprintParts,

  fingerprintFromParts,

  isManagedConfigKey,

  phaseMatches,

  resolveEffectiveEntry,

  type RuntimeConfigPhase,

} from './runtime-config-merge';



export type { RuntimeConfigPhase };



export type ResolvedRuntimeConfig = {

  env: Record<string, string>;

  keys: string[];

  fingerprint: string;

  revision: number;

  missingRequired: Array<{ key: string; label: string }>;

  /** Sensitive plaintext values for log redaction only (never persist). */

  secretPlaintexts: string[];

};



export type ResolveRuntimeConfigInput = {

  projectId: string;

  deployableUnitId: string;

  phase: RuntimeConfigPhase;

  /** Container internal port for managed PORT (RUNTIME). */

  containerPort?: number;

};



/**

 * Resolve plaintext env for a single DeployableUnit + phase.

 * Plaintext exists only in memory — never write back / log / return to clients.

 */

export class RuntimeConfigResolver {

  constructor(private readonly prisma: PrismaClient) {}



  async resolve(input: ResolveRuntimeConfigInput): Promise<ResolvedRuntimeConfig> {

    const unit = await this.prisma.deployableUnit.findFirst({

      where: { id: input.deployableUnitId, projectId: input.projectId },

      select: { id: true, configRevision: true, port: true },

    });

    if (!unit) {

      throw new Error('DeployableUnit not found for runtime config resolve');

    }



    const [requirements, unitValues, projectValues] = await Promise.all([

      this.prisma.runtimeConfigRequirement.findMany({

        where: {

          projectId: input.projectId,

          deployableUnitId: input.deployableUnitId,

        },

      }),

      this.prisma.runtimeConfigValue.findMany({

        where: {

          projectId: input.projectId,

          scopeType: RuntimeConfigScopeType.UNIT,

          scopeId: input.deployableUnitId,

        },

      }),

      this.prisma.runtimeConfigValue.findMany({

        where: {

          projectId: input.projectId,

          scopeType: RuntimeConfigScopeType.PROJECT,

          scopeId: input.projectId,

        },

      }),

    ]);



    const unitValueByKey = new Map(unitValues.map((item) => [item.key, item]));

    const projectValueByKey = new Map(projectValues.map((item) => [item.key, item]));

    const env: Record<string, string> = {};

    const secretPlaintexts: string[] = [];



    for (const req of requirements) {

      if (!phaseMatches(req.injectionPhase, input.phase)) {

        continue;

      }



      const effective = resolveEffectiveEntry(

        req,

        unitValueByKey.get(req.key),

        projectValueByKey.get(req.key),

      );



      if (effective.source === 'MANAGED') {

        continue;

      }



      if (effective.source === 'UNIT' || effective.source === 'PROJECT') {

        const stored =

          effective.source === 'UNIT'

            ? unitValueByKey.get(req.key)

            : projectValueByKey.get(req.key);

        if (!stored) {

          continue;

        }

        try {

          const plaintext = decryptCredential(stored.valueEncrypted);

          env[req.key] = plaintext;

          if (req.sensitive || stored.isSensitive) {

            secretPlaintexts.push(plaintext);

          }

        } catch {

          throw new Error(`配置 ${req.key} 解密失败`);

        }

      } else if (effective.source === 'DEFAULT' && req.defaultValue) {

        env[req.key] = req.defaultValue;

      }

    }



    if (input.phase === 'RUNTIME') {

      const internalPort =

        input.containerPort && input.containerPort > 0

          ? input.containerPort

          : unit.port && unit.port > 0

            ? unit.port

            : 3000;

      env.PORT = String(internalPort);

      env.NODE_ENV = env.NODE_ENV || 'production';

      env.HOST = '0.0.0.0';

      env.HOSTNAME = '0.0.0.0';

    }



    const missingRequired = requirements

      .filter((req) => {

        if (!req.required || req.managedByLaunchOS || isManagedConfigKey(req.key)) {

          return false;

        }

        if (

          !phaseMatches(req.injectionPhase, input.phase) &&

          req.injectionPhase !== RuntimeConfigInjectionPhase.BOTH

        ) {

          return false;

        }

        return env[req.key] === undefined;

      })

      .map((req) => ({ key: req.key, label: req.label }));



    const keys = Object.keys(env).sort();

    const fingerprintParts = buildUnitEffectiveFingerprintParts({

      requirements,

      unitValues: unitValueByKey,

      projectValues: projectValueByKey,

      configRevision: unit.configRevision,

      containerPort:

        input.containerPort && input.containerPort > 0

          ? input.containerPort

          : unit.port ?? undefined,

    }).filter((part) => {

      if (input.phase === 'BUILD') {

        return !part.startsWith('managed:PORT=');

      }

      return true;

    });



    const fingerprint = fingerprintFromParts(fingerprintParts);



    return {

      env,

      keys,

      fingerprint,

      revision: unit.configRevision,

      missingRequired,

      secretPlaintexts,

    };

  }



  /** Missing required across BUILD+RUNTIME for deploy gate. */

  async getMissingRequiredForDeploy(

    projectId: string,

    deployableUnitId: string,

  ): Promise<Array<{ key: string; label: string }>> {

    const [requirements, unitValues, projectValues] = await Promise.all([

      this.prisma.runtimeConfigRequirement.findMany({

        where: {

          projectId,

          deployableUnitId,

          required: true,

          managedByLaunchOS: false,

        },

      }),

      this.prisma.runtimeConfigValue.findMany({

        where: {

          projectId,

          scopeType: RuntimeConfigScopeType.UNIT,

          scopeId: deployableUnitId,

        },

        select: { key: true, valueEncrypted: true, isSensitive: true },

      }),

      this.prisma.runtimeConfigValue.findMany({

        where: {

          projectId,

          scopeType: RuntimeConfigScopeType.PROJECT,

          scopeId: projectId,

        },

        select: { key: true, valueEncrypted: true, isSensitive: true },

      }),

    ]);



    const unitValueByKey = new Map(unitValues.map((item) => [item.key, item]));

    const projectValueByKey = new Map(projectValues.map((item) => [item.key, item]));



    return requirements

      .filter((req) => {

        if (isManagedConfigKey(req.key)) {

          return false;

        }

        const effective = resolveEffectiveEntry(

          req,

          unitValueByKey.get(req.key),

          projectValueByKey.get(req.key),

        );

        return !effective.configured;

      })

      .map((item) => ({ key: item.key, label: item.label }));

  }

}


