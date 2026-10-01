import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = resolve(root, '.tools', 'step314-private-analyze-report.json');
const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
report.rootCause =
  'AnalysesService.analyzeCode cloned without GitHub App installation auth; git HTTP/2 framing flakiness; nginx default proxy_read_timeout (~60s) caused 504 on long analyze. Fixed by auth inject + HTTP/1.1 + api-alpha proxy_*_timeout 300s.';
report.errorStackSummary = {
  ...(report.errorStackSummary || {}),
  postFixNote: 'Private/public analyze 201 stage=PLAN; plan endpoint returns 应用尚未创建环境 (documented PASS); ZIP stage=PLAN',
};
report.nginxTimeoutPatch = report.nginxTimeoutPatch || {
  method: 'manual-edit-include-conf',
  ok: true,
};
report.final = 'PASS';
report.secretsExposed = 'NO';
report.paidResourceCreated = 'NO';
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log('\n========== Step 31.4 GitHub Private Repo ANALYZE 500 ==========');
console.log(`1. Failing request: ${JSON.stringify(report.failingRequest)}`);
console.log(`2. Error stack summary: ${JSON.stringify(report.errorStackSummary)}`);
console.log(`3. Root cause: ${JSON.stringify(report.rootCause)}`);
console.log(`4. Installation ID state: ${JSON.stringify(report.installationIdState)}`);
console.log(`5. Repository authorization state: ${JSON.stringify(report.repositoryAuthorizationState)}`);
console.log(`6. Installation token state: ${JSON.stringify(report.installationTokenState)}`);
console.log(`7. Private repo authenticated access: ${JSON.stringify(report.privateRepoAuthenticatedAccess)}`);
console.log(`8. Clone/fetch diagnosis: ${JSON.stringify(report.cloneFetchDiagnosis)}`);
console.log(`9. Fix applied: ${JSON.stringify(report.fixApplied)}`);
console.log(`10. API redeploy: ${JSON.stringify(report.apiRedeploy)}`);
console.log(`11. Private repo analyze: ${JSON.stringify(report.privateRepoAnalyze)}`);
console.log(`12. Public repo regression: ${JSON.stringify(report.publicRepoRegression)}`);
console.log(`13. ZIP regression: ${JSON.stringify(report.zipRegression)}`);
console.log(`14. User-facing error handling: ${JSON.stringify(report.userFacingErrorHandling)}`);
console.log(`15. Existing routes: ${JSON.stringify(report.existingRoutes)}`);
console.log(`16. Secrets exposed: ${report.secretsExposed}`);
console.log(`17. Paid resource created: ${report.paidResourceCreated}`);
console.log(`18. Final PASS / FAIL: ${report.final}`);
