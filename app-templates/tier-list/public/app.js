// The tier list screen. Talks to api.js; every request carries the platform
// token the frame was opened with, which is how the server knows who you are.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so an item called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    form: document.getElementById('add-form'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    group: document.getElementById('group'),
    groupTiers: document.getElementById('group-tiers'),
    rankers: document.getElementById('rankers'),
    unranked: document.getElementById('unranked'),
    yours: document.getElementById('yours'),
    yourTiers: document.getElementById('your-tiers'),
    yourCount: document.getElementById('your-count'),
  };

  // Whole class names per tier, so the build and the <style> block see them.
  var TIER_CLASS = { S: 'tier-s', A: 'tier-a', B: 'tier-b', C: 'tier-c', D: 'tier-d', F: 'tier-f' };
  var TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

  function api(method, url, body) {
    var headers = { 'x-usernode-token': token };
    // A preview opened at a chosen moment tells the server what time it is
    // there (req.now; "Time-dependent features" in the platform conventions).
    if (window.usernode && window.usernode.previewNow) headers['x-usernode-now'] = window.usernode.now().toISOString();
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            throw new Error(data.error === 'account_required'
              ? 'Make an account to join in.'
              : data.error || 'Something went wrong (' + res.status + ').');
          }
          return data;
        });
      });
  }

  /** A tiny element builder: h('p', 'text-small', 'Hello'). */
  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function showStatus(err) {
    el.status.textContent = err ? err.message : '';
    el.status.hidden = !err;
  }

  function act(promise) {
    return promise.then(function () { showStatus(null); return load(); }).catch(showStatus);
  }

  function count(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  // ── The group's tier list ──────────────────────────────────────────────

  function groupRow(tier, items) {
    var row = h('div', 'flex min-h-14 items-stretch');
    row.setAttribute('data-tier', tier);
    var label = h('div', 'flex w-14 shrink-0 items-center justify-center text-heading ' + TIER_CLASS[tier], tier);
    label.setAttribute('aria-label', 'Tier ' + tier);
    row.appendChild(label);
    var chips = h('div', 'flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-3 py-2');
    items.forEach(function (item) {
      var chip = h('span', 'inline-flex max-w-full items-center rounded-lg bg-raised px-2.5 py-1 text-small');
      chip.setAttribute('data-item', String(item.id));
      chip.appendChild(h('span', 'truncate font-medium', item.name));
      chip.title = item.name + ': ' + count(item.votes, 'person', 'people') + ' ranked it';
      chips.appendChild(chip);
    });
    row.appendChild(chips);
    return row;
  }

  function renderGroup(data) {
    el.groupTiers.textContent = '';
    TIERS.forEach(function (tier) {
      var items = data.items
        .filter(function (i) { return i.tier === tier; })
        .sort(function (a, b) { return b.average - a.average || b.votes - a.votes; });
      el.groupTiers.appendChild(groupRow(tier, items));
    });
    el.rankers.textContent = data.rankers ? count(data.rankers, 'person', 'people') + ' ranking' : '';
    var waiting = data.items.filter(function (i) { return !i.tier; });
    el.unranked.hidden = !waiting.length;
    el.unranked.textContent = waiting.length
      ? 'Not in a tier yet: ' + waiting.map(function (i) { return i.name; }).join(', ')
      : '';
  }

  // ── Your tiers ─────────────────────────────────────────────────────────

  function yourRow(item) {
    var row = h('li', 'flex flex-col gap-2 px-4 py-3');
    row.setAttribute('data-item', String(item.id));

    var top = h('div', 'flex items-start gap-3');
    var names = h('div', 'min-w-0 flex-1');
    names.appendChild(h('p', 'text-body font-medium break-words', item.name));
    names.appendChild(h('p', 'text-small text-muted', item.mine ? 'Added by you' : 'Added by @' + item.by));
    top.appendChild(names);
    if (item.mine) {
      var remove = h('button', 'btn-secondary -my-1 shrink-0 border-0 bg-transparent px-2 text-small text-muted', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + item.name);
      remove.addEventListener('click', function () {
        if (window.confirm('Take "' + item.name + '" off the list, with everyone\'s tiers for it?')) {
          act(api('DELETE', '/api/items/' + item.id));
        }
      });
      top.appendChild(remove);
    }
    row.appendChild(top);

    var picks = h('div', 'grid grid-cols-6 gap-1.5');
    picks.setAttribute('role', 'group');
    picks.setAttribute('aria-label', 'Your tier for ' + item.name);
    TIERS.forEach(function (tier) {
      var on = item.yours === tier;
      var pick = h('button', on
        ? 'min-h-11 rounded-lg text-body font-semibold ring-2 ring-fg ring-offset-2 ring-offset-surface ' + TIER_CLASS[tier]
        : 'min-h-11 rounded-lg border border-line bg-surface text-body font-semibold text-muted hover:bg-raised', tier);
      pick.type = 'button';
      pick.setAttribute('data-pick', tier);
      pick.setAttribute('aria-pressed', on ? 'true' : 'false');
      pick.setAttribute('aria-label', tier + (on ? ', your tier. Tap to clear.' : ''));
      pick.addEventListener('click', function () {
        // Tapping your tier again takes the item out of your tiers.
        act(api('PUT', '/api/items/' + item.id + '/tier', { tier: on ? null : tier }));
      });
      picks.appendChild(pick);
    });
    row.appendChild(picks);
    return row;
  }

  function renderYours(data) {
    el.yourTiers.textContent = '';
    data.items.forEach(function (item) { el.yourTiers.appendChild(yourRow(item)); });
    var ranked = data.items.filter(function (i) { return i.yours; }).length;
    el.yourCount.textContent = ranked === data.items.length ? 'All ranked' : ranked + ' of ' + data.items.length + ' ranked';
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    el.empty.hidden = state !== 'empty';
    el.group.hidden = state !== 'ready';
    el.yours.hidden = state !== 'ready';
  }

  function render(data) {
    if (!data.items.length) return show('empty');
    renderGroup(data);
    renderYours(data);
    show('ready');
  }

  var loaded = false;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/items')
      .then(function (data) { loaded = true; render(data); })
      .catch(function (err) {
        // A refresh that fails keeps what is on screen; only a first load
        // with nothing to show turns into the error state.
        if (loaded) showStatus(err);
        else show('error');
      })
      .then(function () { loading = null; });
    return loading;
  }

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = el.form.elements.name;
    if (!input.value.trim()) return;
    act(api('POST', '/api/items', { name: input.value }).then(function () { el.form.reset(); }));
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people rank too: look again every 15 seconds while the app is on
  // screen, and straight away when it comes back. Skipped while someone is
  // typing, so a refresh never interrupts them.
  setInterval(function () {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.value;
    if (!document.hidden && !typing) load();
  }, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  load();
})();
