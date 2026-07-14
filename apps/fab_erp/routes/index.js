import { Router } from 'express';
import mutateRouter from './mutate.js';
import versionRouter from './version.js';
import processTemplateStepsRouter from './processTemplateSteps.js';
import grnRouter       from './grn.js';
import stockRouter     from './stock.js';
import bomRouter       from './bom.js';
import itemsRouter     from './items.js';
import codegenRouter   from './codegen.js';
import searchRouter    from './search.js';
import tasksRouter     from './tasks.js';

const router = Router();

router.get('/health', (req, res) => res.json({ ok: true, app: 'fab_erp' }));

router.use(mutateRouter);
router.use(versionRouter);
router.use(processTemplateStepsRouter);
router.use(grnRouter);
router.use(stockRouter);
router.use(bomRouter);
router.use(itemsRouter);
router.use(codegenRouter);
router.use(searchRouter);
router.use(tasksRouter);

export default router;
