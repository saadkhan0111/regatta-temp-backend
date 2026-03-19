/**
 * RegattaStream — Notification Service
 * ─────────────────────────────────────────────────────────────
 * Handles all notification delivery:
 *   - In-app notifications (DB inbox)
 *   - Push notifications (Expo push API → APNs / FCM)
 *   - Quiet hours enforcement
 *   - Race result triggers
 *   - Upcoming race reminders (via cron)
 *   - Campaign / chat notifications
 *   - Token management and failure tracking
 *
 * Usage:
 *   const notifSvc = require('./notificationService');
 *
 *   // After results post:
 *   await notifSvc.notifyRaceResultsPosted(raceId, regattaId);
 *
 *   // Race day reminder (called by cron):
 *   await notifSvc.sendRaceDayReminders();
 */

'use strict';

const axios = require('axios');
const { Notification, NotificationPrefs, PushToken, Follow, NOTIF_TYPES } = require('../models/notifications');
const { User }    = require('../models');

// Expo Push API endpoint
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

// ── CORE DELIVERY ──────────────────────────────────────────────

/**
 * Primary notification dispatch.
 * Creates in-app notification record, sends push if eligible.
 *
 * @param {Object} opts
 *   userId      - recipient user ID
 *   type        - one of NOTIF_TYPES
 *   title       - push/in-app title (max 120 chars)
 *   body        - push/in-app body  (max 500 chars)
 *   data        - deep-link routing { screen, regattaId, raceId, clubId, ... }
 *   imageUrl    - optional image for rich push
 *   groupKey    - optional collapse key (e.g. 'regatta_pcrc26_results')
 *   ttlHours    - expires after N hours (default 2160 = 90 days)
 */
async function dispatch(opts) {
  const {
    userId, type, title, body, data = {}, imageUrl,
    groupKey, ttlHours = 2160,
  } = opts;

  // 1. Get user prefs (or defaults if not yet set)
  const prefs = await getPrefsForUser(userId);

  // 2. Check master switches
  const typePrefs = prefs.types?.[type] || { push: true, inApp: true };

  // 3. Create in-app notification
  let notif = null;
  if (prefs.inAppEnabled && typePrefs.inApp !== false) {
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
    notif = await Notification.create({
      userId, type, title, body, imageUrl, data, groupKey, expiresAt,
    });
  }

  // 4. Send push
  if (prefs.pushEnabled && typePrefs.push !== false) {
    // Quiet hours check
    if (!isQuietHours(prefs)) {
      await sendPushToUser(userId, { title, body, data: { ...data, type }, imageUrl, groupKey });
      if (notif) {
        await Notification.findByIdAndUpdate(notif._id, { 'push.sent': true, 'push.sentAt': new Date() });
      }
    }
  }

  return notif;
}

/**
 * Dispatch to multiple users at once.
 * Used for fanout (e.g. all followers of a club).
 */
async function dispatchToMany(userIds, opts) {
  // Process in batches of 100 to avoid DB overload
  const BATCH = 100;
  const results = [];
  for (let i = 0; i < userIds.length; i += BATCH) {
    const batch = userIds.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(uid => dispatch({ ...opts, userId: uid })));
    results.push(...settled);
  }
  return results;
}

// ── RACE RESULT TRIGGERS ───────────────────────────────────────

/**
 * Called by dataAggregator after results are posted for a race.
 * Fans out to all followers of each club in the results.
 */
async function notifyRaceResultsPosted(raceDoc, regattaDoc) {
  const clubIds = [...new Set(
    raceDoc.results.map(r => r.clubId?.toString()).filter(Boolean)
  )];

  for (const clubId of clubIds) {
    // Get all users following this club
    const follows = await Follow.find({
      targetType: 'club',
      targetId: clubId,
      notificationsEnabled: true,
    }).lean();

    if (!follows.length) continue;

    const club = await require('../models').Club.findById(clubId).lean();
    const clubResult = raceDoc.results.find(r => r.clubId?.toString() === clubId);
    const podium = clubResult?.place <= 3;

    // Standard results notification
    const userIds = follows.map(f => f.userId);
    await dispatchToMany(userIds, {
      type: NOTIF_TYPES.RACE_RESULTS_POSTED,
      title: `${club?.name || 'Your club'} — ${regattaDoc?.shortName || regattaDoc?.name} Results`,
      body: clubResult
        ? `Finished #${clubResult.place} in ${raceDoc.eventName} — ${clubResult.finishTime}`
        : `Results posted for ${raceDoc.eventName}`,
      data: {
        screen: 'raceDetail',
        raceId: raceDoc._id,
        regattaId: regattaDoc._id,
        clubId,
      },
      groupKey: `race_results_${raceDoc._id}`,
      imageUrl: club?.emoji,
    });

    // Podium notification (separate, higher priority)
    if (podium) {
      await dispatchToMany(userIds, {
        type: NOTIF_TYPES.CLUB_PODIUM_FINISH,
        title: `🏆 ${club?.name} — #${clubResult.place} Place!`,
        body: `${raceDoc.eventName} · ${clubResult.finishTime} · ${regattaDoc?.shortName || regattaDoc?.name}`,
        data: {
          screen: 'raceDetail',
          raceId: raceDoc._id,
          regattaId: regattaDoc._id,
          clubId,
        },
        groupKey: `podium_${raceDoc._id}_${clubId}`,
        imageUrl: club?.emoji,
      });
    }
  }
}

/**
 * Called after ELO rerank — notify users when a followed club
 * moves significantly in Speed Order (±3 or more).
 */
async function notifyEloRankChange(clubId, oldRank, newRank) {
  const delta = oldRank - newRank; // positive = moved up
  if (Math.abs(delta) < 3) return; // skip tiny moves

  const follows = await Follow.find({ targetType: 'club', targetId: clubId, notificationsEnabled: true }).lean();
  if (!follows.length) return;

  const club = await require('../models').Club.findById(clubId).lean();
  const direction = delta > 0 ? '▲' : '▼';
  const userIds = follows.map(f => f.userId);

  await dispatchToMany(userIds, {
    type: NOTIF_TYPES.ELO_RANK_CHANGE,
    title: `${club?.name} Speed Order ${direction}${Math.abs(delta)}`,
    body: `Now ranked #${newRank} nationally (was #${oldRank})`,
    data: { screen: 'elo', clubId },
    groupKey: `elo_${clubId}_${Date.now()}`,
  });
}

// ── UPCOMING RACE REMINDERS ────────────────────────────────────

/**
 * Called by cron daily at 6 AM.
 * Sends "race day" alerts for any followed club racing today.
 */
async function sendRaceDayReminders() {
  const { Regatta } = require('../models');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const regattas = await Regatta.find({
    date: { $gte: today, $lt: tomorrow },
    status: { $in: ['upcoming', 'entries_open', 'heat_sheets'] },
  }).lean();

  for (const reg of regattas) {
    await _sendRegattaReminder(reg, NOTIF_TYPES.RACE_DAY_REMINDER, '🚣 Race Day!');
  }
}

/**
 * Called by cron daily at 6 AM.
 * Sends "race week" alerts for regattas exactly 7 days out.
 */
async function sendRaceWeekReminders() {
  const { Regatta } = require('../models');
  const target = new Date();
  target.setDate(target.getDate() + 7);
  target.setHours(0, 0, 0, 0);
  const targetEnd = new Date(target);
  targetEnd.setDate(targetEnd.getDate() + 1);

  const regattas = await Regatta.find({
    date: { $gte: target, $lt: targetEnd },
    status: { $in: ['upcoming', 'entries_open'] },
  }).lean();

  for (const reg of regattas) {
    await _sendRegattaReminder(reg, NOTIF_TYPES.RACE_WEEK_REMINDER, '📅 7 Days Out');
  }
}

/**
 * Notify followers when heat sheets are posted for a regatta.
 */
async function notifyHeatSheetsPosted(regattaId) {
  const { Regatta } = require('../models');
  const reg = await Regatta.findById(regattaId).lean();
  if (!reg) return;
  await _sendRegattaReminder(reg, NOTIF_TYPES.HEAT_SHEETS_POSTED, '📋 Heat Sheets Posted');
}

/**
 * Notify followers ~10 min before a race goes live.
 */
async function notifyLiveRaceStarting(raceDoc, regattaDoc) {
  const clubIds = [...new Set(raceDoc.results.map(r => r.clubId?.toString()).filter(Boolean))];

  for (const clubId of clubIds) {
    const follows = await Follow.find({ targetType: 'club', targetId: clubId, notificationsEnabled: true }).lean();
    if (!follows.length) continue;

    const club = await require('../models').Club.findById(clubId).lean();
    await dispatchToMany(follows.map(f => f.userId), {
      type: NOTIF_TYPES.LIVE_RACE_STARTING,
      title: `🔴 ${raceDoc.eventName} Starting Now`,
      body: `${club?.name || 'Your club'} is about to race at ${regattaDoc?.name}`,
      data: { screen: 'liveTracker', raceId: raceDoc._id, regattaId: regattaDoc._id, clubId },
      groupKey: `live_${raceDoc._id}`,
    });
  }
}

// ── CAMPAIGN & MESSAGE NOTIFICATIONS ──────────────────────────

/**
 * Notify admin when a campaign is sent.
 */
async function notifyCampaignSent(campaignDoc, sentCount) {
  const { Club } = require('../models');
  const club = await Club.findById(campaignDoc.clubId).lean();

  // Find admin users for this club
  const admins = await User.find({ clubIds: campaignDoc.clubId, role: { $in: ['club_admin','super_admin'] } }).lean();
  if (!admins.length) return;

  await dispatchToMany(admins.map(u => u._id), {
    type: NOTIF_TYPES.CAMPAIGN_SENT,
    title: `📧 Campaign Sent — ${club?.name}`,
    body: `Delivered to ${sentCount} supporters: "${campaignDoc.subject}"`,
    data: { screen: 'campaigns', campaignId: campaignDoc._id, clubId: campaignDoc.clubId },
    groupKey: `campaign_sent_${campaignDoc._id}`,
  });
}

/**
 * Notify when a new donation is received.
 */
async function notifyDonationReceived(clubId, amount, donorName) {
  const { Club } = require('../models');
  const club = await Club.findById(clubId).lean();
  const admins = await User.find({ clubIds: clubId, role: { $in: ['club_admin','super_admin'] } }).lean();
  if (!admins.length) return;

  await dispatchToMany(admins.map(u => u._id), {
    type: NOTIF_TYPES.DONATION_RECEIVED,
    title: `💛 New Donation — ${club?.name}`,
    body: `${donorName || 'A supporter'} donated $${amount.toFixed(2)}`,
    data: { screen: 'clubDetail', clubId },
    groupKey: `donation_${clubId}_${Date.now()}`,
  });
}

/**
 * Notify user of a CrewChat message.
 */
async function notifyCrewChatMessage(recipientUserId, senderName, messagePreview, chatRoomId, isMention = false) {
  await dispatch({
    userId: recipientUserId,
    type: isMention ? NOTIF_TYPES.CREW_CHAT_MENTION : NOTIF_TYPES.CREW_CHAT_MESSAGE,
    title: isMention ? `${senderName} mentioned you` : `New message from ${senderName}`,
    body: messagePreview.length > 100 ? messagePreview.slice(0, 100) + '…' : messagePreview,
    data: { screen: 'crewChat', chatRoomId },
    groupKey: `chat_${chatRoomId}`,
    ttlHours: 72,
  });
}

/**
 * Notify when a new supporter joins a club.
 */
async function notifyNewSupporter(clubId, supporterName) {
  const admins = await User.find({ clubIds: clubId, role: { $in: ['club_admin','super_admin'] } }).lean();
  if (!admins.length) return;

  const { Club } = require('../models');
  const club = await Club.findById(clubId).lean();

  await dispatchToMany(admins.map(u => u._id), {
    type: NOTIF_TYPES.NEW_SUPPORTER_JOINED,
    title: `👥 New Supporter — ${club?.name}`,
    body: `${supporterName} joined your supporter list`,
    data: { screen: 'supporterList', clubId },
    groupKey: `supporter_${clubId}`,
    ttlHours: 168,
  });
}

// ── PUSH DELIVERY ──────────────────────────────────────────────

/**
 * Send push to all active devices for a user (Expo push API).
 */
async function sendPushToUser(userId, payload) {
  const tokens = await PushToken.find({ userId, active: true }).lean();
  if (!tokens.length) return [];

  const messages = tokens.map(t => ({
    to: t.token,
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
    sound: 'default',
    badge: 1,
    ...(payload.imageUrl ? { richContent: { image: payload.imageUrl } } : {}),
    ...(payload.groupKey ? { channelId: payload.groupKey } : {}),
    ttl: 86400,  // 24 hours
    priority: 'high',
  }));

  try {
    const { data: response } = await axios.post(EXPO_PUSH_URL, messages, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    });

    // Process receipts and deactivate invalid tokens
    const receipts = Array.isArray(response.data) ? response.data : [response.data];
    await _processReceipts(tokens, receipts);

    return receipts;
  } catch (err) {
    console.error('[PushService] Send error:', err.message);
    return [];
  }
}

/**
 * Send a broadcast push to all users (system announcements).
 * Processes in batches of 100 to respect Expo rate limits.
 */
async function sendBroadcastPush(payload) {
  const allTokens = await PushToken.find({ active: true }).lean();
  const BATCH = 100;

  for (let i = 0; i < allTokens.length; i += BATCH) {
    const batch = allTokens.slice(i, i + BATCH);
    const messages = batch.map(t => ({
      to: t.token,
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      sound: 'default',
    }));

    try {
      await axios.post(EXPO_PUSH_URL, messages, {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error(`[PushService] Broadcast batch ${i} error:`, err.message);
    }

    // Small pause between batches
    if (i + BATCH < allTokens.length) await new Promise(r => setTimeout(r, 200));
  }
}

// ── TOKEN MANAGEMENT ───────────────────────────────────────────

/**
 * Register or update a push token for a device.
 */
async function registerToken(userId, token, platform, deviceId, appVersion) {
  return PushToken.findOneAndUpdate(
    { token },
    {
      $set: { userId, token, platform, deviceId, appVersion, active: true, lastUsedAt: new Date(), failCount: 0 },
    },
    { upsert: true, new: true }
  );
}

/**
 * Deactivate a token (called when user logs out or token expires).
 */
async function deactivateToken(token) {
  return PushToken.findOneAndUpdate({ token }, { active: false });
}

/**
 * Deactivate all tokens for a user (logout all devices).
 */
async function deactivateAllTokens(userId) {
  return PushToken.updateMany({ userId }, { active: false });
}

// ── INBOX MANAGEMENT ──────────────────────────────────────────

/**
 * Get paginated notification inbox for a user.
 */
async function getInbox(userId, opts = {}) {
  const { limit = 30, skip = 0, unreadOnly = false } = opts;
  const filter = { userId, dismissed: false };
  if (unreadOnly) filter.read = false;

  const [notifications, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(Number(limit)).skip(Number(skip)).lean(),
    Notification.countDocuments({ userId, read: false, dismissed: false }),
  ]);

  return { notifications, unreadCount };
}

/**
 * Mark one or all notifications as read.
 */
async function markRead(userId, notifId = null) {
  const filter = { userId };
  if (notifId) filter._id = notifId;
  return Notification.updateMany(filter, { read: true, readAt: new Date() });
}

/**
 * Dismiss (soft-delete) a notification.
 */
async function dismiss(userId, notifId) {
  return Notification.findOneAndUpdate(
    { _id: notifId, userId },
    { dismissed: true, dismissedAt: new Date() }
  );
}

/**
 * Hard-delete notifications older than N days.
 * Can also target a specific type.
 */
async function deleteOld(userId, opts = {}) {
  const { olderThanDays = 30, type = null } = opts;
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000);
  const filter = { userId, createdAt: { $lt: cutoff } };
  if (type) filter.type = type;
  const result = await Notification.deleteMany(filter);
  return { deleted: result.deletedCount };
}

/**
 * Delete all dismissed notifications for a user.
 */
async function clearDismissed(userId) {
  const result = await Notification.deleteMany({ userId, dismissed: true });
  return { deleted: result.deletedCount };
}

// ── PREFERENCES ───────────────────────────────────────────────

/**
 * Get or create default prefs for a user.
 */
async function getPrefsForUser(userId) {
  let prefs = await NotificationPrefs.findOne({ userId }).lean();
  if (!prefs) {
    prefs = await NotificationPrefs.create({ userId });
  }
  return prefs;
}

/**
 * Update notification preferences.
 */
async function updatePrefs(userId, updates) {
  return NotificationPrefs.findOneAndUpdate(
    { userId },
    { $set: updates },
    { upsert: true, new: true }
  );
}

// ── FOLLOWS ───────────────────────────────────────────────────

async function followTarget(userId, targetType, targetId, overrides = {}) {
  return Follow.findOneAndUpdate(
    { userId, targetType, targetId },
    { $set: { userId, targetType, targetId, overrides, notificationsEnabled: true, followedAt: new Date() } },
    { upsert: true, new: true }
  );
}

async function unfollowTarget(userId, targetType, targetId) {
  return Follow.findOneAndDelete({ userId, targetType, targetId });
}

async function getFollows(userId, targetType = null) {
  const filter = { userId };
  if (targetType) filter.targetType = targetType;
  return Follow.find(filter).lean();
}

// ── INTERNAL HELPERS ──────────────────────────────────────────

async function _sendRegattaReminder(reg, type, prefix) {
  // Find all clubs with entries in this regatta (from follows that match upcoming races)
  const follows = await Follow.find({
    targetType: 'regatta',
    targetId: reg._id,
    notificationsEnabled: true,
  }).lean();

  // Also get followers of participating clubs
  // (simplified — in production join with RC entries)
  if (!follows.length) return;

  const userIds = follows.map(f => f.userId);
  await dispatchToMany(userIds, {
    type,
    title: `${prefix} — ${reg.shortName || reg.name}`,
    body: `${reg.name} · ${reg.location} · ${new Date(reg.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`,
    data: { screen: 'upcoming', regattaId: reg._id },
    groupKey: `regatta_reminder_${reg._id}_${type}`,
  });
}

async function _processReceipts(tokens, receipts) {
  const invalidStatuses = ['DeviceNotRegistered', 'InvalidCredentials', 'MessageRateExceeded'];
  const ops = [];

  receipts.forEach((receipt, i) => {
    const token = tokens[i];
    if (!token) return;

    if (receipt.status === 'error' && invalidStatuses.includes(receipt.details?.error)) {
      ops.push({
        updateOne: {
          filter: { _id: token._id },
          update: { $inc: { failCount: 1 }, $set: { active: false } },
        },
      });
    } else if (receipt.status === 'ok') {
      ops.push({
        updateOne: {
          filter: { _id: token._id },
          update: { $set: { failCount: 0, lastUsedAt: new Date() } },
        },
      });
    }
  });

  if (ops.length) await PushToken.bulkWrite(ops);
}

function isQuietHours(prefs) {
  if (!prefs.quietHours?.enabled) return false;
  const now = new Date();
  // Use UTC hour as approximation (proper timezone requires a library like luxon)
  const hour = now.getUTCHours();
  const { startHour, endHour } = prefs.quietHours;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // Wraps midnight (e.g. 22 → 7)
  return hour >= startHour || hour < endHour;
}

module.exports = {
  // Core
  dispatch,
  dispatchToMany,
  // Race results
  notifyRaceResultsPosted,
  notifyEloRankChange,
  notifyLiveRaceStarting,
  // Upcoming
  sendRaceDayReminders,
  sendRaceWeekReminders,
  notifyHeatSheetsPosted,
  // Campaigns & messages
  notifyCampaignSent,
  notifyDonationReceived,
  notifyCrewChatMessage,
  notifyNewSupporter,
  // Push tokens
  registerToken,
  deactivateToken,
  deactivateAllTokens,
  sendBroadcastPush,
  // Inbox
  getInbox,
  markRead,
  dismiss,
  deleteOld,
  clearDismissed,
  // Prefs
  getPrefsForUser,
  updatePrefs,
  // Follows
  followTarget,
  unfollowTarget,
  getFollows,
};
