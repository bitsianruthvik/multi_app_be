/**
 * notifications.js — the login's own in-app notifications (TM/CF_HRMS_HIRING_SPEC.md §42.3).
 *
 *   GET  /notifications?unread=1        mine, newest first, and how many are unread (the bell)
 *   POST /notifications/:id/read        mark one of mine read
 *   POST /notifications/read-all        mark all of mine read
 *
 * Any login with access to the app: a notification is addressed to a login (the absence digest goes to HR
 * and to in-charges), and only that login ever reads or marks it — the user id comes from the token.
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { myNotifications, markRead, markAllRead } from '../services/notifications.js';

const router = Router();
const SIGNED_IN = guard(PERM.signedIn, { note: 'only the login’s own notifications' });

router.get('/notifications', SIGNED_IN, handle((req) => myNotifications(pool, ctx(req), { unreadOnly: ['1', 'true'].includes(String(req.query.unread ?? '')) })));
router.post('/notifications/read-all', SIGNED_IN, handle((req) => markAllRead(pool, ctx(req))));
router.post('/notifications/:id/read', SIGNED_IN, handle((req) => markRead(pool, ctx(req), intParam(req.params.id))));

export default router;
