'use strict';

// What a proposal still needs before it merges — the whole ordered list, not
// just the thing currently wrong with it.
//
// The card's tags are a NEGATIVE surface: they name what is broken and say
// nothing about what is required. So an absent tag is ambiguous between three
// very different facts — the gate passed, the gate does not apply here, or the
// gate has no UI at all. The third case was real for two of the seven: a
// locked app's admin-yes requirement surfaced only as a toast to whoever voted
// next, and the GitHub-side refusals surfaced nowhere.
//
// A developer can infer the rest. The question a voter actually has is not
// "what state is this in" but "is it my turn?", and no arrangement of tags
// answers that.
//
// ── Why this is a spec plus a stop point, and not a second evaluator ──
//
// routes/votes.js's checkAndMerge IS the gate. Re-deriving its conditions here
// would mean two implementations of "can this merge", drifting apart, with the
// describing one eventually lying about the deciding one.
//
// It does not need re-deriving. The gate is a fixed, ordered list, and
// evaluation only ever has to reach the FIRST refusal: everything before it
// passed, the refusal is where the proposal is now, and everything after it is
// simply not reached yet. So checkAndMerge records what it actually did, from
// the same call sites that already narrate it into merge_debug_runs, and this
// module holds the static order and turns the two into a list.
//
// That is also why `evaluated` is stored as an ORDERED ARRAY rather than a map
// keyed by gate: it is a recording of a real run, and its order is the gate's
// order, not this file's idea of it.
//
// Named REQUIREMENTS, not "merge gate", on purpose: services/active-users.js
// already exports a mergeGate(), and it is only the first of the seven steps
// below — the vote threshold. Two things called the same would be read as one.

// The gates, in the order checkAndMerge evaluates them. `key` matches the
// phase its dstep() already reports.
//
// `actor` is the half that makes the list worth showing. Most steps are
// 'auto' — nobody has to do anything — and saying so is the reassurance the
// tags structurally cannot give. The other three name a person, and that is
// what the card's opening rule keys on.
const GATES = [
  {
    key: 'approvals',
    label: 'Enough approvals',
    actor: 'group',
  },
  {
    key: 'explicit',
    label: 'Explicit approval from the group',
    actor: 'group',
    // Only for a change to dapp.json's admins block, which loses the
    // time-based merge paths entirely.
    applies: (c) => !!c.explicitApproval,
  },
  {
    key: 'admin_yes',
    label: 'An admin approves it',
    actor: 'admin',
    applies: (c) => !!c.locked,
  },
  {
    key: 'integration',
    label: 'Up to date with main',
    actor: 'auto',
  },
  {
    key: 'checks',
    label: 'Checks pass',
    actor: 'author',
  },
  {
    key: 'platform_env',
    label: 'Platform variables have values',
    actor: 'admin',
    // The platform's own app only: a proposal that declares a required
    // variable with no value would deploy the platform into a crash loop.
    applies: (c) => !!c.selfHosted,
  },
  {
    key: 'github',
    label: 'GitHub accepts the merge',
    actor: 'auto',
  },
];

const GATE_KEYS = new Set(GATES.map((g) => g.key));

// done    — passed
// active  — in flight, nobody has to act (a sync, a check run, the merge)
// waiting — a person has to do something
// blocked — something failed and needs fixing
// pending — not reached yet
const STATES = new Set(['done', 'active', 'waiting', 'blocked', 'pending']);

/**
 * Collects what a single checkAndMerge run actually did.
 *
 * The gate calls pass() as it clears each condition and stop() at the one that
 * refuses, beside the dstep() already there. Nothing here decides anything —
 * it only records, which is the property that keeps it honest.
 */
function trace() {
  const evaluated = [];
  const context = {};
  let stopped = false;
  return {
    /** Record which optional gates apply to this proposal at all. */
    context(patch) {
      Object.assign(context, patch || {});
      return this;
    },
    pass(key, detail) {
      if (!GATE_KEYS.has(key)) throw new Error(`Unknown merge gate: ${key}`);
      if (stopped) return this;
      evaluated.push({ key, state: 'done', detail: detail || null });
      return this;
    },
    /** The gate that refused. Everything after it is 'pending' by definition. */
    stop(key, state, detail) {
      if (!GATE_KEYS.has(key)) throw new Error(`Unknown merge gate: ${key}`);
      if (!STATES.has(state)) throw new Error(`Unknown gate state: ${state}`);
      if (stopped) return this;
      evaluated.push({ key, state, detail: detail || null });
      stopped = true;
      return this;
    },
    /**
     * Correct the recorded stop once its real outcome is known.
     *
     * Gate 7 is the only caller. It is marked 'active' before the merge is
     * attempted — which is genuinely what is happening while it runs — and the
     * attempt then either succeeds or fails in one of three ways that used to
     * be visible nowhere. Revising is how one gate reports both, without
     * letting a later gate's mark reopen an earlier gate's refusal.
     */
    revise(key, state, detail) {
      if (!GATE_KEYS.has(key)) throw new Error(`Unknown merge gate: ${key}`);
      if (!STATES.has(state)) throw new Error(`Unknown gate state: ${state}`);
      const last = evaluated[evaluated.length - 1];
      if (!last || last.key !== key) return this;
      last.state = state;
      last.detail = detail || null;
      return this;
    },
    get stopped() { return stopped; },
    toRecord() {
      return { evaluated: evaluated.slice(), context: { ...context } };
    },
  };
}

/**
 * spec + what the run did → the full ordered list the card renders.
 *
 * A gate that does not apply is OMITTED rather than greyed: a locked-app row
 * on an unlocked app is noise, and the count should read 4 of 4 rather than
 * 4 of 7.
 */
function describe(record) {
  const r = record || {};
  const evaluated = Array.isArray(r.evaluated) ? r.evaluated : [];
  const context = r.context || {};
  const seen = new Map();
  for (const e of evaluated) {
    if (e && GATE_KEYS.has(e.key) && !seen.has(e.key)) seen.set(e.key, e);
  }
  const out = [];
  for (const gate of GATES) {
    if (gate.applies && !gate.applies(context)) continue;
    const hit = seen.get(gate.key);
    out.push({
      key: gate.key,
      label: gate.label,
      actor: gate.actor,
      state: hit && STATES.has(hit.state) ? hit.state : 'pending',
      detail: (hit && hit.detail) || null,
    });
  }
  return out;
}

// Who each actor means, in the words the card uses.
const ACTOR_WORD = { auto: 'automatic', author: 'the author', admin: 'an admin', group: 'the group' };

/**
 * The collapsed line — the whole answer for most people.
 *
 * `viewer` is { isAuthor, isAdmin, hasVoted }; all three are already known on
 * the client, so this costs no new field. It decides two things: whether the
 * headline says "you" instead of a role, and `opensFor` — the one viewer this
 * card should expand itself for.
 */
function summarize(list, viewer) {
  const gates = Array.isArray(list) ? list : [];
  const v = viewer || {};
  const total = gates.length;
  const done = gates.filter((g) => g.state === 'done').length;
  // The step the proposal is actually sitting on: the first that is neither
  // finished nor unreached.
  const current = gates.find((g) => g.state !== 'done' && g.state !== 'pending') || null;

  if (!current) {
    return {
      headline: total && done === total ? 'Merging now' : 'Nothing left to check',
      detail: total ? `all ${total} steps done` : null,
      done, total, current: null, opensFor: null, needsViewer: false,
    };
  }

  // 'auto' and anything in flight need nobody, whoever is looking.
  if (current.actor === 'auto' || current.state === 'active') {
    return {
      headline: 'Nothing needs you',
      detail: current.detail && current.detail.note ? current.detail.note : current.label.toLowerCase(),
      done, total, current: current.key, opensFor: null, needsViewer: false,
    };
  }

  const byActor = {
    author: { headline: 'Waiting on the author', mine: 'Waiting on you', opensFor: 'author', is: !!v.isAuthor },
    admin: { headline: 'Waiting on an admin', mine: 'Waiting on you', opensFor: 'admin', is: !!v.isAdmin },
    group: { headline: 'Waiting on the group', mine: 'Waiting on your vote', opensFor: 'voter', is: !v.hasVoted },
  }[current.actor] || null;

  if (!byActor) {
    return {
      headline: 'Waiting', detail: current.label.toLowerCase(),
      done, total, current: current.key, opensFor: null, needsViewer: false,
    };
  }

  return {
    headline: byActor.is ? byActor.mine : byActor.headline,
    detail: (current.detail && current.detail.note) || null,
    done,
    total,
    current: current.key,
    // A card opens itself only for the person who can clear the step it is
    // stuck on. An admin-approval row put in front of somebody who is not an
    // admin is a chore they cannot do.
    opensFor: byActor.opensFor,
    needsViewer: byActor.is,
  };
}

/** The nested block the serializer hangs on a proposal row, beside `integration`. */
function readRequirements(session) {
  const s = session || {};
  const raw = s.merge_requirements;
  const record = raw && typeof raw === 'object' ? raw : null;
  if (!record) return { measuredAt: null, gates: [], evaluated: false };
  return {
    measuredAt: s.merge_requirements_at ? new Date(s.merge_requirements_at).toISOString() : null,
    gates: describe(record),
    evaluated: true,
  };
}

/**
 * Store what a run did. Best-effort by construction: this is a DESCRIPTION,
 * and a proposal must never fail to merge because its description could not
 * be written down.
 */
async function store(pool, sessionId, t) {
  if (!pool || !sessionId || !t) return null;
  const record = typeof t.toRecord === 'function' ? t.toRecord() : t;
  if (!record || !Array.isArray(record.evaluated) || !record.evaluated.length) return null;
  try {
    await pool.query(
      `UPDATE chat_sessions
          SET merge_requirements = $2::jsonb, merge_requirements_at = NOW()
        WHERE id = $1`,
      [sessionId, JSON.stringify(record)]
    );
  } catch {
    return null;
  }
  return record;
}

module.exports = {
  GATES,
  ACTOR_WORD,
  trace,
  describe,
  summarize,
  readRequirements,
  store,
};
