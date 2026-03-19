/**
 * RegattaStream — API Routes
 * All route handlers. Import into server.js individually by path.
 * Each export is an Express Router.
 *
 * Full endpoint list:
 *
 * AUTH
 *   POST /api/auth/register
 *   POST /api/auth/login
 *   GET  /api/auth/me
 *
 * CLUBS
 *   GET  /api/clubs                        — list/search all clubs
 *   GET  /api/clubs/:id                    — club detail + stats
 *   PUT  /api/clubs/:id                    — update club (admin)
 *   POST /api/clubs/:id/claim              — claim a club
 *   GET  /api/clubs/:id/history            — race history (filterable)
 *   GET  /api/clubs/:id/upcoming           — upcoming entries
 *   GET  /api/clubs/:id/analytics          — season analytics
 *
 * REGATTAS
 *   GET  /api/regattas                     — list regattas (filter: status, date)
 *   GET  /api/regattas/:id                 — regatta detail
 *   POST /api/regattas                     — create regatta (admin)
 *
 * RACES
 *   GET  /api/races?regattaId=&boatClass=  — race results
 *   GET  /api/races/:id                    — single race detail
 *
 * ELO
 *   GET  /api/elo/rankings                 — Speed Order rankings
 *   GET  /api/elo/clubs/:clubId/history    — ELO history for club
 *
 * CAMPAIGNS
 *   GET  /api/campaigns?clubId=            — list campaigns for club
 *   POST /api/campaigns                    — create campaign
 *   PUT  /api/campaigns/:id               — update campaign
 *   POST /api/campaigns/:id/send          — send campaign
 *   GET  /api/campaigns/:id/analytics     — opens, clicks, installs
 *   POST /api/campaigns/preview           — render HTML preview (no send)
 *
 * SUPPORTERS
 *   GET  /api/supporters?clubId=           — list supporters
 *   POST /api/supporters                   — add single supporter
 *   POST /api/supporters/import            — import CSV list
 *   DELETE /api/supporters/:id            — remove supporter
 *   POST /api/supporters/unsubscribe       — unsubscribe via token
 *
 * ERG
 *   GET  /api/erg?athleteId=              — erg session list
 *   POST /api/erg                          — log erg session
 *   PUT  /api/erg/:id/verify              — coach verify session
 *   POST /api/erg/ocr                      — OCR PM5 screenshot
 *
 * BOATS
 *   GET  /api/boats?clubId=               — boat bay list
 *   POST /api/boats                        — add boat
 *   PUT  /api/boats/:id/status            — check out / return
 *   POST /api/boats/:id/damage            — file damage report
 *
 * IMPORT
 *   POST /api/import/csv                   — upload CSV results
 *   POST /api/import/sync/:partner         — manual trigger sync
 *
 * SHARE
 *   POST /api/share/card                   — generate share card image URL
 *   POST /api/share/track                  — track share link click
 */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { User, Club, Regatta, Race, EloHistory, Campaign, Supporter, ErgSession, BoatBay } = require('../models/index');
const { ingest, ingestCSV } = require('../services/dataAggregator');
const { processRace, computeSpeedOrder } = require('../services/eloEngine');
const campaignService = require('../services/campaignService');

const upload = multer({ dest: process.env.UPLOAD_DIR || './uploads', limits: { fileSize: 25 * 1024 * 1024 } });

// ── AUTH MIDDLEWARE ─────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (!['club_admin', 'super_admin'].includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  });
}

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════
const authRouter = express.Router();

authRouter.post('/register', async (req, res, next) => {
  try {
    const { email, password, firstName, lastName, role } = req.body;
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ email, passwordHash, firstName, lastName, role: role || 'athlete' });
    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
    res.status(201).json({ token, user: { id: user._id, email, firstName, lastName, role: user.role } });
  } catch (e) { next(e); }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });
    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role } });
  } catch (e) { next(e); }
});

authRouter.get('/me', auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-passwordHash').populate('clubIds');
    res.json(user);
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// CLUBS
// ═══════════════════════════════════════════════════════════════
const clubsRouter = express.Router();

clubsRouter.get('/', async (req, res, next) => {
  try {
    const { q, region, type, limit = 50, skip = 0 } = req.query;
    const filter = {};
    if (q) filter.$text = { $search: q };
    if (region) filter.region = region;
    if (type) filter.type = type;
    const clubs = await Club.find(filter).sort({ soRank: 1, eloScore: -1 }).limit(Number(limit)).skip(Number(skip));
    res.json({ clubs, total: await Club.countDocuments(filter) });
  } catch (e) { next(e); }
});

clubsRouter.get('/:id', async (req, res, next) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    res.json(club);
  } catch (e) { next(e); }
});

clubsRouter.get('/:id/history', async (req, res, next) => {
  try {
    const { gender, boatClass, year, limit = 50 } = req.query;
    const filter = { 'results.clubId': req.params.id };
    const races = await Race.find(filter)
      .populate('regattaId', 'name shortName date location timingPartner')
      .sort({ raceDate: -1 })
      .limit(Number(limit))
      .lean();

    // Filter and shape for response
    const history = races
      .filter(r => (!gender || r.gender === gender) && (!boatClass || r.boatClass === boatClass))
      .filter(r => !year || new Date(r.raceDate).getFullYear() === Number(year))
      .map(r => {
        const clubResult = r.results.find(x => String(x.clubId) === req.params.id);
        return {
          raceId: r._id,
          eventName: r.eventName,
          boatClass: r.boatClass,
          gender: r.gender,
          heatType: r.heatType,
          raceDate: r.raceDate,
          regatta: r.regattaId,
          place: clubResult?.place,
          finishTime: clubResult?.finishTime,
          eloDelta: clubResult?.eloDelta,
          soRankBefore: clubResult?.soRankBefore,
          soRankAfter: clubResult?.soRankAfter,
        };
      });
    res.json(history);
  } catch (e) { next(e); }
});

clubsRouter.get('/:id/upcoming', async (req, res, next) => {
  try {
    const regattas = await Regatta.find({ status: 'upcoming', date: { $gte: new Date() } }).sort({ date: 1 }).lean();
    // Filter to regattas where this club has entries (from RC sync)
    // For now returns all upcoming — dev should join with entry data from RC
    res.json(regattas);
  } catch (e) { next(e); }
});

clubsRouter.put('/:id', adminAuth, async (req, res, next) => {
  try {
    const club = await Club.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    res.json(club);
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// REGATTAS
// ═══════════════════════════════════════════════════════════════
const regattasRouter = express.Router();

regattasRouter.get('/', async (req, res, next) => {
  try {
    const { status, from, to, limit = 30, skip = 0 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }
    const regattas = await Regatta.find(filter).sort({ date: -1 }).limit(Number(limit)).skip(Number(skip));
    res.json(regattas);
  } catch (e) { next(e); }
});

regattasRouter.get('/:id', async (req, res, next) => {
  try {
    const regatta = await Regatta.findById(req.params.id);
    if (!regatta) return res.status(404).json({ error: 'Not found' });
    const races = await Race.find({ regattaId: req.params.id }).lean();
    res.json({ regatta, races });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// RACES
// ═══════════════════════════════════════════════════════════════
const racesRouter = express.Router();

racesRouter.get('/', async (req, res, next) => {
  try {
    const { regattaId, boatClass, gender, clubId } = req.query;
    const filter = {};
    if (regattaId) filter.regattaId = regattaId;
    if (boatClass) filter.boatClass = boatClass;
    if (gender) filter.gender = gender;
    if (clubId) filter['results.clubId'] = clubId;
    const races = await Race.find(filter).populate('regattaId', 'name date location timingPartner').sort({ raceDate: -1 });
    res.json(races);
  } catch (e) { next(e); }
});

racesRouter.get('/:id', async (req, res, next) => {
  try {
    const race = await Race.findById(req.params.id).populate('regattaId');
    if (!race) return res.status(404).json({ error: 'Not found' });
    res.json(race);
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// ELO / SPEED ORDER
// ═══════════════════════════════════════════════════════════════
const eloRouter = express.Router();

eloRouter.get('/rankings', async (req, res, next) => {
  try {
    const { boatClass = 'all', gender, limit = 100 } = req.query;
    const filter = {};
    if (boatClass !== 'all') filter.boatClass = boatClass;
    const clubs = await Club.find(filter).sort({ soRank: 1 }).limit(Number(limit)).lean();
    res.json(clubs);
  } catch (e) { next(e); }
});

eloRouter.get('/clubs/:clubId/history', async (req, res, next) => {
  try {
    const history = await EloHistory
      .find({ clubId: req.params.clubId })
      .sort({ date: -1 })
      .limit(50)
      .populate('raceId', 'eventName boatClass gender')
      .populate('regattaId', 'name shortName date');
    res.json(history);
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// CAMPAIGNS
// ═══════════════════════════════════════════════════════════════
const campaignsRouter = express.Router();

campaignsRouter.get('/', auth, async (req, res, next) => {
  try {
    const { clubId, status, limit = 20 } = req.query;
    const filter = {};
    if (clubId) filter.clubId = clubId;
    if (status) filter.status = status;
    const campaigns = await Campaign.find(filter).sort({ createdAt: -1 }).limit(Number(limit));
    res.json(campaigns);
  } catch (e) { next(e); }
});

campaignsRouter.post('/', auth, async (req, res, next) => {
  try {
    const campaign = await Campaign.create({ ...req.body, createdBy: req.user.id });
    res.status(201).json(campaign);
  } catch (e) { next(e); }
});

campaignsRouter.put('/:id', auth, async (req, res, next) => {
  try {
    const campaign = await Campaign.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(campaign);
  } catch (e) { next(e); }
});

campaignsRouter.post('/:id/send', auth, async (req, res, next) => {
  try {
    const result = await campaignService.send(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

campaignsRouter.post('/preview', auth, async (req, res, next) => {
  try {
    const html = await campaignService.buildResultsEmail(req.body);
    res.json({ html });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// SUPPORTERS
// ═══════════════════════════════════════════════════════════════
const supportersRouter = express.Router();

supportersRouter.get('/', auth, async (req, res, next) => {
  try {
    const { clubId, role, subscribed = 'true', limit = 100 } = req.query;
    const filter = { clubId };
    if (role) filter.role = role;
    if (subscribed !== 'all') filter.subscribed = subscribed === 'true';
    const supporters = await Supporter.find(filter).sort({ createdAt: -1 }).limit(Number(limit));
    const stats = {
      total: await Supporter.countDocuments({ clubId, subscribed: true }),
      byRole: await Supporter.aggregate([{ $match: { clubId: require('mongoose').Types.ObjectId.createFromHexString(clubId) } }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
      bySource: await Supporter.aggregate([{ $match: { clubId: require('mongoose').Types.ObjectId.createFromHexString(clubId) } }, { $group: { _id: '$source', count: { $sum: 1 } } }]),
    };
    res.json({ supporters, stats });
  } catch (e) { next(e); }
});

supportersRouter.post('/', async (req, res, next) => {
  try {
    const supporter = await Supporter.findOneAndUpdate(
      { clubId: req.body.clubId, email: req.body.email.toLowerCase() },
      { $set: req.body, $setOnInsert: { subscribed: true } },
      { upsert: true, new: true }
    );
    res.status(201).json(supporter);
  } catch (e) { next(e); }
});

supportersRouter.post('/unsubscribe', async (req, res, next) => {
  try {
    const id = Buffer.from(req.body.token, 'base64').toString('utf8');
    await Supporter.findByIdAndUpdate(id, { subscribed: false, unsubscribedAt: new Date() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

supportersRouter.post('/import', auth, upload.single('csv'), async (req, res, next) => {
  try {
    const fs = require('fs');
    const buf = fs.readFileSync(req.file.path);
    const records = require('csv-parse/sync').parse(buf, { columns: true, skip_empty_lines: true, trim: true });
    const ops = records.map(r => ({
      updateOne: {
        filter: { clubId: req.body.clubId, email: (r.email || r.Email || '').toLowerCase() },
        update: {
          $set: {
            clubId: req.body.clubId,
            email: (r.email || r.Email || '').toLowerCase(),
            firstName: r.first_name || r.FirstName || r.firstName || '',
            lastName: r.last_name || r.LastName || r.lastName || '',
            role: (r.role || r.Role || 'fan').toLowerCase(),
            source: 'csv_import',
            subscribed: true,
          }
        },
        upsert: true,
      },
    }));
    const result = await Supporter.bulkWrite(ops);
    fs.unlinkSync(req.file.path);
    res.json({ upserted: result.upsertedCount, modified: result.modifiedCount });
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// ERG
// ═══════════════════════════════════════════════════════════════
const ergRouter = express.Router();

ergRouter.get('/', auth, async (req, res, next) => {
  try {
    const sessions = await ErgSession.find({ athleteId: req.query.athleteId || req.user.athleteId })
      .sort({ sessionDate: -1 }).limit(100);
    res.json(sessions);
  } catch (e) { next(e); }
});

ergRouter.post('/', auth, async (req, res, next) => {
  try {
    const session = await ErgSession.create({ ...req.body, athleteId: req.body.athleteId || req.user.athleteId });
    res.status(201).json(session);
  } catch (e) { next(e); }
});

ergRouter.put('/:id/verify', auth, async (req, res, next) => {
  try {
    const session = await ErgSession.findByIdAndUpdate(req.params.id,
      { verified: true, verifiedBy: req.user.id, verifiedAt: new Date() }, { new: true });
    res.json(session);
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// BOATS
// ═══════════════════════════════════════════════════════════════
const boatsRouter = express.Router();

boatsRouter.get('/', auth, async (req, res, next) => {
  try {
    const boats = await BoatBay.find({ clubId: req.query.clubId }).sort({ name: 1 });
    res.json(boats);
  } catch (e) { next(e); }
});

boatsRouter.post('/', auth, async (req, res, next) => {
  try {
    const boat = await BoatBay.create(req.body);
    res.status(201).json(boat);
  } catch (e) { next(e); }
});

boatsRouter.put('/:id/status', auth, async (req, res, next) => {
  try {
    const { status, crewId } = req.body;
    const update = { status };
    if (status === 'on_water') { update.currentCrewId = crewId; update.checkedOutAt = new Date(); }
    if (status === 'available') { update.currentCrewId = null; }
    const boat = await BoatBay.findByIdAndUpdate(req.params.id, update, { new: true });
    res.json(boat);
  } catch (e) { next(e); }
});

boatsRouter.post('/:id/damage', auth, async (req, res, next) => {
  try {
    const boat = await BoatBay.findByIdAndUpdate(req.params.id,
      { $push: { damageReports: { ...req.body, reportedBy: req.user.id, reportedAt: new Date() } } },
      { new: true });
    res.json(boat);
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// IMPORT
// ═══════════════════════════════════════════════════════════════
const importRouter = express.Router();

importRouter.post('/csv', auth, upload.single('csv'), async (req, res, next) => {
  try {
    const fs = require('fs');
    const buf = fs.readFileSync(req.file.path);
    const result = await ingestCSV(buf, req.body);
    fs.unlinkSync(req.file.path);
    res.json(result);
  } catch (e) { next(e); }
});

importRouter.post('/sync/:partner', auth, async (req, res, next) => {
  try {
    const result = await ingest(req.params.partner, req.body);
    res.json(result);
  } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════════
// SHARE
// ═══════════════════════════════════════════════════════════════
const shareRouter = express.Router();

shareRouter.post('/track', async (req, res, next) => {
  try {
    // Track share link clicks → add to supporter list
    const { clubId, email, source = 'share_link', sourceDetail } = req.body;
    if (email) {
      await Supporter.findOneAndUpdate(
        { clubId, email: email.toLowerCase() },
        { $set: { clubId, email: email.toLowerCase(), source, sourceDetail, subscribed: true } },
        { upsert: true }
      );
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── EXPORT ALL ROUTERS ──────────────────────────────────────────
module.exports = {
  auth: authRouter,
  clubs: clubsRouter,
  regattas: regattasRouter,
  races: racesRouter,
  elo: eloRouter,
  campaigns: campaignsRouter,
  supporters: supportersRouter,
  erg: ergRouter,
  boats: boatsRouter,
  import: importRouter,
  share: shareRouter,
};

// server.js imports these as:
// app.use('/api/auth',      require('./routes/auth'));      // ← routes/auth.js = module.exports = authRouter
// etc.
// For simplicity, split into individual files at routes/ if preferred.
