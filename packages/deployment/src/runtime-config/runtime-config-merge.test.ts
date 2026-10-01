import assert from 'node:assert/strict';

import { RuntimeConfigInjectionPhase } from '@launchos/database';

import { describe, it } from 'node:test';

import {

  buildUnitEffectiveFingerprint,

  collectUnitsAffectedByProjectKeyChange,

  isManagedConfigKey,

  resolveEffectiveEntry,

} from './runtime-config-merge';



describe('runtime-config-merge', () => {

  it('applies managed > unit > project > default > missing', () => {

    const req = {

      key: 'SENTRY_DSN',

      required: false,

      sensitive: false,

      managedByLaunchOS: false,

      defaultValue: 'default-dsn',

      injectionPhase: RuntimeConfigInjectionPhase.RUNTIME,

    };

    const unit = { key: 'SENTRY_DSN', valueEncrypted: 'enc:unit', isSensitive: false };

    const project = { key: 'SENTRY_DSN', valueEncrypted: 'enc:project', isSensitive: false };



    assert.equal(resolveEffectiveEntry(req, unit, project).source, 'UNIT');

    assert.equal(resolveEffectiveEntry(req, undefined, project).source, 'PROJECT');

    assert.equal(resolveEffectiveEntry(req, undefined, undefined).source, 'DEFAULT');

    assert.equal(

      resolveEffectiveEntry({ ...req, defaultValue: null }, undefined, undefined).source,

      'MISSING',

    );

    assert.equal(

      resolveEffectiveEntry(

        { ...req, managedByLaunchOS: true },

        unit,

        project,

      ).source,

      'MANAGED',

    );

  });



  it('rejects managed keys from user override semantics', () => {

    assert.equal(isManagedConfigKey('PORT'), true);

    assert.equal(isManagedConfigKey('JWT_SECRET'), false);

  });



  it('does not dirty units without requirement for changed project key', () => {

    const projectBefore = new Map([

      ['SENTRY_DSN', { key: 'SENTRY_DSN', valueEncrypted: 'enc:a', isSensitive: false }],

      ['DATABASE_URL', { key: 'DATABASE_URL', valueEncrypted: 'enc:db', isSensitive: true }],

    ]);

    const projectAfter = new Map([

      ['SENTRY_DSN', { key: 'SENTRY_DSN', valueEncrypted: 'enc:c', isSensitive: false }],

      ['DATABASE_URL', { key: 'DATABASE_URL', valueEncrypted: 'enc:db', isSensitive: true }],

    ]);



    const webReq = {

      key: 'SENTRY_DSN',

      required: false,

      sensitive: false,

      managedByLaunchOS: false,

      defaultValue: null,

      injectionPhase: RuntimeConfigInjectionPhase.RUNTIME,

    };

    const apiReq = {

      key: 'SENTRY_DSN',

      required: false,

      sensitive: false,

      managedByLaunchOS: false,

      defaultValue: null,

      injectionPhase: RuntimeConfigInjectionPhase.RUNTIME,

    };



    const affected = collectUnitsAffectedByProjectKeyChange({

      changedKey: 'SENTRY_DSN',

      units: [

        {

          id: 'web',

          configRevision: 1,

          port: 80,

          requirements: [webReq],

          unitValues: new Map(),

        },

        {

          id: 'api',

          configRevision: 2,

          port: 3000,

          requirements: [apiReq],

          unitValues: new Map([

            ['SENTRY_DSN', { key: 'SENTRY_DSN', valueEncrypted: 'enc:b', isSensitive: false }],

          ]),

        },

      ],

      projectValuesBefore: projectBefore,

      projectValuesAfter: projectAfter,

    });



    assert.deepEqual(affected, ['web']);

  });



  it('fingerprint stays stable when unrelated project key changes', () => {

    const req = {

      key: 'JWT_SECRET',

      required: true,

      sensitive: true,

      managedByLaunchOS: false,

      defaultValue: null,

      injectionPhase: RuntimeConfigInjectionPhase.RUNTIME,

    };

    const unitValues = new Map([

      ['JWT_SECRET', { key: 'JWT_SECRET', valueEncrypted: 'enc:jwt', isSensitive: true }],

    ]);

    const before = new Map([

      ['SENTRY_DSN', { key: 'SENTRY_DSN', valueEncrypted: 'enc:a', isSensitive: false }],

    ]);

    const after = new Map([

      ['SENTRY_DSN', { key: 'SENTRY_DSN', valueEncrypted: 'enc:c', isSensitive: false }],

    ]);



    const fpBefore = buildUnitEffectiveFingerprint({

      requirements: [req],

      unitValues,

      projectValues: before,

      configRevision: 3,

      containerPort: 3000,

    });

    const fpAfter = buildUnitEffectiveFingerprint({

      requirements: [req],

      unitValues,

      projectValues: after,

      configRevision: 3,

      containerPort: 3000,

    });

    assert.equal(fpBefore, fpAfter);

  });

});


