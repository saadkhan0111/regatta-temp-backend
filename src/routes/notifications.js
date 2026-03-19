/**
 * RegattaStream — Notification Routes
 * Mounts at /api/notifications
 *
 * GET    /api/notifications              — user inbox (paginated)
 * GET    /api/notifications/unread-count — badge count only
 * PUT    /api/notifications/read-all     — mark all read
 * PUT    /api/notifications/:id/read     — mark one read
 * DELETE /api/notifications/:id          — dismiss one
 * DELETE /api/notifications/bulk         — bulk delete (by age or type)
 * DELETE /api/notifications/dismissed    — clear all dismissed
 *
 * GET    /api/notifications/prefs        — get preferences
 * PUT    /api/notifications/prefs        — update preferences
 *
 * POST   /api/notifications/tokens       — register push token
 * DELETE /api/notifications/tokens       — deactivate token (logout)
 *
 * GET    /api/notifications/follows      — list follows
 * POST   /api/notifications/follows      — follow club/regatta/athlete
 * DELETE /api/notifications/follows/:targetType/:targetId — unfollow
 * PUT    /api/notifications/follows/:id/overrides — update per-follow overrides
 *
 * POST   /api/notifications/test         — send test push (dev only)
 * POST   /api/notifications/broadcast    — broadcast (super_admin only)
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const notifSvc = require('../services/notificationService');
const { Notification, NotificationPrefs, PushToken, Follow, NOTIF_TYPES } = require('../models/notifications');

// ── AUTH ───────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (!['club_admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

function superAdminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'super_admin')
      return res.status(403).json({ error: 'Super admin required' });
    next();
  });
}

// ── INBOX ──────────────────────────────────────────────────────

/**
 * GET /api/notifications
 * Returns paginated inbox + unread badge count.
 * Query: limit=30&skip=0&unreadOnly=false
 */
router.get('/', auth, async (req, res, next) => {
  try {
    const { limit = 30, skip = 0, unreadOnly = 'false' } = req.query;
    const inbox = await notifSvc.getInbox(req.user.id, {
      limit: Number(limit),
      skip: Number(skip),
      unreadOnly: unreadOnly === 'true',
    });
    res.json(inbox);
  } catch (e) { next(e); }
});

/**
 * GET /api/notifications/unread-count
 * Lightweight — for badge refresh polling.
 */
router.get('/unread-count', auth, async (req, res, next) => {
  try {
    const count = await Notification.countDocuments({
      userId: req.user.id,
      read: false,
      dismissed: false,
    });
    res.json({ count });
  } catch (e) { next(e); }
});

/**
 * PUT /api/notifications/read-all
 * Mark all as read.
 */
router.put('/read-all', auth, async (req, res, next) => {
  try {
    await notifSvc.markRead(req.user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * PUT /api/notifications/:id/read
 * Mark single notification as read.
 */
router.put('/:id/read', auth, async (req, res, next) => {
  try {
    await notifSvc.markRead(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * DELETE /api/notifications/:id
 * Dismiss (soft-delete) a single notification.
 */
router.delete('/:id', auth, async (req, res, next) => {
  try {
    await notifSvc.dismiss(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * DELETE /api/notifications/bulk
 * Bulk delete by age and/or type.
 * Body: { olderThanDays: 30, type: 'race_results_posted' }
 */
router.delete('/bulk', auth, async (req, res, next) => {
  try {
    const { olderThanDays = 30, type } = req.body;
    const result = await notifSvc.deleteOld(req.user.id, { olderThanDays: Number(olderThanDays), type });
    res.json(result);
  } catch (e) { next(e); }
});

/**
 * DELETE /api/notifications/dismissed
 * Clear all already-dismissed notifications.
 */
router.delete('/dismissed', auth, async (req, res, next) => {
  try {
    const result = await notifSvc.clearDismissed(req.user.id);
    res.json(result);
  } catch (e) { next(e); }
});

// ── PREFERENCES ───────────────────────────────────────────────

/**
 * GET /api/notifications/prefs
 * Returns full preference object.
 */
router.get('/prefs', auth, async (req, res, next) => {
  try {
    const prefs = await notifSvc.getPrefsForUser(req.user.id);
    res.json(prefs);
  } catch (e) { next(e); }
});

/**
 * PUT /api/notifications/prefs
 * Update preferences. Supports partial updates.
 *
 * Examples:
 *   { pushEnabled: false }                        — master push off
 *   { quietHours: { enabled: true, startHour: 22, endHour: 7, timezone: 'America/New_York' } }
 *   { types: { race_results_posted: { push: true, inApp: true, email: false } } }
 *   { 'types.crew_chat_message.push': false }     — dot-notation for single toggle
 */
router.put('/prefs', auth, async (req, res, next) => {
  try {
    const prefs = await notifSvc.updatePrefs(req.user.id, req.body);
    res.json(prefs);
  } catch (e) { next(e); }
});

/**
 * GET /api/notifications/prefs/types
 * Returns list of all notification types with labels (for settings UI).
 */
router.get('/prefs/types', auth, async (req, res, next) => {
  try {
    const typesMeta = [
      { key: NOTIF_TYPES.RACE_RESULTS_POSTED,   group: 'Results',   label: 'Race Results Posted',      description: 'When results from a followed club are available' },
      { key: NOTIF_TYPES.CLUB_PODIUM_FINISH,     group: 'Results',   label: 'Podium Finish Alert',      description: 'When a followed club finishes 1st, 2nd, or 3rd' },
      { key: NOTIF_TYPES.ELO_RANK_CHANGE,        group: 'Results',   label: 'Speed Order Movement',     description: 'When a club moves 3+ places in national rankings' },
      { key: NOTIF_TYPES.RACE_DAY_REMINDER,      group: 'Upcoming',  label: 'Race Day Reminder',        description: 'Morning alert on the day a followed club races' },
      { key: NOTIF_TYPES.RACE_WEEK_REMINDER,     group: 'Upcoming',  label: '7-Day Race Reminder',      description: 'One week before a followed club races' },
      { key: NOTIF_TYPES.ENTRIES_CONFIRMED,      group: 'Upcoming',  label: 'Entries Confirmed',        description: 'When a followed club confirms regatta entries' },
      { key: NOTIF_TYPES.HEAT_SHEETS_POSTED,     group: 'Upcoming',  label: 'Heat Sheets Posted',       description: 'When heat draw is available for a followed regatta' },
      { key: NOTIF_TYPES.LIVE_RACE_STARTING,     group: 'Live',      label: 'Race Starting Now',        description: '10 minutes before a followed crew goes to the start' },
      { key: NOTIF_TYPES.CREW_CHAT_MESSAGE,      group: 'Messages',  label: 'New Chat Message',         description: 'New messages in CrewChat rooms you\'re part of' },
      { key: NOTIF_TYPES.CREW_CHAT_MENTION,      group: 'Messages',  label: 'Chat Mention',             description: 'When someone @mentions you in a chat' },
      { key: NOTIF_TYPES.CAMPAIGN_SENT,          group: 'Admin',     label: 'Campaign Sent',            description: 'Confirmation when your email campaign is delivered' },
      { key: NOTIF_TYPES.NEW_SUPPORTER_JOINED,   group: 'Admin',     label: 'New Supporter',            description: 'When someone joins your club\'s supporter list' },
      { key: NOTIF_TYPES.SUPPORTER_MILESTONE,    group: 'Admin',     label: 'Supporter Milestone',      description: 'When supporter list hits a milestone (100, 500, etc.)' },
      { key: NOTIF_TYPES.DONATION_RECEIVED,      group: 'Admin',     label: 'Donation Received',        description: 'When a donation is made to your club' },
      { key: NOTIF_TYPES.SYSTEM_ANNOUNCEMENT,    group: 'System',    label: 'RegattaStream Updates',    description: 'New features, announcements, and important notices' },
    ];
    res.json(typesMeta);
  } catch (e) { next(e); }
});

// ── PUSH TOKENS ───────────────────────────────────────────────

/**
 * POST /api/notifications/tokens
 * Register or update a push token for this device.
 * Body: { token, platform: 'ios'|'android', deviceId, appVersion }
 */
router.post('/tokens', auth, async (req, res, next) => {
  try {
    const { token, platform, deviceId, appVersion } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    if (!['ios','android','web'].includes(platform)) return res.status(400).json({ error: 'invalid platform' });
    const doc = await notifSvc.registerToken(req.user.id, token, platform, deviceId, appVersion);
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

/**
 * DELETE /api/notifications/tokens
 * Deactivate push token (on logout or user opt-out).
 * Body: { token } OR deactivates all user's tokens if no token provided.
 */
router.delete('/tokens', auth, async (req, res, next) => {
  try {
    if (req.body.token) {
      await notifSvc.deactivateToken(req.body.token);
    } else {
      await notifSvc.deactivateAllTokens(req.user.id);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── FOLLOWS ───────────────────────────────────────────────────

/**
 * GET /api/notifications/follows
 * List all follows for the current user.
 * Query: ?targetType=club|regatta|athlete
 */
router.get('/follows', auth, async (req, res, next) => {
  try {
    const follows = await notifSvc.getFollows(req.user.id, req.query.targetType || null);

    // Hydrate with target names for display
    const { Club, Regatta, Athlete } = require('../models');
    const hydrated = await Promise.all(follows.map(async f => {
      let target = null;
      try {
        if (f.targetType === 'club')    target = await Club.findById(f.targetId, 'name emoji primaryColor eloScore soRank').lean();
        if (f.targetType === 'regatta') target = await Regatta.findById(f.targetId, 'name date location status').lean();
        if (f.targetType === 'athlete') target = await Athlete.findById(f.targetId, 'firstName lastName ergPr2k').lean();
      } catch {}
      return { ...f, target };
    }));

    res.json(hydrated);
  } catch (e) { next(e); }
});

/**
 * POST /api/notifications/follows
 * Follow a club, regatta, or athlete.
 * Body: { targetType: 'club'|'regatta'|'athlete', targetId, overrides: {} }
 */
router.post('/follows', auth, async (req, res, next) => {
  try {
    const { targetType, targetId, overrides = {} } = req.body;
    if (!['club','regatta','athlete'].includes(targetType)) return res.status(400).json({ error: 'invalid targetType' });
    if (!targetId) return res.status(400).json({ error: 'targetId required' });
    const follow = await notifSvc.followTarget(req.user.id, targetType, targetId, overrides);
    res.status(201).json(follow);
  } catch (e) { next(e); }
});

/**
 * DELETE /api/notifications/follows/:targetType/:targetId
 * Unfollow.
 */
router.delete('/follows/:targetType/:targetId', auth, async (req, res, next) => {
  try {
    await notifSvc.unfollowTarget(req.user.id, req.params.targetType, req.params.targetId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * PUT /api/notifications/follows/:id/overrides
 * Update per-follow notification overrides.
 * Body: { race_results_posted: true, race_day_reminder: false, ... }
 */
router.put('/follows/:id/overrides', auth, async (req, res, next) => {
  try {
    const follow = await Follow.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { $set: { overrides: req.body } },
      { new: true }
    );
    if (!follow) return res.status(404).json({ error: 'Follow not found' });
    res.json(follow);
  } catch (e) { next(e); }
});

/**
 * PUT /api/notifications/follows/:id/mute
 * Toggle notifications off for a specific follow without unfollowing.
 */
router.put('/follows/:id/mute', auth, async (req, res, next) => {
  try {
    const { muted } = req.body; // true = mute, false = unmute
    const follow = await Follow.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { $set: { notificationsEnabled: !muted } },
      { new: true }
    );
    if (!follow) return res.status(404).json({ error: 'Follow not found' });
    res.json(follow);
  } catch (e) { next(e); }
});

// ── ADMIN / DEV ───────────────────────────────────────────────

/**
 * POST /api/notifications/test
 * Send a test push notification to the requesting user.
 * Dev/staging only.
 */
router.post('/test', auth, async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'Not available in production' });
    const notif = await notifSvc.dispatch({
      userId: req.user.id,
      type: NOTIF_TYPES.SYSTEM_ANNOUNCEMENT,
      title: '🔔 Test Notification',
      body: req.body.message || 'Push notification is working correctly!',
      data: { screen: 'notifications' },
    });
    res.json({ ok: true, notif });
  } catch (e) { next(e); }
});

/**
 * POST /api/notifications/broadcast
 * Send a system broadcast to all users.
 * Super admin only.
 * Body: { title, body, data: {} }
 */
router.post('/broadcast', superAdminAuth, async (req, res, next) => {
  try {
    const { title, body, data = {} } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body required' });

    // Create in-app notifications for all users
    const { User } = require('../models');
    const users = await User.find({}, '_id').lean();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 3600 * 1000); // 30 days

    await Notification.insertMany(users.map(u => ({
      userId: u._id,
      type: NOTIF_TYPES.SYSTEM_ANNOUNCEMENT,
      title, body, data, expiresAt,
      groupKey: `broadcast_${now.toISOString().split('T')[0]}`,
    })));

    // Send push broadcast
    await notifSvc.sendBroadcastPush({ title, body, data });

    res.json({ ok: true, userCount: users.length });
  } catch (e) { next(e); }
});

/**
 * POST /api/notifications/manual
 * Manually trigger a notification to a specific user (admin tool).
 */
router.post('/manual', adminAuth, async (req, res, next) => {
  try {
    const { userId, type, title, body, data } = req.body;
    if (!userId || !type || !title || !body) return res.status(400).json({ error: 'userId, type, title, body required' });
    if (!Object.values(NOTIF_TYPES).includes(type)) return res.status(400).json({ error: 'invalid type' });
    const notif = await notifSvc.dispatch({ userId, type, title, body, data: data || {} });
    res.status(201).json(notif);
  } catch (e) { next(e); }
});

module.exports = router;
