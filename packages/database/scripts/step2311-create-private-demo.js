/**
 * DEPRECATED for Step 23.11 corrected plan.
 * LaunchOS GitHub App must NOT create or push repositories.
 * Use step2311-wait-probe.js instead.
 */
console.log(JSON.stringify({
  refused: true,
  reason: 'Step 23.11 corrected: App is read-only. Do not POST /user/repos or push with installation token.',
  use: 'node packages/database/scripts/step2311-wait-probe.js',
}, null, 2));
process.exit(0);
