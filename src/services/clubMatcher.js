/**
 * Club Matcher — resolves crew names from timing data to Club documents.
 * 4-tier matching:
 *   1. Exact name match
 *   2. Alias match (club.aliases array)
 *   3. Fuzzy substring match (>= 80% similarity)
 *   4. Create new club stub if no match
 */
'use strict';
const { Club } = require('../models');

// Cache clubs in memory between races (invalidated on any Club write)
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getClubs() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL) return _cache;
  _cache = await Club.find({}, 'name abbr aliases city eloScore').lean();
  _cacheAt = Date.now();
  return _cache;
}

function invalidateCache() { _cache = null; }

/**
 * Simple trigram similarity (0–1).
 * Fast enough for in-memory club list matching.
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.85;

  const ngrams = s => {
    const set = new Set();
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  };

  const g1 = ngrams(s1);
  const g2 = ngrams(s2);
  let intersect = 0;
  g1.forEach(g => { if (g2.has(g)) intersect++; });
  return (2 * intersect) / (g1.size + g2.size);
}

/**
 * Match a crew name string to a Club document.
 * @param {string} crewName - e.g. 'Cal Crew V8+', 'University of Washington', 'UW Rowing'
 * @returns {Object|null} - Club lean document or null
 */
async function match(crewName) {
  if (!crewName) return null;

  // Strip common suffixes to get clean club name
  const clean = crewName
    .replace(/\s+(V8\+|2V8\+|V4\+|JV|Novice|A|B|Varsity|Jr\.?|Frosh|novice)\s*$/i, '')
    .replace(/\s+(Crew|Rowing|Sculling|Club|RC|AC|BC)\s*$/i, '')
    .trim();

  const clubs = await getClubs();

  // Tier 1: exact name match (case-insensitive)
  let match = clubs.find(c => c.name.toLowerCase() === clean.toLowerCase());
  if (match) return match;

  // Tier 2: exact abbr match
  match = clubs.find(c => c.abbr && c.abbr.toLowerCase() === clean.toLowerCase());
  if (match) return match;

  // Tier 3: alias match
  match = clubs.find(c =>
    (c.aliases || []).some(a => a.toLowerCase() === clean.toLowerCase() || a.toLowerCase() === crewName.toLowerCase())
  );
  if (match) return match;

  // Tier 4: fuzzy — find best match above threshold
  let bestScore = 0;
  let bestClub = null;
  for (const c of clubs) {
    const score = Math.max(
      similarity(clean, c.name),
      similarity(crewName, c.name),
      ...(c.aliases || []).map(a => similarity(clean, a))
    );
    if (score > bestScore) { bestScore = score; bestClub = c; }
  }

  if (bestScore >= 0.80) return bestClub;

  // Tier 5: create stub club
  console.log(`[ClubMatcher] No match for "${crewName}" (${clean}) — creating stub`);
  const stub = await Club.create({
    name: clean,
    abbr: clean.slice(0, 5).toUpperCase(),
    city: 'Unknown',
    state: 'XX',
    aliases: [crewName, clean],
  });
  invalidateCache();
  return stub;
}

module.exports = { match, invalidateCache };
