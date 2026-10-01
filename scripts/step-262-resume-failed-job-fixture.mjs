/**
 * @deprecated Prefer step-262-creating-instance-mock-fixture.mjs
 *
 * This older fixture polluted production via CloudResource.metadata
 * fixtureStopBeforeRunInstances — that path is REMOVED from the Worker.
 *
 * Exits non-zero to prevent accidental re-use.
 */
console.error(
  JSON.stringify(
    {
      ok: false,
      deprecated: true,
      reason:
        'metadata fixtureStopBeforeRunInstances polluted production; use step-262-creating-instance-mock-fixture.mjs (explicit testOnly DI)',
    },
    null,
    2,
  ),
);
process.exitCode = 1;
