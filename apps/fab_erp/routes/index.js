import { Router } from 'express';
import mutateRouter from './mutate.js';
import versionRouter from './version.js';
import processTemplateStepsRouter from './processTemplateSteps.js';
import grnRouter       from './grn.js';
import bomRouter       from './bom.js';
import routingRouter   from './routing.js';
import mrpRouter       from './mrp.js';
import ordersRouter    from './orders.js';
import schedulerRouter from './scheduler.js';
import plannerRouter   from './planner.js';
import itemsRouter     from './items.js';
import codegenRouter   from './codegen.js';
import searchRouter    from './search.js';

const router = Router();

router.get('/health', (req, res) => res.json({ ok: true, app: 'fab_erp' }));

router.use(mutateRouter);
router.use(versionRouter);
router.use(processTemplateStepsRouter);
router.use(grnRouter);
router.use(bomRouter);
router.use(routingRouter);
router.use(mrpRouter);
router.use(ordersRouter);
router.use(schedulerRouter);
router.use(plannerRouter);
router.use(itemsRouter);
router.use(codegenRouter);
router.use(searchRouter);

export default router;
