// The lists screen. Talks to api.js; every request carries the platform
// token the frame was opened with, which is how the server knows who you are.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so a task called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var listsEl = document.getElementById('lists');
  var statusEl = document.getElementById('status');
  var form = document.getElementById('new-list-form');

  function api(method, url, body) {
    var headers = { 'x-usernode-token': token };
    // A preview opened at a chosen moment tells the server what time it is
    // there (req.now; "Time-dependent features" in the platform conventions).
    if (window.usernode && window.usernode.previewNow) headers['x-usernode-now'] = window.usernode.now().toISOString();
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ').');
          return data;
        });
      });
  }

  function showError(err) {
    statusEl.textContent = err ? err.message : '';
    statusEl.hidden = !err;
  }

  /** A tiny element builder: h('p', 'text-sm', 'Hello'). */
  function h(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function act(promise) {
    return promise.then(function () { showError(null); return load(); }).catch(showError);
  }

  function taskRow(task) {
    var row = h('li', 'flex items-start gap-3 px-4 py-3');
    row.setAttribute('data-task', String(task.id));

    var box = h('input', 'mt-1 h-5 w-5 shrink-0 accent-violet-600');
    box.type = 'checkbox';
    box.checked = task.done;
    box.setAttribute('aria-label', (task.done ? 'Mark not done: ' : 'Mark done: ') + task.text);
    box.addEventListener('change', function () {
      act(api('POST', '/api/tasks/' + task.id + '/done', { done: box.checked }));
    });
    row.appendChild(box);

    var body = h('div', 'min-w-0 flex-1');
    body.appendChild(h('p', task.done
      ? 'text-[15px] leading-5 line-through text-zinc-400 dark:text-zinc-500 break-words'
      : 'text-[15px] leading-5 break-words', task.text));
    var who = task.done
      ? 'Done by @' + task.doneBy
      : task.claimedByMe ? 'You are on it'
        : task.claimedBy ? '@' + task.claimedBy + ' is on it'
          : 'Added by @' + task.by;
    body.appendChild(h('p', 'text-[13px] text-zinc-500 dark:text-zinc-400', who));
    row.appendChild(body);

    if (!task.done && (!task.claimedBy || task.claimedByMe)) {
      var claim = h('button', task.claimedByMe
        ? 'shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-[13px] font-semibold px-3 py-1'
        : 'shrink-0 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-[13px] font-semibold px-3 py-1',
      task.claimedByMe ? 'Let go' : 'I\'ll do it');
      claim.type = 'button';
      claim.addEventListener('click', function () { act(api('POST', '/api/tasks/' + task.id + '/claim')); });
      row.appendChild(claim);
    }
    if (task.canRemove) {
      var remove = h('button', 'shrink-0 h-7 w-7 rounded-full text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + task.text);
      remove.addEventListener('click', function () { act(api('DELETE', '/api/tasks/' + task.id)); });
      row.appendChild(remove);
    }
    return row;
  }

  function listCard(list) {
    var card = h('article', 'rounded-2xl bg-white dark:bg-zinc-900 ring-1 ring-zinc-200 dark:ring-zinc-800 overflow-hidden');
    card.setAttribute('data-list', String(list.id));

    var head = h('div', 'flex items-start gap-2 px-4 pt-4 pb-2');
    var titles = h('div', 'min-w-0 flex-1');
    titles.appendChild(h('h2', 'text-[17px] font-semibold leading-6 break-words', list.title));
    var done = list.tasks.filter(function (t) { return t.done; }).length;
    titles.appendChild(h('p', 'text-[13px] text-zinc-500 dark:text-zinc-400',
      (list.tasks.length ? done + ' of ' + list.tasks.length + ' done' : 'No tasks yet') + ' · by @' + list.by));
    head.appendChild(titles);
    if (list.mine) {
      var del = h('button', 'shrink-0 text-[13px] font-medium text-zinc-500 hover:text-red-600 dark:text-zinc-400 px-2 py-1', 'Remove');
      del.type = 'button';
      del.addEventListener('click', function () {
        if (window.confirm('Remove "' + list.title + '" and its tasks?')) act(api('DELETE', '/api/lists/' + list.id));
      });
      head.appendChild(del);
    }
    card.appendChild(head);

    if (list.tasks.length) {
      var ul = h('ul', 'divide-y divide-zinc-100 dark:divide-zinc-800 border-t border-zinc-100 dark:border-zinc-800');
      list.tasks.forEach(function (t) { ul.appendChild(taskRow(t)); });
      card.appendChild(ul);
    }

    var add = h('form', 'flex gap-2 px-4 py-3 border-t border-zinc-100 dark:border-zinc-800');
    var input = h('input', 'flex-1 min-w-0 bg-transparent text-[15px] placeholder:text-zinc-400 focus:outline-none');
    input.name = 'text';
    input.maxLength = 200;
    input.autocomplete = 'off';
    input.placeholder = 'Add a task';
    input.setAttribute('aria-label', 'Add a task to ' + list.title);
    add.appendChild(input);
    var addBtn = h('button', 'shrink-0 text-[15px] font-semibold text-violet-600 dark:text-violet-400', 'Add');
    addBtn.type = 'submit';
    add.appendChild(addBtn);
    add.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!input.value.trim()) return;
      act(api('POST', '/api/lists/' + list.id + '/tasks', { text: input.value }));
    });
    card.appendChild(add);
    return card;
  }

  function render(data) {
    listsEl.textContent = '';
    if (!data.lists.length) {
      listsEl.appendChild(h('p', 'text-sm text-zinc-500 dark:text-zinc-400 text-center py-8',
        'No lists yet. Start one above and invite people to add to it.'));
      return;
    }
    data.lists.forEach(function (l) { listsEl.appendChild(listCard(l)); });
  }

  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/lists')
      .then(render)
      .catch(showError)
      .then(function () { loading = null; });
    return loading;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var title = form.elements.title;
    if (!title.value.trim()) return;
    act(api('POST', '/api/lists', { title: title.value }).then(function () { form.reset(); }));
  });

  // Other people change the lists too: look again every 15 seconds while
  // the app is on screen, and straight away when it comes back. Skipped
  // while someone is typing, so a refresh never eats a half-written task.
  setInterval(function () {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.value;
    if (!document.hidden && !typing) load();
  }, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  load();
})();
