/**
 * RegattaStream — Notification Models
 * Covers:
 *   Notification       — per-user inbox (in-app + push record)
 *   NotificationPrefs  — per-user granular preference settings
 *   PushToken          — device push tokens (Expo / APNs / FCM)
 *   Follow             — user follows a club or regatta
 */

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────
// NOTIFICATION TYPES (shared constant — import on both sides)
// ─────────────────────────────────────────────────────────────
const NOTIF_TYPES = {
  // Results
  RACE_RESULTS_POSTED:      'race_results_posted',       // results are live
  CLUB_PODIUM_FINISH:       'club_podium_finish',         // club you follow got 1-3
  ELO_RANK_CHANGE:          'elo_rank_change',            // club moved in Speed Order

  // Upcoming / schedule
  RACE_DAY_REMINDER:        'race_day_reminder',          // day-of alert for followed club
  RACE_WEEK_REMINDER:       'race_week_reminder',         // 7 days out
  ENTRIES_CONFIRMED:        'entries_confirmed',           // club's entries confirmed at regatta
  HEAT_SHEETS_POSTED:       'heat_sheets_posted',          // heat sheets / draw available
  LIVE_RACE_STARTING:       'live_race_starting',          // ~10 min before boat launches

  // Campaigns & messaging
  CAMPAIGN_SENT:            'campaign_sent',              // email campaign sent (admin)
  NEW_CAMPAIGN_RECEIVED:    'new_campaign_received',      // supporter received a campaign
  CREW_CHAT_MESSAGE:        'crew_chat_message',          // CrewChat new message
  CREW_CHAT_MENTION:        'crew_chat_mention',          // @mention in chat

  // Club / admin
  CLUB_CLAIMED:             'club_claimed',               // someone claimed a club
  NEW_SUPPORTER_JOINED:     'new_supporter_joined',       // new supporter added
  SUPPORTER_MILESTONE:      'supporter_milestone',        // e.g. 100 supporters
  DONATION_RECEIVED:        'donation_received',          // donation made to club

  // App / system
  APP_UPDATE:               'app_update',                 // new app version
  SYSTEM_ANNOUNCEMENT:      'system_announcement',        // broadcast from RS team
};

// ─────────────────────────────────────────────────────────────
// 1. NOTIFICATION (inbox item per user)
// ─────────────────────────────────────────────────────────────
const notificationSchema = new Schema({
  userId:       { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  type:         { type: String, enum: Object.values(NOTIF_TYPES), required: true },
  title:        { type: String, required: true, maxlength: 120 },
  body:         { type: String, required: true, maxlength: 500 },
  imageUrl:     { type: String },    // club emoji / logo for rich push

  // Deep-link routing data (frontend reads this to navigate)
  data: {
    screen:     { type: String },    // e.g. 'raceDetail', 'clubDetail', 'crewChat'
    regattaId:  { type: Schema.Types.ObjectId, ref: 'Regatta' },
    raceId:     { type: Schema.Types.ObjectId, ref: 'Race' },
    clubId:     { type: Schema.Types.ObjectId, ref: 'Club' },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign' },
    chatRoomId: { type: String },
    messageId:  { type: String },
    extra:      { type: Schema.Types.Mixed },
  },

  // Delivery state
  read:         { type: Boolean, default: false, index: true },
  readAt:       { type: Date },
  dismissed:    { type: Boolean, default: false },
  dismissedAt:  { type: Date },

  // Push delivery record
  push: {
    sent:       { type: Boolean, default: false },
    sentAt:     { type: Date },
    receipts:   [{ tokenId: String, status: String, error: String }],
  },

  // For grouping (e.g. collapse multiple results from same regatta)
  groupKey:     { type: String, index: true },

  expiresAt:    { type: Date },   // auto-delete after this date (TTL index below)
}, {
  timestamps: true,
});

// Auto-delete notifications older than 90 days
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Fast inbox queries
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, dismissed: 1, createdAt: -1 });

const Notification = mongoose.model('Notification', notificationSchema);


// ─────────────────────────────────────────────────────────────
// 2. NOTIFICATION PREFERENCES (per user, granular control)
// ─────────────────────────────────────────────────────────────
const channelPrefsSchema = new Schema({
  push:  { type: Boolean, default: true },
  inApp: { type: Boolean, default: true },
  email: { type: Boolean, default: false },
}, { _id: false });

const notificationPrefsSchema = new Schema({
  userId:   { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  // Master switches
  pushEnabled:  { type: Boolean, default: true },
  inAppEnabled: { type: Boolean, default: true },
  emailEnabled: { type: Boolean, default: false },

  // Quiet hours (local time — frontend sends timezone)
  quietHours: {
    enabled:   { type: Boolean, default: false },
    startHour: { type: Number, default: 22, min: 0, max: 23 },  // 10 PM
    endHour:   { type: Number, default: 7,  min: 0, max: 23 },  // 7 AM
    timezone:  { type: String, default: 'America/Los_Angeles' },
  },

  // Per-type preferences
  types: {
    // Results
    race_results_posted:      { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: false }) },
    club_podium_finish:       { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: false }) },
    elo_rank_change:          { type: channelPrefsSchema, default: () => ({ push: false, inApp: true,  email: false }) },

    // Upcoming / schedule
    race_day_reminder:        { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: true  }) },
    race_week_reminder:       { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: false }) },
    entries_confirmed:        { type: channelPrefsSchema, default: () => ({ push: false, inApp: true,  email: false }) },
    heat_sheets_posted:       { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: false }) },
    live_race_starting:       { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: false }) },

    // Campaigns & messaging
    campaign_sent:            { type: channelPrefsSchema, default: () => ({ push: false, inApp: true,  email: false }) },
    new_campaign_received:    { type: channelPrefsSchema, default: () => ({ push: false, inApp: false, email: false }) },
    crew_chat_message:        { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: false }) },
    crew_chat_mention:        { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: true  }) },

    // Club / admin
    club_claimed:             { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: true  }) },
    new_supporter_joined:     { type: channelPrefsSchema, default: () => ({ push: false, inApp: true,  email: false }) },
    supporter_milestone:      { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: false }) },
    donation_received:        { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: true  }) },

    // System
    app_update:               { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: false }) },
    system_announcement:      { type: channelPrefsSchema, default: () => ({ push: true,  inApp: true,  email: false }) },
  },
}, { timestamps: true });

const NotificationPrefs = mongoose.model('NotificationPrefs', notificationPrefsSchema);


// ─────────────────────────────────────────────────────────────
// 3. PUSH TOKEN (one per device per user)
// ─────────────────────────────────────────────────────────────
const pushTokenSchema = new Schema({
  userId:    { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  token:     { type: String, required: true },  // Expo push token or raw FCM/APNs
  platform:  { type: String, enum: ['ios', 'android', 'web'], required: true },
  provider:  { type: String, enum: ['expo', 'fcm', 'apns'], default: 'expo' },
  deviceId:  { type: String },   // unique device identifier for dedup
  appVersion:{ type: String },
  active:    { type: Boolean, default: true, index: true },
  lastUsedAt:{ type: Date, default: Date.now },
  failCount: { type: Number, default: 0 },  // increment on send failure; deactivate at 3
}, { timestamps: true });

pushTokenSchema.index({ token: 1 }, { unique: true });
pushTokenSchema.index({ userId: 1, active: 1 });

const PushToken = mongoose.model('PushToken', pushTokenSchema);


// ─────────────────────────────────────────────────────────────
// 4. FOLLOW (user follows a club or regatta)
// ─────────────────────────────────────────────────────────────
const followSchema = new Schema({
  userId:      { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  targetType:  { type: String, enum: ['club', 'regatta', 'athlete'], required: true },
  targetId:    { type: Schema.Types.ObjectId, required: true, index: true },

  // Granular notification overrides for this specific follow
  // If not set, falls back to NotificationPrefs.types[type]
  overrides: {
    race_results_posted:  { type: Boolean },
    race_day_reminder:    { type: Boolean },
    race_week_reminder:   { type: Boolean },
    heat_sheets_posted:   { type: Boolean },
    live_race_starting:   { type: Boolean },
    elo_rank_change:      { type: Boolean },
  },

  notificationsEnabled: { type: Boolean, default: true },
  followedAt: { type: Date, default: Date.now },
}, { timestamps: true });

followSchema.index({ userId: 1, targetType: 1, targetId: 1 }, { unique: true });

const Follow = mongoose.model('Follow', followSchema);


module.exports = { Notification, NotificationPrefs, PushToken, Follow, NOTIF_TYPES };
