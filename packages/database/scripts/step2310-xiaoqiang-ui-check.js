const fs = require('fs');
const path = require('path');
function loadEnv() {
  const envPath = path.resolve(__dirname, '../../../.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();
const { PrismaClient } = require('../generated/client');
const {
  deriveUnitProductStatus,
  defaultUnitDisplayName,
  UNIT_PRODUCT_STATUS_LABELS,
} = require('../../../apps/api/dist/deployable-units/unit-product');

const p = new PrismaClient();
(async () => {
  const units = await p.deployableUnit.findMany({
    where: {
      OR: [
        { project: { name: { contains: 'Xiaoqiang' } } },
        { project: { name: { contains: '照型' } } },
      ],
    },
    select: {
      name: true,
      type: true,
      framework: true,
      deployable: true,
      rootPath: true,
      project: { select: { name: true } },
    },
  });
  const out = units.map((u) => {
    const status = deriveUnitProductStatus({ deployable: u.deployable });
    return {
      project: u.project.name,
      displayName: defaultUnitDisplayName(u.type, u.rootPath, u.name),
      type: u.type,
      framework: u.framework,
      deployable: u.deployable,
      productStatusLabel: UNIT_PRODUCT_STATUS_LABELS[status],
      showLaunchButton: u.deployable,
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
