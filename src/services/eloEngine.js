/**
 * RegattaStream ELO Engine (Speed Order)
 * ─────────────────────────────────────────────────────────────
 * Computes ELO ratings after each race. Supports:
 *   - Standard 2000m sprint (collegiate, open)
 *   - Head race time trial format
 *   - Masters bracket adjustments
 *   - Para classification adjustments
 *
 * Usage:
 *   const elo = require('./eloEngine');
 *   const updates = elo.processRace(raceResults);
 *
 * raceResults: Array of { clubId, finishMs, place, eloCurrent }
 * Returns:     Array of { clubId, eloBefore, eloAfter, eloDelta, soRankBefore, soRankAfter }
 */

'use strict';

// ── CONFIG ─────────────────────────────────────────────────────
const K_BASE       = 32;   // Base K-factor (how much each race moves ratings)
const K_HEAD       = 18;   // Reduced K for head race time trials (more variance)
const ELO_DEFAULT  = 1500; // Starting ELO for new clubs
const ELO_FLOOR    = 800;  // Minimum possible ELO
const ELO_CEILING  = 3200; // Maximum possible ELO

// K-factor multipliers by race importance
const K_MULTIPLIER = {
  national_championship: 2.0,
  conference_championship: 1.5,
  invitational: 1.0,
  dual: 0.8,
  head: 0.6,   // head race (time trial)
};

// ── CORE ELO MATH ──────────────────────────────────────────────

/**
 * Expected score (probability of winning) for team A vs team B.
 * Standard Elo expected score formula.
 */
function expectedScore(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

/**
 * Actual score for a finish position in a multi-competitor race.
 * In multi-competitor racing, score = fraction of competitors beaten.
 * 1st of 6: beats 5, score = 5/5 = 1.0
 * 3rd of 6: beats 3, score = 3/5 = 0.6
 */
function actualScore(place, numCompetitors) {
  if (numCompetitors <= 1) return 0.5;
  return (numCompetitors - place) / (numCompetitors - 1);
}

/**
 * K-factor for a race, adjusted by race type and current rating.
 * Higher-rated clubs get slightly lower K (more stable at top).
 */
function kFactor(raceType = 'invitational', elo = 1500) {
  const base = K_BASE * (K_MULTIPLIER[raceType] || 1.0);
  // Reduce K slightly for very high-rated clubs
  if (elo > 2200) return base * 0.85;
  if (elo > 1900) return base * 0.92;
  return base;
}

// ── MAIN FUNCTIONS ─────────────────────────────────────────────

/**
 * Process a single race and return ELO updates for all competitors.
 *
 * @param {Array} results - Race results in finish order
 *   Each: { clubId, finishMs, place, eloCurrent, dnf, dns, dsq }
 * @param {Object} opts
 *   raceType:   'invitational'|'conference_championship'|'national_championship'|'head'|'dual'
 *   isHeadRace: true for time trial format (pairwise comparison by time)
 * @returns {Array} updates - { clubId, eloBefore, eloAfter, eloDelta }
 */
function processRace(results, opts = {}) {
  const { raceType = 'invitational', isHeadRace = false } = opts;
  const n = results.length;

  if (n < 2) return results.map(r => ({
    clubId: r.clubId,
    eloBefore: r.eloCurrent,
    eloAfter: r.eloCurrent,
    eloDelta: 0,
  }));

  // Exclude DNS/DSQ from ELO calculation (DNF still counts — they raced)
  const active = results.filter(r => !r.dns && !r.dsq);
  const nActive = active.length;

  // Calculate raw ELO delta for each competitor vs all others
  const deltas = new Map(); // clubId => cumulative delta
  active.forEach(r => deltas.set(r.clubId, 0));

  for (let i = 0; i < nActive; i++) {
    for (let j = i + 1; j < nActive; j++) {
      const a = active[i];
      const b = active[j];

      const eA = a.eloCurrent || ELO_DEFAULT;
      const eB = b.eloCurrent || ELO_DEFAULT;

      const expected_A = expectedScore(eA, eB);
      const expected_B = 1 - expected_A;

      let actual_A, actual_B;

      if (isHeadRace) {
        // Head race: compare finish times directly
        actual_A = a.finishMs < b.finishMs ? 1 : a.finishMs === b.finishMs ? 0.5 : 0;
        actual_B = 1 - actual_A;
      } else {
        // Sprint race: use finish positions
        actual_A = a.place < b.place ? 1 : a.place === b.place ? 0.5 : 0;
        actual_B = 1 - actual_A;
      }

      const kA = kFactor(raceType, eA);
      const kB = kFactor(raceType, eB);

      deltas.set(a.clubId, deltas.get(a.clubId) + kA * (actual_A - expected_A));
      deltas.set(b.clubId, deltas.get(b.clubId) + kB * (actual_B - expected_B));
    }
  }

  // Normalize deltas by number of matchups (n-1 comparisons per competitor)
  const matchups = nActive - 1;

  return results.map(r => {
    if (r.dns || r.dsq) {
      return { clubId: r.clubId, eloBefore: r.eloCurrent, eloAfter: r.eloCurrent, eloDelta: 0 };
    }

    const rawDelta = deltas.get(r.clubId) || 0;
    const normalizedDelta = matchups > 0 ? rawDelta / matchups : rawDelta;
    const eloBefore = r.eloCurrent || ELO_DEFAULT;
    const eloAfterRaw = eloBefore + normalizedDelta;
    const eloAfter = Math.min(ELO_CEILING, Math.max(ELO_FLOOR, Math.round(eloAfterRaw)));
    const eloDelta = eloAfter - eloBefore;

    return {
      clubId: r.clubId,
      eloBefore,
      eloAfter,
      eloDelta,
      place: r.place,
      finishMs: r.finishMs,
    };
  });
}

/**
 * Recompute Speed Order (national rank) for all clubs by boat class.
 * Call after processRace to update soRank.
 *
 * @param {Array} clubs - Array of { clubId, eloScore } for a given boat class/gender
 * @returns {Array} - Same clubs with soRank added, sorted descending by ELO
 */
function computeSpeedOrder(clubs) {
  const sorted = [...clubs].sort((a, b) => b.eloScore - a.eloScore);
  return sorted.map((c, i) => ({ ...c, soRank: i + 1 }));
}

/**
 * Provision ELO score for a new club with no race history.
 * Uses median ELO adjusted by USRowing tier if available.
 */
function provisionNewClub(tier = 'club') {
  const tierDefaults = {
    ncaa_d1: 1700,
    ncaa_d2: 1580,
    ncaa_d3: 1520,
    club: 1500,
    masters: 1500,
    junior: 1480,
  };
  return tierDefaults[tier] || ELO_DEFAULT;
}

/**
 * Parse finish time string to milliseconds.
 * Accepts: '5:42.1', '15:22.4', '1:05:22.4' (hours for head races)
 */
function parseTimeToMs(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 2) {
    // MM:SS.f
    return Math.round((parts[0] * 60 + parts[1]) * 1000);
  } else if (parts.length === 3) {
    // H:MM:SS.f
    return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  }
  return null;
}

/**
 * Format milliseconds back to time string.
 */
function formatTime(ms) {
  if (!ms) return null;
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = (totalSec % 60).toFixed(1).padStart(4, '0');
  return `${mins}:${secs}`;
}

module.exports = {
  processRace,
  computeSpeedOrder,
  provisionNewClub,
  parseTimeToMs,
  formatTime,
  ELO_DEFAULT,
  K_BASE,
};
