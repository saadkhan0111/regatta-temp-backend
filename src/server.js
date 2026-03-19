/**
 * RegattaStream — Express Server v2.1
 * Notification routes, cron reminder jobs, push token cleanup added.
 */
'use strict';
require('dotenv').config();
const express   = require('express');
const mongoose  = require('mongoose');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const cron      = require('node-cron');
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/clubs',         require('./routes/clubs'));
app.use('/api/regattas',      require('./routes/regattas'));
app.use('/api/races',         require('./routes/races'));
app.use('/api/elo',           require('./routes/elo'));
app.use('/api/campaigns',     require('./routes/campaigns'));
app.use('/api/supporters',    require('./routes/supporters'));
app.use('/api/erg',           require('./routes/erg'));
app.use('/api/boats',         require('./routes/boats'));
app.use('/api/import',        require('./routes/import'));
app.use('/api/share',         require('./routes/share'));
app.use('/api/notifications', require('./routes/notifications'));
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.1.0', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', uptime: Math.floor(process.uptime()) }));
app.use((err, req, res, next) => { console.error('[Error]', err.message); res.status(err.status || 500).json({ error: err.message || 'Internal server error' }); });
async function connectDB() { await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 10 }); console.log('[DB] MongoDB connected'); }
function startCronJobs() {
  const { ingest } = require('./services/dataAggregator');
  const notifSvc = require('./services/notificationService');
  const { Club } = require('./models');
  const { computeSpeedOrder } = require('./services/eloEngine');
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
    try { const { PushToken } = require('./models/notifications'); await PushToken.updateMany({ failCount: { $gte: 3 } }, { active: false }); const cutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000); await PushToken.deleteMany({ active: false, updatedAt: { $lt: cutoff } }); } catch (e) { console.error('[CRON][Tokens]', e.message); }
  });
  cron.schedule('0 4 * * *', async () => {
    try { const { Notification } = require('./models/notifications'); const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000); await Notification.deleteMany({ dismissed: true, dismissedAt: { $lt: cutoff } }); } catch (e) { console.error('[CRON][Notifs]', e.message); }
  });
  console.log('[CRON] All jobs scheduled');
}
async function start() { await connectDB(); startCronJobs(); const PORT = process.env.PORT || 3001; app.listen(PORT, () => { console.log(`[Server] RegattaStream v2.1 on port ${PORT}`); }); }
start().catch(err => { console.error('[Fatal]', err); process.exit(1); });
module.exports = app;
