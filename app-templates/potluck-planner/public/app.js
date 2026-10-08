// The potluck planner screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so a dish called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    potlucks: document.getElementById('potlucks'),
    plan: document.getElementById('plan-form'),
    pastSection: document.getElementById('past-section'),
    past: document.getElementById('past'),
  };

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

  /** A small "x" drawn as an SVG, for remove buttons. */
  function crossIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('class', 'h-4 w-4');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M5 5l10 10M15 5L5 15');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.75');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    return svg;
  }

  /** An error line under whatever was being done, or the page's own. */
  function showStatus(err, where) {
    var line = where || el.status;
    line.textContent = err ? err.message : '';
    line.hidden = !err;
  }

  function act(promise, where) {
    return promise.then(function () { showStatus(null, where); return load(); }).catch(function (err) { showStatus(err, where); });
  }

  // ── When ───────────────────────────────────────────────────────────────

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  /** "Today, 6:00 PM", "Tomorrow, 6:00 PM" or "Sat, Oct 17, 6:00 PM", in the viewer's own time. */
  function when(iso, nowIso) {
    var at = new Date(iso);
    var now = new Date(nowIso);
    var tomorrow = new Date(now.getTime());
    tomorrow.setDate(tomorrow.getDate() + 1);
    var time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (sameDay(at, now)) return 'Today, ' + time;
    if (sameDay(at, tomorrow)) return 'Tomorrow, ' + time;
    return at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + time;
  }

  function count(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  // ── A potluck ──────────────────────────────────────────────────────────

  function dishLine(d) {
    var line = h('div', 'flex items-center gap-1');
    line.setAttribute('data-dish', String(d.id));
    var text = h('p', 'min-w-0 flex-1 text-body break-words', d.dish);
    text.appendChild(h('span', 'text-small text-muted', d.mine ? ' · you' : ' · @' + d.by));
    line.appendChild(text);
    if (d.canRemove) {
      var remove = h('button', 'btn-secondary -my-2 shrink-0 border-0 bg-transparent px-0 text-muted');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Take ' + d.dish + ' off');
      remove.appendChild(crossIcon());
      remove.addEventListener('click', function () { act(api('DELETE', '/api/dishes/' + d.id)); });
      line.appendChild(remove);
    }
    return line;
  }

  function courseRow(c) {
    var row = h('li', 'list-row items-start');
    row.setAttribute('data-course', c.course);
    row.appendChild(h('p', 'w-20 shrink-0 pt-0.5 text-small font-medium text-muted', c.course));
    var dishes = h('div', 'flex min-w-0 flex-1 flex-col gap-1');
    if (c.dishes.length) c.dishes.forEach(function (d) { dishes.appendChild(dishLine(d)); });
    else dishes.appendChild(h('p', 'text-body text-muted', 'Nobody yet'));
    row.appendChild(dishes);
    return row;
  }

  function bringForm(p, courses) {
    var form = h('form', 'flex flex-col gap-2');
    form.setAttribute('autocomplete', 'off');
    form.appendChild(h('p', 'section-label mb-0', 'What are you bringing?'));
    var fields = h('div', 'flex gap-2');
    var course = h('select', 'field w-28 shrink-0');
    course.name = 'course';
    course.setAttribute('aria-label', 'Course');
    courses.forEach(function (c) {
      var option = h('option', null, c);
      option.value = c;
      course.appendChild(option);
    });
    // Suggest the first course nobody has taken.
    var open = p.courses.filter(function (c) { return c.course !== 'Other' && !c.dishes.length; })[0];
    if (open) course.value = open.course;
    fields.appendChild(course);
    var dish = h('input', 'field min-w-0 flex-1');
    dish.name = 'dish';
    dish.type = 'text';
    dish.maxLength = 80;
    dish.required = true;
    dish.placeholder = 'e.g. apple pie';
    dish.setAttribute('aria-label', 'Your dish');
    fields.appendChild(dish);
    var add = h('button', 'btn-secondary shrink-0', 'Add');
    add.type = 'submit';
    fields.appendChild(add);
    form.appendChild(fields);
    var error = h('p', 'text-small text-danger');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.appendChild(error);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!dish.value.trim()) return;
      act(api('POST', '/api/potlucks/' + p.id + '/dishes', { course: course.value, dish: dish.value }), error);
    });
    return form;
  }

  function potluckBlock(p, data) {
    var block = h('article', 'flex flex-col gap-3');
    block.setAttribute('data-potluck', String(p.id));

    var head = h('div', 'flex flex-col gap-0.5 px-1');
    head.appendChild(h('h2', 'text-heading break-words', p.title));
    head.appendChild(h('p', 'text-body', when(p.startsAt, data.now) + (p.place ? ' · ' + p.place : '')));
    var by = h('p', 'flex items-center gap-2 text-small text-muted', (p.mine ? 'Planned by you' : 'Planned by @' + p.host) + ' · ' + count(p.dishes, 'dish', 'dishes'));
    if (p.mine) {
      var off = h('button', 'btn-secondary -my-2 ml-auto border-0 bg-transparent px-2 text-small text-muted', 'Call it off');
      off.type = 'button';
      off.addEventListener('click', function () {
        if (window.confirm('Call off "' + p.title + '"? Everyone\'s dishes for it go too.')) act(api('DELETE', '/api/potlucks/' + p.id));
      });
      by.appendChild(off);
    }
    head.appendChild(by);
    block.appendChild(head);

    var list = h('ul', 'list');
    p.courses.forEach(function (c) {
      if (c.course === 'Other' && !c.dishes.length) return;
      list.appendChild(courseRow(c));
    });
    block.appendChild(list);

    var open = p.courses
      .filter(function (c) { return c.course !== 'Other' && !c.dishes.length; })
      .map(function (c) { return c.course.toLowerCase(); });
    if (open.length) {
      var words = open.length === 1 ? open[0] : open.slice(0, -1).join(', ') + ' or ' + open[open.length - 1];
      block.appendChild(h('p', 'px-1 text-small text-muted', 'Nobody is bringing ' + words + ' yet.'));
    }

    if (data.me) block.appendChild(bringForm(p, data.courses));
    return block;
  }

  function pastRow(p, data) {
    var row = h('li', 'list-row');
    var text = h('div', 'min-w-0 flex-1');
    text.appendChild(h('p', 'text-body break-words', p.title));
    text.appendChild(h('p', 'text-small text-muted', when(p.startsAt, data.now) + ' · ' + count(p.dishes, 'dish', 'dishes')));
    row.appendChild(text);
    return row;
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    if (state !== 'ready') {
      el.empty.hidden = true;
      el.potlucks.hidden = true;
      el.pastSection.hidden = true;
    }
  }

  function render(data) {
    el.potlucks.textContent = '';
    data.upcoming.forEach(function (p) { el.potlucks.appendChild(potluckBlock(p, data)); });
    el.potlucks.hidden = !data.upcoming.length;
    el.empty.hidden = !!data.upcoming.length;
    el.past.textContent = '';
    data.past.forEach(function (p) { el.past.appendChild(pastRow(p, data)); });
    el.pastSection.hidden = !data.past.length;
    // The plan form's day starts no earlier than today.
    var now = new Date(data.now);
    el.plan.elements.date.min = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    show('ready');
  }

  var loaded = false;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/potlucks')
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

  var planError = document.getElementById('plan-status');
  el.plan.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = el.plan.elements;
    if (!f.title.value.trim() || !f.date.value || !f.time.value) return;
    // The planner's own day and time, sent as one moment.
    var startsAt = new Date(f.date.value + 'T' + f.time.value);
    act(api('POST', '/api/potlucks', { title: f.title.value, place: f.place.value, startsAt: startsAt.toISOString() })
      .then(function () { el.plan.reset(); window.scrollTo({ top: 0, behavior: 'smooth' }); }), planError);
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people sign up too: look again every 30 seconds while the app is
  // on screen, and straight away when it comes back. Skipped while someone
  // is typing, so a refresh never eats a half-written dish.
  setInterval(function () {
    var active = document.activeElement;
    var typing = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT') && (active.value || active.tagName === 'SELECT');
    if (!document.hidden && !typing) load();
  }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  load();
})();
