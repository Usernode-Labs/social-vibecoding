'use strict';

const docker = require('../docker');
const kubernetes = require('../kubernetes');
const caddy = require('../caddy');

function bindingRef(config, app, sessionId) {
  const runtimeKind = require('../application-runtime').mode(config);
  return {
    runtimeKind,
    appId: app.id,
    appSlug: app.slug,
    sessionId,
    hostname: runtimeKind === 'kubernetes'
      ? `${app.slug}--s${sessionId}.${config.kubernetes.appDomain}`
      : caddy.stagingHostname(app.slug, `s${sessionId}`),
    runtimeName: kubernetes.appResourceName(app, 'staging', sessionId),
    namespace: runtimeKind === 'kubernetes' ? config.kubernetes.appNamespace : null,
  };
}

function findPreviewMap(value) {
  const found = [];

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.handler === 'map' && node.source === '{http.request.host}'
        && node.destinations?.includes('{upstream}')) {
      found.push(node);
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === 'object') visit(child);
    }
  }

  visit(value);
  if (found.length !== 1) throw new Error('Caddy preview map is missing or ambiguous');
  return found[0];
}

function caddyTarget(map, hostname) {
  const index = map.destinations.indexOf('{upstream}');
  for (const mapping of map.mappings || []) {
    if (mapping.input === hostname) {
      const target = mapping.outputs?.[index];
      if (typeof target !== 'string' || !target) throw new Error('Caddy preview target is unrecognized');
      return target;
    }
    if (!mapping.input_regexp) continue;
    // The existing Caddyfile uses numbered captures, expanded by Go's regexp
    // package. Unsupported expressions fail closed instead of assuming an alias.
    const match = new RegExp(mapping.input_regexp).exec(hostname);
    if (!match) continue;
    const output = mapping.outputs?.[index];
    if (typeof output !== 'string') throw new Error('Caddy preview target is unrecognized');
    const target = output.replace(/\$(?:\{(\d+)\}|(\d+))/g, (_text, braced, plain) => match[Number(braced || plain)] || '');
    if (!target || /[${}]/.test(target)) throw new Error('Caddy preview target expansion is unrecognized');
    return target;
  }
  throw new Error('Caddy preview has no recognized route');
}

// Keep the admin endpoint on Caddy's loopback. The platform already has Docker
// authority; generated apps do not. Tests can supply an HTTP transport instead.
async function caddyAdmin(config, body = null, token = null) {
  const args = ['exec', config.previewCaddyContainer || 'caddy', 'wget', '-S', '-O', '-'];
  if (body !== null) {
    args.push('--header=Content-Type: application/json', `--header=If-Match: ${token}`,
      `--post-data=${JSON.stringify(body)}`);
  }
  args.push('http://127.0.0.1:2019/config/');
  let result;
  try {
    result = await docker.execFileAsync('docker', args, { timeout: 15000 });
  } catch (_) {
    // execFile errors include command arguments, including the configuration.
    // Never send that body to diagnostics or caller-visible error text.
    throw new Error('Conditional Caddy configuration request failed; inspect before retrying');
  }

  const etag = String(result.stderr).match(/\bEtag:\s*([^\r\n]+)/i)?.[1].trim();
  if (body === null && !etag) throw new Error('Caddy did not provide a conditional configuration token');
  return { body: body === null ? JSON.parse(result.stdout) : null, token: etag };
}

function createBindingAdapters({ admin = caddyAdmin, clients = kubernetes._getClients } = {}) {
  async function inspect(config, ref) {
    if (ref.runtimeKind === 'docker') {
      const response = await admin(config);
      const map = findPreviewMap(response.body);
      return {
        target: caddyTarget(map, ref.hostname),
        token: response.token,
        uid: null,
      };
    }

    try {
      const ingress = await clients().networking.readNamespacedIngress({ name: ref.runtimeName, namespace: ref.namespace });
      const rule = ingress.spec?.rules?.find(rule => rule.host === ref.hostname);
      const path = rule?.http?.paths?.find(path => path.path === '/');
      if (!path) throw new Error('Stable preview Ingress has no recognized catch-all route');
      return {
        target: path.backend.service.name,
        token: ingress.metadata.resourceVersion,
        uid: ingress.metadata.uid,
      };
    } catch (err) {
      if (err.code === 404 || err.statusCode === 404 || err.response?.statusCode === 404) {
        return { target: null, token: null, uid: null };
      }
      throw err;
    }
  }

  async function activate(config, ref, expected, candidate) {
    if (ref.runtimeKind === 'docker') {
      const response = await admin(config);
      if (response.token !== expected.token) throw new Error('Preview binding changed before activation');
      const map = findPreviewMap(response.body);
      const index = map.destinations.indexOf('{upstream}');
      const target = caddyTarget(map, ref.hostname);
      if (target !== expected.target) throw new Error('Preview binding target changed before activation');

      if (map.destinations.some(destination => !['{upstream}', '{applink}'].includes(destination))) {
        throw new Error('Caddy preview map has unrecognized destinations');
      }
      const outputs = map.destinations.map(() => '');
      outputs[index] = candidate.runtimeName;
      map.mappings = [
        { input: ref.hostname, outputs },
        ...(map.mappings || []).filter(mapping => mapping.input !== ref.hostname),
      ];
      // ETag precondition fences even a command accepted by Docker before our
      // process lost its lock. Do not retry against a freshly read version.
      await admin(config, response.body, expected.token);
      return;
    }

    const { networking } = clients();
    let ingress;
    if (expected.uid) {
      ingress = await networking.readNamespacedIngress({ name: ref.runtimeName, namespace: ref.namespace });
      if (ingress.metadata.uid !== expected.uid || ingress.metadata.resourceVersion !== expected.token) {
        throw new Error('Preview Ingress changed before activation');
      }
      const path = ingress.spec.rules.find(rule => rule.host === ref.hostname)?.http.paths.find(path => path.path === '/');
      if (path?.backend?.service?.name !== expected.target) throw new Error('Preview Ingress target changed before activation');
      path.backend.service.name = candidate.runtimeName;
      await networking.replaceNamespacedIngress({ name: ref.runtimeName, namespace: ref.namespace, body: ingress });
      return;
    }

    // Create is conditional on absence; a competing create returns 409. Never
    // call the generic upsert, which would read and overwrite a successor.
    if (expected.target !== null || expected.token !== null) {
      throw new Error('Absent Ingress activation requires an absent expected binding');
    }
    const assetBackend = ref.appSlug !== config.selfAppSlug
      ? await kubernetes.ensurePlatformAssetBackend(config)
      : null;
    ingress = kubernetes.appIngressManifest({
      name: ref.runtimeName,
      namespace: ref.namespace,
      hostname: ref.hostname,
      resourceLabels: {
        'app.kubernetes.io/managed-by': 'social-vibecoding-runtime',
        'social.usernode.io/app-id': String(ref.appId),
        'social.usernode.io/session-id': String(ref.sessionId),
        'social.usernode.io/environment': 'staging',
      },
      cfg: config.kubernetes,
      assetBackend,
    });
    ingress.spec.rules[0].http.paths.find(path => path.path === '/').backend.service.name = candidate.runtimeName;
    await networking.createNamespacedIngress({ namespace: ref.namespace, body: ingress });
  }

  return { inspect, activate };
}

module.exports = { bindingRef, findPreviewMap, caddyTarget, createBindingAdapters, ...createBindingAdapters() };
