// The feed screen. Talks to api.js; every request carries the platform
// token the frame was opened with, which is how the server knows who you are.
//
// Photos: the browser shrinks a picked photo (cameras make files far bigger
// than a feed needs, and storage takes at most 5 MB), uploads it with the
// bridge's usernode.uploadFile(), and posts only the URL that comes back.
// Outside Homeroom there is no bridge, so posting a photo says so instead.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it. Class names are whole literals so the Tailwind build
// can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var feed = document.getElementById('feed');
  var statusEl = document.getElementById('status');
  var form = document.getElementById('composer');
  var postBtn = document.getElementById('post-btn');
  var note = document.getElementById('composer-note');
  var photoInput = document.getElementById('photo-input');
  var preview = document.getElementById('photo-preview');
  var previewImg = preview.querySelector('img');
  var moreBtn = document.getElementById('more-btn');

  var MAX_SIDE = 1600;
  var picked = null; // the shrunk photo, as a Blob, until it is posted
  var oldest = null;

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

  function h(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function timeAgo(iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString();
  }

  // ── Picking and shrinking a photo ───────────────────────────────────

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error('Could not read that photo.'));
        }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that photo.')); };
      img.src = url;
    });
  }

  function clearPhoto() {
    picked = null;
    photoInput.value = '';
    preview.hidden = true;
    if (previewImg.src) URL.revokeObjectURL(previewImg.src);
    previewImg.removeAttribute('src');
  }

  photoInput.addEventListener('change', function () {
    var file = photoInput.files && photoInput.files[0];
    if (!file) return;
    shrink(file).then(function (blob) {
      picked = blob;
      previewImg.src = URL.createObjectURL(blob);
      preview.hidden = false;
      showError(null);
    }).catch(showError);
  });
  document.getElementById('photo-remove').addEventListener('click', clearPhoto);

  function upload(blob) {
    var bridge = window.usernode;
    if (!bridge || typeof bridge.uploadFile !== 'function') {
      return Promise.reject(new Error('Photos can be posted when this app is open in Homeroom.'));
    }
    var file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
    return bridge.uploadFile(file, { visibility: 'public' }).then(function (stored) { return stored.url; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var caption = form.elements.caption.value;
    if (!caption.trim() && !picked) return;
    postBtn.disabled = true;
    note.textContent = picked ? 'Uploading photo…' : 'Posting…';
    (picked ? upload(picked) : Promise.resolve(null))
      .then(function (imageUrl) { return api('POST', '/api/posts', { caption: caption, imageUrl: imageUrl }); })
      .then(function () { form.reset(); clearPhoto(); showError(null); return load(); })
      .catch(showError)
      .then(function () { postBtn.disabled = false; note.textContent = ''; });
  });

  // ── The feed ───────────────────────────────────────────────────────

  function postCard(post) {
    var card = h('article', 'rounded-2xl bg-white dark:bg-zinc-900 ring-1 ring-zinc-200 dark:ring-zinc-800 overflow-hidden');
    card.setAttribute('data-post', String(post.id));

    var head = h('div', 'flex items-center gap-3 px-4 pt-3 pb-2');
    head.appendChild(h('span', 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 text-sm font-semibold',
      post.by.charAt(0).toUpperCase()));
    var who = h('div', 'min-w-0 flex-1');
    who.appendChild(h('p', 'text-[15px] font-semibold leading-5 truncate', '@' + post.by));
    who.appendChild(h('p', 'text-[13px] text-zinc-500 dark:text-zinc-400', timeAgo(post.at)));
    head.appendChild(who);
    card.appendChild(head);

    if (post.imageUrl) {
      var img = h('img', 'w-full max-h-[480px] object-cover bg-zinc-100 dark:bg-zinc-800');
      img.loading = 'lazy';
      img.alt = post.caption ? 'Photo: ' + post.caption.slice(0, 80) : 'Photo from @' + post.by;
      img.src = post.imageUrl;
      card.appendChild(img);
    }
    if (post.caption) {
      card.appendChild(h('p', 'px-4 pt-3 text-[15px] leading-6 whitespace-pre-line break-words', post.caption));
    }

    var actions = h('div', 'flex items-center gap-1 px-2 py-2');
    var like = h('button', post.liked
      ? 'rounded-full px-3 py-1.5 text-[14px] font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10'
      : 'rounded-full px-3 py-1.5 text-[14px] font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800',
    (post.liked ? '♥ ' : '♡ ') + (post.likes ? post.likes + (post.likes === 1 ? ' like' : ' likes') : 'Like'));
    like.type = 'button';
    like.setAttribute('aria-pressed', post.liked ? 'true' : 'false');
    like.addEventListener('click', function () {
      api('POST', '/api/posts/' + post.id + '/like').then(load).catch(showError);
    });
    actions.appendChild(like);
    actions.appendChild(h('span', 'flex-1'));

    if (post.mine) {
      var del = h('button', 'rounded-full px-3 py-1.5 text-[13px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-red-600', 'Delete');
      del.type = 'button';
      del.addEventListener('click', function () {
        if (window.confirm('Delete this post?')) api('DELETE', '/api/posts/' + post.id).then(load).catch(showError);
      });
      actions.appendChild(del);
    } else {
      var report = h('button', 'rounded-full px-3 py-1.5 text-[13px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 disabled:opacity-60',
        post.reported ? 'Reported' : 'Report');
      report.type = 'button';
      report.disabled = post.reported;
      report.addEventListener('click', function () {
        if (!window.confirm('Report this post? Posts several people report are hidden.')) return;
        api('POST', '/api/posts/' + post.id + '/report').then(load).catch(showError);
      });
      actions.appendChild(report);
    }
    card.appendChild(actions);
    return card;
  }

  function render(posts, append) {
    if (!append) feed.textContent = '';
    if (!append && !posts.length) {
      feed.appendChild(h('p', 'text-sm text-zinc-500 dark:text-zinc-400 text-center py-8', 'No posts yet. Be the first.'));
      return;
    }
    posts.forEach(function (p) { feed.appendChild(postCard(p)); });
    if (posts.length) oldest = posts[posts.length - 1].id;
  }

  function load() {
    return api('GET', '/api/posts').then(function (data) {
      render(data.posts, false);
      moreBtn.hidden = !data.more;
    }).catch(showError);
  }

  moreBtn.addEventListener('click', function () {
    api('GET', '/api/posts?before=' + oldest).then(function (data) {
      render(data.posts, true);
      moreBtn.hidden = !data.more;
    }).catch(showError);
  });

  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  load();
})();
