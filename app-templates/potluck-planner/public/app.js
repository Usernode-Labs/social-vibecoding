// The potluck planner's screens. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// Three screens, one at a time, each with its own address in the URL's
// hash so the phone's back and a reload land where you were: the potlucks
// (#/), one potluck (#/p/<id>) and planning a new one (#/plan). Moving
// between them slides like a phone's own screens (the native kit's
// transition, when it is there).
//
// A potluck shows who is bringing what by course. Every dish can get a
// reaction and comments ("is it vegetarian?"), and every potluck has its own
// chat underneath.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so a dish called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    listView: document.getElementById('list-view'),
    potluckView: document.getElementById('potluck-view'),
    planView: document.getElementById('plan-view'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    upcomingSection: document.getElementById('upcoming-section'),
    potlucks: document.getElementById('potlucks'),
    pastSection: document.getElementById('past-section'),
    past: document.getElementById('past'),
    potluck: document.getElementById('potluck'),
    potluckLoading: document.getElementById('potluck-loading'),
    potluckError: document.getElementById('potluck-error'),
    potluckGone: document.getElementById('potluck-gone'),
    plan: document.getElementById('plan-form'),
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

  /**
   * A tap that cannot be undone asks for a second one. window.confirm() is no
   * use here: Homeroom's app frame does not allow dialogs, so it returns false
   * without showing anything. The first tap says what the second will do, and
   * the button goes back to how it was after a few seconds.
   */
  function tapTwice(button, armedLabel, action) {
    var timer = null;
    var resting = null;
    var label = null;
    var className = null;
    function rest() {
      timer = null;
      button.textContent = '';
      resting.forEach(function (n) { button.appendChild(n); });
      if (label) button.setAttribute('aria-label', label);
      button.className = className;
    }
    button.addEventListener('click', function () {
      if (timer) {
        clearTimeout(timer);
        rest();
        action();
        return;
      }
      resting = Array.prototype.slice.call(button.childNodes);
      label = button.getAttribute('aria-label');
      className = button.className;
      button.textContent = armedLabel;
      button.setAttribute('aria-label', armedLabel);
      button.className = 'btn-secondary shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-danger';
      timer = setTimeout(rest, 4000);
    });
  }

  /**
   * Ask before something that cannot be undone. With the native kit, its
   * action sheet: the phone's own way to confirm, with the destructive
   * choice in red and a Cancel. Without it, the second tap above.
   */
  function confirmFirst(button, question, verb, action) {
    if (window.unNative && window.unNative.actionSheet) {
      button.addEventListener('click', function () {
        window.unNative.actionSheet({ title: question, actions: [{ label: verb, destructive: true }] })
          .then(function (chosen) { if (chosen) action(); });
      });
    } else {
      tapTwice(button, 'Tap again to ' + verb.toLowerCase(), action);
    }
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

  /** "mains", "mains or drinks", "sides, salads or drinks". */
  function either(words) {
    return words.length === 1 ? words[0] : words.slice(0, -1).join(', ') + ' or ' + words[words.length - 1];
  }

  /** The courses nobody has taken yet, in lower case ("Other" never counts). */
  function openCourses(p) {
    return p.courses
      .filter(function (c) { return c.course !== 'Other' && !c.dishes.length; })
      .map(function (c) { return c.course.toLowerCase(); });
  }

  /** A right-pointing chevron, the sign that a row opens something. */
  function chevron() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'h-5 w-5 shrink-0 text-muted');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M9 6l6 6-6 6');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  // ── A potluck ──────────────────────────────────────────────────────────

  // Whose reaction picker is open, and whose comments are showing, by dish id.
  var picking = null;
  var opened = {};

  function people(list, me) {
    return list.map(function (u) { return me && u === me.username ? 'you' : '@' + u; }).join(', ');
  }

  function shortTime(iso) {
    var at = new Date(iso);
    return sameDay(at, new Date(current.now))
      ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function sendForm(placeholder, label, onSend) {
    var form = h('form', 'flex gap-2');
    form.setAttribute('autocomplete', 'off');
    var input = h('input', 'field min-w-0 flex-1');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    input.setAttribute('enterkeyhint', 'send');
    form.appendChild(input);
    var send = h('button', 'btn-secondary shrink-0', 'Send');
    send.type = 'submit';
    form.appendChild(send);
    var error = h('p', 'text-small text-danger');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!input.value.trim()) return;
      act(onSend(input.value), error);
    });
    var wrap = h('div', 'flex flex-col gap-1');
    wrap.appendChild(form);
    wrap.appendChild(error);
    return wrap;
  }

  function dishLine(d) {
    var me = current.me;
    var block = h('div', 'flex flex-col');
    block.setAttribute('data-dish', String(d.id));
    var line = h('div', 'flex items-center gap-1');
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
    block.appendChild(line);

    // Reactions, a way to add one, and the comments.
    var social = h('div', 'flex flex-wrap items-center gap-x-1');
    d.reactions.forEach(function (r) {
      var b = h('button', 'inline-flex min-h-11 items-center');
      b.type = 'button';
      b.setAttribute('data-reaction', r.emoji);
      b.setAttribute('aria-pressed', r.mine ? 'true' : 'false');
      b.setAttribute('aria-label', r.emoji + ' from ' + people(r.people, me) + (r.mine ? '. Tap to take yours back.' : '. Tap to add yours.'));
      b.appendChild(h('span', r.mine
        ? 'inline-flex items-center gap-1 rounded-full border border-accent bg-raised px-2 py-0.5 text-small'
        : 'inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-small', r.emoji + ' ' + r.count));
      if (me) b.addEventListener('click', function () { act(api('POST', '/api/dishes/' + d.id + '/reactions', { emoji: r.emoji })); });
      social.appendChild(b);
    });
    if (me) {
      var react = h('button', 'btn-secondary border-0 bg-transparent px-2 text-small text-muted', picking === d.id ? 'Close' : 'React');
      react.type = 'button';
      react.setAttribute('aria-expanded', picking === d.id ? 'true' : 'false');
      react.addEventListener('click', function () { picking = picking === d.id ? null : d.id; render(current); });
      social.appendChild(react);
    }
    var talk = h('button', 'btn-secondary border-0 bg-transparent px-2 text-small text-muted',
      d.comments.length ? count(d.comments.length, 'comment', 'comments') : 'Comment');
    talk.type = 'button';
    talk.setAttribute('aria-expanded', opened[d.id] ? 'true' : 'false');
    talk.addEventListener('click', function () { opened[d.id] = !opened[d.id]; render(current); });
    if (me || d.comments.length) social.appendChild(talk);
    block.appendChild(social);

    if (picking === d.id) {
      var picker = h('div', 'flex flex-wrap gap-1');
      picker.setAttribute('role', 'group');
      picker.setAttribute('aria-label', 'React to ' + d.dish);
      current.reactions.forEach(function (emoji) {
        var mine = d.reactions.some(function (r) { return r.emoji === emoji && r.mine; });
        var b = h('button', mine
          ? 'min-h-11 min-w-11 rounded-lg border border-accent bg-raised text-heading'
          : 'min-h-11 min-w-11 rounded-lg border border-line bg-surface text-heading hover:bg-raised', emoji);
        b.type = 'button';
        b.setAttribute('aria-label', (mine ? 'Take back ' : 'React with ') + emoji);
        b.addEventListener('click', function () {
          picking = null;
          act(api('POST', '/api/dishes/' + d.id + '/reactions', { emoji: emoji }));
        });
        picker.appendChild(b);
      });
      block.appendChild(picker);
    }

    if (opened[d.id]) {
      var thread = h('div', 'mt-1 flex flex-col gap-2 border-l-2 border-line pl-3');
      d.comments.forEach(function (c) {
        var p = h('p', 'text-small break-words');
        p.appendChild(h('span', 'font-medium', c.mine ? 'You' : '@' + c.by));
        p.appendChild(document.createTextNode(' ' + c.text));
        thread.appendChild(p);
      });
      if (me) {
        thread.appendChild(sendForm('e.g. is it vegetarian?', 'Comment on ' + d.dish, function (value) {
          return api('POST', '/api/dishes/' + d.id + '/comments', { text: value });
        }));
      }
      block.appendChild(thread);
    }
    return block;
  }

  function chat(p) {
    var me = current.me;
    var section = h('section', 'flex flex-col gap-2');
    section.setAttribute('data-chat', String(p.id));
    section.appendChild(h('h3', 'section-label mb-0', 'Chat'));
    if (p.messages.length) {
      var list = h('ul', 'list');
      p.messages.forEach(function (m) {
        var li = h('li', 'flex flex-col gap-0.5 px-4 py-2');
        li.setAttribute('data-message', String(m.id));
        li.appendChild(h('p', 'text-small text-muted', (m.mine ? 'You' : '@' + m.by) + ' · ' + shortTime(m.at)));
        li.appendChild(h('p', 'text-body break-words', m.text));
        list.appendChild(li);
      });
      section.appendChild(list);
    } else {
      section.appendChild(h('p', 'px-1 text-small text-muted', 'No messages yet. Say hello, or ask what is still missing.'));
    }
    if (me) {
      section.appendChild(sendForm('Message everyone coming', 'Message everyone coming to ' + p.title, function (value) {
        return api('POST', '/api/potlucks/' + p.id + '/messages', { text: value });
      }));
    }
    return section;
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
    dish.setAttribute('enterkeyhint', 'done');
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

  /** One potluck, the whole of its own screen. `past`: it has happened. */
  function potluckBlock(p, data, past) {
    var block = h('article', 'flex flex-col gap-4');
    block.setAttribute('data-potluck', String(p.id));

    var head = h('div', 'flex flex-col gap-1 px-1');
    head.appendChild(h('h2', 'text-title break-words', p.title));
    head.appendChild(h('p', 'text-body break-words', when(p.startsAt, data.now) + (p.place ? ' · ' + p.place : '')));
    var actionError = h('p', 'text-small text-danger');
    actionError.setAttribute('role', 'alert');
    actionError.hidden = true;
    var by = h('div', 'flex flex-wrap items-center gap-x-2 text-small text-muted');
    by.appendChild(h('p', 'min-w-0 break-words', (p.mine ? 'Planned by you' : 'Planned by @' + p.host) + ' · ' + count(p.dishes, 'dish', 'dishes')));
    if (p.mine && !past) {
      var off = h('button', 'btn-secondary -my-2 ml-auto border-0 bg-transparent px-2 text-small text-muted', 'Call it off');
      off.type = 'button';
      // Everyone's dishes for it go too; back to the potlucks once it has.
      confirmFirst(off, 'Call off ' + p.title + '? Everyone\'s dishes for it go too.', 'Call it off', function () {
        api('DELETE', '/api/potlucks/' + p.id)
          .then(function () { showStatus(null); back(); return load(); })
          .catch(function (err) { showStatus(err, actionError); });
      });
      by.appendChild(off);
    }
    head.appendChild(by);
    head.appendChild(actionError);
    if (past) head.appendChild(h('p', 'text-small text-muted', 'This potluck has passed.'));
    block.appendChild(head);

    var list = h('ul', 'list');
    p.courses.forEach(function (c) {
      if (c.course === 'Other' && !c.dishes.length) return;
      list.appendChild(courseRow(c));
    });
    block.appendChild(list);

    if (past) return block;

    var open = openCourses(p);
    if (open.length) block.appendChild(h('p', 'px-1 text-small text-muted', 'Nobody is bringing ' + either(open) + ' yet.'));

    if (data.me) block.appendChild(bringForm(p, data.courses));
    block.appendChild(chat(p));
    return block;
  }

  /** A potluck in the list: what and when, and what is still missing. Opens it. */
  function potluckRow(p, data, past) {
    var li = h('li');
    var row = h('button', 'list-row w-full text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus');
    row.type = 'button';
    row.setAttribute('data-potluck', String(p.id));
    var text = h('div', 'flex min-w-0 flex-1 flex-col gap-0.5');
    text.appendChild(h('p', 'text-body font-medium break-words', p.title));
    text.appendChild(h('p', 'text-small text-muted break-words', when(p.startsAt, data.now) + (p.place ? ' · ' + p.place : '')));
    var open = past ? [] : openCourses(p);
    text.appendChild(h('p', 'text-small text-muted', count(p.dishes, 'dish', 'dishes')
      + (open.length ? ' · no ' + either(open) + ' yet' : '')));
    row.appendChild(text);
    row.appendChild(chevron());
    row.addEventListener('click', function () { go('#/p/' + p.id); });
    li.appendChild(row);
    return li;
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    if (state !== 'ready') {
      el.empty.hidden = true;
      el.upcomingSection.hidden = true;
      el.pastSection.hidden = true;
    }
    paintPotluck();
  }

  var current = null; // the last list read
  var failed = false; // the first read failed, and nothing has come back since

  function render(data) {
    current = data;
    failed = false;
    el.potlucks.textContent = '';
    data.upcoming.forEach(function (p) { el.potlucks.appendChild(potluckRow(p, data, false)); });
    el.upcomingSection.hidden = !data.upcoming.length;
    el.empty.hidden = !!data.upcoming.length;
    el.past.textContent = '';
    data.past.forEach(function (p) { el.past.appendChild(potluckRow(p, data, true)); });
    el.pastSection.hidden = !data.past.length;
    // The plan form's day starts no earlier than today.
    var now = new Date(data.now);
    el.plan.elements.date.min = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    show('ready');
  }

  /** The potluck screen, for the potluck its address names. */
  function paintPotluck() {
    var r = route();
    if (r.screen !== 'potluck') return;
    var p = null;
    var past = false;
    if (current) {
      p = current.upcoming.filter(function (x) { return x.id === r.id; })[0] || null;
      if (!p) {
        p = current.past.filter(function (x) { return x.id === r.id; })[0] || null;
        past = !!p;
      }
    }
    el.potluckLoading.hidden = !!current || failed;
    el.potluckError.hidden = !!current || !failed;
    el.potluckGone.hidden = !current || !!p;
    el.potluck.hidden = !p;
    el.potluck.textContent = '';
    if (p) el.potluck.appendChild(potluckBlock(p, current, past));
  }

  // ── Screens ────────────────────────────────────────────────────────────

  /** Where the address says we are: { screen: 'list' | 'plan' | 'potluck', id }. */
  function route() {
    var m = /^#\/p\/(\d+)$/.exec(window.location.hash);
    if (m) return { screen: 'potluck', id: Number(m[1]) };
    if (window.location.hash === '#/plan') return { screen: 'plan' };
    return { screen: 'list' };
  }

  function depth(r) { return r.screen === 'list' ? 0 : 1; }

  var shown = route();
  var pushed = 0; // screens this visit went forward to that Back can return from
  var listScroll = 0;
  var nextMotion = null;

  /** Forward to another screen: a new entry the phone's back returns from. */
  function go(hash) {
    if (window.location.hash === hash) return;
    pushed += 1;
    window.location.hash = hash;
  }

  /** Back to the potlucks: the way we came if we came that way, else straight there. */
  function back() {
    if (pushed > 0) window.history.back();
    else window.location.replace('#/');
  }

  function showScreen(r, motion) {
    if (shown.screen === 'list' && r.screen !== 'list') listScroll = window.scrollY;
    var apply = function () {
      el.listView.hidden = r.screen !== 'list';
      el.potluckView.hidden = r.screen !== 'potluck';
      el.planView.hidden = r.screen !== 'plan';
      paintPotluck();
      if (r.screen === 'plan') showStatus(null, planError);
      window.scrollTo(0, r.screen === 'list' ? listScroll : 0);
    };
    shown = r;
    if (motion !== 'none' && window.unNative && window.unNative.transition) window.unNative.transition(apply, { type: motion });
    else apply();
  }

  window.addEventListener('hashchange', function () {
    var r = route();
    var motion = nextMotion || (depth(r) > depth(shown) ? 'push' : depth(r) < depth(shown) ? 'pop' : 'none');
    nextMotion = null;
    if (motion === 'pop' && pushed > 0) pushed -= 1;
    picking = null;
    showScreen(r, motion);
  });

  document.getElementById('plan-start').addEventListener('click', function () { go('#/plan'); });
  document.getElementById('plan-back').addEventListener('click', back);
  document.getElementById('potluck-back').addEventListener('click', back);

  var loaded = false;
  var loading = null;
  var again = false;
  function load() {
    // A read already on its way may have left before the change just made:
    // read once more when it is back.
    if (loading) { again = true; return loading; }
    loading = api('GET', '/api/potlucks')
      .then(function (data) { loaded = true; render(data); })
      .catch(function (err) {
        // A refresh that fails keeps what is on screen; only a first load
        // with nothing to show turns into the error state.
        if (loaded) showStatus(err);
        else { failed = true; show('error'); }
      })
      .then(function () {
        loading = null;
        if (again) { again = false; return load(); }
      });
    return loading;
  }

  var planError = document.getElementById('plan-status');
  el.plan.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = el.plan.elements;
    if (!f.title.value.trim() || !f.date.value || !f.time.value) return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    // The planner's own day and time, sent as one moment.
    var startsAt = new Date(f.date.value + 'T' + f.time.value);
    api('POST', '/api/potlucks', { title: f.title.value, place: f.place.value, startsAt: startsAt.toISOString() })
      .then(function (made) {
        showStatus(null, planError);
        el.plan.reset();
        return load().then(function () {
          // Into the potluck just planned, in the planning screen's place:
          // Back from it goes to the potlucks, not to an empty form.
          nextMotion = 'push';
          window.location.replace('#/p/' + made.id);
        });
      })
      .catch(function (err) { showStatus(err, planError); });
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });
  document.getElementById('potluck-retry').addEventListener('click', function () {
    failed = false;
    paintPotluck();
    load();
  });

  // Other people sign up, react and chat too: whenever anybody changes
  // something, the potlucks are fetched again at once, and looked at every
  // minute regardless (public/live-updates.js). Not while someone is typing
  // or choosing a reaction: what changed then is fetched the moment they are
  // done, so a refresh never eats a half-written dish or message.
  function quiet() {
    var active = document.activeElement;
    var typing = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT') && (active.value || active.tagName === 'SELECT');
    return !typing && picking === null;
  }
  if (window.LiveUpdates) window.LiveUpdates.watch({ refresh: load, quiet: quiet });

  // The first screen, drawn: Homeroom keeps its opening cover up until then
  // (usernode.ready, the platform bridge), so the app appears in one step
  // rather than as loading shapes that then change. The cover lifts after a
  // few seconds regardless.
  showScreen(shown, 'none');
  var first = load();
  if (window.usernode && window.usernode.ready) window.usernode.ready(first);
  // Pulling the page down past its top reads everything again, with the
  // spinner a phone's own lists have, and bounces inside the app rather
  // than dragging Homeroom along with it.
  first.then(function () {
    if (window.unNative && window.unNative.attachPullToRefresh) window.unNative.attachPullToRefresh(window, function () { return load(); });
  });
})();
