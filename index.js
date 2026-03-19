/**
 * RegattaStream — Express Server v2.1
 * Notification routes, cron reminder jobs, push token cleanup added.
 */
'use strict';
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// Path prefix changed from './routes' to './src/routes' etc to accommodate being in the root directory
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/clubs', require('./src/routes/clubs'));
app.use('/api/regattas', require('./src/routes/regattas'));
app.use('/api/races', require('./src/routes/races'));
app.use('/api/elo', require('./src/routes/elo'));
app.use('/api/campaigns', require('./src/routes/campaigns'));
app.use('/api/supporters', require('./src/routes/supporters'));
app.use('/api/erg', require('./src/routes/erg'));
app.use('/api/boats', require('./src/routes/boats'));
app.use('/api/import', require('./src/routes/import'));
app.use('/api/share', require('./src/routes/share'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.1.0', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', uptime: Math.floor(process.uptime()) }));
app.use((err, req, res, next) => { console.error('[Error]', err.message); res.status(err.status || 500).json({ error: err.message || 'Internal server error' }); });

// Singleton pattern connection to prevent max pool size hitting on Vercel
let isConnected = false;
async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 10 });
    isConnected = true;
    console.log('[DB] MongoDB connected');
  } catch (e) {
    console.error('[DB] Failed to connect:', e.message);
  }
}

function startCronJobs() {
  const { ingest } = require('./src/services/dataAggregator');
  const notifSvc = require('./src/services/notificationService');
  const { Club } = require('./src/models');
  const { computeSpeedOrder } = require('./src/services/eloEngine');
  cron.schedule(`*/${process.env.SYNC_HERENOW_INTERVAL || 2} * * * *`, async () => { try { await ingest('HereNOW'); } catch (e) { console.error('[CRON][HN]', e.message); } });
  cron.schedule(`*/${process.env.SYNC_REGATTACENTRAL_INTERVAL || 5} * * * *`, async () => { try { await ingest('RegattaCentral'); } catch (e) { console.error('[CRON][RC]', e.message); } });
  cron.schedule('*/10 * * * *', async () => { try { await ingest('CrewTimer'); } catch (e) { console.error('[CRON][CT]', e.message); } });
  cron.schedule('*/30 * * * *', async () => {
    try {
      const clubs = await Club.find({}, '_id eloScore soRank').lean();
      const ranked = computeSpeedOrder(clubs.map(c => ({ clubId: c._id, eloScore: c.eloScore })));
      for (const r of ranked) {
        const old = clubs.find(c => c._id.toString() === r.clubId.toString());
        await Club.findByIdAndUpdate(r.clubId, { soRank: r.soRank });
        if (old && old.soRank && Math.abs(old.soRank - r.soRank) >= 3) {
          await notifSvc.notifyEloRankChange(r.clubId, old.soRank, r.soRank);
        }
      }
    } catch (e) { console.error('[CRON][ELO]', e.message); }
  });
  cron.schedule('0 6 * * *', async () => {
    try { await notifSvc.sendRaceDayReminders(); await notifSvc.sendRaceWeekReminders(); console.log('[CRON] Reminders sent'); }
    catch (e) { console.error('[CRON][Remind]', e.message); }
  });
  cron.schedule('0 3 * * 0', async () => {
    try { const { PushToken } = require('./src/models/notifications'); await PushToken.updateMany({ failCount: { $gte: 3 } }, { active: false }); const cutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000); await PushToken.deleteMany({ active: false, updatedAt: { $lt: cutoff } }); } catch (e) { console.error('[CRON][Tokens]', e.message); }
  });
  cron.schedule('0 4 * * *', async () => {
    try { const { Notification } = require('./src/models/notifications'); const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000); await Notification.deleteMany({ dismissed: true, dismissedAt: { $lt: cutoff } }); } catch (e) { console.error('[CRON][Notifs]', e.message); }
  });
  console.log('[CRON] All jobs scheduled');
}

// Vercel export vs Local execution
if (process.env.VERCEL) {
  // Connect Mongoose globally for Serverless
  connectDB();
} else {
  // Local Development
  async function start() {
    await connectDB();
    startCronJobs();
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => { console.log(`[Server] RegattaStream v2.1 on port ${PORT}`); });
  }
  start().catch(err => { console.error('[Fatal]', err); process.exit(1); });
}

module.exports = app;
