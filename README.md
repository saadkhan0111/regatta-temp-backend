# RegattaStream Backend — Developer README
**Version 2.0 | Node.js + Express + MongoDB**
Contact: noah@regattastream.com

---

## Quick Start (5 minutes)

```bash
# 1. Install
npm install

# 2. Configure environment
cp .env.example .env
# Fill in MONGODB_URI and ANTHROPIC_API_KEY at minimum

# 3. Seed database with starter clubs and sample race
npm run seed

# 4. Start dev server
npm run dev
# → API running at http://localhost:3001
# → Health check: http://localhost:3001/health
```

---

## Project Structure

```
src/
├── server.js                  Entry point — Express app, cron jobs, DB connect
├── models/
│   └── index.js               All 10 Mongoose schemas (see Schema Reference below)
├── routes/
│   └── index.js               All API route handlers (split into individual files per route group)
├── services/
│   ├── eloEngine.js           ELO / Speed Order calculation engine
│   ├── dataAggregator.js      9-source timing data ingest pipeline
│   ├── clubMatcher.js         Fuzzy club name → Club document resolver
│   └── campaignService.js     Email campaign builder + AI copy + Nodemailer send
└── scripts/
    └── seed.js                DB seed — starter clubs, sample regatta, sample race
```

---

## Schema Reference (10 Collections)

| Collection    | Purpose                                       |
|---------------|-----------------------------------------------|
| `clubs`       | 1,400+ rowing clubs. ELO, aliases, plan tier  |
| `athletes`    | Individual athletes. COPPA flags, erg PRs     |
| `regattas`    | Regatta metadata. Timing partner IDs, status  |
| `races`       | Individual event results within a regatta     |
| `elohistories`| ELO time series per club/boat class/date      |
| `campaigns`   | Email campaigns. Status, analytics, HTML body |
| `supporters`  | Club email lists. Role, source, engagement    |
| `ergsessions` | Individual erg workout logs with OCR support  |
| `boatbays`    | Boat inventory. Status, damage reports        |
| `users`       | Auth. JWT, Apple/Google OAuth slots           |

---

## API Endpoint Reference

### Auth
```
POST /api/auth/register    { email, password, firstName, lastName, role }
POST /api/auth/login       { email, password } → { token }
GET  /api/auth/me          Bearer token → user object
```

### Clubs
```
GET  /api/clubs                         ?q=&region=&type=&limit=&skip=
GET  /api/clubs/:id
GET  /api/clubs/:id/history             ?gender=&boatClass=&year=&limit=
GET  /api/clubs/:id/upcoming
GET  /api/clubs/:id/analytics
PUT  /api/clubs/:id                     (admin auth required)
```

### Results
```
GET  /api/regattas                      ?status=&from=&to=&limit=
GET  /api/regattas/:id                  → { regatta, races[] }
GET  /api/races                         ?regattaId=&boatClass=&gender=&clubId=
GET  /api/races/:id
```

### ELO / Speed Order
```
GET  /api/elo/rankings                  ?boatClass=&gender=&limit=
GET  /api/elo/clubs/:clubId/history
```

### Campaigns
```
GET  /api/campaigns                     ?clubId=&status=&limit=  (auth)
POST /api/campaigns                     Create draft campaign     (auth)
PUT  /api/campaigns/:id                 Update draft             (auth)
POST /api/campaigns/:id/send            Send campaign            (auth)
POST /api/campaigns/preview             Render HTML preview      (auth)
```

### Supporters
```
GET  /api/supporters                    ?clubId=&role=&subscribed= (auth)
POST /api/supporters                    Add single supporter (public — for share links)
POST /api/supporters/import             Upload CSV                (auth, multipart)
POST /api/supporters/unsubscribe        { token }                 (public)
```

### Import / Sync
```
POST /api/import/csv                    Upload CSV results file   (auth, multipart)
POST /api/import/sync/:partner          Manual trigger partner sync (auth)
                                        partner: HereNOW | RegattaCentral | CrewTimer
```

### Erg / Boats / Share
```
GET  /api/erg                           ?athleteId=               (auth)
POST /api/erg                           Log session               (auth)
PUT  /api/erg/:id/verify                Coach verify              (auth)
GET  /api/boats                         ?clubId=                  (auth)
POST /api/boats                         Add boat                  (auth)
PUT  /api/boats/:id/status              Check out / return        (auth)
POST /api/boats/:id/damage              File damage report        (auth)
POST /api/share/track                   Track share link → add supporter (public)
```

---

## Data Ingest Pipeline

```
HereNOW / RC / CrewTimer API
        ↓ (cron: every 2-10 min)
dataAggregator.ingest()
        ↓
Normalize to common schema
        ↓
upsertRegatta() — find or create regatta doc
        ↓
upsertRace() — find or create race doc with results
        ↓
clubMatcher.match() — 4-tier fuzzy match crew names → Club._id
        ↓
eloEngine.processRace() — compute ELO deltas for all competitors
        ↓
applyEloUpdates() — write EloHistory docs, update Club.eloScore
        ↓
rerankSpeedOrder() — recompute soRank for all clubs (cron: every 30 min)
        ↓
[optional] campaignService — auto-trigger results email if regatta.campaignTriggered = false
```

---

## Campaign Flow

```
POST /api/campaigns        { clubId, type, regattaId, subject, includes, audience }
        ↓
POST /api/campaigns/preview   → renders HTML with real race data, ELO, history
        ↓ (user approves preview)
POST /api/campaigns/:id/send
        → campaignService.send()
        → pulls Supporter list by segment
        → buildResultsEmail() → AI intro via Claude API
        → nodemailer batch send (50/batch)
        → updates Campaign.status = 'sent', analytics.delivered
```

---

## Environment Variables

See `.env.example` for full list. Minimum required to start:
- `MONGODB_URI` — local or Atlas connection string
- `ANTHROPIC_API_KEY` — for AI race stories and campaign copy
- `JWT_SECRET` — any 64-char random string

Optional (needed for full functionality):
- `SMTP_*` — SendGrid or other SMTP for campaign emails
- `STRIPE_*` — subscriptions and donations
- `HERENOW_API_KEY` — live results sync
- `REGATTACENTRAL_API_KEY` — entries and results

---

## Build Priority (Phase Order)

### Phase 1 — Foundation (Week 1-2)
1. MongoDB connected, models verified with seed script
2. Auth routes working (register/login/me)
3. Club read endpoints working
4. Regatta + Race read endpoints working

### Phase 2 — Data Pipeline (Week 2-3)
5. CSV import working (`POST /api/import/csv`)
6. HereNOW live sync working (requires API key)
7. ELO engine tested with real race data
8. Club match verified against 10 sample crews

### Phase 3 — Campaign System (Week 3-4)
9. Supporter add/import/unsubscribe
10. Campaign create + HTML preview
11. Campaign send via Nodemailer (test with Mailtrap first)
12. Campaign analytics tracking (webhook from SendGrid)

### Phase 4 — Full Feature (Week 4-6)
13. Erg log CRUD + coach verification
14. Boat Bay CRUD
15. Stripe subscription integration
16. Share link tracking → supporter growth
17. Push notifications (React Native side)
18. COPPA flows (minor flag, parent consent)

---

## Key Decisions for Developer

| Decision | Choice | Reason |
|----------|--------|--------|
| Framework | Express (not Next.js API) | Clean separation from React Native frontend |
| DB | MongoDB Atlas (prod) / local for dev | Flexible schema for varied timing data |
| Auth | JWT (no sessions) | Stateless — works with React Native |
| Email | Nodemailer + SendGrid | Reliable delivery + analytics webhooks |
| AI | Claude claude-sonnet-4-20250514 | Race stories, campaign copy, OCR |
| File storage | Local uploads/ (dev), S3 (prod) | Swap UPLOAD_DIR env var |
| Deployment | Railway or Render (Node.js) | Simple, no Docker required to start |

---

## Notes

- **Club matching:** The `aliases` array on Club is critical. Run `npm run seed` to populate starter aliases. Add more as timing partners are integrated.
- **ELO accuracy:** The engine uses pairwise comparison (not simple place-based). This gives more accurate ratings when field sizes vary.
- **Campaign HTML:** The `htmlBody` is stored in the Campaign doc after first render. Subsequent sends reuse it unless the admin regenerates.
- **COPPA:** `Athlete.isMinor` and `Supporter.isParentAccount` flags exist. Frontend must gate minor data appropriately. Do not expose minor PII via the API without parent consent verification.
- **Rate limiting:** `/api` routes are limited to 300 req/15min by default. Increase for internal cron clients or use a separate internal API prefix.

Questions: noah@regattastream.com
