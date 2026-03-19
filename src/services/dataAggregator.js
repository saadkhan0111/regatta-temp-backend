/**
 * RegattaStream Data Aggregator
 * ─────────────────────────────────────────────────────────────
 * Fetches race results from all 9 timing partners, normalizes
 * to a common schema, matches clubs, and triggers ELO updates.
 *
 * Partners:
 *   1. HereNOW       — REST API (primary partner)
 *   2. RegattaCentral — REST API (partner)
 *   3. CrewTimer      — REST API (partner)
 *   4. RegattaMaster  — REST API (partner)
 *   5. Time-Team      — scrape / partial API
 *   6. RegattaTiming  — scrape / partial API
 *   7. RowTimer       — manual upload + scrape
 *   8. ClockCaster    — partial API
 *   9. CSV / Manual   — file upload handler
 */

'use strict';

const axios = require('axios');
const { parse: csvParse } = require('csv-parse/sync');
const { Club, Regatta, Race } = require('../models');
const eloEngine = require('./eloEngine');
const clubMatcher = require('./clubMatcher');

// ── NORMALIZED RESULT SCHEMA ────────────────────────────────────
/**
 * All adapters produce this shape:
 * {
 *   regatta: { name, date, location, timingPartner, externalId },
 *   events: [{
 *     eventName, boatClass, gender, division, heatType,
 *     results: [{ place, bow, crewName, finishTime, dnf, dns, dsq }]
 *   }]
 * }
 */

// ── ADAPTER: HERENOW ───────────────────────────────────────────
async function fetchHereNow(opts = {}) {
  const baseUrl = process.env.HERENOW_BASE_URL;
  const apiKey  = process.env.HERENOW_API_KEY;

  const { data } = await axios.get(`${baseUrl}/regattas`, {
    headers: { 'x-api-key': apiKey },
    params: { status: 'results', limit: 50, ...opts },
  });

  return (data.regattas || []).map(reg => ({
    regatta: {
      name: reg.name,
      shortName: reg.short_name,
      date: new Date(reg.race_date),
      location: reg.venue,
      city: reg.city,
      state: reg.state,
      timingPartner: 'HereNOW',
      externalId: String(reg.id),
      herenowRegattaId: String(reg.id),
    },
    events: (reg.events || []).map(ev => ({
      eventName: ev.event_name,
      boatClass: normalizeBoatClass(ev.boat_class),
      gender: normalizeGender(ev.gender),
      division: ev.division || 'Open',
      heatType: normalizeHeatType(ev.round),
      results: (ev.results || []).map(r => ({
        place: r.place,
        bow: r.bow_number,
        crewName: r.entry_name,
        finishTime: r.finish_time,
        finishMs: eloEngine.parseTimeToMs(r.finish_time),
        dnf: r.dnf || false,
        dns: r.dns || false,
        dsq: r.dsq || false,
      })),
    })),
  }));
}

// ── ADAPTER: REGATTACENTRAL ────────────────────────────────────
async function fetchRegattaCentral(opts = {}) {
  const baseUrl = process.env.REGATTACENTRAL_BASE_URL;
  const apiKey  = process.env.REGATTACENTRAL_API_KEY;

  const { data } = await axios.get(`${baseUrl}/events`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    params: { type: 'rowing', has_results: true, ...opts },
  });

  return (data.events || []).map(reg => ({
    regatta: {
      name: reg.title,
      date: new Date(reg.start_date),
      location: `${reg.city}, ${reg.state}`,
      city: reg.city,
      state: reg.state,
      timingPartner: 'RegattaCentral',
      externalId: String(reg.event_id),
      rcRegattaId: String(reg.event_id),
    },
    events: (reg.races || []).map(race => ({
      eventName: race.race_name,
      boatClass: normalizeBoatClass(race.shell),
      gender: normalizeGender(race.gender),
      division: race.division,
      heatType: normalizeHeatType(race.round),
      results: (race.entries || [])
        .filter(e => e.place)
        .sort((a, b) => a.place - b.place)
        .map(e => ({
          place: e.place,
          bow: e.bow,
          crewName: e.entry,
          finishTime: e.finish,
          finishMs: eloEngine.parseTimeToMs(e.finish),
          dnf: e.status === 'DNF',
          dns: e.status === 'DNS',
          dsq: e.status === 'DSQ',
        })),
    })),
  }));
}

// ── ADAPTER: CREWTIMER ─────────────────────────────────────────
async function fetchCrewTimer(opts = {}) {
  const apiKey = process.env.CREWTIMER_API_KEY;

  const { data } = await axios.get('https://api.crewtimer.com/results', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    params: opts,
  });

  return (data || []).map(reg => ({
    regatta: {
      name: reg.Title,
      date: new Date(reg.MeetDate),
      location: reg.Location || '',
      timingPartner: 'CrewTimer',
      externalId: reg.MeetID,
    },
    events: Object.entries(reg.events || {}).map(([eventId, ev]) => ({
      eventName: ev.EventName,
      boatClass: normalizeBoatClass(ev.EventName),
      gender: normalizeGender(ev.EventName),
      division: ev.Division || 'Open',
      heatType: 'final_A',
      results: (ev.results || []).map(r => ({
        place: r.Place,
        bow: r.Bow,
        crewName: r.Crew,
        finishTime: r.Time,
        finishMs: eloEngine.parseTimeToMs(r.Time),
        dnf: r.Time === 'DNF',
        dns: r.Time === 'DNS',
        dsq: r.Time === 'DSQ',
      })),
    })),
  }));
}

// ── ADAPTER: CSV / MANUAL IMPORT ───────────────────────────────
/**
 * Parse a CSV upload into normalized regatta data.
 * Expected CSV columns (flexible order, case-insensitive headers):
 *   place, bow, crew, time, event, gender, boat_class
 *   Optional: division, heat_type, dnf, dns, dsq
 */
function parseCSV(csvBuffer, regattaMeta = {}) {
  const records = csvParse(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    cast: true,
  });

  // Group by event
  const eventMap = {};
  records.forEach(row => {
    const key = `${row.event || row.Event || 'Unknown'}__${row.gender || row.Gender || ''}`;
    if (!eventMap[key]) {
      eventMap[key] = {
        eventName: row.event || row.Event || 'Unknown Event',
        boatClass: normalizeBoatClass(row.boat_class || row.BoatClass || row.event || ''),
        gender: normalizeGender(row.gender || row.Gender || ''),
        division: row.division || row.Division || 'Open',
        heatType: normalizeHeatType(row.heat_type || row.HeatType || 'Final'),
        results: [],
      };
    }
    eventMap[key].results.push({
      place: parseInt(row.place || row.Place, 10),
      bow: String(row.bow || row.Bow || ''),
      crewName: row.crew || row.Crew || row.entry || row.Entry || '',
      finishTime: row.time || row.Time || row.finish || row.Finish || '',
      finishMs: eloEngine.parseTimeToMs(row.time || row.Time || row.finish || row.Finish),
      dnf: String(row.dnf || '').toUpperCase() === 'TRUE' || String(row.time || '').toUpperCase() === 'DNF',
      dns: String(row.dns || '').toUpperCase() === 'TRUE' || String(row.time || '').toUpperCase() === 'DNS',
      dsq: String(row.dsq || '').toUpperCase() === 'TRUE' || String(row.time || '').toUpperCase() === 'DSQ',
    });
  });

  return [{
    regatta: {
      name: regattaMeta.name || 'Imported Regatta',
      date: regattaMeta.date ? new Date(regattaMeta.date) : new Date(),
      location: regattaMeta.location || '',
      timingPartner: 'CSV',
      externalId: `csv_${Date.now()}`,
    },
    events: Object.values(eventMap),
  }];
}

// ── NORMALIZERS ────────────────────────────────────────────────

function normalizeBoatClass(raw = '') {
  const s = raw.toUpperCase().replace(/\s+/g, '');
  if (s.includes('8'))  return '8+';
  if (s.includes('4+')) return '4+';
  if (s.includes('4X')) return '4x';
  if (s.includes('4-')) return '4-';
  if (s.includes('2X')) return '2x';
  if (s.includes('2-')) return '2-';
  if (s.includes('1X')) return '1x';
  if (s.includes('SINGLE')) return '1x';
  if (s.includes('DOUBLE')) return '2x';
  if (s.includes('PAIR'))   return '2-';
  if (s.includes('QUAD'))   return '4x';
  if (s.includes('EIGHT'))  return '8+';
  return raw.trim() || 'Unknown';
}

function normalizeGender(raw = '') {
  const s = raw.toUpperCase();
  if (s.includes('WOMEN') || s.includes('WOM') || s.includes(" W ") || s === 'W') return 'W';
  if (s.includes('MEN')   || s.includes(" M ") || s === 'M') return 'M';
  if (s.includes('MIXED') || s.includes('COED')) return 'Mixed';
  return 'M'; // default
}

function normalizeHeatType(raw = '') {
  const s = (raw || '').toUpperCase();
  if (s.includes('FINAL') && s.includes('A')) return 'final_A';
  if (s.includes('FINAL') && s.includes('B')) return 'final_B';
  if (s.includes('FINAL') && s.includes('C')) return 'final_C';
  if (s.includes('FINAL'))  return 'final_A';
  if (s.includes('SEMI'))   return 'semifinal';
  if (s.includes('HEAT'))   return 'heat';
  if (s.includes('TIME') || s.includes('TT')) return 'time_trial';
  return 'final_A';
}

// ── MAIN INGEST PIPELINE ───────────────────────────────────────
/**
 * Full ingest: fetch → normalize → match clubs → upsert DB → ELO → campaign trigger
 *
 * @param {string} partner - timing partner name
 * @param {Object} opts    - partner-specific options
 * @returns {Object}       - { regattas, races, eloUpdates, campaignsTriggered }
 */
async function ingest(partner, opts = {}) {
  let normalized = [];

  switch (partner) {
    case 'HereNOW':        normalized = await fetchHereNow(opts);        break;
    case 'RegattaCentral': normalized = await fetchRegattaCentral(opts);  break;
    case 'CrewTimer':      normalized = await fetchCrewTimer(opts);       break;
    // Add RegattaMaster, Time-Team, etc. as APIs become available
    default:
      throw new Error(`Unknown timing partner: ${partner}`);
  }

  const results = {
    partner,
    regattas: [],
    races: [],
    eloUpdates: [],
    errors: [],
  };

  for (const norm of normalized) {
    try {
      // 1. Upsert regatta
      const regatta = await upsertRegatta(norm.regatta);
      results.regattas.push(regatta._id);

      // 2. Process each event
      for (const ev of norm.events) {
        try {
          const race = await upsertRace(regatta, ev);
          results.races.push(race._id);

          // 3. Match clubs to results
          const matched = await matchClubs(race.results);

          // 4. Compute ELO updates
          const eloInput = matched
            .filter(r => r.clubId)
            .map(r => ({
              clubId: r.clubId,
              finishMs: r.finishMs,
              place: r.place,
              eloCurrent: r.eloScore || 1500,
              dnf: r.dnf,
              dns: r.dns,
              dsq: r.dsq,
            }));

          if (eloInput.length >= 2) {
            const updates = eloEngine.processRace(eloInput, { raceType: opts.raceType });
            await applyEloUpdates(race._id, regatta._id, updates);
            results.eloUpdates.push(...updates);
          }
        } catch (evErr) {
          results.errors.push({ event: ev.eventName, error: evErr.message });
        }
      }

      // 5. Mark regatta results posted, trigger campaign check
      await Regatta.findByIdAndUpdate(regatta._id, {
        status: 'results',
        resultsPostedAt: new Date(),
      });

    } catch (regErr) {
      results.errors.push({ regatta: norm.regatta.name, error: regErr.message });
    }
  }

  return results;
}

// ── DB HELPERS ─────────────────────────────────────────────────

async function upsertRegatta(meta) {
  const query = {};
  if (meta.herenowRegattaId) query.herenowRegattaId = meta.herenowRegattaId;
  else if (meta.rcRegattaId)  query.rcRegattaId = meta.rcRegattaId;
  else query.externalId = meta.externalId;

  return Regatta.findOneAndUpdate(
    query,
    { $set: { ...meta, lastSyncAt: new Date() } },
    { upsert: true, new: true }
  );
}

async function upsertRace(regatta, ev) {
  return Race.findOneAndUpdate(
    { regattaId: regatta._id, eventName: ev.eventName, heatType: ev.heatType },
    { $set: { ...ev, regattaId: regatta._id } },
    { upsert: true, new: true }
  );
}

async function matchClubs(results) {
  return Promise.all(results.map(async r => {
    const club = await clubMatcher.match(r.crewName);
    return { ...r, clubId: club?._id, eloScore: club?.eloScore };
  }));
}

async function applyEloUpdates(raceId, regattaId, updates) {
  const { EloHistory } = require('../models');
  const ops = updates.map(u => ({
    updateOne: {
      filter: { clubId: u.clubId, raceId },
      update: { $set: { ...u, raceId, regattaId, date: new Date() } },
      upsert: true,
    },
  }));
  if (ops.length) await EloHistory.bulkWrite(ops);

  // Update club's current ELO
  await Promise.all(updates.map(u =>
    require('../models').Club.findByIdAndUpdate(u.clubId, {
      $set: { eloScore: u.eloAfter },
    })
  ));
}

/**
 * Ingest from CSV buffer (for /api/import/csv endpoint)
 */
async function ingestCSV(buffer, regattaMeta) {
  const normalized = parseCSV(buffer, regattaMeta);
  // reuse pipeline — mark as CSV source
  const results = { regattas: [], races: [], eloUpdates: [], errors: [] };
  for (const norm of normalized) {
    const regatta = await upsertRegatta(norm.regatta);
    results.regattas.push(regatta._id);
    for (const ev of norm.events) {
      const race = await upsertRace(regatta, ev);
      results.races.push(race._id);
    }
  }
  return results;
}

module.exports = {
  ingest,
  ingestCSV,
  parseCSV,
  fetchHereNow,
  fetchRegattaCentral,
  fetchCrewTimer,
  normalizeBoatClass,
  normalizeGender,
  normalizeHeatType,
};
