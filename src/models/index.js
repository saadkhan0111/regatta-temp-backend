/**
 * RegattaStream — MongoDB Schemas (Mongoose)
 * All 9 collections. Import individually or via models/index.js
 *
 * Collections:
 *   clubs, athletes, regattas, races, eloHistory,
 *   campaigns, supporters, ergSessions, boatBay
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────
// 1. CLUBS
// ─────────────────────────────────────────────────────────────
const clubSchema = new Schema({
  name:         { type: String, required: true, index: true },
  abbr:         { type: String, required: true, uppercase: true, maxlength: 6 },
  city:         { type: String, required: true },
  state:        { type: String, required: true },
  region:       { type: String, enum: ['West','East','Midwest','South','International'], default: 'West' },
  type:         { type: String, enum: ['NCAA_D1','NCAA_D2','NCAA_D3','Club','Masters','Junior','HighSchool'], default: 'Club' },
  founded:      { type: Number },
  emoji:        { type: String, default: '🚣' },
  primaryColor: { type: String, default: '#0D1F3C' },
  accentColor:  { type: String, default: '#F0A020' },
  logoUrl:      { type: String },
  coverPhotoUrl:{ type: String },
  website:      { type: String },
  description:  { type: String },

  // Timing partner IDs — used for cross-referencing results
  rcId:         { type: String, index: true },    // RegattaCentral
  herenowId:    { type: String, index: true },    // HereNOW
  crewTimerId:  { type: String },
  regattaMasterId: { type: String },
  usRowingId:   { type: String },

  // Current ELO / Speed Order
  eloScore:     { type: Number, default: 1500 },
  soRank:       { type: Number },

  // Aggregate season stats (recalculated after each race)
  seasonStats: {
    wins:       { type: Number, default: 0 },
    losses:     { type: Number, default: 0 },
    races:      { type: Number, default: 0 },
    topThrees:  { type: Number, default: 0 },
    avgEloDelta:{ type: Number, default: 0 },
  },

  // Subscription / admin
  plan:         { type: String, enum: ['free','pro','club'], default: 'free' },
  stripeCustomerId: { type: String },
  stripeSubscriptionId: { type: String },
  claimedBy:    { type: Schema.Types.ObjectId, ref: 'User' },
  claimedAt:    { type: Date },
  isVerified:   { type: Boolean, default: false },

  // Fundraising
  donateUrl:    { type: String },
  stripeConnectId: { type: String },    // Stripe Connect for direct payouts
  fundraisingEnabled: { type: Boolean, default: false },

  // Name aliases for fuzzy club matching from timing data
  aliases:      [{ type: String }],
}, { timestamps: true });

clubSchema.index({ name: 'text', aliases: 'text' });
const Club = mongoose.model('Club', clubSchema);


// ─────────────────────────────────────────────────────────────
// 2. ATHLETES
// ─────────────────────────────────────────────────────────────
const athleteSchema = new Schema({
  userId:       { type: Schema.Types.ObjectId, ref: 'User' },
  clubId:       { type: Schema.Types.ObjectId, ref: 'Club', index: true },
  firstName:    { type: String, required: true },
  lastName:     { type: String, required: true },
  displayName:  { type: String },
  gradYear:     { type: Number },
  height:       { type: Number },   // inches
  weight:       { type: Number },   // lbs
  side:         { type: String, enum: ['port','starboard','both','scull','cox'] },
  events:       [{ type: String }], // e.g. ['M8+','M4+','M1x']
  eloScore:     { type: Number, default: 1500 },
  soRank:       { type: Number },
  isRecruiting: { type: Boolean, default: false },
  recruitingGpa:    { type: Number },
  recruitingSat:    { type: Number },
  recruitingVideo:  { type: String },
  ergPr2k:          { type: String },   // e.g. '6:48.2'
  flowScoreLatest:  { type: Number },
  avatarUrl:        { type: String },
  isMinor:          { type: Boolean, default: false }, // COPPA flag
  parentEmail:      { type: String },
  consentVerified:  { type: Boolean, default: false },
}, { timestamps: true });

athleteSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});
const Athlete = mongoose.model('Athlete', athleteSchema);


// ─────────────────────────────────────────────────────────────
// 3. REGATTAS
// ─────────────────────────────────────────────────────────────
const regattaSchema = new Schema({
  name:         { type: String, required: true, index: true },
  shortName:    { type: String },
  date:         { type: Date, required: true, index: true },
  endDate:      { type: Date },
  location:     { type: String, required: true },
  city:         { type: String },
  state:        { type: String },
  venueName:    { type: String },
  courseLength: { type: Number, default: 2000 }, // meters

  status: {
    type: String,
    enum: ['upcoming','entries_open','heat_sheets','live','results','cancelled'],
    default: 'upcoming',
    index: true,
  },

  // Timing source
  timingPartner: {
    type: String,
    enum: ['HereNOW','RegattaCentral','CrewTimer','RegattaMaster','Time-Team',
           'RegattaTiming','RowTimer','ClockCaster','Manual','CSV'],
    required: true,
  },
  timingPartnerId: { type: String }, // external ID in that partner's system

  // Entry data
  entryCount:   { type: Number, default: 0 },
  clubCount:    { type: Number, default: 0 },
  eventList:    [{ type: String }], // e.g. ['M8+','W8+','M1x']

  // Sync metadata
  lastSyncAt:   { type: Date },
  syncErrors:   [{ type: String }],
  resultsPostedAt: { type: Date },

  // Campaign trigger — set true when AI campaign auto-fires
  campaignTriggered: { type: Boolean, default: false },

  rcRegattaId:  { type: String },
  herenowRegattaId: { type: String },
}, { timestamps: true });

const Regatta = mongoose.model('Regatta', regattaSchema);


// ─────────────────────────────────────────────────────────────
// 4. RACES (individual event results within a regatta)
// ─────────────────────────────────────────────────────────────
const raceResultSchema = new Schema({
  place:        { type: Number, required: true },
  bow:          { type: String },
  crewName:     { type: String, required: true },
  clubId:       { type: Schema.Types.ObjectId, ref: 'Club' },
  clubName:     { type: String },               // denormalized for speed
  athletes:     [{ type: Schema.Types.ObjectId, ref: 'Athlete' }],
  finishTime:   { type: String, required: true }, // '5:42.1'
  finishMs:     { type: Number },               // milliseconds for sorting/math
  split500:     { type: String },               // '1:25.5'
  marginSec:    { type: Number },               // seconds behind leader (0 for 1st)
  eloBefore:    { type: Number },
  eloAfter:     { type: Number },
  eloDelta:     { type: Number },
  soRankBefore: { type: Number },
  soRankAfter:  { type: Number },
  dnf:          { type: Boolean, default: false },
  dns:          { type: Boolean, default: false },
  dsq:          { type: Boolean, default: false },
}, { _id: false });

const raceSchema = new Schema({
  regattaId:    { type: Schema.Types.ObjectId, ref: 'Regatta', required: true, index: true },
  eventName:    { type: String, required: true }, // 'Men\'s Varsity 8+'
  boatClass:    { type: String, required: true, index: true }, // '8+','4+','1x', etc.
  gender:       { type: String, enum: ['M','W','Mixed'], required: true },
  division:     { type: String }, // 'Varsity','JV','Novice','Junior','Masters','Para'
  heatType:     { type: String, enum: ['heat','semifinal','final_A','final_B','final_C','time_trial'], default: 'final_A' },
  heatNum:      { type: Number, default: 1 },
  raceDate:     { type: Date },
  raceTime:     { type: String }, // scheduled start time '09:30'
  courseLength: { type: Number, default: 2000 },
  conditions:   { type: String }, // weather/water notes

  results:      [raceResultSchema],

  // AI-generated race story
  story: {
    headline:   { type: String },
    body:       { type: String },
    generatedAt:{ type: Date },
    model:      { type: String, default: 'claude-sonnet-4-20250514' },
  },

  // Source tracking
  timingSource: { type: String },
  externalId:   { type: String },   // ID in timing partner's system
  rawData:      { type: Schema.Types.Mixed }, // original payload for debugging
}, { timestamps: true });

raceSchema.index({ regattaId: 1, boatClass: 1, gender: 1, heatType: 1 });
raceSchema.index({ 'results.clubId': 1 });
const Race = mongoose.model('Race', raceSchema);


// ─────────────────────────────────────────────────────────────
// 5. ELO HISTORY (Speed Order time series per club/boat class)
// ─────────────────────────────────────────────────────────────
const eloHistorySchema = new Schema({
  clubId:       { type: Schema.Types.ObjectId, ref: 'Club', required: true, index: true },
  boatClass:    { type: String, required: true },
  gender:       { type: String, enum: ['M','W','Mixed'], required: true },
  raceId:       { type: Schema.Types.ObjectId, ref: 'Race', required: true },
  regattaId:    { type: Schema.Types.ObjectId, ref: 'Regatta' },
  date:         { type: Date, required: true, index: true },
  eloBefore:    { type: Number, required: true },
  eloAfter:     { type: Number, required: true },
  eloDelta:     { type: Number, required: true },
  soRankBefore: { type: Number },
  soRankAfter:  { type: Number },
  place:        { type: Number },
  finishTime:   { type: String },
}, { timestamps: true });

eloHistorySchema.index({ clubId: 1, boatClass: 1, gender: 1, date: -1 });
const EloHistory = mongoose.model('EloHistory', eloHistorySchema);


// ─────────────────────────────────────────────────────────────
// 6. CAMPAIGNS (email campaigns sent to supporters)
// ─────────────────────────────────────────────────────────────
const campaignSchema = new Schema({
  clubId:       { type: Schema.Types.ObjectId, ref: 'Club', required: true, index: true },
  createdBy:    { type: Schema.Types.ObjectId, ref: 'User' },

  type: {
    type: String,
    enum: ['results','preview','weekly','season_recap','custom'],
    required: true,
  },

  subject:      { type: String, required: true },
  previewText:  { type: String },   // email preview / snippet
  htmlBody:     { type: String },   // full rendered HTML

  // Data sources wired into this campaign
  regattaId:    { type: Schema.Types.ObjectId, ref: 'Regatta' },
  raceIds:      [{ type: Schema.Types.ObjectId, ref: 'Race' }],

  // Content toggles
  includes: {
    timingData:     { type: Boolean, default: true },
    eloRankings:    { type: Boolean, default: true },
    seasonHistory:  { type: Boolean, default: true },
    upcomingRaces:  { type: Boolean, default: true },
    appCta:         { type: Boolean, default: true },
    donateButton:   { type: Boolean, default: true },
  },

  // Audience
  audience: {
    segment: { type: String, enum: ['all','parents','alumni','donors','athletes'], default: 'all' },
    recipientCount: { type: Number, default: 0 },
    suppressedCount: { type: Number, default: 0 },
  },

  status: {
    type: String,
    enum: ['draft','scheduled','sending','sent','failed','cancelled'],
    default: 'draft',
    index: true,
  },

  scheduledAt:  { type: Date },
  sentAt:       { type: Date },

  // Delivery analytics (updated via webhook or polling)
  analytics: {
    delivered:    { type: Number, default: 0 },
    opens:        { type: Number, default: 0 },
    uniqueOpens:  { type: Number, default: 0 },
    clicks:       { type: Number, default: 0 },
    uniqueClicks: { type: Number, default: 0 },
    appInstalls:  { type: Number, default: 0 },   // tracked via UTM + app open
    donations:    { type: Number, default: 0 },   // donations attributed to campaign
    donationAmt:  { type: Number, default: 0 },   // total dollars
    unsubscribes: { type: Number, default: 0 },
    bounces:      { type: Number, default: 0 },
    spamReports:  { type: Number, default: 0 },
    openRate:     { type: Number, default: 0 },   // recalculated on update
    clickRate:    { type: Number, default: 0 },
  },

  // AI-generated copy (subject line, preview text, body snippets)
  aiGenerated:  { type: Boolean, default: false },
  aiModel:      { type: String },

  // SendGrid / Nodemailer message IDs for tracking
  externalMessageIds: [{ type: String }],
}, { timestamps: true });

campaignSchema.index({ clubId: 1, status: 1, sentAt: -1 });
const Campaign = mongoose.model('Campaign', campaignSchema);


// ─────────────────────────────────────────────────────────────
// 7. SUPPORTERS (email list per club)
// ─────────────────────────────────────────────────────────────
const supporterSchema = new Schema({
  clubId:       { type: Schema.Types.ObjectId, ref: 'Club', required: true, index: true },
  email:        { type: String, required: true, lowercase: true },
  firstName:    { type: String },
  lastName:     { type: String },

  role: {
    type: String,
    enum: ['parent','alumni','donor','athlete','fan','coach','other'],
    default: 'fan',
  },

  source: {
    type: String,
    enum: ['qr_scan','share_link','app_signup','email_invite','csv_import','rc_import','manual'],
    required: true,
  },

  sourceDetail: { type: String },   // e.g. QR code ID, share link campaign ID
  referredBy:   { type: Schema.Types.ObjectId, ref: 'Supporter' },

  subscribed:     { type: Boolean, default: true, index: true },
  unsubscribedAt: { type: Date },
  unsubscribeReason: { type: String },

  // COPPA — minor-linked parent account
  isParentAccount:  { type: Boolean, default: false },
  linkedAthleteId:  { type: Schema.Types.ObjectId, ref: 'Athlete' },
  consentVerified:  { type: Boolean, default: false },
  consentAt:        { type: Date },

  // Engagement stats (recalculated from campaign events)
  engagementStats: {
    campaignsSent:    { type: Number, default: 0 },
    campaignsOpened:  { type: Number, default: 0 },
    linksClicked:     { type: Number, default: 0 },
    appInstalled:     { type: Boolean, default: false },
    appInstalledAt:   { type: Date },
    donated:          { type: Boolean, default: false },
    donationTotal:    { type: Number, default: 0 },
    lastOpenAt:       { type: Date },
    lastClickAt:      { type: Date },
  },

  // Custom tags (e.g. 'parent_of_varsity', 'donor_2026')
  tags:           [{ type: String }],

  stripeCustomerId: { type: String },
}, { timestamps: true });

supporterSchema.index({ clubId: 1, email: 1 }, { unique: true });
supporterSchema.index({ clubId: 1, subscribed: 1, role: 1 });
const Supporter = mongoose.model('Supporter', supporterSchema);


// ─────────────────────────────────────────────────────────────
// 8. ERG SESSIONS
// ─────────────────────────────────────────────────────────────
const ergSessionSchema = new Schema({
  athleteId:    { type: Schema.Types.ObjectId, ref: 'Athlete', required: true, index: true },
  clubId:       { type: Schema.Types.ObjectId, ref: 'Club', index: true },
  sessionDate:  { type: Date, required: true },

  pieceType:    { type: String, required: true }, // '2K Test', '4x1K', '60\' SS', etc.
  distance:     { type: Number },   // meters (null for timed pieces)
  duration:     { type: Number },   // seconds (null for distance pieces)

  avgSplit:     { type: String },   // '1:42.3' formatted
  avgSplitMs:   { type: Number },   // raw ms per 500m for math
  avgWatts:     { type: Number },
  peakWatts:    { type: Number },
  avgSpm:       { type: Number },   // strokes per minute
  avgHr:        { type: Number },
  peakHr:       { type: Number },
  spi:          { type: Number },   // Stroke Power Index
  dragFactor:   { type: Number },

  is2kPr:       { type: Boolean, default: false },  // is this athlete's PR?
  isPr:         { type: Boolean, default: false },   // PR for this piece type
  verifiedBy:   { type: Schema.Types.ObjectId, ref: 'User' },  // coach verified
  verifiedAt:   { type: Date },
  verified:     { type: Boolean, default: false },

  // OCR source (PM5 screenshot auto-import)
  ocrSource:    { type: Boolean, default: false },
  ocrImageUrl:  { type: String },
  ocrConfidence:{ type: Number },   // 0–1

  // Concept2 logbook sync
  c2LogbookId:  { type: String },

  notes:        { type: String },
}, { timestamps: true });

ergSessionSchema.index({ athleteId: 1, sessionDate: -1 });
const ErgSession = mongoose.model('ErgSession', ergSessionSchema);


// ─────────────────────────────────────────────────────────────
// 9. BOAT BAY
// ─────────────────────────────────────────────────────────────
const boatBaySchema = new Schema({
  clubId:       { type: Schema.Types.ObjectId, ref: 'Club', required: true, index: true },
  name:         { type: String, required: true },   // 'Varsity 8+'
  manufacturer: { type: String },                   // 'WinTech', 'Concept2 Alden'
  model:        { type: String },
  year:         { type: Number },
  boatClass:    { type: String, required: true },   // '8+','4+','1x', etc.
  gender:       { type: String, enum: ['M','W','Coed'] },

  status: {
    type: String,
    enum: ['available','on_water','in_repair','retired','reserved'],
    default: 'available',
    index: true,
  },

  currentCrewId:  { type: Schema.Types.ObjectId, ref: 'Athlete' },
  checkedOutAt:   { type: Date },
  expectedReturn: { type: Date },

  condition: {
    overall:    { type: Number, min: 1, max: 5, default: 5 },  // 1=poor, 5=excellent
    hull:       { type: Number, min: 1, max: 5, default: 5 },
    riggers:    { type: Number, min: 1, max: 5, default: 5 },
    footstretchers: { type: Number, min: 1, max: 5, default: 5 },
  },

  maintenanceLogs: [{
    date:     { type: Date, default: Date.now },
    type:     { type: String, enum: ['inspection','repair','cleaning','rigging'] },
    notes:    { type: String },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  }],

  damageReports: [{
    reportedAt:   { type: Date, default: Date.now },
    reportedBy:   { type: Schema.Types.ObjectId, ref: 'User' },
    description:  { type: String },
    photoUrls:    [{ type: String }],
    severity:     { type: String, enum: ['minor','moderate','major'] },
    resolved:     { type: Boolean, default: false },
    resolvedAt:   { type: Date },
  }],

  notes:        { type: String },
}, { timestamps: true });

const BoatBay = mongoose.model('BoatBay', boatBaySchema);


// ─────────────────────────────────────────────────────────────
// 10. USERS (auth)
// ─────────────────────────────────────────────────────────────
const userSchema = new Schema({
  email:        { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String },
  firstName:    { type: String, required: true },
  lastName:     { type: String, required: true },
  role:         { type: String, enum: ['athlete','coach','club_admin','super_admin'], default: 'athlete' },
  clubIds:      [{ type: Schema.Types.ObjectId, ref: 'Club' }],
  athleteId:    { type: Schema.Types.ObjectId, ref: 'Athlete' },
  avatarUrl:    { type: String },
  lastLoginAt:  { type: Date },
  isMinor:      { type: Boolean, default: false },
  parentEmail:  { type: String },
  appleId:      { type: String },
  googleId:     { type: String },
  pushTokens:   [{ type: String }],  // for push notifications
}, { timestamps: true });

const User = mongoose.model('User', userSchema);


module.exports = { Club, Athlete, Regatta, Race, EloHistory, Campaign, Supporter, ErgSession, BoatBay, User };
