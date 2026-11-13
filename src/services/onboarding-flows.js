'use strict';

// Admin › Onboarding flows: one row per real person, saying where they came
// from, how they got in, what they did first, which projects they made or
// joined, where they are now and how engaged they are. The section
// (frontend/src/features/admin/admin-onboarding-flows.tsx) draws each row as
// one thread through a flow chart.
//
// It reads nothing of its own. Four readings of services/journey.js are
// joined by user id: everyone's first mile (everyoneMile), who is in which
// project and whom they brought (flows), the stages over all time (stages),
// and when each person last did something (lastActs); the people still on
// the waitlist come counted (waitingSummary). `assemble` is the join, and it
// is pure, so its rules are tested without a database.
//
// The four rules it settles, so the chart never has to guess:
//   * A project is private or public by its audience as it is now
//     (communities.audienceSql: 'open' is public, anything else private).
//   * A contribution is a vote on a change or a request, feedback, a request
//     filed, or a change of their own. It counts for the project it was on.
//   * Somebody is in a lane only while they are active: a contribution or a
//     day in an app within RECENT_DAYS. Before that they are 'lapsed'.
//   * Somebody let off the waitlist within TOO_NEW_DAYS who has not made an
//     account yet is 'new', too early to say, not lost.

const journey = require('./journey');

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 28;
const TOO_NEW_DAYS = 7;
// "Came back to" a project: its app used on this many days or more.
const RETURN_DAYS = 2;

// What people answer when the waitlist asks where they heard of Homeroom.
// Anything else they typed is 'other'.
const SAID = new Set(['x', 'friend', 'event', 'other']);

// A referring host named by the platform it belongs to, where it is one.
const PLATFORMS = [
  ['t.co', 'X'], ['x.com', 'X'], ['twitter.com', 'X'], ['wa.me', 'WhatsApp'], ['whatsapp', 'WhatsApp'],
  ['t.me', 'Telegram'], ['telegram', 'Telegram'], ['discord', 'Discord'], ['instagram', 'Instagram'],
  ['reddit', 'Reddit'], ['linkedin', 'LinkedIn'], ['facebook', 'Facebook'], ['youtube', 'YouTube'],
  ['google', 'Google'],
];

/**
 * The best recorded evidence of where a click came from: a named platform
 * or host, a campaign, a tag, or how the invite link was passed on.
 * `{ t: 'rec', l }` when something was recorded, `{ t: 'noref' }` when the
 * source was looked for and none was given, null when nothing was recorded.
 */
function channel({ host = null, utm = null, tag = null, via = null } = {}) {
  const named = host && host !== 'none' ? String(host) : null;
  if (named) {
    const hit = PLATFORMS.find(([needle]) => named.toLowerCase().includes(needle));
    return { t: 'rec', l: hit ? hit[1] : named };
  }
  if (utm && utm !== 'none') return { t: 'rec', l: `Campaign: ${utm}` };
  if (tag && tag !== 'none') return { t: 'rec', l: `Tag: ${tag}` };
  if (via && via !== 'none') return { t: 'rec', l: via === 'copied' ? 'Link copied' : via === 'shared' ? 'Link shared' : `Link ${via}` };
  if (host === 'none') return { t: 'noref' };
  return null;
}

const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const daysBetween = (from, to) => Math.floor((new Date(to).getTime() - new Date(from).getTime()) / DAY_MS);
const audOf = (app) => (app && app.audience === 'open' ? 'public' : 'private');
const step = (m, key) => (m.steps || []).find((s) => s.key === key) || null;
const stepDone = (m, key) => { const s = step(m, key); return !!s && s.state === 'done'; };

/**
 * Pure: the lanes of one person from their facts. `priv` is being in a
 * private project with someone else (their link brought somebody into one,
 * or they joined one and did something); `pub` is contributing to a public
 * project ('contrib') or coming back to one ('user'). Either counts only
 * while the person is `recent`; otherwise they are 'lapsed'.
 */
function classify(p) {
  const acted = p.first !== 'none' || p.st.includes('V');
  const privShare = p.shared.some((x) => x.aud === 'private');
  const privInv = !!p.inv && p.inv.aud === 'private' && p.inv.status === 'joined';
  const priv = privShare || (privInv && acted && p.got === 'in');
  const pub = p.pubContrib ? 'contrib' : (p.pubN > 0 ? 'user' : null);
  const would = priv || !!pub;
  const live = would && p.recent;
  let out = 'none';
  if (would && !p.recent) out = 'lapsed';
  else if (privShare) out = 'shared';
  else if (pub === 'contrib') out = 'pub_contrib';
  else if (pub === 'user') out = 'pub_user';
  else if (priv) out = 'member';
  let lane = 'none';
  if (live) lane = priv && pub ? 'both' : (priv ? 'share' : 'pub');
  return { ...p, priv: live && priv, pub: live ? pub : null, out, lane };
}

/**
 * Pure: the reading, from the five Journey readings it joins.
 *
 * `people` are one row each, keyed `k` (the user id, or 's<signupId>' for a
 * person with no account). `ghost` are inviters who are not counted
 * themselves (staff, the left-out list) with the people their links
 * reached. `pubApps` are the public projects by how many people came back.
 */
function assemble({ mile, flows, stages, last, waiting, early = null, now = new Date() } = {}) {
  const nowMs = new Date(now).getTime();
  const appBySlug = new Map((flows.apps || []).map((a) => [a.slug, a]));
  const flowsByUser = new Map((flows.people || []).map((p) => [Number(p.userId), p]));
  const stageByUser = new Map((stages.people || []).map((p) => [Number(p.userId), p]));
  const keyOf = (m) => (m.userId != null ? Number(m.userId) : `s${m.signupId}`);
  const known = new Set((mile.people || []).filter((m) => m.userId != null).map((m) => Number(m.userId)));
  const earlyUntil = early && early.until ? new Date(early.until).getTime() : null;

  const people = (mile.people || []).map((m) => {
    const uid = m.userId != null ? Number(m.userId) : null;
    const fp = uid != null ? flowsByUser.get(uid) : null;
    const sg = uid != null ? stageByUser.get(uid) : null;
    const la = uid != null && last ? last.get(uid) : null;
    const apps = fp ? fp.apps : [];
    const appOf = (a) => appBySlug.get(a.slug) || null;

    // The door: the invite, when it came before they were in; else the
    // waitlist, when they were let off it; else they were let in directly.
    const inviteFirst = !!m.invite && m.inviteAt
      && (!m.accessAt || new Date(m.inviteAt).getTime() <= new Date(m.accessAt).getTime());
    const waitJoined = m.releasedAt && m.waitlist && m.waitlist.joinedAt ? new Date(m.waitlist.joinedAt).getTime() : null;
    let door = 'direct';
    if (inviteFirst && (waitJoined == null || new Date(m.inviteAt).getTime() <= waitJoined)) door = 'invite';
    else if (m.releasedAt) door = 'waitlist';
    else if (inviteFirst) door = 'invite';

    const s1 = earlyUntil != null && !!m.accountAt && new Date(m.accountAt).getTime() <= earlyUntil;
    const said = m.waitlist && m.waitlist.discovery ? String(m.waitlist.discovery).toLowerCase() : null;
    let src = 'unrecorded';
    if (s1) src = 'season1';
    else if (door === 'invite') src = 'invite';
    else if (door === 'waitlist' && said) src = SAID.has(said) ? said : 'other';

    const tooNew = !!m.releasedAt && nowMs - new Date(m.releasedAt).getTime() < TOO_NEW_DAYS * DAY_MS;
    let got = 'in';
    if (!m.hasAccount) {
      if (tooNew) got = 'new';
      else got = m.stuckAt === 'mail_sent' ? 'mail_none' : 'mail_ignored';
    } else if (m.invitedOnly || !stepDone(m, 'access')) {
      got = step(m, 'account') && !stepDone(m, 'account') ? 'acct' : 'waiting';
    } else if (!stepDone(m, 'account')) got = 'acct';

    const firstAct = step(m, 'first_act');
    let first = 'none';
    if (got === 'in' && firstAct && firstAct.state === 'done') {
      first = firstAct.note === 'app' ? 'app' : (firstAct.note === 'joined' ? 'joined' : 'spoke');
    }
    const opened = step(m, 'opened');

    const st = sg ? [['A', 'arrive'], ['E', 'explore'], ['V', 'activate'], ['B', 'belong'], ['U', 'use'], ['S', 'stay']]
      .filter(([, key]) => sg[key] === true).map(([ch]) => ch).join('') : '';
    const kinds = sg ? [...(sg.activateKinds || [])] : [];

    const made = apps.filter((a) => a.made && appOf(a)).map((a) => ({ n: appOf(a).name, aud: audOf(appOf(a)), at: day(appOf(a).madeAt) }));
    const returned = apps.filter((a) => a.days >= RETURN_DAYS);
    const pubBack = returned.filter((a) => !a.made && appOf(a) && appOf(a).audience === 'open' && !appOf(a).platform)
      .sort((a, b) => b.days - a.days);
    const contributed = (a) => a.votes + a.requests + a.feedback + a.changes > 0;
    const pubContrib = apps.some((a) => appOf(a) && appOf(a).audience === 'open' && contributed(a));

    // The invite that brought them: the link they followed, else an invite
    // by name to a project they did not make.
    let inv = null;
    if (m.invite) {
      const app = m.invite.slug ? appBySlug.get(m.invite.slug) : null;
      inv = {
        by: m.invite.by, n: m.invite.project || (app && app.name) || null, aud: audOf(app),
        how: m.invite.how || null, status: m.invite.status === 'joined' ? 'joined' : 'waiting', seen: !!m.invite.openedAt,
      };
    } else {
      const named = apps.find((a) => a.invitedBy && !a.made && appOf(a));
      if (named) {
        inv = { by: named.invitedBy, n: appOf(named).name, aud: audOf(appOf(named)), how: null, status: named.member ? 'joined' : 'waiting', seen: false };
      }
    }

    const shared = (fp ? fp.invites : []).map((i) => {
      const app = appBySlug.get(i.slug);
      const mine = apps.find((a) => a.slug === i.slug);
      return { n: app ? app.name : i.slug, aud: audOf(app), own: !!(mine && mine.made), inv: i.reached.map((r) => Number(r.userId)).filter((id) => known.has(id)) };
    }).filter((x) => x.inv.length > 0);
    const sent = (fp ? fp.invites : []).reduce((n, i) => n + i.links + i.direct, 0);

    const lastContrib = la && la.lastContribAt ? new Date(la.lastContribAt).getTime() : null;
    const lastApp = la && la.lastAppDay ? new Date(`${la.lastAppDay}T00:00:00Z`).getTime() : null;
    const lastActive = Math.max(lastContrib || 0, lastApp || 0) || null;
    const ago = (ms) => (ms == null ? null : Math.max(0, Math.floor((nowMs - ms) / DAY_MS)));

    return classify({
      k: keyOf(m),
      n: m.hasAccount ? m.name : `Signup #${m.signupId}`,
      door, src, s1, tooNew,
      linkJoin: !!m.invite && door !== 'invite',
      cohort: day(m.releasedAt),
      wait: m.waitlist && m.releasedAt ? m.waitlist.waitedDays : null,
      got,
      stuck: m.stuckAt || null,
      stuckReason: m.stuckReason || null,
      first,
      opened: opened && opened.state === 'done',
      st, kinds,
      days: m.daysSince,
      failed: m.failedAttempts || 0,
      taps: m.repeatedTaps || 0,
      mail: m.mail ? [m.mail.opened === true, m.mail.clicked === true] : null,
      signup: m.signupMethod || null,
      acct: day(m.accountAt),
      access: day(m.accessAt),
      noAccount: !m.hasAccount,
      arr: door === 'waitlist' && m.cameFrom && m.cameFrom.waitlist
        ? channel({ host: m.cameFrom.waitlist.referrerHost, utm: m.cameFrom.waitlist.utmSource, tag: m.cameFrom.waitlist.ref })
        : (door === 'invite' && m.cameFrom && m.cameFrom.invite
          ? channel({ host: m.cameFrom.invite.referrerHost, via: m.cameFrom.invite.via }) : null),
      via: inv && m.cameFrom && m.cameFrom.invite
        ? channel({ host: m.cameFrom.invite.referrerHost, via: m.cameFrom.invite.via }) : null,
      made, inv, shared, sent,
      useDays: returned.reduce((n, a) => n + a.days, 0),
      useApps: returned.length,
      pubApp: pubBack.length ? appOf(pubBack[0]).name : null,
      pubDays: pubBack.length ? pubBack[0].days : 0,
      pubN: pubBack.length,
      pubContrib,
      accepted: apps.reduce((n, a) => n + a.live, 0),
      lastA: ago(lastActive),
      lastC: ago(lastContrib),
      recent: lastActive != null && nowMs - lastActive <= RECENT_DAYS * DAY_MS,
    });
  });

  // Inviters who are not counted themselves, with the counted people their
  // invites reached.
  const names = new Set(people.filter((p) => !p.noAccount).map((p) => p.n));
  const ghosts = new Map();
  for (const p of people) {
    if (!p.inv || !p.inv.by || names.has(p.inv.by)) continue;
    if (!ghosts.has(p.inv.by)) ghosts.set(p.inv.by, new Map());
    const byApp = ghosts.get(p.inv.by);
    if (!byApp.has(p.inv.n)) byApp.set(p.inv.n, { n: p.inv.n, aud: p.inv.aud, own: false, inv: [] });
    byApp.get(p.inv.n).inv.push(p.k);
  }
  const ghost = [...ghosts.entries()].map(([n, byApp]) => ({ n, shared: [...byApp.values()] }));

  // Public projects by the people who came back to them.
  const usage = new Map();
  for (const fp of flows.people || []) {
    if (!known.has(Number(fp.userId))) continue;
    for (const a of fp.apps) {
      const app = appBySlug.get(a.slug);
      if (!app || app.audience !== 'open' || app.platform || a.made || !a.days) continue;
      if (!usage.has(a.slug)) usage.set(a.slug, { n: app.name, vis: 0, back: 0, mk: app.madeBy ? [app.madeBy.name] : [] });
      const u = usage.get(a.slug);
      u.vis += 1;
      if (a.days >= RETURN_DAYS) u.back += 1;
    }
  }
  const pubApps = [...usage.values()].sort((a, b) => b.back - a.back || b.vis - a.vis);

  return {
    asOf: new Date(now).toISOString(),
    early: early ? { label: early.label, until: day(early.until) } : null,
    rules: { recentDays: RECENT_DAYS, tooNewDays: TOO_NEW_DAYS, returnDays: RETURN_DAYS },
    people,
    ghost,
    pubApps: pubApps.slice(0, 14),
    nPublic: pubApps.length,
    nApps: (flows.apps || []).filter((a) => !a.platform).length,
    waiting: waiting || null,
    cut: !!(mile.cut || flows.cut),
  };
}

// The first season: the people who had an account by its end are the ones
// who were here before the waitlist, and the chart can leave them out.
const EARLY_SQL = `SELECT s.name, s.ends_at FROM seasons s
                    WHERE s.internal IS NOT TRUE
                    ORDER BY s.starts_at, s.id
                    LIMIT 1`;

async function earlySeason(pool, now) {
  const { rows } = await pool.query(EARLY_SQL);
  const row = rows[0];
  if (!row || !row.ends_at || new Date(row.ends_at).getTime() > new Date(now).getTime()) return null;
  return { label: row.name, until: row.ends_at };
}

/** The reading for Admin › Onboarding flows (assemble says its shape). */
async function reading(pool, { now = new Date(), leftOutIds = [] } = {}) {
  const ctx = { now, leftOutIds };
  const [mile, flows, stages, last, waiting, early] = await Promise.all([
    journey.everyoneMile(pool, ctx),
    journey.flows(pool, ctx),
    journey.stages(pool, { week: journey.allTime(now), ...ctx }),
    journey.lastActs(pool, ctx),
    journey.waitingSummary(pool, ctx),
    earlySeason(pool, now),
  ]);
  return assemble({ mile, flows, stages, last, waiting, early, now });
}

module.exports = {
  RECENT_DAYS,
  TOO_NEW_DAYS,
  RETURN_DAYS,
  EARLY_SQL,
  channel,
  classify,
  assemble,
  earlySeason,
  reading,
};
