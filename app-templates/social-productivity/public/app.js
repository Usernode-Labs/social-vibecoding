/* Star a list, add a task, claim it, tick it off. Plain DOM: no framework. */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var headers = token ? { 'x-usernode-token': token } : {};
  var board = document.getElementById('lists-board');
  var empty = document.getElementById('lists-empty');
  var error = document.getElementById('board-error');
  var form = document.getElementById('new-list-form');
  var input = document.getElementById('new-list-title');
  var lists = [];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function showError(text) {
    error.textContent = text || '';
    error.classList.toggle('hidden', !text);
  }

  function request(method, url, body) {
    return fetch(url, {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'That did not work. Try again.');
        return data;
      });
    });
  }

  function render(next) {
    if (next) lists = next;
    board.innerHTML = '';
    empty.classList.toggle('hidden', lists.length > 0);
    lists.forEach(function (list) {
      board.appendChild(listCard(list));
    });
  }

  function listCard(list) {
    var article = el('article', 'rounded-2xl bg-white dark:bg-zinc-900 ring-1 ring-zinc-200 dark:ring-zinc-800 overflow-hidden');
    var head = el('div', 'flex items-start gap-2 px-4 pt-4 pb-2');
    var titleBox = el('div', 'min-w-0 flex-1');
    titleBox.appendChild(el('h2', 'text-[17px] font-semibold leading-6', list.title));
    var done = list.tasks.filter(function (t) { return t.done; }).length;
    titleBox.appendChild(el('p', 'text-[13px] text-zinc-500 dark:text-zinc-400',
      done + ' of ' + list.tasks.length + ' done · by @' + list.createdByUsername));
    head.appendChild(titleBox);
    var removeList = el('button', 'shrink-0 text-[13px] font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 px-2 py-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent', 'Remove');
    removeList.type = 'button';
    removeList.addEventListener('click', function () {
      if (!window.confirm('Remove this list and its tasks?')) return;
      request('DELETE', '/api/lists/' + list.id).then(function (data) { render(data.lists); }).catch(function (err) { showError(err.message); });
    });
    head.appendChild(removeList);
    article.appendChild(head);

    var ul = el('ul', 'divide-y divide-zinc-100 dark:divide-zinc-800 border-t border-zinc-100 dark:border-zinc-800');
    list.tasks.forEach(function (task) { ul.appendChild(taskRow(task)); });
    article.appendChild(ul);

    var taskForm = el('form', 'flex gap-2 px-4 py-3 border-t border-zinc-100 dark:border-zinc-800');
    var taskInput = el('input', 'flex-1 min-w-0 bg-transparent text-[15px] placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none');
    taskInput.type = 'text';
    taskInput.maxLength = 160;
    taskInput.placeholder = 'Add a task';
    taskInput.setAttribute('aria-label', 'Add a task to ' + list.title);
    var addTask = el('button', 'shrink-0 text-[15px] font-semibold text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded', 'Add');
    addTask.type = 'submit';
    taskForm.appendChild(taskInput);
    taskForm.appendChild(addTask);
    taskForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var title = taskInput.value.trim();
      if (!title) return;
      request('POST', '/api/lists/' + list.id + '/tasks', { title: title })
        .then(function (data) { render(data.lists); })
        .catch(function (err) { showError(err.message); });
    });
    article.appendChild(taskForm);
    return article;
  }

  function taskRow(task) {
    var li = el('li', 'flex items-start gap-3 px-4 py-3');
    var box = el('input', 'mt-1 h-5 w-5 shrink-0 accent-accent');
    box.type = 'checkbox';
    box.checked = !!task.done;
    box.setAttribute('aria-label', (task.done ? 'Mark not done: ' : 'Mark done: ') + task.title);
    box.addEventListener('change', function () {
      request('POST', '/api/tasks/' + task.id + '/done', { done: box.checked })
        .then(function (data) { render(data.lists); })
        .catch(function (err) { showError(err.message); });
    });
    li.appendChild(box);

    var text = el('div', 'min-w-0 flex-1');
    text.appendChild(el('p', task.done
      ? 'text-[15px] leading-5 line-through text-zinc-400 dark:text-zinc-500'
      : 'text-[15px] leading-5', task.title));
    var note = task.done && task.doneByUsername
      ? 'Done by @' + task.doneByUsername
      : task.claimedByUsername ? '@' + task.claimedByUsername + ' is on it' : 'Added by @' + task.createdByUsername;
    text.appendChild(el('p', 'text-[13px] text-zinc-500 dark:text-zinc-400', note));
    li.appendChild(text);

    if (!task.done && !task.claimedByUsername) {
      var claim = el('button', 'shrink-0 rounded-full bg-accent text-white text-[13px] font-semibold px-3 py-1 hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent', "I'll do it");
      claim.type = 'button';
      claim.addEventListener('click', function () {
        request('POST', '/api/tasks/' + task.id + '/claim')
          .then(function (data) { render(data.lists); })
          .catch(function (err) { showError(err.message); });
      });
      li.appendChild(claim);
    } else {
      var remove = el('button', 'shrink-0 h-7 w-7 rounded-full text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + task.title);
      remove.addEventListener('click', function () {
        request('DELETE', '/api/tasks/' + task.id)
          .then(function (data) { render(data.lists); })
          .catch(function (err) { showError(err.message); });
      });
      li.appendChild(remove);
    }
    return li;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var title = input.value.trim();
    if (!title) return;
    showError('');
    request('POST', '/api/lists', { title: title }).then(function (data) {
      input.value = '';
      render(data.lists);
    }).catch(function (err) { showError(err.message); });
  });

  request('GET', '/api/state').then(function (data) {
    render(data.lists || []);
  }).catch(function (err) {
    showError(err.message + ' The board could not be loaded.');
  });
})();
