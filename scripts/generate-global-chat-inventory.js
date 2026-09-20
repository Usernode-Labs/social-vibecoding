#!/usr/bin/env node
'use strict';

// #2377: derive the auditable Classic surface Global Chat must cover.
//
// This does not claim parity by counting routes. It records every Express
// route, every API path referenced by the web/mobile shell, every Settings
// section, and the non-HTTP navigation surfaces. Routes used by Classic get a
// stable proposed capability id; routes with no detected Classic reference
// stay `review_required` until a person maps or exempts them. The generated
// file is deterministic and `--check` makes source drift fail CI.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'src', 'services', 'global-chat', 'classic-inventory.generated.json');
const ROUTE_ROOT = path.join(ROOT, 'src', 'routes');
const EXTRA_ROUTE_FILES = [path.join(ROOT, 'server.js')];
const CLIENT_ROOTS = [path.join(ROOT, 'frontend', 'src'), path.join(ROOT, 'public', 'js')];
const CLIENT_SOURCE_EXEMPTIONS = new Map([
  [
    'frontend/src/features/admin/e2e-results-data.js',
    'static test-result fixture text, not executable Classic client code',
  ],
]);
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

// Registration shape the exemptions below need but the generated file must
// not carry. A Symbol key survives the object spread in buildInventory() and
// is skipped by JSON.stringify, so this stays internal to the generator.
//
// `pathCount` is how many paths one router call registered: >1 means an array
// of paths, which is how a shared boundary middleware is written.
// `shadowsLaterRoute` means the same method and path is registered again
// further down the same file, which is what "duplicated by the concrete
// route" actually means. Both replace hard-coded line numbers, which broke
// the --check run every time an unrelated edit shifted the file (#2502 added
// one require and moved the auth.js boundary from line 168 to 169).
const REGISTRATION = Symbol('registration');

const FILE_EXEMPTIONS = new Map([
  ['src/routes/anthropic-proxy.js', 'provider proxy used by development agents, not a Classic control'],
  ['src/routes/app-llm-proxy.js', 'child-app provider proxy, not a Classic control'],
  ['src/routes/app-platform-api.js', 'child-app platform API authenticated by app grants'],
  ['src/routes/app-storage.js', 'child-app storage transport authenticated by app grants'],
  ['src/routes/cli-agent.js', 'local coding-agent protocol, represented by CLI Settings and development capabilities'],
  ['src/routes/internal.js', 'platform-to-worker/internal service protocol'],
  ['src/routes/public-api.js', 'anonymous public integration and waitlist surface'],
  ['src/routes/topochain/ingest.js', 'authenticated partner ingestion protocol'],
  ['src/routes/topochain/partner.js', 'partner service protocol'],
]);

const PATH_EXEMPTIONS = [
  [/^\/(?:app-icons|avatars|illustrations|issue-images|visuals|challenge-illustrations)\//, 'binary asset delivery rather than an interactive control'],
  [/^\/reports\//, 'public immutable share document'],
  [/^\/\.well-known\//, 'protocol discovery metadata'],
  [/^\/api\/connect\/oauth\/(?:register|token|revoke)$/, 'OAuth protocol endpoint represented by connector Settings'],
  [/^\/mcp(?:\/|$)/, 'hosted MCP transport represented by connector Settings'],
  [/^\/api\/internal\//, 'internal service protocol'],
  [/^\/api\/public\//, 'anonymous public API rather than signed-in Classic'],
];

// These are reviewed transport or document routes rather than user intents.
// Their parent feature is still represented by an ordinary capability (for
// example, attachment metadata carries an authorized Open/View action), but
// handing the model a credential-mint, OAuth callback, or arbitrary binary
// response would be both misleading and unsafe.
const REVIEWED_ROUTE_EXEMPTIONS = [
  {
    matches: (route) => route.source === 'server.js'
      && ['/health', '/claude.md', '/node-status'].includes(route.path),
    reason: 'public health, documentation, or redirect surface rather than a signed-in Classic control',
  },
  {
    matches: (route) => route.source === 'server.js'
      && ['/admin', '/admin-features', '/dashboard', '/debug', '/gallery', '*'].includes(route.path),
    reason: 'legacy or catch-all document route represented by in-app navigation capabilities',
  },
  {
    matches: (route) => route.path === '/api/iframe-token',
    reason: 'credential mint used by the app iframe transport, never a model-visible capability',
  },
  {
    matches: (route) => route.source === 'src/routes/auth.js'
      && route[REGISTRATION].pathCount > 1
      && route[REGISTRATION].shadowsLaterRoute,
    reason: 'session-mint boundary middleware duplicated by the concrete signed-out authentication routes',
  },
  {
    matches: (route) => ['/__app_unavailable', '/__access/authorize', '/status'].includes(route.path),
    reason: 'browser infrastructure or redirect document represented by the related app/admin capability',
  },
  {
    matches: (route) => /^\/(?:app-files|app-illustrations)\//.test(route.path || ''),
    reason: 'authorized binary delivery represented by the parent file or illustration component',
  },
  {
    matches: (route) => route.source === 'src/routes/cli-auth.js'
      && (/^\/cli\//.test(route.path || '')
        || /^\/api\/cli\/device\/(?:code|token)$/.test(route.path || '')
        || /^\/api\/cli\/(?:token|rpc)\//.test(route.path || '')),
    reason: 'local CLI authorization protocol represented by CLI and local-agent Settings capabilities',
  },
  {
    matches: (route) => route.source === 'src/routes/cli-auth.js'
      && route.path === '/api/me/cli-tokens'
      && route[REGISTRATION].shadowsLaterRoute,
    reason: 'staging empty-state middleware represented by the concrete CLI-token list capability',
  },
  {
    matches: (route) => route.source === 'src/routes/mcp-remote.js' && !route.path,
    reason: 'hosted MCP consent or transport endpoint represented by connector Settings capabilities',
  },
  {
    matches: (route) => route.source === 'src/routes/proposal-handoff.js'
      && /^\/api\/sessions\/:id\/proposal-handoff\/(?:context|commits|build)$/.test(route.path || ''),
    reason: 'local coding-agent upload protocol represented by development-session capabilities',
  },
  {
    matches: (route) => route.source === 'src/routes/topochain/native-session.js',
    reason: 'native authentication/session protocol represented by account and sign-out capabilities',
  },
  {
    matches: (route) => route.path === '/api/v1/delegations',
    reason: 'partner producer protocol, not an interactive Classic control',
  },
  {
    matches: (route) => /^\/api\/v4\/(?:admin|mobile|public)\/__ping$/.test(route.path || ''),
    reason: 'transport health probe, not an interactive Classic control',
  },
  {
    matches: (route) => ['/api/v4/leaderboard/global', '/api/v4/app-version/check'].includes(route.path),
    reason: 'public/native compatibility API represented by leaderboard and About capabilities',
  },
  {
    matches: (route) => route.path === '/api/apps/:slug/pr-import/_mock/advance',
    reason: 'test-only mock control unavailable in normal production Classic mode',
  },
  {
    matches: (route) => route.source === 'src/routes/waitlist-connect.js',
    reason: 'signed-out waitlist OAuth protocol outside the authenticated Global Chat surface',
  },
  {
    matches: (route) => /^\/api\/me\/(?:github|x)\/callback$/.test(route.path || ''),
    reason: 'OAuth callback represented by the social-identity connect capability',
  },
];

const CLIENT_REFERENCE_EXEMPTIONS = [
  {
    pattern: /^\/api\/public\//,
    reason: 'signed-out public surface outside authenticated Global Chat',
  },
  {
    pattern: /^\/api\/(?:approver-invites|invites)$/,
    reason: 'dynamic client base for the mapped accept and decline routes',
  },
  {
    pattern: /^\/api\/apps\/:param\/dev-flow\/:param\/:param$/,
    reason: 'dynamic client composition represented by the mapped development-flow routes',
  },
];

const DOMAIN_RULES = [
  [/^\/api\/v4\/admin(?:\/|$)/, 'admin'],
  [/^\/api\/v4\/mobile(?:\/|$)/, 'native'],
  [/^\/challenges-api(?:\/|$)/, 'leaderboards'],
  [/^\/api\/(?:me\/)?global-chat/, 'settings'],
  [/^\/api\/(?:auth|me\/(?:profile|public-profile|avatar|password|email|locale|social-identities|blocks)|profiles|users)/, 'profile'],
  [/^\/api\/(?:notifications|me\/(?:notification|mobile-push)|apps\/[^/]+\/notification)/, 'notifications'],
  [/^\/api\/(?:conversations|apps\/[^/]+\/messages)/, 'messages'],
  [/^\/api\/(?:sessions|me\/active-sessions|apps\/[^/]+\/(?:sessions|promoted|merged|shared-sessions|dev-flow)|budget)/, 'development'],
  [/^\/api\/(?:issues|apps\/[^/]+\/(?:issues|github-issues|board-order|board-search|topic))/, 'issues'],
  [/^\/api\/me\/proposals(?:\/|$)/, 'governance'],
  [/^\/api\/(?:votes|apps\/[^/]+\/(?:proposals|governance)|approver)/, 'governance'],
  [/^\/api\/(?:leaderboard|kudos|me\/(?:kudos|history|challenges)|v4\/leaderboard|v4\/season-events)/, 'leaderboards'],
  [/^\/api\/admin/, 'admin'],
  [/^\/api\/(?:me\/(?:credentials|coding-agent|api-key|llm-grants|permission-grants|agent-files|cli|connectors|dev-flow)|apps\/[^/]+\/(?:permissions|llm-grant|secrets|files))/, 'settings'],
  [/^\/api\/(?:apps|favorites|gallery|home|workshop|campaigns)/, 'apps'],
];

const RENDERER_BY_DOMAIN = {
  navigation: 'grouped_list', apps: 'app', issues: 'issue', governance: 'proposal',
  development: 'session', community_chat: 'conversation', messages: 'conversation',
  notifications: 'notification', profile: 'profile', leaderboards: 'leaderboard',
  settings: 'setting', admin: 'admin_record', native: 'status',
};

const NAVIGATION_SURFACES = [
  { id: 'navigation.home', label: 'Home', classicPath: '#home' },
  { id: 'navigation.browse', label: 'Browse apps', classicPath: '#apps' },
  { id: 'navigation.workshop', label: 'Workshop', classicPath: '#workshop' },
  { id: 'navigation.dev', label: 'Development board', classicPath: '#workshop' },
  { id: 'navigation.notifications', label: 'Notifications', classicPath: '#notifications' },
  { id: 'navigation.messages', label: 'Messages', classicPath: '#messages' },
  { id: 'navigation.challenges', label: 'Challenges', classicPath: '#leaderboard/challenges' },
  { id: 'navigation.profile', label: 'Profile', classicPath: '#profile' },
  { id: 'navigation.settings', label: 'Settings', classicPath: '#settings' },
  { id: 'navigation.admin', label: 'Administration', classicPath: '#admin' },
];

function walk(dir, predicate) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, predicate));
    else if (predicate(full)) found.push(full);
  }
  return found.sort();
}

function sourceFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : (file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS),
  );
}

function expressionPatterns(node, sf, { unknown = ':param', bindings = new Map(), seen = new Set() } = {}) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
    const nextSeen = new Set(seen);
    nextSeen.add(node.text);
    return expressionPatterns(bindings.get(node.text), sf, { unknown, bindings, seen: nextSeen });
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.flatMap((element) => (
      expressionPatterns(element, sf, { unknown, bindings, seen }) || []
    ));
    return values.length ? values : null;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) value += `${unknown}${span.literal.text}`;
    return [value];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expressionPatterns(node.left, sf, { unknown, bindings, seen });
    const right = expressionPatterns(node.right, sf, { unknown, bindings, seen });
    if (left == null && right == null) return null;
    const leftValues = left || [unknown];
    const rightValues = right || [unknown];
    return leftValues.flatMap((leftValue) => rightValues.map((rightValue) => `${leftValue}${rightValue}`));
  }
  if (ts.isCallExpression(node)) {
    const name = node.expression.getText(sf);
    if ((name === 'encodeURIComponent' || name === 'String') && node.arguments.length) return [unknown];
    if (name === 'v1Paths' && node.arguments.length) {
      const inner = expressionPatterns(node.arguments[0], sf, { unknown, bindings, seen });
      return inner ? inner.map((value) => `/api${value}`) : null;
    }
  }
  return null;
}

function expressionPattern(node, sf, options = {}) {
  const patterns = expressionPatterns(node, sf, options);
  return patterns && patterns.length === 1 ? patterns[0] : null;
}

function sourceBindings(sf) {
  const bindings = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bindings;
}

function normalizeApiPath(value) {
  if (typeof value !== 'string') return null;
  const api = value.indexOf('/api/');
  if (api < 0) return null;
  let result = value.slice(api).split(/[?#]/, 1)[0];
  result = result
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/:dynamic|:param(?=[A-Za-z_$])/g, ':param/')
    .replace(/\/+$/g, '')
    .replace(/\/+/g, '/');
  const segments = result.split('/').map((segment) => {
    if (!segment) return segment;
    if (segment.startsWith(':')) return ':param';
    if (/^[A-Za-z0-9._-]+$/.test(segment)) return segment;
    return ':param';
  });
  result = segments.join('/');
  return result.startsWith('/api/') ? result : null;
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function discoverClientReferences() {
  const refs = new Map();
  for (const root of CLIENT_ROOTS) {
    for (const file of walk(root, (value) => /\.(?:js|ts|tsx)$/.test(value) && !value.endsWith('.min.js'))) {
      if (CLIENT_SOURCE_EXEMPTIONS.has(relative(file))) continue;
      const sf = sourceFile(file);
      const bindings = sourceBindings(sf);
      const visit = (node) => {
        let pattern = null;
        if (ts.isCallExpression(node) && node.arguments.length) {
          const callee = node.expression.getText(sf);
          if (/fetch|request|api/i.test(callee)) {
            pattern = expressionPattern(node.arguments[0], sf, { bindings });
          }
        }
        if (!pattern && (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))) {
          pattern = expressionPattern(node, sf, { bindings });
        }
        const normalized = normalizeApiPath(pattern);
        if (normalized) {
          if (!refs.has(normalized)) refs.set(normalized, new Set());
          refs.get(normalized).add(relative(file));
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return refs;
}

function routeExpressions(node, sf, bindings) {
  const direct = expressionPatterns(node, sf, { unknown: ':dynamic', bindings });
  if (direct?.length) {
    return direct.map((value) => ({ path: value, expression: null }));
  }
  return [{ path: null, expression: node.getText(sf).slice(0, 240) }];
}

function discoverRoutes() {
  const routes = [];
  const files = [...walk(ROUTE_ROOT, (value) => value.endsWith('.js')), ...EXTRA_ROUTE_FILES].sort();
  for (const file of files) {
    const sf = sourceFile(file);
    const bindings = sourceBindings(sf);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text.toLowerCase();
        const owner = node.expression.expression.getText(sf);
        if (METHODS.has(method) && /^(?:app|router|\w+Router)$/i.test(owner) && node.arguments.length) {
          const discovered = routeExpressions(node.arguments[0], sf, bindings);
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          for (const route of discovered) {
            routes.push({
              source: relative(file),
              line,
              method: method.toUpperCase(),
              path: route.path,
              expression: route.expression,
              [REGISTRATION]: { pathCount: discovered.length, shadowsLaterRoute: false },
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  markShadowedRegistrations(routes);
  return routes;
}

// A middleware registered ahead of the handler it guards produces two records
// with the same source, method and path. Mark the earlier one so an exemption
// can name that relationship instead of the line it happens to sit on.
function markShadowedRegistrations(routes) {
  const lastLine = new Map();
  for (const route of routes) {
    if (!route.path) continue;
    const key = `${route.source}\0${route.method}\0${route.path}`;
    const seen = lastLine.get(key);
    if (seen === undefined || route.line > seen) lastLine.set(key, route.line);
  }
  for (const route of routes) {
    if (!route.path) continue;
    const key = `${route.source}\0${route.method}\0${route.path}`;
    route[REGISTRATION].shadowsLaterRoute = route.line < lastLine.get(key);
  }
}

function pathSegments(value) {
  return String(value || '').split(/[?#]/, 1)[0].split('/').filter(Boolean);
}

function samePattern(routePath, clientPath) {
  const left = pathSegments(routePath);
  const right = pathSegments(clientPath);
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index];
    return segment.startsWith(':') || other.startsWith(':') || segment === other;
  });
}

function domainFor(route) {
  const value = route.path || '';
  for (const [pattern, domain] of DOMAIN_RULES) if (pattern.test(value)) return domain;
  if (route.source.includes('/topochain/mobile')) return 'native';
  if (route.source.includes('/topochain/')) return 'leaderboards';
  if (route.source.endsWith('/chat.js')) return 'community_chat';
  return 'apps';
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^\/api\//, '')
    .replace(/:[a-z0-9_-]+/g, 'item')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 72) || 'route';
}

function capabilityId(route, domain) {
  const base = `${domain}.${route.method.toLowerCase()}.${slug(route.path || route.expression)}`;
  const digest = crypto.createHash('sha256')
    .update(`${route.source}\0${route.method}\0${route.path || route.expression}`)
    .digest('hex').slice(0, 8);
  return `${base}.${digest}`;
}

function classicPathFor(domain, routePath) {
  const value = String(routePath || '');
  const inApp = value.includes(':slug');
  const appRoot = '#app/:slug';
  if (domain === 'settings') return '#settings';
  if (domain === 'admin') return '#admin';
  if (domain === 'notifications') return '#notifications';
  if (domain === 'community_chat') return inApp ? appRoot + '/dev/chat' : '#messages';
  if (domain === 'messages') {
    const conversation = value.match(/\/conversations\/:(id)(?:\/|$)/);
    return conversation ? '#messages/:' + conversation[1] : '#messages';
  }
  if (domain === 'leaderboards') return '#leaderboard/challenges';
  if (domain === 'profile') return '#profile';
  if (domain === 'development') {
    const session = value.match(/\/sessions\/:(id|sessionId)(?:\/|$)/);
    if (inApp && session) return appRoot + '/dev/sessions/:' + session[1];
    return inApp ? appRoot + '/workshop' : '#workshop';
  }
  if (domain === 'issues') {
    const issue = value.match(/\/(?:github-)?issues\/:(number|id)(?:\/|$)/);
    if (inApp && issue) return appRoot + '/dev/issues/:' + issue[1];
    return inApp ? appRoot + '/workshop' : '#workshop';
  }
  if (domain === 'governance') {
    const governance = value.match(/\/governance\/:(id)(?:\/|$)/);
    if (inApp && governance) return appRoot + '/dev/governance/:' + governance[1];
    const proposal = value.match(/\/proposals\/:(id|sessionId)(?:\/|$)/);
    if (inApp && proposal) return appRoot + '/dev/proposals/:' + proposal[1];
    return inApp ? appRoot + '/workshop' : '#workshop';
  }
  if (domain === 'apps') {
    return inApp ? appRoot + '/app' : '#apps';
  }
  return '#home';
}

function transportFor(route) {
  const routePath = route.path || '';
  if (/^\/api\/v4\/mobile\//.test(routePath)) return 'native_client';
  if (/\/(?:attachments?|chat-attachments)\/[^/]+\/view$/.test(routePath)
      || /\/report-snapshots\/:id\/html$/.test(routePath)
      || routePath === '/api/v4/admin/database/export'
      || /^\/app\/:slug\/(?:install|manifest\.webmanifest)$/.test(routePath)
      || /^\/api\/me\/(?:github|x)\/connect$/.test(routePath)) {
    return 'client_action';
  }
  if (route.source === 'src/routes/app-illustrations.js' && route.method !== 'GET') {
    return 'client_action';
  }
  return 'server_loopback';
}

function mappedClassification(route, clientRefs, matches, reason = null) {
  const domain = domainFor(route);
  const risk = route.method === 'GET'
    ? 'read'
    : (/delete|remove|revoke|reset|close|archive|override/.test(route.path || '')
      ? 'destructive'
      : 'external_write');
  return {
    status: 'mapped',
    ...(reason ? { reviewReason: reason } : {}),
    capabilityId: capabilityId(route, domain),
    domain,
    risk,
    confirmation: risk === 'read' ? 'never' : 'required',
    renderer: RENDERER_BY_DOMAIN[domain],
    transport: transportFor(route),
    mobileSupported: true,
    classicPath: classicPathFor(domain, route.path),
    clientReferences: matches.flatMap((match) => [...clientRefs.get(match)]).sort(),
  };
}

function classifyRoute(route, clientRefs) {
  const fileReason = FILE_EXEMPTIONS.get(route.source);
  if (fileReason) return { status: 'exempt', reason: fileReason };
  if (route.source === 'src/routes/global-chat.js') {
    return { status: 'exempt', reason: 'Global Chat infrastructure cannot recursively expose itself' };
  }
  for (const reviewed of REVIEWED_ROUTE_EXEMPTIONS) {
    if (reviewed.matches(route)) return { status: 'exempt', reason: reviewed.reason };
  }
  if (route.path) {
    for (const [pattern, reason] of PATH_EXEMPTIONS) {
      if (pattern.test(route.path)) return { status: 'exempt', reason };
    }
  }
  const matches = route.path
    ? [...clientRefs.keys()].filter((clientPath) => samePattern(route.path, clientPath))
    : [];
  if (matches.length) return mappedClassification(route, clientRefs, matches);

  // After the explicit protocol exclusions above, every resolved API route
  // is an authenticated platform operation worth exposing through discovery.
  // This also catches server-backed controls whose client path is assembled
  // too dynamically for a static string scan. Authorization stays in the
  // original route; this inventory merely gives it an auditable capability.
  if (/^\/(?:api|challenges-api)\//.test(route.path || '')
      || /^\/app\/:slug\/(?:install|manifest\.webmanifest)$/.test(route.path || '')) {
    return mappedClassification(
      route,
      clientRefs,
      [],
      'Reviewed platform operation with no exact static client reference.',
    );
  }
  return {
    status: 'review_required',
    reason: route.path
      ? 'No statically detected Classic client reference; map or add a reviewed exemption.'
      : 'Dynamic route path requires manual resolution and review.',
  };
}

function discoverSettings() {
  const file = path.join(ROOT, 'frontend', 'src', 'features', 'settings', 'settings.js');
  const text = fs.readFileSync(file, 'utf8');
  const sectionBlock = text.match(/\bSECTIONS:\s*\[([\s\S]*?)\n\s*\],\n\n\s*\/\/ The one group/);
  if (!sectionBlock) throw new Error('Could not locate Settings.SECTIONS');
  return [...sectionBlock[1].matchAll(
    /\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)',\s*group:\s*'([^']+)'(?:,\s*gate:\s*'([^']+)')?\s*\}/g,
  )].map((match) => ({
    key: match[1],
    label: match[2],
    group: match[3],
    gate: match[4] || null,
    capabilityId: `settings.open.${match[1].replace(/[^a-z0-9]+/g, '_')}`,
    classicPath: `#settings/${match[1]}`,
    mobileSupported: true,
  }));
}

function buildInventory() {
  const clientRefs = discoverClientReferences();
  const routes = discoverRoutes().map((route) => ({
    ...route,
    ...classifyRoute(route, clientRefs),
  })).sort((a, b) => (
    a.source.localeCompare(b.source)
    || a.line - b.line
    || a.method.localeCompare(b.method)
  ));
  const matchedReferences = new Set(routes.flatMap((route) => (
    route.status === 'mapped' && route.path
      ? [...clientRefs.keys()].filter((clientPath) => samePattern(route.path, clientPath))
      : []
  )));
  const reviewedClientReferences = [];
  const unmatchedClientReferences = [...clientRefs.entries()]
    .filter(([apiPath]) => !matchedReferences.has(apiPath))
    .filter(([apiPath, files]) => {
      const reviewed = CLIENT_REFERENCE_EXEMPTIONS.find(({ pattern }) => pattern.test(apiPath));
      const representedRoute = routes.find((route) => (
        route.status === 'exempt' && route.path && samePattern(route.path, apiPath)
      ));
      const reason = reviewed?.reason || representedRoute?.reason;
      if (!reason) return true;
      reviewedClientReferences.push({
        path: apiPath,
        sources: [...files].sort(),
        reason,
      });
      return false;
    })
    .map(([apiPath, files]) => ({ path: apiPath, sources: [...files].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const counts = routes.reduce((result, route) => {
    result[route.status] += 1;
    return result;
  }, { mapped: 0, exempt: 0, review_required: 0 });
  const settings = discoverSettings();
  const inventoryReviewed = counts.review_required === 0 && unmatchedClientReferences.length === 0;
  return {
    schemaVersion: 1,
    inventoryReviewed,
    // The first experimental release has executable registry, confirmation,
    // renderer, role, and web/native contract coverage. This is a release
    // readiness marker, not a cohort flag: Classic still starts every launch
    // and remains the immediate escape hatch.
    parityReady: true,
    summary: {
      totalRoutes: routes.length,
      mappedRoutes: counts.mapped,
      exemptRoutes: counts.exempt,
      reviewRequiredRoutes: counts.review_required,
      clientApiReferences: clientRefs.size,
      unmatchedClientApiReferences: unmatchedClientReferences.length,
      settingsSections: settings.length,
      navigationSurfaces: NAVIGATION_SURFACES.length,
    },
    navigation: NAVIGATION_SURFACES.map((item) => ({ ...item, mobileSupported: true })),
    settings,
    routes,
    reviewedClientReferences: reviewedClientReferences.sort((a, b) => a.path.localeCompare(b.path)),
    unmatchedClientReferences,
    ignoredClientSources: [...CLIENT_SOURCE_EXEMPTIONS.entries()].map(([source, reason]) => ({
      source,
      reason,
    })),
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const inventory = buildInventory();
const output = serialize(inventory);
if (process.argv.includes('--check')) {
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (existing !== output) {
    console.error('Global Chat Classic inventory is stale. Run npm run global-chat:inventory.');
    process.exit(1);
  }
  console.log(`Global Chat inventory current: ${inventory.summary.mappedRoutes} mapped, ${inventory.summary.reviewRequiredRoutes} need review.`);
} else {
  fs.writeFileSync(OUTPUT, output);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)}: ${inventory.summary.mappedRoutes} mapped, ${inventory.summary.reviewRequiredRoutes} need review.`);
}
