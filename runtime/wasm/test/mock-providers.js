'use strict';
// Stand-ins for World Weather's outside services: Open-Meteo geocoding,
// forecast and air quality, and NWS alerts. Each answer is made up but
// well formed and always the same for the same question, and comes after
// 30 ms (the bench's ww/mock.js replayed recorded answers the same way).
// HTTPS on 443 under the real host names: the test points those names here
// (--add-host) and both twins trust the test's own certificate authority,
// so the app's code is not edited. Plain HTTP on 8080 answers the test:
//   GET /__stats   { requests, most: the most requests in flight at once }
//   POST /__reset  starts counting again
//
//   node mock-providers.js <cert.pem> <key.pem>

const fs = require('fs');
const http = require('http');
const https = require('https');

const DELAY_MS = Number(process.env.DELAY_MS || 30);
let requests = 0;
let inFlight = 0;
let most = 0;

const PLACES = {
  paris: [
    { id: 2988507, name: 'Paris', latitude: 48.85341, longitude: 2.3488, elevation: 42, feature_code: 'PPLC', country_code: 'FR', country: 'France', admin1: 'Île-de-France', admin2: 'Paris', timezone: 'Europe/Paris', population: 2138551 },
    { id: 4717560, name: 'Paris', latitude: 33.66094, longitude: -95.55551, elevation: 177, feature_code: 'PPLA2', country_code: 'US', country: 'United States', admin1: 'Texas', admin2: 'Lamar', timezone: 'America/Chicago', population: 24782 },
  ],
  sinjai: [
    { id: 1626916, name: 'Sinjai', latitude: -5.1241, longitude: 120.253, elevation: 30, feature_code: 'PPLA2', country_code: 'ID', country: 'Indonesia', admin1: 'Sulawesi Selatan', admin2: 'Kabupaten Sinjai', timezone: 'Asia/Makassar', population: 47000 },
    { id: 8073452, name: 'Sinjai Utara', latitude: -5.1167, longitude: 120.2333, elevation: 12, feature_code: 'ADM3', country_code: 'ID', country: 'Indonesia', admin1: 'Sulawesi Selatan', admin2: 'Kabupaten Sinjai', admin3: 'Sinjai Utara', timezone: 'Asia/Makassar', population: 46000 },
  ],
};

/** A number from the question, the same each time: 0 <= x < 1. */
function det(...parts) {
  let h = 2166136261;
  for (const c of parts.join('|')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h / 4294967296;
}
const one = (x) => Math.round(x * 10) / 10;

function forecast(q) {
  const lat = Number(q.get('latitude'));
  const lon = Number(q.get('longitude'));
  const glat = Math.round(lat * 10) / 10 + 0.04;
  const glon = Math.round(lon * 10) / 10 - 0.03;
  const value = (name, i) => {
    const r = det(lat, lon, name, i);
    if (name === 'is_day') return i % 24 >= 7 && i % 24 < 19 ? 1 : 0;
    if (name.startsWith('weather_code')) return [0, 1, 2, 3, 45, 61, 80][Math.floor(r * 7)];
    if (name.includes('probability') || name.includes('humidity')) return Math.floor(r * 100);
    if (name.includes('direction')) return Math.floor(r * 360);
    if (name === 'visibility') return Math.floor(r * 24000);
    if (name.startsWith('sunrise')) return `2026-11-${String(27 + (i % 3)).padStart(2, '0')}T07:${String(10 + i).padStart(2, '0')}`;
    if (name.startsWith('sunset')) return `2026-11-${String(27 + (i % 3)).padStart(2, '0')}T17:${String(10 + i).padStart(2, '0')}`;
    if (name.includes('temperature')) return one(25 - Math.abs(lat) / 4 + r * 6);
    return one(r * 20);
  };
  const block = (vars, times) => {
    const o = { time: times };
    for (const v of vars) o[v] = times.map((_, i) => value(v, i));
    return o;
  };
  const current = { time: '2026-11-27T12:00', interval: 900 };
  for (const v of String(q.get('current') || '').split(',').filter(Boolean)) current[v] = value(v, 12);
  const hours = Array.from({ length: Number(q.get('forecast_hours') || 24) }, (_, i) => `2026-11-27T${String(i).padStart(2, '0')}:00`);
  const days = Array.from({ length: Number(q.get('forecast_days') || 7) }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
  return {
    latitude: glat, longitude: glon, generationtime_ms: 0.1, utc_offset_seconds: 3600, timezone: 'Europe/Paris',
    timezone_abbreviation: 'GMT+1', elevation: Math.floor(det(lat, lon) * 300), current,
    hourly: block(String(q.get('hourly') || '').split(',').filter(Boolean), hours),
    daily: block(String(q.get('daily') || '').split(',').filter(Boolean), days),
  };
}

function answer(host, url, headers) {
  const q = url.searchParams;
  if (host.startsWith('geocoding-api.')) {
    if (url.pathname === '/v1/search') {
      const results = PLACES[String(q.get('name') || '').trim().toLowerCase()];
      return [200, results ? { results, generationtime_ms: 0.4 } : { generationtime_ms: 0.4 }];
    }
    if (url.pathname === '/v1/get') {
      const id = Number(q.get('id'));
      const found = Object.values(PLACES).flat().find((p) => p.id === id);
      return [200, found || {}];
    }
  }
  if (host.startsWith('api.open-meteo.') && url.pathname === '/v1/forecast') return [200, forecast(q)];
  if (host.startsWith('air-quality-api.') && url.pathname === '/v1/air-quality') {
    const lat = Number(q.get('latitude'));
    const lon = Number(q.get('longitude'));
    return [200, { latitude: Math.round(lat * 10) / 10, longitude: Math.round(lon * 10) / 10 + 0.05, current: { time: '2026-11-27T12:00', interval: 3600, us_aqi: Math.floor(det('aqi', lat, lon) * 150), pm2_5: one(det('pm25', lat) * 40), pm10: one(det('pm10', lon) * 60) } }];
  }
  if (host === 'api.weather.gov' && url.pathname === '/alerts/active') {
    // NWS refuses clients that do not say who they are.
    if (!/World Weather/.test(headers['user-agent'] || '')) return [403, { title: 'Forbidden' }];
    return [200, { features: [{ properties: { event: 'Wind Advisory', headline: 'Wind Advisory for ' + q.get('point'), severity: 'Moderate', senderName: 'NWS Test Office', onset: '2026-11-27T10:00:00-05:00', ends: '2026-11-27T22:00:00-05:00', areaDesc: 'Test County', instruction: 'Secure outdoor objects.' } }] }];
  }
  return [404, { error: 'unknown' }];
}

const [certFile, keyFile] = process.argv.slice(2);
https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
  requests++;
  inFlight++;
  most = Math.max(most, inFlight);
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  const [status, body] = answer(host, new URL(req.url, 'https://' + host), req.headers);
  setTimeout(() => {
    inFlight--;
    const b = JSON.stringify(body);
    res.writeHead(status, { 'content-type': host === 'api.weather.gov' ? 'application/geo+json' : 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) });
    res.end(b);
  }, DELAY_MS);
}).listen(443);

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__reset') { requests = 0; most = inFlight; res.end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ requests, most }));
}).listen(8080, () => console.log('providers on 443, stats on 8080'));
