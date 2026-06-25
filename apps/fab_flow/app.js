import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import planRoutes     from './routes/planRoutes.js';
import capacityRoutes from './routes/capacityRoutes.js';
import scheduleRoutes from './routes/scheduleRoutes.js';
import { startScheduleCron } from './workers/scheduleCronJob.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const resourceDefs = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'resourceDef.json'), 'utf-8'),
);

export default {
  slug: 'fab_flow',
  resourceDefs,
  jobHandlers: {},

  register(server) {
    server.use('/api/:companySlug/fab_flow', planRoutes);
    server.use('/api/:companySlug/fab_flow', capacityRoutes);
    server.use('/api/:companySlug/fab_flow', scheduleRoutes);
    startScheduleCron();
  },

  migrations: path.join(__dirname, 'models', 'init.sql'),
};
