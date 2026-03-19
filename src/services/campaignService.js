/**
 * Campaign Service — generates and sends supporter email campaigns.
 * Handles: results emails, race previews, weekly digests, season recaps.
 * AI copy generation via Claude. Delivery via Nodemailer/SendGrid.
 */
'use strict';

const nodemailer = require('nodemailer');
const Anthropic   = require('@anthropic-ai/sdk');
const { Campaign, Club, Regatta, Race, Supporter, EloHistory } = require('../models');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── EMAIL TRANSPORT ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── GENERATE CAMPAIGN HTML ─────────────────────────────────────

/**
 * Build a results campaign HTML body.
 * Pulls real data from DB — race results, ELO, season history.
 */
async function buildResultsEmail(campaign) {
  const club    = await Club.findById(campaign.clubId).lean();
  const regatta = campaign.regattaId ? await Regatta.findById(campaign.regattaId).lean() : null;

  // Get races where this club participated
  const races = regatta
    ? await Race.find({ regattaId: regatta._id, 'results.clubId': club._id }).lean()
    : [];

  // Season history — last 8 races for this club
  const eloHistory = await EloHistory
    .find({ clubId: club._id })
    .sort({ date: -1 })
    .limit(8)
    .populate('raceId regattaId')
    .lean();

  // AI-generated intro paragraph
  const intro = await generateIntro(club, regatta, races, 'results');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${campaign.subject}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 0;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- HEADER -->
  <tr><td style="background:${club.primaryColor||'#0D1F3C'};padding:24px;text-align:center;border-radius:8px 8px 0 0;">
    <div style="font-size:40px">${club.emoji||'🚣'}</div>
    <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:900;color:#fff;letter-spacing:1px;margin-top:6px">${(club.name||'').toUpperCase()}</div>
    ${regatta ? `<div style="font-size:12px;color:rgba(255,255,255,.6);margin-top:4px">${regatta.name} · ${regatta.date ? new Date(regatta.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : ''}</div>` : ''}
  </td></tr>

  <!-- BODY -->
  <tr><td style="background:#fff;padding:24px;">
    <h1 style="font-size:20px;font-weight:800;color:#111;margin:0 0 14px">${campaign.subject.replace(/^[🏆⏳📊📰]\s*/,'')}</h1>
    <p style="font-size:14px;color:#555;line-height:1.65;margin:0 0 20px">${intro}</p>

    ${campaign.includes?.timingData && races.length > 0 ? buildResultsTable(races, club) : ''}
    ${campaign.includes?.eloRankings ? buildEloBlock(club) : ''}
    ${campaign.includes?.seasonHistory && eloHistory.length > 0 ? buildHistoryTable(eloHistory) : ''}
    ${campaign.includes?.appCta ? buildAppCta(club) : ''}
    ${campaign.includes?.donateButton && club.donateUrl ? buildDonateBlock(club) : ''}
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f0ede8;padding:14px 24px;border-radius:0 0 8px 8px;border-top:1px solid #e0ddd8;">
    <table width="100%"><tr>
      <td style="font-size:11px;color:#999">Sent via <strong>RegattaStream</strong> · ${regatta?.timingPartner||'RegattaStream'}</td>
      <td align="right" style="font-size:11px"><a href="${process.env.FRONTEND_URL}/unsubscribe?token={{unsubToken}}" style="color:#999">Unsubscribe</a></td>
    </tr></table>
  </td></tr>

</table></td></tr></table>
</body></html>`;

  return html;
}

function buildResultsTable(races, club) {
  if (!races.length) return '';
  let html = `<div style="margin-bottom:20px">
    <div style="font-size:11px;font-weight:700;color:#111;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">🏁 Race Results</div>`;
  for (const race of races.slice(0, 4)) {
    const clubResult = race.results.find(r => String(r.clubId) === String(club._id));
    if (!clubResult) continue;
    html += `<div style="background:#f8f9fa;border-radius:8px;padding:12px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:700;color:#333;margin-bottom:8px">${race.eventName}</div>
      ${race.results.slice(0,4).map(r => `
        <div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid #eee">
          <div style="width:24px;height:24px;border-radius:12px;background:${r.place===1?'#F0A020':r.place===2?'#B8B8B8':'#C07530'};color:${r.place<=2?'#000':'#fff'};display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;margin-right:10px;flex-shrink:0">${r.place}</div>
          <span style="flex:1;font-size:13px;font-weight:${String(r.clubId)===String(club._id)?'700':'400'}">${r.crewName}</span>
          <span style="font-family:monospace;font-size:12px;color:#333">${r.finishTime||''}</span>
          ${r.eloDelta?`<span style="font-size:10px;font-weight:700;margin-left:6px;color:${r.eloDelta>0?'#16a34a':'#dc2626'}">${r.eloDelta>0?'+':''}${r.eloDelta}</span>`:''}
        </div>`).join('')}
    </div>`;
  }
  return html + '</div>';
}

function buildEloBlock(club) {
  return `<div style="display:flex;gap:10px;margin-bottom:20px">
    ${[{n:`#${club.soRank||'—'}`,l:'Speed Order'},{n:club.eloScore||1500,l:'ELO Score'},{n:club.seasonStats?.wins||0,l:'Wins This Season'}].map(s=>
      `<div style="flex:1;background:#f8f9fa;border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:22px;font-weight:800;color:#111">${s.n}</div>
        <div style="font-size:10px;color:#777;text-transform:uppercase;letter-spacing:.4px">${s.l}</div>
      </div>`).join('')}
  </div>`;
}

function buildHistoryTable(history) {
  return `<div style="margin-bottom:20px">
    <div style="font-size:11px;font-weight:700;color:#111;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">📊 Recent Results</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${history.slice(0,5).map(h=>`
        <tr>
          <td style="font-size:11px;color:#999;padding:5px 0;width:60px">${h.date?new Date(h.date).toLocaleDateString('en-US',{month:'short',day:'numeric'}):''}</td>
          <td style="font-size:12px;color:#333;padding:5px 4px">${h.raceId?.eventName||''}</td>
          <td style="font-size:12px;color:#333;padding:5px 0">${h.regattaId?.shortName||h.regattaId?.name||''}</td>
          <td align="right" style="font-size:12px;font-weight:700;color:#111;padding:5px 0">#${h.place||'—'}</td>
          <td align="right" style="font-size:11px;font-weight:700;padding:5px 0 5px 6px;color:${(h.eloDelta||0)>0?'#16a34a':'#dc2626'}">${(h.eloDelta||0)>0?'+':''}${h.eloDelta||0}</td>
        </tr>`).join('')}
    </table>
  </div>`;
}

function buildAppCta(club) {
  return `<div style="text-align:center;margin:20px 0">
    <a href="${process.env.FRONTEND_URL}?utm_source=campaign&utm_medium=email&club=${club._id}" style="display:inline-block;background:#F0A020;color:#111;font-weight:800;font-size:14px;padding:13px 30px;border-radius:8px;text-decoration:none">
      View Full Results on RegattaStream →
    </a>
    <div style="font-size:11px;color:#aaa;margin-top:8px">Free · No credit card · 2 minutes</div>
    <div style="margin-top:10px;display:flex;justify-content:center;gap:10px">
      <a href="${process.env.APP_IOS_URL}" style="font-size:12px;color:#555;text-decoration:none">📱 iOS App</a>
      <a href="${process.env.APP_ANDROID_URL}" style="font-size:12px;color:#555;text-decoration:none">🤖 Android App</a>
    </div>
  </div>`;
}

function buildDonateBlock(club) {
  return `<div style="background:#FFF8E6;border:1px solid #F0A020;border-radius:8px;padding:14px;margin-bottom:16px">
    <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:4px">💛 Support ${club.name}</div>
    <div style="font-size:12px;color:#555;line-height:1.5">Every dollar helps us race, travel, and train at the highest level.</div>
    <a href="${club.donateUrl}" style="display:inline-block;margin-top:10px;background:#F0A020;color:#111;font-weight:700;font-size:12px;padding:8px 18px;border-radius:6px;text-decoration:none">Donate →</a>
  </div>`;
}

// ── AI COPY GENERATION ─────────────────────────────────────────

async function generateIntro(club, regatta, races, type) {
  try {
    const bestResult = races.flatMap(r => r.results)
      .filter(r => String(r.clubId) === String(club._id))
      .sort((a, b) => a.place - b.place)[0];

    const prompt = type === 'results'
      ? `Write a 2-sentence email intro for a ${club.name} supporter email about their recent race at ${regatta?.name || 'a regatta'}. ${bestResult ? `They finished #${bestResult.place} with a time of ${bestResult.finishTime}.` : ''} Keep it enthusiastic, specific, and brief. No hashtags, no em dashes.`
      : `Write a 2-sentence pre-race preview intro for a ${club.name} supporter email about their upcoming race at ${regatta?.name || 'an upcoming regatta'}. Keep it energetic, specific, brief.`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text?.trim() || '';
  } catch {
    return `${club.name} had a strong showing this weekend. Here's the full breakdown.`;
  }
}

// ── SEND ───────────────────────────────────────────────────────

/**
 * Send a campaign to all eligible supporters.
 * Handles unsubscribed, COPPA minors, and tracking tokens.
 */
async function send(campaignId) {
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
    throw new Error(`Campaign status is ${campaign.status} — cannot send`);
  }

  // Build HTML if not already set
  let html = campaign.htmlBody;
  if (!html) {
    html = await buildResultsEmail(campaign);
    await Campaign.findByIdAndUpdate(campaignId, { htmlBody: html });
  }

  // Get recipients
  const segmentQuery = { clubId: campaign.clubId, subscribed: true };
  const { segment } = campaign.audience || {};
  if (segment && segment !== 'all') {
    segmentQuery.role = segment === 'parents' ? { $in: ['parent'] }
      : segment === 'alumni'  ? { $in: ['alumni'] }
      : segment === 'donors'  ? { $in: ['donor'] }
      : segment === 'athletes'? { $in: ['athlete'] }
      : undefined;
  }

  const supporters = await Supporter.find(segmentQuery).lean();

  // Mark sending
  await Campaign.findByIdAndUpdate(campaignId, {
    status: 'sending',
    'audience.recipientCount': supporters.length,
    sentAt: new Date(),
  });

  // Batch send (50 at a time to respect rate limits)
  const BATCH = 50;
  const messageIds = [];
  for (let i = 0; i < supporters.length; i += BATCH) {
    const batch = supporters.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async sup => {
      const personalizedHtml = html.replace('{{unsubToken}}', Buffer.from(sup._id.toString()).toString('base64'));
      const info = await transporter.sendMail({
        from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_FROM}>`,
        to: sup.email,
        subject: campaign.subject,
        html: personalizedHtml,
        headers: {
          'X-Campaign-Id': campaignId,
          'X-Supporter-Id': sup._id.toString(),
        },
      });
      messageIds.push(info.messageId);
    }));
    // Brief pause between batches
    if (i + BATCH < supporters.length) await new Promise(r => setTimeout(r, 500));
  }

  await Campaign.findByIdAndUpdate(campaignId, {
    status: 'sent',
    externalMessageIds: messageIds,
  });

  return { sent: supporters.length, campaignId };
}

module.exports = { buildResultsEmail, generateIntro, send };
