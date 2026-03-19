/**
 * RegattaStream Seed Script
 * Populates MongoDB with starter clubs, one sample regatta, and race results.
 * Run: npm run seed
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { Club, Regatta, Race, Supporter } = require('../models');
const eloEngine = require('../services/eloEngine');

const CLUBS = [
  { name:'Cal Crew', abbr:'CAL', city:'Berkeley', state:'CA', region:'West', type:'NCAA_D1', founded:1870, emoji:'🐻', primaryColor:'#003262', accentColor:'#FDB515', eloScore:2187, soRank:3, aliases:['California Golden Bears Crew','UC Berkeley Crew','Cal Rowing'], rcId:'RC-CAL-001', herenowId:'HN-CAL' },
  { name:'UW Rowing', abbr:'UW', city:'Seattle', state:'WA', region:'West', type:'NCAA_D1', founded:1901, emoji:'🐾', primaryColor:'#4B2E83', accentColor:'#B7A57A', eloScore:2210, soRank:1, aliases:['University of Washington Crew','Washington Huskies Rowing','UW Crew'], rcId:'RC-UW-001', herenowId:'HN-UW' },
  { name:'Yale Crew', abbr:'YAL', city:'New Haven', state:'CT', region:'East', type:'NCAA_D1', founded:1843, emoji:'🏛️', primaryColor:'#00356B', accentColor:'#ADB17D', eloScore:2195, soRank:2, aliases:['Yale Bulldogs Crew','Yale University Rowing'], rcId:'RC-YALE-001', herenowId:'HN-YALE' },
  { name:'Stanford Rowing', abbr:'STA', city:'Palo Alto', state:'CA', region:'West', type:'NCAA_D1', founded:1894, emoji:'🌲', primaryColor:'#8C1515', accentColor:'#B1B3B3', eloScore:2058, soRank:6, aliases:['Stanford Cardinal Rowing','Stanford Crew'], rcId:'RC-STA-001', herenowId:'HN-STA' },
  { name:'MIT Crew', abbr:'MIT', city:'Cambridge', state:'MA', region:'East', type:'NCAA_D3', founded:1947, emoji:'⚙️', primaryColor:'#8B0000', eloScore:1876, soRank:12, aliases:['MIT Rowing','Massachusetts Institute of Technology Crew'], rcId:'RC-MIT-001' },
  { name:'Penn AC', abbr:'PAC', city:'Philadelphia', state:'PA', region:'East', type:'Club', founded:1866, emoji:'🔴', primaryColor:'#011F5B', eloScore:1990, soRank:8, aliases:['Penn Athletic Club','Penn Rowing'], rcId:'RC-PAC-001' },
  { name:'Long Beach RC', abbr:'LBC', city:'Long Beach', state:'CA', region:'West', type:'Club', founded:1952, emoji:'🌊', primaryColor:'#005F9E', eloScore:1820, soRank:22, aliases:['Long Beach Rowing Association','LBRA'], rcId:'RC-LBC-001' },
];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[Seed] Connected to MongoDB');

  // ── Clubs ──
  await Club.deleteMany({});
  const clubs = await Club.insertMany(CLUBS);
  console.log(`[Seed] Inserted ${clubs.length} clubs`);
  const clubMap = Object.fromEntries(clubs.map(c => [c.abbr, c]));

  // ── Sample Regatta ──
  await Regatta.deleteMany({});
  const regatta = await Regatta.create({
    name: 'Pacific Coast Rowing Championships',
    shortName: 'PCRCs',
    date: new Date('2026-03-08'),
    location: 'Redwood Shores, CA',
    city: 'Redwood Shores',
    state: 'CA',
    status: 'results',
    timingPartner: 'HereNOW',
    entryCount: 142,
    clubCount: 28,
    resultsPostedAt: new Date('2026-03-08T18:00:00Z'),
  });
  console.log(`[Seed] Created regatta: ${regatta.name}`);

  // ── Sample Race (Men's 8+) ──
  await Race.deleteMany({});
  const raceResults = [
    { place:1, crewName:"Cal Crew V8+",    clubId:clubMap.CAL._id, finishTime:'5:42.1', finishMs:eloEngine.parseTimeToMs('5:42.1') },
    { place:2, crewName:"UW V8+",          clubId:clubMap.UW._id,  finishTime:'5:44.8', finishMs:eloEngine.parseTimeToMs('5:44.8') },
    { place:3, crewName:"Yale V8+",        clubId:clubMap.YAL._id, finishTime:'5:46.2', finishMs:eloEngine.parseTimeToMs('5:46.2') },
    { place:4, crewName:"Stanford V8+",    clubId:clubMap.STA._id, finishTime:'5:49.7', finishMs:eloEngine.parseTimeToMs('5:49.7') },
    { place:5, crewName:"Penn AC V8+",     clubId:clubMap.PAC._id, finishTime:'5:53.0', finishMs:eloEngine.parseTimeToMs('5:53.0') },
    { place:6, crewName:"MIT V8+",         clubId:clubMap.MIT._id, finishTime:'5:58.1', finishMs:eloEngine.parseTimeToMs('5:58.1') },
  ];

  // Compute ELO
  const eloInput = raceResults.map(r => ({
    clubId: r.clubId,
    finishMs: r.finishMs,
    place: r.place,
    eloCurrent: clubs.find(c => String(c._id) === String(r.clubId))?.eloScore || 1500,
  }));
  const eloUpdates = eloEngine.processRace(eloInput, { raceType: 'conference_championship' });
  const eloMap = Object.fromEntries(eloUpdates.map(u => [String(u.clubId), u]));

  const resultsWithElo = raceResults.map(r => ({
    ...r,
    eloBefore: eloMap[String(r.clubId)]?.eloBefore,
    eloAfter:  eloMap[String(r.clubId)]?.eloAfter,
    eloDelta:  eloMap[String(r.clubId)]?.eloDelta,
  }));

  await Race.create({
    regattaId: regatta._id,
    eventName: "Men's Varsity 8+",
    boatClass: '8+',
    gender: 'M',
    division: 'Varsity',
    heatType: 'final_A',
    raceDate: new Date('2026-03-08T14:30:00Z'),
    results: resultsWithElo,
    timingSource: 'HereNOW',
  });
  console.log(`[Seed] Created race: Men's Varsity 8+`);

  // ── Sample Supporters for Cal ──
  await Supporter.deleteMany({});
  const calId = clubMap.CAL._id;
  await Supporter.insertMany([
    { clubId:calId, email:'sarah.m@example.com', firstName:'Sarah', lastName:'Mitchell', role:'parent', source:'qr_scan', subscribed:true },
    { clubId:calId, email:'david.k@example.com', firstName:'David', lastName:'Kim', role:'alumni', source:'share_link', subscribed:true },
    { clubId:calId, email:'mike.p@cal.edu', firstName:'Mike', lastName:'Peralta', role:'athlete', source:'app_signup', subscribed:true },
  ]);
  console.log('[Seed] Inserted sample supporters');

  console.log('\n[Seed] ✅ Done. Start the server with: npm run dev');
  process.exit(0);
}

seed().catch(e => { console.error('[Seed] Error:', e); process.exit(1); });
