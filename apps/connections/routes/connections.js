import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import * as connections from '../services/connectionService.js';

/**
 * The Connections screen. Admins of the company only: a connection reaches a
 * customer's files, whichever app later reads through it.
 */
const router = Router({ mergeParams: true });

const adminOnly = (req, res, next) => {
  if (String(req.user?.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can manage connections.' });
  }
  next();
};

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (!err.status) req.log?.error?.({ err }, 'connections');
    res.status(err.status || 500).json({ error: err.message });
  }
};

const cid = (req) => req.company.id;

router.get('/providers', protect, adminOnly, wrap(() => ({ providers: connections.describeProviders() })));
router.get('/connections', protect, adminOnly, wrap(async (req) => ({ connections: await connections.list(cid(req)) })));
router.post('/connections', protect, adminOnly, wrap((req) => connections.create(cid(req), req.body || {}, req.user.id)));
router.put('/connections/:id', protect, adminOnly, wrap((req) => connections.update(cid(req), req.params.id, req.body || {})));
router.delete('/connections/:id', protect, adminOnly, wrap(async (req) => {
  await connections.remove(cid(req), req.params.id);
  return { ok: true };
}));
router.post('/connections/:id/test', protect, adminOnly, wrap((req) => connections.test(cid(req), req.params.id)));
router.get('/connections/:id/files', protect, adminOnly, wrap(async (req) => ({
  files: await connections.listFiles(cid(req), req.params.id, req.query.folder ? String(req.query.folder) : undefined),
})));

export default router;
