// Public receiver reads run on the device. Never forward the platform's
// cookies, authorization or page URL to this independently hosted service.
import { t } from '../../lib/i18n/runtime';

export class StakingDataError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function observabilityOrigin(value) {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch {
    throw new StakingDataError('configuration', t('profile:staking.error.misconfigured'));
  }
}

export async function readObservabilityJson(url, signal, {
  fetchImpl = fetch, timeoutMs = 15000, maxBytes = 8 * 1024 * 1024,
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let reader;
  try {
    const response = await fetchImpl(url, { signal: controller.signal,
      mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
      cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' } });
    reader = response.body?.getReader();
    if (!response.ok) throw new StakingDataError('http',
      t('profile:staking.error.http', { status: response.status }));
    if (!reader) throw new StakingDataError('invalid_response', t('profile:staking.error.emptyResponse'));
    const decoder = new TextDecoder();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new StakingDataError('response_too_large', t('profile:staking.error.tooLarge'));
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    try { return JSON.parse(chunks.join('')); }
    catch { throw new StakingDataError('invalid_response', t('profile:staking.error.invalidResponse')); }
  } catch (error) {
    if (signal?.aborted || error instanceof StakingDataError) throw error;
    throw new StakingDataError(timedOut ? 'timeout' : 'connection', timedOut
      ? t('profile:staking.error.timeout')
      : t('profile:staking.error.unreachable'));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (reader) await reader.cancel().catch(() => {});
  }
}

export async function fetchStakingEpoch({ observabilityUrl, chainId, wallet, epoch }, signal, {
  read = readObservabilityJson,
} = {}) {
  const origin = observabilityOrigin(observabilityUrl);
  if (typeof chainId !== 'string' || !chainId) throw new StakingDataError('configuration', t('profile:staking.error.network'));
  if (typeof wallet !== 'string' || !/^(?:ut1|B62)[a-zA-Z0-9]{20,120}$/.test(wallet)) {
    throw new StakingDataError('wallet', t('profile:staking.error.wallet'));
  }
  const current = epoch === 'current';
  if (!current && !/^(0|[1-9]\d{0,8})$/.test(String(epoch))) {
    throw new StakingDataError('epoch', t('profile:staking.error.epoch'));
  }
  const upstream = (path, parameters) => {
    const url = new URL('/v1/observability/' + path, origin);
    url.search = new URLSearchParams(parameters).toString();
    return read(url.toString(), signal);
  };
  const stats = await upstream('vrf/producer-stats', {
    sender: wallet, period: current ? 'current_epoch' : 'epoch',
    ...(current ? {} : { epoch: String(epoch) }),
  });
  const number = stats?.epoch;
  if (!Number.isSafeInteger(number) || number < 0 || !Number.isSafeInteger(stats.slots_per_epoch)
      || stats.slots_per_epoch <= 0 || !Number.isSafeInteger(stats.current_slot) || stats.current_slot < 0
      || !Number.isFinite(stats.generated_at_ms) || (!current && number !== Number(epoch))) {
    throw new StakingDataError('invalid_response', t('profile:staking.error.notYet'));
  }
  const currentEpoch = Math.floor(stats.current_slot / stats.slots_per_epoch);
  if (number > currentEpoch) throw new StakingDataError('epoch', t('profile:staking.error.notStarted'));
  const slots = await upstream('vrf/slots', { sender: wallet, epoch: String(number) });
  const start = number * stats.slots_per_epoch;
  const end = start + stats.slots_per_epoch - 1;
  const summary = slots?.summary;
  const countFields = ['total', 'produced', 'missed', 'pending', 'dropped', 'unobserved'];
  const valid = Number.isSafeInteger(end) && slots?.from_slot === start && slots.to_slot === end
    && slots.cache?.complete === true && stats.cache?.complete === true
    && slots.participant_count === 1 && Array.isArray(slots.obligations)
    && countFields.every((field) => Number.isSafeInteger(summary?.[field]) && summary[field] >= 0)
    && summary.total === slots.obligations.length
    && slots.obligations.every((slot) => slot?.epoch === number && Number.isFinite(slot.slot_time_ms));
  const counts = valid ? {
    won: summary.total,
    upcoming: slots.obligations.filter((slot) => slot.status === 'pending' && slot.slot_time_ms > stats.generated_at_ms).length,
    produced: summary.produced, missed: summary.missed,
    unobserved: summary.unobserved, dropped: summary.dropped,
  } : null;
  // Ended epochs stay refreshable until the receiver closes the full range
  // and resolves every obligation. A gap must never become a permanent zero.
  const complete = valid && number < currentEpoch
    && summary.pending === 0 && summary.unobserved === 0
    && stats.from_slot === start && stats.to_slot === end
    && stats.covered_slot_count === stats.slots_per_epoch
    && stats.receiver_observation_complete === true
    && Number.isInteger(stats.closed_through_slot) && stats.closed_through_slot >= end;
  return { chainId, wallet, epoch: number, currentEpoch, complete, counts,
    observability: { stats, slots } };
}
