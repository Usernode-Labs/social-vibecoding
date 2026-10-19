'use strict';

// POST /api/internal/alerts: Alertmanager's webhook into Homeroom.
//
// The cluster's Prometheus rules (the infra repo's kube-prometheus-stack)
// send a reviewed allowlist of alerts to Discord, and nothing to Homeroom,
// so an infra problem reached the platform only when a person read Discord
// or Grafana and said so. A second receiver, `homeroom`, sends every warning
// and critical here as well (docs/platform-signals.md has the receiver and
// routes), and each alert becomes a platform signal (services/platform-
// signals.js): `firing` raises it, `resolved` clears it. Discord keeps
// getting what it got, so a Homeroom outage that stops this webhook still
// reaches people.
//
// AUTH: a bearer token equal to ALERTMANAGER_WEBHOOK_TOKEN, compared in
// constant time. Alertmanager cannot sign a body the way GitHub's webhook
// does, so a shared token is the strongest check it supports; the public
// ingress routes this path too, and the token is what guards it. With no
// token configured the route answers 503 and does nothing.
//
// IDEMPOTENT AND QUICK: the handler only writes rows and answers 200; the
// leader's sweep files the requests. Alertmanager retries anything that is
// not a 2xx, and a repeat of a firing alert only refreshes its row.
//
// The Watchdog alert always fires: it is the heartbeat (platform_signal_
// sources), and its silence for two hours is itself a signal
// (`alerting_silent`).

const crypto = require('node:crypto');
const express = require('express');
const { Router } = express;
const { getPool } = require('../db/pool');
const log = require('../services/logger');

const MAX_ALERTS = 100;

// Warnings that file a request. Every critical files; any other warning is
// recorded (it counts on the infra topic page) and files nothing.
const FILING_WARNINGS = new Set([
  'KubeDeploymentRolloutStuck',
  'KubeDeploymentReplicasMismatch',
  'KubeStatefulSetReplicasMismatch',
  'KubePodCrashLooping',
  'KubePersistentVolumeFillingUp',
  'KubePersistentVolumeInodesFillingUp',
  'NodeFilesystemSpaceFillingUp',
]);

// The labels a request may name: where the alert is, never what it carries.
const RESOURCE_LABELS = Object.freeze([
  'namespace', 'deployment', 'statefulset', 'persistentvolumeclaim', 'node', 'instance', 'mountpoint',
  'database_cluster', 'job',
]);

/** Pure: whether `header` carries `expected` as its bearer token. */
function tokenMatches(header, expected) {
  const m = String(header || '').match(/^Bearer\s+(.+)$/i);
  if (!m || !expected) return false;
  const a = crypto.createHash('sha256').update(m[1].trim()).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Pure: the resource an alert is about, from the labels its route groups by
 * (namespace/deployment, namespace/persistentvolumeclaim, node, instance and
 * mountpoint, namespace/database_cluster, then namespace). Alertmanager's own
 * `fingerprint` hashes every label, pod names included, which change on each
 * restart, so it is not used.
 */
function resourceOf(labels = {}) {
  const l = labels || {};
  const ns = l.namespace ? `${l.namespace}/` : '';
  if (l.deployment) return `${ns}${l.deployment}`;
  if (l.statefulset) return `${ns}${l.statefulset}`;
  if (l.persistentvolumeclaim) return `${ns}${l.persistentvolumeclaim}`;
  if (l.node) return String(l.node);
  if (l.instance && l.mountpoint) return `${l.instance}:${l.mountpoint}`;
  if (l.database_cluster) return `${ns}${l.database_cluster}`;
  if (l.namespace) return String(l.namespace);
  if (l.instance) return String(l.instance);
  return 'cluster';
}

/** Pure: whether Homeroom's own code is the likely fix (a bot problem). */
function isHomeroomDeployment(labels = {}) {
  return labels.namespace === 'social-platform' && /^social-vibecoding/.test(String(labels.deployment || ''));
}

/** Pure: one Alertmanager alert as a platform signal item, or null. */
function itemOf(alert) {
  const labels = alert && typeof alert.labels === 'object' ? alert.labels : {};
  const name = String(labels.alertname || '').slice(0, 80);
  const severity = String(labels.severity || '');
  if (!name || name === 'Watchdog' || !/^(critical|warning)$/.test(severity)) return null;
  const resource = resourceOf(labels).slice(0, 120);
  const annotations = alert.annotations && typeof alert.annotations === 'object' ? alert.annotations : {};
  const where = RESOURCE_LABELS.filter((k) => labels[k]).map((k) => `${k}=${String(labels[k]).slice(0, 80)}`);
  const fileable = severity === 'critical' || FILING_WARNINGS.has(name);
  return {
    kind: 'alert',
    key: `${name}:${resource}`,
    subject: { alertname: name, resource, severity, noFile: !fileable },
    fixer: isHomeroomDeployment(labels) ? 'bot' : 'infra',
    title: `Infra alert: ${name} on ${resource}`,
    summary: `Prometheus's ${severity} alert ${name} is firing for ${resource}.`,
    done: `${name} resolves for ${resource} and stays resolved for 30 minutes.`,
    evidence: {
      lines: [
        `Severity: ${severity}. Firing since ${alert.startsAt || 'unknown'}.`,
        where.length ? `Labels: ${where.join(', ')}.` : null,
        annotations.summary ? `Summary: ${String(annotations.summary).slice(0, 240)}` : null,
        annotations.description ? `Description: ${String(annotations.description).slice(0, 240)}` : null,
      ].filter(Boolean),
      where: isHomeroomDeployment(labels) ? ['deploy/helm/social-vibecoding-platform/templates/platform.yaml'] : [],
    },
    // The rule's link points into the cluster's own Prometheus.
    evidencePrivate: { generatorURL: alert.generatorURL || null, labels },
  };
}

function alertsWebhookRoutes(config) {
  const router = Router();
  const signals = () => require('../services/platform-signals');

  router.post('/api/internal/alerts', express.json({ limit: '1mb' }), async (req, res) => {
    const expected = process.env.ALERTMANAGER_WEBHOOK_TOKEN;
    if (!expected) return res.status(503).json({ error: 'Alerts are not configured on this server' });
    if (!tokenMatches(req.get('authorization'), expected)) return res.status(401).json({ error: 'Unauthorized' });
    const alerts = Array.isArray(req.body?.alerts) ? req.body.alerts.slice(0, MAX_ALERTS) : null;
    if (!alerts) return res.status(400).json({ error: 'Expected an Alertmanager webhook body' });
    const pool = getPool(config);
    let raised = 0;
    let cleared = 0;
    try {
      for (const alert of alerts) {
        if (alert?.labels?.alertname === 'Watchdog') {
          await signals().noteHeartbeat(pool, 'alertmanager');
          continue;
        }
        const item = itemOf(alert);
        if (!item) continue;
        if (alert.status === 'resolved') {
          if (await signals().clear(pool, signals().fingerprintOf('alert', item.key))) cleared += 1;
        } else if (await signals().raise(pool, item)) {
          raised += 1;
        }
      }
      return res.json({ ok: true, received: alerts.length, raised, cleared });
    } catch (err) {
      log.error('alerts-webhook', 'Could not take an Alertmanager webhook', { err: err.message });
      return res.status(500).json({ error: 'Could not record the alerts' });
    }
  });

  return router;
}

module.exports = {
  alertsWebhookRoutes,
  tokenMatches,
  resourceOf,
  itemOf,
  isHomeroomDeployment,
  FILING_WARNINGS,
};
