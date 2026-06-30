/**
 * codegen.js — company-level code-generation rule settings + code issuance.
 *
 * GET  /codegen-rules?entityType=item        — fetch rule (or built-in default)
 * POST /codegen-rules                        — upsert segments for an entity type
 * POST /codegen/preview                      — sample code, does not consume the sequence
 * POST /codegen/next-code                    — generates and consumes the next real code
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { getRule, saveRule, previewCode, generateCode } from '../services/codegenService.js';

const router = Router();

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

router.get('/codegen-rules', protect, async (req, res) => {
  try {
    const entityType = req.query.entityType;
    if (!entityType) return res.status(400).json({ message: '"entityType" query param is required.' });
    const companyId = req.user.companyId ?? req.user.company_id;
    const rule = await getRule(companyId, entityType);
    res.json(rule);
  } catch (err) {
    res.status(500).json({ message: err.message ?? 'Failed to load rule' });
  }
});

router.post('/codegen-rules', protect, requirePerm('fab_erp_items_meta_manage'), async (req, res) => {
  try {
    const { entityType, segments } = req.body ?? {};
    if (!entityType || !Array.isArray(segments)) {
      return res.status(400).json({ message: '"entityType" and "segments" (array) are required.' });
    }
    const companyId = req.user.companyId ?? req.user.company_id;
    await saveRule(companyId, entityType, segments);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message ?? 'Failed to save rule' });
  }
});

router.post('/codegen/preview', protect, async (req, res) => {
  try {
    const { entityType, segments, context } = req.body ?? {};
    if (!entityType || !Array.isArray(segments)) {
      return res.status(400).json({ message: '"entityType" and "segments" (array) are required.' });
    }
    const companyId = req.user.companyId ?? req.user.company_id;
    const code = await previewCode(companyId, entityType, segments, context ?? {});
    res.json({ code });
  } catch (err) {
    res.status(500).json({ message: err.message ?? 'Preview failed' });
  }
});

router.post('/codegen/next-code', protect, async (req, res) => {
  try {
    const { entityType, context } = req.body ?? {};
    if (!entityType) return res.status(400).json({ message: '"entityType" is required.' });
    const companyId = req.user.companyId ?? req.user.company_id;
    const code = await generateCode(companyId, entityType, context ?? {});
    res.json({ code });
  } catch (err) {
    res.status(500).json({ message: err.message ?? 'Failed to generate code' });
  }
});

export default router;
