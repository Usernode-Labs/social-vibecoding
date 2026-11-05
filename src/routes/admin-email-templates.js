'use strict';

// Admin > Email templates: the routes that read, write, preview and test the
// templates and layouts every platform email is written from
// (services/mail/template-store.js).
//
// Mounted by routes/admin.js after its router-level adminMiddleware, so any
// admin may read and preview; every write and the test send need a full admin
// (requireAdminWrite). Writes are validated inside the store's transaction
// (services/mail/template-validation.js through the store's `check`), so a
// template and a layout edited at the same moment are each checked against the
// other's result.
//
// Every refusal is a status and a sentence an admin can act on: 400 with
// `errors: [{ field, message }]` for content that cannot be saved, 404 for a
// version or layout that is not there, 409 when someone else saved first or
// the database was busy, and 422 when a delete needs (or got the wrong)
// replacement. Admin console text stays English in code.
//
// Paths:
//   GET    /api/admin/email-templates            actions, every version, languages
//   POST   /api/admin/email-templates            save a new live version
//   POST   /api/admin/email-templates/preview    render unsaved fields, store nothing
//   POST   /api/admin/email-templates/test       send unsaved fields to yourself
//   POST   /api/admin/email-templates/:id/restore
//   DELETE /api/admin/email-templates/:id        body { replacementId } for a live one, and
//                                                { expectedLiveId } to refuse a stale delete
//   POST   /api/admin/email-templates/:id/translate          start Translate for that version
//                                                           (body { overwrite } to replace an admin's own)
//   GET    /api/admin/email-templates/:id/translate          its progress, any admin
//   GET    /api/admin/email-templates/:id/translations       every language of that version
//   PUT    /api/admin/email-templates/:id/translations/:locale  an admin's correction
// and the same under /api/admin/email-layouts, where DELETE takes the layout's
// family id (a layout is deleted as a whole) and `replacementId` is a family id;
// everything else there takes a layout version's id.
//
// A save that leaves some translation broken (services/mail/template-translate.js
// recheckTranslations) is not refused for it: that translation is marked
// unusable, English goes for that part, and the response lists it in
// `unusableTranslations`.

const { Router } = require('express');
const { requireAdminWrite } = require('../middleware/admin');
const { mailTestLimiter, emailPreviewLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');
const events = require('../services/events');
const mail = require('../services/mail');
const store = require('../services/mail/template-store');
const language = require('../services/mail/language');
const { ACTIONS, actionFor } = require('../services/mail/actions');
// Read through the module, so a test can stand in for it.
const renderer = require('../services/mail/render');
const { validateTemplate, validateLayout, LAYOUT_PLACEHOLDERS } = require('../services/mail/template-validation');
const translate = require('../services/mail/template-translate');

const STATUS = {
  invalid: 400,
  unknown_action: 400,
  not_found: 404,
  conflict: 409,
  retry: 409,
  replacement_required: 422,
  invalid_replacement: 422,
  english_only: 400,
  budget: 429,
  no_model: 503,
};

const MESSAGES = {
  invalid: 'This cannot be saved yet. Fix the problems shown and try again.',
  conflict: 'Someone else changed this since you opened it. Reload to see their version, then make your change again.',
  retry: 'The database was busy with another change. Try again in a moment.',
};

function invalid(errors, extra = {}) {
  const err = new Error('invalid');
  err.code = 'invalid';
  err.errors = errors;
  Object.assign(err, extra);
  return err;
}

function sendError(res, err, context) {
  const status = err && Object.hasOwn(STATUS, err.code) ? STATUS[err.code] : null;
  if (!status) {
    log.error('admin', 'Email template request failed', { context, message: err && err.message });
    return res.status(500).json({ error: 'Something went wrong on the server. Nothing was changed.' });
  }
  const body = { error: MESSAGES[err.code] || `${err.message}.`, code: err.code };
  if (err.code === 'invalid') body.errors = err.errors || [];
  if (err.code === 'unknown_action') {
    body.code = 'invalid';
    body.error = MESSAGES.invalid;
    body.errors = [{ field: 'action', message: 'Choose what this email is for from the list of actions.' }];
  }
  if (err.templates) body.templates = err.templates;
  return res.status(status).json(body);
}

// A positive integer id from a path or body, or null.
const toId = (value) => (/^[1-9][0-9]{0,9}$/.test(String(value)) && Number(value) <= 2147483647 ? Number(value) : null);

// An optional id field: null when absent, the id, or a refusal naming the field.
function optionalId(body, field) {
  const value = body[field];
  if (value === undefined || value === null || value === '') return null;
  const id = toId(value);
  if (id === null) throw invalid([{ field, message: `${field} must be a whole number.` }]);
  return id;
}

// A delete checks the live version the admin saw only when the body names one
// (null meaning "there was none"), so an older caller without it still works.
function expected(body) {
  return Object.hasOwn(body, 'expectedLiveId') ? { expectedLiveId: optionalId(body, 'expectedLiveId') } : {};
}

const str = (value) => (typeof value === 'string' ? value : '');

function templateFields(body) {
  return {
    name: str(body.name).trim(),
    subject: str(body.subject),
    preheader: str(body.preheader),
    why: str(body.why),
    html: str(body.html),
    text: str(body.text),
  };
}

// A template's words, the part a translation replaces.
const TEMPLATE_WORDS = ['subject', 'preheader', 'why', 'html', 'text'];

function layoutFields(body) {
  return { name: str(body.name).trim(), html: str(body.html), text: str(body.text) };
}

const refuseUnless = (result) => {
  if (!result.ok) throw invalid(result.errors, result.templates ? { templates: result.templates } : {});
};

function describeActions() {
  return Object.entries(ACTIONS).map(([action, a]) => ({
    action,
    label: a.label,
    englishOnly: !!a.englishOnly,
    required: a.required,
    placeholders: Object.entries(a.placeholders).map(([name, p]) => ({
      name, description: p.description, kind: p.kind, fromCode: !!p.fromCode,
    })),
  }));
}

function languages() {
  try {
    const list = require('../services/language-cache').readSource()?.files?.['config.json']?.languages || {};
    return Object.entries(list).map(([code, label]) => ({ code, label }));
  } catch {
    return [{ code: 'en', label: 'English' }];
  }
}

const LIVE_ONLY_MESSAGE = 'No live template for that action to show the layout with.';

function emailTemplateAdminRoutes(pool, config) {
  const router = Router();

  // Locales each version has a translation for, by version id.
  async function localesBy(table) {
    const { rows } = table === 'templates'
      ? await pool.query('SELECT template_id AS id, array_agg(locale ORDER BY locale) AS locales FROM email_template_translations GROUP BY template_id')
      : await pool.query('SELECT layout_id AS id, array_agg(locale ORDER BY locale) AS locales FROM email_layout_translations GROUP BY layout_id');
    return new Map(rows.map((r) => [r.id, r.locales]));
  }

  // What a send in `locale` would render these fields with: the reader's
  // language (null for English), the translator for words built in code, and
  // the message itself, with the action's sample payload.
  async function render(kind, template, layout, locale) {
    const action = actionFor(kind);
    const reader = action.englishOnly ? null : language.readerLanguage(locale);
    const t = reader && action.codeWords ? await language.translatorFor(pool, reader) : null;
    const message = renderer.renderMessage(kind, { template, layout }, action.sample || {}, t || undefined, { readerHasLanguage: !!reader });
    return { reader, t, message };
  }

  // The template and layout a preview or test renders: for a template, the
  // unsaved fields in the chosen layout (that layout's live version, in the
  // locale where translated); for a layout, the action's live template inside
  // the unsaved layout.
  //
  // A template's own words in another language: while the draft is still the
  // live version's English word for word, readers in that language get the
  // live version's translation of it, so that is what is shown. Any other
  // draft has no translation yet, and its readers would get its English after
  // a save: `untranslated` says so, and the console labels the preview.
  async function partsFor(what, body) {
    const kind = str(body.action) || (what === 'layout' ? 'otp' : '');
    const action = actionFor(kind);
    if (!action) throw invalid([{ field: 'action', message: 'Choose what this email is for from the list of actions.' }]);
    const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
    const reader = action.englishOnly ? null : language.readerLanguage(body.locale);
    const snap = await store.snapshot(pool);
    if (what === 'template') {
      const template = templateFields(fields);
      const familyId = optionalId(fields, 'layoutFamilyId');
      let layout = null;
      if (familyId !== null) {
        if (!Object.hasOwn(snap.layouts, familyId)) throw Object.assign(new Error('That layout does not exist'), { code: 'not_found' });
        layout = store.inReaderLanguage(snap.layouts[familyId], reader, 'layout');
      }
      const validation = validateTemplate(kind, { ...template, name: undefined }, layout);
      const shown = reader ? savedTranslation(snap, kind, template, reader) : null;
      return { kind, template: shown || template, layout, validation, untranslated: !!reader && !shown };
    }
    const layout = layoutFields(fields);
    if (!Object.hasOwn(snap.templates, kind)) throw invalid([{ field: 'action', message: LIVE_ONLY_MESSAGE }]);
    const template = store.inReaderLanguage(snap.templates[kind], reader, 'template');
    // The live template it is shown with must still work inside it, on every
    // path, as it would have to for the layout to be saved.
    const validation = validateLayout({ html: layout.html, text: layout.text }, [{ ...template, action: kind }]);
    return { kind, template, layout, validation };
  }

  // The live version's words in `reader`, when `template` is that version's
  // English unchanged and a send in `reader` would use a translation of it;
  // else null.
  function savedTranslation(snap, kind, template, reader) {
    const live = Object.hasOwn(snap.templates, kind) ? snap.templates[kind] : null;
    if (!live || !TEMPLATE_WORDS.every((field) => (live[field] || '') === template[field])) return null;
    const translated = store.inReaderLanguage(live, reader, 'template');
    if (translated === live) return null;
    return { ...template, ...Object.fromEntries(TEMPLATE_WORDS.map((field) => [field, translated[field] || ''])) };
  }

  async function preview(what, req, res) {
    try {
      const { kind, template, layout, validation, untranslated = false } = await partsFor(what, req.body || {});
      let message;
      try {
        ({ message } = await render(kind, template, layout, (req.body || {}).locale));
      } catch (err) {
        // Does not parse: there is nothing to show, only why.
        if (!validation.ok) throw invalid(validation.errors);
        // Only a mistake in the template is the admin's to read; anything else
        // is the server's, and its detail stays in the log.
        if (err && err.name === 'TemplateSyntaxError') throw invalid([{ field: 'html', message: `The email could not be put together: ${err.message}.` }]);
        log.error('admin', 'An email preview could not be rendered', { what, message: err && err.message });
        throw invalid([{ field: 'html', message: 'The email could not be put together. The server logged why; try again or ask a developer.' }]);
      }
      // Problems that would stop a save are shown beside the preview, not
      // instead of it, so an admin can see a draft while they fix it.
      res.json({ subject: message.subject, html: message.html, text: message.text, problems: validation.ok ? [] : validation.errors, untranslated });
    } catch (err) {
      sendError(res, err, `${what} preview`);
    }
  }

  async function testSend(what, req, res) {
    try {
      const body = req.body || {};
      const { kind, template, layout, validation } = await partsFor(what, body);
      refuseUnless(validation);
      const { rows: [me] } = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      const to = me && typeof me.email === 'string' && me.email.trim() ? me.email.trim() : null;
      if (!to) return res.status(400).json({ error: 'Your account has no email address, so there is nowhere to send a test.', code: 'no_address' });
      const { reader, t } = await render(kind, template, layout, body.locale);
      // As send() resolves it. In another language the fields stand for that
      // language's version, so they render as a translation does, with the
      // reader's words for what code builds; `english` is a copy of the same
      // fields so the translation is always the one used.
      const resolved = reader
        ? { template, layout, english: { template: { ...template }, layout }, t, readerHasLanguage: true }
        : { template, layout, english: { template, layout }, t: null, readerHasLanguage: false };
      const outcome = await mail.sendTest(config, { to, preview: { kind, payload: actionFor(kind).sample || {}, resolved } });
      await events.record(pool, {
        type: events.EVENT_TYPES.MAIL_TEST_SENT,
        userId: req.user.id,
        metadata: { status: outcome.status, provider: outcome.provider, recipient: to, action: kind, unsaved: what },
      });
      log.warn('admin', 'Admin sent a test of an email template', { by: req.user.username, action: kind, status: outcome.status, provider: outcome.provider });
      return res.json({ outcome, to });
    } catch (err) {
      return sendError(res, err, `${what} test`);
    }
  }

  // Awaited, so the trace exists by the time the admin sees the change.
  // record() never rejects.
  const changed = (req, metadata) => events.record(pool, { type: events.EVENT_TYPES.EMAIL_TEMPLATE_CHANGED, userId: req.user.id, metadata });

  // ── Templates ────────────────────────────────────────────────────────

  router.get('/api/admin/email-templates', async (_req, res) => {
    try {
      const [all, templateLocales, layoutLocales] = await Promise.all([
        store.listAll(pool), localesBy('templates'), localesBy('layouts'),
      ]);
      res.json({
        actions: describeActions(),
        layoutPlaceholders: Object.entries(LAYOUT_PLACEHOLDERS).map(([name, p]) => ({ name, description: p.description })),
        languages: languages(),
        templates: all.templates.map((row) => ({ ...row, locales: templateLocales.get(row.id) || [] })),
        layouts: all.layouts.map((row) => ({ ...row, locales: layoutLocales.get(row.id) || [] })),
      });
    } catch (err) {
      sendError(res, err, 'list templates');
    }
  });

  router.post('/api/admin/email-templates', requireAdminWrite, async (req, res) => {
    try {
      const body = req.body || {};
      const action = str(body.action);
      if (!actionFor(action)) throw invalid([{ field: 'action', message: 'Choose what this email is for from the list of actions.' }]);
      const fields = templateFields(body);
      const layoutFamilyId = optionalId(body, 'layoutFamilyId');
      const expectedLiveId = optionalId(body, 'expectedLiveId');
      let unusableTranslations = [];
      const row = await store.saveTemplate(pool, { action, ...fields, layoutFamilyId, expectedLiveId }, req.user.id, {
        check: async ({ layout, client }) => {
          refuseUnless(validateTemplate(action, fields, layout));
          unusableTranslations = await translate.recheckTranslations(client, { templates: [{ ...fields, action, id: null }], layout });
        },
      });
      await changed(req, { what: 'template', change: 'saved', id: row.id, action: row.action, version: row.version });
      res.json({ template: row, unusableTranslations });
    } catch (err) {
      sendError(res, err, 'save template');
    }
  });

  router.post('/api/admin/email-templates/preview', emailPreviewLimiter, (req, res) => preview('template', req, res));

  router.post('/api/admin/email-templates/test', requireAdminWrite, mailTestLimiter, (req, res) => testSend('template', req, res));

  router.post('/api/admin/email-templates/:id/restore', requireAdminWrite, async (req, res) => {
    try {
      const id = toId(req.params.id);
      if (!id) throw Object.assign(new Error('That template does not exist'), { code: 'not_found' });
      const expectedLiveId = optionalId(req.body || {}, 'expectedLiveId');
      let unusableTranslations = [];
      const row = await store.restoreTemplate(pool, id, { expectedLiveId }, req.user.id, {
        check: async ({ row: version, layout, client }) => {
          refuseUnless(validateTemplate(version.action, version, layout));
          unusableTranslations = await translate.recheckTranslations(client, { templates: [version], layout });
        },
      });
      await changed(req, { what: 'template', change: 'restored', id: row.id, action: row.action, version: row.version });
      res.json({ template: row, unusableTranslations });
    } catch (err) {
      sendError(res, err, 'restore template');
    }
  });

  router.delete('/api/admin/email-templates/:id', requireAdminWrite, async (req, res) => {
    try {
      const id = toId(req.params.id);
      if (!id) throw Object.assign(new Error('That template does not exist'), { code: 'not_found' });
      const body = req.body || {};
      const replacementId = optionalId(body, 'replacementId');
      let unusableTranslations = [];
      const result = await store.deleteTemplate(pool, id, { replacementId, ...expected(body) }, req.user.id, {
        check: async ({ row: version, layout, client }) => {
          refuseUnless(validateTemplate(version.action, version, layout));
          unusableTranslations = await translate.recheckTranslations(client, { templates: [version], layout });
        },
      });
      const { rows: [gone] } = await pool.query('SELECT action FROM email_templates WHERE id = $1', [id]);
      await changed(req, { what: 'template', change: 'deleted', id, action: gone ? gone.action : null, replacementId: result.liveId });
      res.json({ ...result, unusableTranslations });
    } catch (err) {
      sendError(res, err, 'delete template');
    }
  });

  // ── Layouts ──────────────────────────────────────────────────────────

  router.get('/api/admin/email-layouts', async (_req, res) => {
    try {
      const [all, locales] = await Promise.all([store.listAll(pool), localesBy('layouts')]);
      const usedBy = new Map();
      for (const row of all.templates) {
        if (row.status !== 'live' || row.deleted_at || row.layout_family_id == null) continue;
        if (!usedBy.has(row.layout_family_id)) usedBy.set(row.layout_family_id, []);
        usedBy.get(row.layout_family_id).push({ id: row.id, action: row.action, name: row.name });
      }
      res.json({
        placeholders: Object.entries(LAYOUT_PLACEHOLDERS).map(([name, p]) => ({ name, description: p.description })),
        languages: languages(),
        layouts: all.layouts.map((row) => ({
          ...row,
          locales: locales.get(row.id) || [],
          usedBy: row.status === 'live' && !row.deleted_at ? usedBy.get(row.family_id) || [] : [],
        })),
      });
    } catch (err) {
      sendError(res, err, 'list layouts');
    }
  });

  router.post('/api/admin/email-layouts', requireAdminWrite, async (req, res) => {
    try {
      const body = req.body || {};
      const fields = layoutFields(body);
      const familyId = optionalId(body, 'familyId');
      const expectedLiveId = optionalId(body, 'expectedLiveId');
      let unusableTranslations = [];
      const row = await store.saveLayout(pool, { familyId, ...fields, expectedLiveId }, req.user.id, {
        // The English templates must work inside it, or nothing is saved. A
        // translation that does not is marked, never a reason to refuse: the
        // new version has no translations yet, so they are sent inside it.
        check: async ({ templates, client }) => {
          refuseUnless(validateLayout(fields, templates));
          unusableTranslations = await translate.recheckTranslations(client, { templates, layout: { html: fields.html, text: fields.text } });
        },
      });
      await changed(req, { what: 'layout', change: 'saved', id: row.id, familyId: row.family_id, version: row.version });
      res.json({ layout: row, unusableTranslations });
    } catch (err) {
      sendError(res, err, 'save layout');
    }
  });

  router.post('/api/admin/email-layouts/preview', emailPreviewLimiter, (req, res) => preview('layout', req, res));

  router.post('/api/admin/email-layouts/test', requireAdminWrite, mailTestLimiter, (req, res) => testSend('layout', req, res));

  router.post('/api/admin/email-layouts/:id/restore', requireAdminWrite, async (req, res) => {
    try {
      const id = toId(req.params.id);
      if (!id) throw Object.assign(new Error('That layout version does not exist'), { code: 'not_found' });
      const expectedLiveId = optionalId(req.body || {}, 'expectedLiveId');
      let unusableTranslations = [];
      const row = await store.restoreLayout(pool, id, { expectedLiveId }, req.user.id, {
        check: async ({ row: version, templates, client }) => {
          refuseUnless(validateLayout({ html: version.html, text: version.text }, templates));
          unusableTranslations = await translate.recheckTranslations(client, { templates, layout: version });
        },
      });
      await changed(req, { what: 'layout', change: 'restored', id: row.id, familyId: row.family_id, version: row.version });
      res.json({ layout: row, unusableTranslations });
    } catch (err) {
      sendError(res, err, 'restore layout');
    }
  });

  // `:id` is the layout's family: a layout is deleted with all its versions.
  router.delete('/api/admin/email-layouts/:id', requireAdminWrite, async (req, res) => {
    try {
      const familyId = toId(req.params.id);
      if (!familyId) throw Object.assign(new Error('That layout does not exist'), { code: 'not_found' });
      const body = req.body || {};
      const replacementFamilyId = optionalId(body, 'replacementId');
      let unusableTranslations = [];
      const result = await store.deleteLayout(pool, familyId, { replacementFamilyId, ...expected(body) }, req.user.id, {
        // Every template that moves must still work inside the replacement.
        check: async ({ templates, layout, client }) => {
          const errors = [];
          const broken = [];
          for (const template of templates) {
            const result = validateTemplate(template.action, template, layout);
            if (result.ok) continue;
            broken.push({ id: template.id, action: template.action, name: template.name });
            errors.push({ field: 'replacementId', message: `"${template.name}" would break in that layout: ${result.errors[0].message}` });
          }
          if (errors.length) throw invalid(errors, { templates: broken });
          unusableTranslations = await translate.recheckTranslations(client, { templates, layout });
        },
      });
      await changed(req, { what: 'layout', change: 'deleted', familyId, replacementId: result.movedTo });
      res.json({ ...result, unusableTranslations });
    } catch (err) {
      sendError(res, err, 'delete layout');
    }
  });

  // ── Translations ─────────────────────────────────────────────────────

  const KINDS = { 'email-templates': 'template', 'email-layouts': 'layout' };
  const versionId = (req, kind) => {
    const id = toId(req.params.id);
    if (!id) throw Object.assign(new Error(kind === 'template' ? 'That template does not exist' : 'That layout version does not exist'), { code: 'not_found' });
    return id;
  };

  for (const [base, kind] of Object.entries(KINDS)) {
    router.post(`/api/admin/${base}/:id/translate`, requireAdminWrite, async (req, res) => {
      try {
        const id = versionId(req, kind);
        const overwrite = (req.body || {}).overwrite === true;
        const { started, job } = await translate.startTranslation(pool, kind, id, { overwrite, userId: req.user.id });
        if (started) {
          await changed(req, { what: kind, change: 'translate', id, overwrite });
          log.warn('admin', 'Admin started Translate for an email', { by: req.user.username, kind, id, overwrite });
        }
        res.status(202).json({ started, ...job });
      } catch (err) {
        sendError(res, err, `translate ${kind}`);
      }
    });

    router.get(`/api/admin/${base}/:id/translate`, async (req, res) => {
      try {
        res.json(await translate.jobStatus(pool, kind, versionId(req, kind)));
      } catch (err) {
        sendError(res, err, `translate ${kind} progress`);
      }
    });

    router.get(`/api/admin/${base}/:id/translations`, async (req, res) => {
      try {
        res.json({ translations: await translate.translationsOf(pool, kind, versionId(req, kind)) });
      } catch (err) {
        sendError(res, err, `${kind} translations`);
      }
    });

    router.put(`/api/admin/${base}/:id/translations/:locale`, requireAdminWrite, async (req, res) => {
      try {
        const id = versionId(req, kind);
        const body = req.body || {};
        const fields = kind === 'template'
          ? { subject: str(body.subject), preheader: str(body.preheader), why: str(body.why), html: str(body.html), text: str(body.text) }
          : { html: str(body.html), text: str(body.text) };
        const result = await translate.saveCorrection(pool, kind, id, req.params.locale, fields);
        await changed(req, { what: `${kind} translation`, change: 'corrected', id, locale: req.params.locale });
        res.json(result);
      } catch (err) {
        sendError(res, err, `correct ${kind} translation`);
      }
    });
  }

  return router;
}

module.exports = { emailTemplateAdminRoutes };
