import type { CloudPlanDefinition } from './types';

export const MOCK_CLOUD_PLANS: readonly CloudPlanDefinition[] = [
  {
    name: 'Starter',
    cpu: 1,
    memory: '1GB',
    storage: '10GB',
    database: 'none',
    description: 'Minimal Node.js runtime for simple apps without a database.',
  },
  {
    name: 'Standard',
    cpu: 2,
    memory: '4GB',
    storage: '40GB',
    database: 'PostgreSQL',
    description: 'Application runtime plus PostgreSQL for projects that persist data.',
  },
  {
    name: 'Production',
    cpu: 4,
    memory: '8GB',
    storage: '80GB',
    database: 'PostgreSQL + Redis',
    description: 'Higher capacity runtime with PostgreSQL and Redis for complex workloads.',
  },
];
