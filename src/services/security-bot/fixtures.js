'use strict';

// The security bot's full synthetic fixture set for an arena (#4678, checkpoint
// two). An arena is a throwaway target seeded entirely with fabricated people
// and fabricated data, so the probes have real identity and ownership
// boundaries to test without ever touching a real person or real data.
//
// The cast mirrors the personas a change is ever shot or reviewed under, so the
// arena can exercise each one:
//
//   * alice, bob      two ordinary signed-in members, each a member of exactly
//                     one private project (disjoint membership).
//   * nonMember       a signed-in member of NEITHER project, for "a stranger
//                     who is logged in still cannot read it".
//   * readOnlyAdmin   a Homeroom read-only administrator.
//   * fullAdmin       a controller-only full administrator — the identity that
//                     exists only inside the disposable build, never a real
//                     account, used to drive controls read-only admins cannot.
//
// Two private projects, A and B, with DISJOINT membership (A: alice, B: bob),
// each holding obviously-fake protected data and a PER-RUN secret marker. The
// marker is unique to the run, so a leak found in a probe can be traced to the
// run that planted it and can never be confused with real content.
//
// Everything here is pure: it fabricates values, writes nothing, and makes no
// network or model call. The arena/runtime boundary is what plants these into
// the throwaway target; this module only describes them.

const crypto = require('node:crypto');

class FixtureError extends Error {
  constructor(code) {
    super(`Security bot fixtures: ${code}`);
    this.name = 'SecurityBotFixtureError';
    this.code = code;
  }
}

// An obviously-fake, per-run marker embedded in every planted secret. Carries
// the run id so a leak is traceable, and random bytes so two runs never share a
// marker.
function runMarker(runId) {
  if (!Number.isSafeInteger(runId) || runId < 0) throw new FixtureError('invalid_run_id');
  return `secbot-run-${runId}-${crypto.randomBytes(8).toString('hex')}`;
}

function persona(label, role, { controllerOnly = false } = {}) {
  return {
    identityRef: `arena-${label}-${crypto.randomUUID()}`,
    // Obviously fake: an `arena-demo-` prefix no real account can wear.
    username: `arena-demo-${label}`,
    displayName: `Arena demo ${label[0].toUpperCase()}${label.slice(1)}`,
    role,
    controllerOnly,
  };
}

/**
 * Build the full fixture set for one run.
 *
 *   buildFixtureSet({ runId }) => {
 *     runMarker,
 *     personas: { alice, bob, nonMember, readOnlyAdmin, fullAdmin },
 *     projects: { A, B },   // each { key, name, memberRefs, secret, marker }
 *   }
 *
 * A project's `secret` embeds the per-run marker, so a value that surfaces where
 * it should not be readable is unambiguously this run's planted data.
 */
function buildFixtureSet({ runId } = {}) {
  const marker = runMarker(runId);
  const personas = {
    alice: persona('alice', 'member'),
    bob: persona('bob', 'member'),
    nonMember: persona('nonmember', 'member'),
    readOnlyAdmin: persona('ro-admin', 'read_only_admin'),
    fullAdmin: persona('full-admin', 'full_admin', { controllerOnly: true }),
  };
  const project = (key, name, members) => ({
    key,
    name: `Arena demo project ${name}`,
    memberRefs: members.map((p) => p.identityRef),
    // Obviously-fake protected data carrying this run's marker.
    secret: `arena-demo-secret-${key}-${marker}-${crypto.randomBytes(12).toString('hex')}`,
    marker,
  });
  const projects = {
    A: project('A', 'A', [personas.alice]),
    B: project('B', 'B', [personas.bob]),
  };
  return { runMarker: marker, personas, projects };
}

/**
 * Map the fixture set onto the two owners the private-data cross-account probe
 * expects ({ ownerA, ownerB }), so that probe can be reused unchanged:
 *
 *   ownerA  alice reading project A (her own)       — positive control side
 *   ownerB  bob reading project B (alice must not)  — the cross-account target
 *
 * `username` is the project key used to build the resource path; `identityRef`
 * is the member who is authorized for that project; `secret` is the project's
 * planted secret.
 */
function probeOwners(set) {
  if (!set?.projects?.A || !set?.projects?.B) throw new FixtureError('fixtures_required');
  return {
    ownerA: {
      identityRef: set.personas.alice.identityRef,
      username: set.projects.A.key,
      secret: set.projects.A.secret,
    },
    ownerB: {
      identityRef: set.personas.bob.identityRef,
      username: set.projects.B.key,
      secret: set.projects.B.secret,
    },
  };
}

module.exports = { FixtureError, runMarker, buildFixtureSet, probeOwners };
