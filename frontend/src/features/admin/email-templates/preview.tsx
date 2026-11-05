'use strict';

import { useEffect, useRef, useState } from 'react';

import { AdminUI } from '../admin-console.js';
import { FailureNotice, readFailure, request, type Failure, type FieldError, type Language } from './shared';

// The preview beside the editor, and the test send. Both render the UNSAVED
// fields on the server (POST .../preview and .../test), with the action's
// sample values, in the chosen reader language.
//
// The server's HTML is only ever drawn inside an iframe with `sandbox=""`
// set through `srcDoc`: no scripts, no same-origin access, no forms, no
// popups. That holds for a view-only admin's preview too. The validator
// already refuses scripts and handlers on save, but a preview shows a draft
// that has not passed it yet, and the frame is what keeps a draft from
// running anything in the console.

export interface PreviewResult { subject: string; html: string; text: string; problems: FieldError[] }

interface TestResult { ok: boolean; message: string }

function testHeadline(outcome: any, to: string): TestResult {
  switch (outcome && outcome.status) {
    case 'sent':
      // A server with no mail provider "sends" by writing the mail to its log.
      return outcome.provider === 'log'
        ? { ok: true, message: 'Rendered to the platform log: this server has no mail provider, so nothing was delivered.' }
        : { ok: true, message: `Sent to ${to}. Check your inbox.` };
    case 'skipped_staging': return { ok: true, message: 'Rendered to the platform log. Staging never delivers mail.' };
    case 'no_transport': return { ok: false, message: 'Nothing was sent: no mail transport is configured.' };
    case 'no_template': return { ok: false, message: 'Nothing was sent: the email could not be put together.' };
    case 'suppressed_bounce': return { ok: false, message: `Nothing was sent: ${to} has bounced or reported spam.` };
    case 'suppressed_rate_limit': return { ok: false, message: 'Held back: one test to the same address every 30 seconds.' };
    case 'failed': return { ok: false, message: `The provider refused the message${outcome.error ? `: ${outcome.error}` : '.'}` };
    default: return { ok: false, message: 'The send finished with an unexpected result.' };
  }
}

export function PreviewView({
  result, loading, failure, mode, locale, languages, englishOnly, canWrite, testing, testResult, onLocale, onSendTest,
  extra, stale = false,
}: {
  result: PreviewResult | null;
  // The last preview that rendered, kept on screen after a newer draft was
  // refused: dimmed and labelled so it is not read as the current draft.
  stale?: boolean;
  loading: boolean;
  failure: Failure | null;
  mode: 'html' | 'text';
  locale: string;
  languages: Language[];
  englishOnly: boolean;
  canWrite: boolean;
  testing: boolean;
  testResult: TestResult | null;
  onLocale: (code: string) => void;
  onSendTest: () => void;
  // A control the layout editor adds: which email to show inside it.
  extra?: React.ReactNode;
}) {
  return (
    <div id="email-template-preview" className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-xs">
          <span className="text-zinc-500 dark:text-zinc-400">Language</span>
          <select className={`${AdminUI.select} mt-1`} value={englishOnly ? 'en' : locale}
            disabled={englishOnly} onChange={(e) => onLocale(e.target.value)}>
            {languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
        {extra}
        {loading ? <span className={AdminUI.loading}>Loading…</span> : null}
      </div>
      {englishOnly ? <p className="text-xs text-zinc-500 dark:text-zinc-400">This email is sent in English only.</p> : null}
      {failure ? <FailureNotice failure={failure} /> : null}
      {result ? (
        <div className={stale ? 'opacity-50 space-y-3' : 'space-y-3'} data-email-preview-stale={stale ? '' : undefined}>
          {stale ? <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">Last good preview, before your latest change</p> : null}
          <div className="text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">Subject: </span>
            <span className="font-medium break-words">{result.subject}</span>
          </div>
          {mode === 'html' ? (
            <iframe title="Email preview" sandbox="" srcDoc={result.html}
              className="block w-full h-[32rem] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white" />
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-3 text-xs font-mono max-h-[32rem] overflow-y-auto">{result.text}</pre>
          )}
          {result.problems.length ? (
            <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              <p className="font-semibold">To fix before this can be saved:</p>
              <ul className="list-disc ms-5 mt-1">
                {/* eslint-disable-next-line react/no-array-index-key */}
                {result.problems.map((p, i) => <li key={i}>{p.message}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {canWrite ? (
        <div>
          <button type="button" id="email-template-test" className={AdminUI.btn.outline} disabled={testing} onClick={onSendTest}>
            {testing ? 'Sending…' : 'Send test to me'}
          </button>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Sends what you see now, unsaved, to your own address, the one on the account you are signed in with.
          </p>
          {testResult ? (
            <p className={`text-sm mt-2 ${testResult.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`} role="status">
              {testResult.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const DEBOUNCE_MS = 500;

/**
 * Asks for a preview whenever the fields or the language change, after a
 * short pause, and sends the test. `base` is `/api/admin/email-templates` or
 * `/api/admin/email-layouts`; `body` is what the route reads besides the
 * locale. Field problems from a refused test go back to the form through
 * `onFieldFailure`, so they show beside their fields.
 */
export function PreviewPane({ base, body, mode, languages, englishOnly, canWrite, onFieldFailure, extra }: {
  base: string;
  body: { action: string; fields: Record<string, unknown> };
  mode: 'html' | 'text';
  languages: Language[];
  englishOnly: boolean;
  canWrite: boolean;
  onFieldFailure: (failure: Failure) => void;
  extra?: React.ReactNode;
}) {
  const [locale, setLocale] = useState('en');
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // Only the newest request may draw: a slow answer for an older draft must
  // not replace a newer one.
  const latest = useRef(0);
  const key = JSON.stringify(body);
  // An email sent in English only is previewed and tested in English, whatever
  // the picker was left on for another email.
  const sentLocale = englishOnly ? 'en' : locale;

  useEffect(() => {
    const mine = ++latest.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      const res = await request(`${base}/preview`, 'POST', { ...body, locale: sentLocale });
      if (!alive.current || mine !== latest.current) return;
      setLoading(false);
      if (res.ok && res.data) {
        setFailure(null);
        setResult({
          subject: String(res.data.subject || ''),
          html: String(res.data.html || ''),
          text: String(res.data.text || ''),
          problems: Array.isArray(res.data.problems) ? res.data.problems : [],
        });
      } else {
        // The previous render stays, marked as the last good one (see stale).
        setFailure(readFailure(res.status, res.data));
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, key, sentLocale]);

  const sendTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    const res = await request(`${base}/test`, 'POST', { ...body, locale: sentLocale });
    if (!alive.current) return;
    setTesting(false);
    if (res.ok && res.data) { setTestResult(testHeadline(res.data.outcome, String(res.data.to || 'you'))); return; }
    const refused = readFailure(res.status, res.data);
    if (refused.kind === 'fields') onFieldFailure(refused);
    setTestResult({ ok: false, message: refused.message });
  };

  return (
    <PreviewView result={result} stale={!!failure && !!result} loading={loading} failure={failure} mode={mode} locale={locale}
      languages={languages} englishOnly={englishOnly} canWrite={canWrite} testing={testing}
      testResult={testResult} onLocale={setLocale} onSendTest={sendTest} extra={extra} />
  );
}
