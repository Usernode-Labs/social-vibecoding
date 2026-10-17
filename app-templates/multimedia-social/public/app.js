/* A feed of posts: write, like, report, delete your own. Plain DOM. */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var headers = token ? { 'x-usernode-token': token } : {};
  var feed = document.getElementById('feed-posts');
  var empty = document.getElementById('feed-empty');
  var error = document.getElementById('feed-error');
  var composer = document.getElementById('composer');
  var caption = document.getElementById('composer-caption');
  var photo = document.getElementById('composer-photo');
  var photoName = document.getElementById('composer-photo-name');
  var postButton = document.getElementById('composer-post');
  var posts = [];
  var chosenPhoto = null;

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
    if (next) posts = next;
    feed.innerHTML = '';
    empty.classList.toggle('hidden', posts.length > 0);
    posts.forEach(function (post) { feed.appendChild(postCard(post)); });
  }

  function postCard(post) {
    var article = el('article', 'rounded-2xl bg-white dark:bg-zinc-900 ring-1 ring-zinc-200 dark:ring-zinc-800 overflow-hidden');
    article.setAttribute('data-post-id', String(post.id));

    var head = el('div', 'flex items-baseline gap-2 px-4 pt-4 pb-1');
    head.appendChild(el('p', 'min-w-0 flex-1 text-[15px] font-semibold', '@' + post.author));
    var when = new Date(post.createdAt);
    head.appendChild(el('p', 'shrink-0 text-[13px] text-zinc-500 dark:text-zinc-400',
      isNaN(when.getTime()) ? '' : when.toLocaleDateString()));
    article.appendChild(head);

    if (post.caption) {
      article.appendChild(el('p', 'px-4 pb-3 text-[15px] leading-6 whitespace-pre-wrap break-words', post.caption));
    }
    if (post.photoUrl) {
      var img = el('img', 'block w-full max-h-96 object-cover bg-zinc-100 dark:bg-zinc-800');
      img.src = post.photoUrl;
      img.alt = post.caption ? 'Photo: ' + post.caption.slice(0, 120) : 'Photo in this post';
      img.loading = 'lazy';
      article.appendChild(img);
    }

    var actions = el('div', 'flex items-center gap-2 px-4 py-3');
    var like = el('button', 'rounded-full px-3 py-1.5 text-[13px] font-semibold ring-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
      (post.likedByMe
        ? 'bg-accent-soft text-accent-ink ring-transparent dark:bg-accent-soft-dark dark:text-accent-soft-ink'
        : 'text-zinc-600 dark:text-zinc-300 ring-zinc-200 dark:ring-zinc-700'),
    (post.likedByMe ? 'Liked' : 'Like') + (post.likes ? ' · ' + post.likes : ''));
    like.type = 'button';
    like.disabled = !!post.likedByMe;
    like.setAttribute('aria-pressed', post.likedByMe ? 'true' : 'false');
    like.addEventListener('click', function () {
      request('POST', '/api/posts/' + post.id + '/like')
        .then(function (data) { render(data.posts); })
        .catch(function (err) { showError(err.message); });
    });
    actions.appendChild(like);

    var report = el('button', 'rounded-full px-3 py-1.5 text-[13px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent', 'Report');
    report.type = 'button';
    report.addEventListener('click', function () {
      if (!window.confirm('Report this post? Three different reports hide it.')) return;
      request('POST', '/api/posts/' + post.id + '/report')
        .then(function (data) { render(data.posts); })
        .catch(function (err) { showError(err.message); });
    });
    actions.appendChild(report);

    if (post.authorId) {
      var remove = el('button', 'ml-auto rounded-full px-3 py-1.5 text-[13px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-red-700 dark:hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent', 'Delete');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        if (!window.confirm('Delete your post?')) return;
        request('DELETE', '/api/posts/' + post.id)
          .then(function (data) { render(data.posts); })
          .catch(function (err) { showError(err.message); });
      });
      actions.appendChild(remove);
    }
    article.appendChild(actions);
    return article;
  }

  photo.addEventListener('change', function () {
    chosenPhoto = photo.files && photo.files[0] ? photo.files[0] : null;
    photoName.textContent = chosenPhoto ? chosenPhoto.name : '';
  });

  composer.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = caption.value.trim();
    if (!text && !chosenPhoto) return;
    showError('');
    postButton.disabled = true;
    postButton.textContent = 'Posting…';
    var stored = Promise.resolve(null);
    if (chosenPhoto) {
      if (!window.usernode || typeof window.usernode.uploadFile !== 'function') {
        postButton.disabled = false;
        postButton.textContent = 'Post';
        return showError('Photos are not available here. You can still post without one.');
      }
      stored = window.usernode.uploadFile(chosenPhoto, { visibility: 'public' });
    }
    stored.then(function (file) {
      return request('POST', '/api/posts', {
        caption: text,
        photoUrl: file ? file.url : '',
        photoId: file ? file.id : '',
      });
    }).then(function (data) {
      caption.value = '';
      photo.value = '';
      chosenPhoto = null;
      photoName.textContent = '';
      render(data.posts);
    }).catch(function (err) {
      showError(err.message || 'The photo could not be uploaded.');
    }).finally(function () {
      postButton.disabled = false;
      postButton.textContent = 'Post';
    });
  });

  request('GET', '/api/posts').then(function (data) {
    render(data.posts || []);
  }).catch(function (err) {
    showError(err.message + ' The feed could not be loaded.');
  });
})();
