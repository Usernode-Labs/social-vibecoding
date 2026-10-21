'use strict';

// #5123: every OpenRouter request denies data collection.
const crypto = require('node:crypto');
const { withNoTraining } = require('../../worker/openrouter-privacy');

// Short, mono PCM recordings only. Reading the WAV's frame count gives us
// an actual duration bound without trusting a browser-supplied duration.
const SAMPLE_RATE = 16000;
const MAX_SECONDS = 60;
const MAX_BYTES = 44 + SAMPLE_RATE * 2 * MAX_SECONDS;
const DEFAULT_MODEL = 'openai/whisper-large-v3-turbo';

class DictationError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function validateWav(data) {
  if (!Buffer.isBuffer(data) || data.length <= 44 || data.length > MAX_BYTES
      || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE'
      || data.toString('ascii', 12, 16) !== 'fmt ' || data.readUInt32LE(16) !== 16
      || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 1
      || data.readUInt32LE(24) !== SAMPLE_RATE || data.readUInt32LE(28) !== SAMPLE_RATE * 2
      || data.readUInt16LE(32) !== 2 || data.readUInt16LE(34) !== 16
      || data.toString('ascii', 36, 40) !== 'data'
      || data.readUInt32LE(4) !== data.length - 8 || data.readUInt32LE(40) !== data.length - 44
      || (data.length - 44) % 2 !== 0) throw new DictationError('invalid_audio');
  const seconds = (data.length - 44) / (SAMPLE_RATE * 2);
  if (seconds < 0.15) throw new DictationError('no_speech');
  let energy = 0;
  for (let i = 44; i < data.length; i += 2) energy += (data.readInt16LE(i) / 32768) ** 2;
  if (Math.sqrt(energy / ((data.length - 44) / 2)) < 0.001) throw new DictationError('no_speech');
  return { seconds };
}

async function transcribe({ data, apiKey, config, signal, fetchImpl = fetch }) {
  const { seconds } = validateWav(data);
  if (!apiKey) throw new DictationError('key_required', 403);
  const model = config.dictationModel || DEFAULT_MODEL;
  const response = await fetchImpl(`${(config.openrouterApiBase || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
      'HTTP-Referer': config.openrouterOrigin || 'https://app.onhomeroom.com', 'X-OpenRouter-Title': 'Homeroom dictation' },
    // #5123: the recording reaches only a host that neither trains on it nor keeps it.
    body: JSON.stringify(withNoTraining({ model, input_audio: { data: data.toString('base64'), format: 'wav' } })),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 402) throw new DictationError('credits_required', 402);
    if ([401, 403].includes(response.status)) throw new DictationError('key_required', 403);
    if (response.status === 429) throw new DictationError('busy', 429);
    throw new DictationError('transcription_failed', 502);
  }
  // Bound the response too; neither audio nor the transcript goes in logs.
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128 * 1024) throw new DictationError('transcription_failed', 502);
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DictationError('transcription_failed', 502); }
  if (typeof result.text !== 'string' || result.text.length > 16000) throw new DictationError('transcription_failed', 502);
  const text = result.text.trim();
  if (!text) throw new DictationError('no_speech');
  return { text, seconds, model, usage: result.usage || {} };
}

// One provider request per person at a time, on any process: a dictation
// claims the person's dictation_claims row until it ends, or until `leaseMs`
// lapses after a crash. Resolves the claim's id, or null while another
// holds it. It was a Set in each process: two Pods ran two at once.
async function claim(pool, userId, leaseMs) {
  const id = crypto.randomUUID();
  const { rowCount } = await pool.query(
    `INSERT INTO dictation_claims (user_id, claim_id, claimed_until)
     VALUES ($1, $2, NOW() + make_interval(secs => $3))
     ON CONFLICT (user_id) DO UPDATE SET claim_id = EXCLUDED.claim_id, claimed_until = EXCLUDED.claimed_until
       WHERE dictation_claims.claimed_until < NOW()`,
    [userId, id, leaseMs / 1000]
  );
  return rowCount ? id : null;
}

// Its own claim only: one that lapsed and another took is the other's.
async function release(pool, userId, claimId) {
  await pool.query('DELETE FROM dictation_claims WHERE user_id = $1 AND claim_id = $2', [userId, claimId]);
}

module.exports = { SAMPLE_RATE, MAX_SECONDS, MAX_BYTES, DEFAULT_MODEL, DictationError, validateWav, transcribe, claim, release };
