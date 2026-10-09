const http = require('node:http');
const https = require('node:https');

// Unlike client-node 1.4's Watch.watch(), this handle exists before auth or
// response headers finish. A rollout can therefore cancel connection setup.
function watchDeployment(kc, { namespace, name, resourceVersion, timeoutMs }, onEvent, onDone) {
  const controller = new AbortController();
  let request;
  let response;
  let agent;
  let stopped = false;
  let buffer = '';
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    response?.destroy();
    request?.destroy();
    agent?.destroy();
    buffer = '';
  };
  const fail = error => {
    if (stopped) return;
    stop();
    onDone(error);
  };
  const timer = setTimeout(() => fail(new Error('Deployment watch expired')), timeoutMs);
  (async () => {
    const cluster = kc.getCurrentCluster();
    if (!cluster) throw new Error('No currently active cluster');
    const url = new URL(`${cluster.server}/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`);
    url.searchParams.set('watch', 'true');
    url.searchParams.set('fieldSelector', `metadata.name=${name}`);
    url.searchParams.set('resourceVersion', resourceVersion);
    url.searchParams.set('timeoutSeconds', String(Math.max(1, Math.ceil(timeoutMs / 1000))));
    const options = {};
    await kc.applyToHTTPSOptions(options);
    agent = options.agent;
    if (stopped) { agent?.destroy(); return; }
    const transport = url.protocol === 'https:' ? https : http;
    request = transport.request(url, { ...options, method: 'GET', signal: controller.signal }, incoming => {
      response = incoming;
      if (stopped) { response.destroy(); return; }
      if (response.statusCode !== 200) {
        const error = new Error(`Deployment watch HTTP ${response.statusCode}`);
        error.statusCode = response.statusCode;
        fail(error);
        return;
      }
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (stopped) return;
        buffer += chunk;
        // Deployment objects are small; a corrupt/unbounded stream must not
        // consume the process while the ordinary poller is still available.
        if (buffer.length > 1024 * 1024) { fail(new Error('Deployment watch event too large')); return; }
        let newline;
        while (!stopped && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'ERROR') { fail(new Error('Deployment watch error')); return; }
            onEvent(event.type, event.object);
          } catch (error) { fail(error); }
        }
      });
      response.on('error', fail);
      response.on('end', () => fail(new Error('Deployment watch closed')));
      response.on('close', () => fail(new Error('Deployment watch disconnected')));
    });
    request.on('error', fail);
    request.end();
  })().catch(fail);
  return { abort: stop };
}

module.exports = { watchDeployment };
