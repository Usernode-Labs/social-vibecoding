(function () {
  /* ── Shared pieces ── */
  const ICONS = {
    chevL: '<path d="M15 5l-7 7 7 7"/>',
    chevR: '<path d="M9 5l7 7-7 7"/>',
    chevD: '<path d="M6 9l6 6 6-6"/>',
    tray: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
    bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8"/>',
    inbox: '<path d="M4 13l2.5-7h11L20 13v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z"/><path d="M4 13h4.5l1 2h5l1-2H20"/>',
    board: '<rect x="4" y="5" width="4" height="14" rx="1"/><rect x="10" y="5" width="4" height="9" rx="1"/><rect x="16" y="5" width="4" height="6" rx="1"/>',
    hash: '<path d="M9.5 4L7.5 20M16.5 4l-2 16M5 9h15M4 15h15"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    people: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="8.5" r="2.6"/><path d="M15.5 13.6A4.6 4.6 0 0 1 21 18"/>',
    home: '<path d="M4 11l8-7 8 7v8.5a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    chat: '<path d="M5 19l1.2-3.4A7.5 7.5 0 1 1 9.2 18.4z"/>',
    person: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>'
  };
  const ic = (name) => '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tile = (t, cls) => '<span class="' + (cls || 'tile') + '" style="background:' + t.bg + ';color:' + t.fg + '">' + esc(t.l) + '</span>';
  const status = () => '<div class="status"><span>9:41</span><i></i></div>';
  const bellMe = '<span class="icbtn" aria-hidden="true">' + ic('bell') + '</span><span class="me" aria-hidden="true">H</span>';
  const title = (text, cls) => '<span class="title' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>';
  const hdr = (sub, main) => '<span class="hdr-title"><small>' + esc(sub) + '</small><b>' + esc(main) + '</b></span>';
  // the community's name as the title, the page under it, small
  const hdrCommunity = (name, page) => '<span class="hdr-title"><b>' + esc(name) + '</b><small>' + esc(page) + '</small></span>';
  const backBtn = '<button type="button" class="icbtn disc" data-act="back" aria-label="Back">' + ic('chevL') + '</button>';

  const CHATS = [
    { id: 'bot', name: 'Homeroom bot', ai: true, t: { l: 'H', bg: '#111', fg: '#fff' }, sub: 'Builds what you ask for', preview: '1 needs you · 2 in progress', time: 'now', unread: 1, sect: 'agents',
      msgs: [['I wrote a plan for #5391. Tap Build it when you are happy with it.'], ['Looks good, build it', 1], ['Building now. I will tell you when it is ready to try.']] },
    { id: 'lukas', name: 'Lukas', t: { l: 'L', bg: '#4f7cac', fg: '#fff' }, sub: 'Direct message', preview: 'Sounds good, I will look tonight', time: '2h', sect: 'people',
      msgs: [['Can you look at the new Needs you cards?', 1], ['Sounds good, I will look tonight']] },
    { id: 'group', name: 'Lukas, snait', group: [{ l: 'L', bg: '#4f7cac' }, { l: 'S', bg: '#5b7a52' }], sub: '3 members', preview: 'snait: pushed the fix for the tray', time: 'Fri', sect: 'people',
      msgs: [['The tray snaps shut on iOS', 0, 'Lukas'], ['pushed the fix for the tray', 0, 'snait']] },
    { id: 'snait', name: 'snait', t: { l: 'S', bg: '#5b7a52', fg: '#fff' }, sub: 'Direct message', preview: 'in the notification bell with the badge', time: 'Oct 10', sect: 'people',
      msgs: [['Where did you see it?', 1], ['in the notification bell with the badge']] }
  ];
  const chatById = (id) => CHATS.find((c) => c.id === id);
  const UNREAD = CHATS.reduce((n, c) => n + (c.unread || 0), 0);

  const COMMUNITIES = [
    { id: 'homeroom', name: 'Homeroom', t: { l: 'H', bg: '#111', fg: '#fff' }, aud: 'public', meta: 'Public community · 262 members', votes: 6, recent: 1,
      topics: ['onboarding', 'homeroom-bot', 'proposal-pipeline', 'infra', 'project-workflows'],
      vote: 'Add SMS notification support for waitlist users', work: 'Homeroom bot is writing the plan for #5391', said: ['@scraido2', 'Have a good one and enjoy your weekend'] },
    { id: 'typeracer', name: 'Type Racer Battle', t: { l: 'T', bg: '#facc15', fg: '#1f2937' }, aud: 'public', meta: 'Public community · 13 members', votes: 5, recent: 2, topics: [],
      vote: 'Show each racer’s best time on the results screen', said: ['@kai', 'new record on the long passage'] },
    { id: 'gamecorner', name: 'Game Corner', t: { l: 'G', bg: '#312e81', fg: '#fff' }, aud: 'public', meta: 'Public community', votes: 0, recent: 3, topics: [], said: ['@ana', 'the new puzzle is hard'] },
    { id: 'bay', name: 'Bay Area Restaurants', t: { l: 'B', bg: '#f4f4f5', fg: '#111' }, aud: 'private', meta: 'Private community · 2 members', votes: 1, recent: 4, topics: [],
      vote: 'Add a filter for places open late', said: ['@sam', 'adding the new ramen place'] },
    { id: 'sands', name: 'Falling Sands Game', t: { l: 'F', bg: '#f97316', fg: '#fff' }, aud: 'public', meta: 'Public community · 8 members', votes: 0, recent: 5, topics: [], said: ['@mo', 'water and lava together is great'] },
    { id: 'studio', name: 'Homeroom Creative Studio', t: { l: 'C', bg: '#7c3aed', fg: '#fff' }, aud: 'private', meta: 'Private community · 7 members', votes: 0, recent: 6, topics: [], said: ['@lukas', 'first poster draft is up'] },
    { id: 'ear', name: 'Ear Trainer (test)', t: { l: 'E', bg: '#fde047', fg: '#1f2937' }, aud: 'private', meta: 'Private community · 3 members', votes: 0, topics: [], said: ['@evan', 'testing the interval drill'] },
    { id: 'todo', name: 'Todo List', t: { l: 'T', bg: '#2563eb', fg: '#fff' }, aud: 'public', meta: 'Public community', votes: 0, topics: [], said: ['@lee', 'shared lists work now'] },
    { id: 'gym', name: 'Gym Tracker', t: { l: 'G', bg: '#dc2626', fg: '#fff' }, aud: 'public', meta: 'Public community', votes: 0, topics: [], said: ['@jo', 'logged a new PR'] },
    { id: 'recipe', name: 'RecipeBot', t: { l: 'R', bg: '#ea580c', fg: '#fff' }, aud: 'public', meta: 'Public community', votes: 0, topics: [], said: ['@ria', 'try the miso soup'] },
    { id: 'supply', name: 'Supply Line', t: { l: 'S', bg: '#c2410c', fg: '#fff' }, aud: 'public', meta: 'Public community', votes: 0, topics: [], said: ['@dev', 'new map is up'] },
    { id: 'tier', name: 'Community Tier Lists', t: { l: 'C', bg: '#9333ea', fg: '#fff' }, aud: 'public', meta: 'Public community', votes: 0, topics: [], said: ['@kim', 'S tier is getting crowded'] },
    { id: 'mypage', name: 'MyPage', t: { l: 'M', bg: '#db2777', fg: '#fff' }, aud: 'public', meta: 'Public community', votes: 0, topics: [], said: ['@pat', 'added a links section'] }
  ];
  const byId = (id) => COMMUNITIES.find((c) => c.id === id);

  const LOOKS = {
    todo: ['#7cb4ff', '#2563eb', 'T'], homeroom: ['#3f3f46', '#0a0a0a', 'H'], gym: ['#fb7185', '#dc2626', 'G'],
    recipe: ['#fdba74', '#ea580c', 'R'], supply: ['#fbbf24', '#c2410c', 'S'], tier: ['#c4b5fd', '#7c3aed', 'C'],
    mypage: ['#f9a8d4', '#db2777', 'M'], gamecorner: ['#4f46e5', '#1e1b4b', 'G'], sheep: ['#fffbeb', '#fef3c7', 'S', '#2563eb'],
    snail: ['#27272a', '#0a0a0a', 'S', '#fde047'], pourover: ['#b45309', '#78350f', 'P'], bloom: ['#27272a', '#0a0a0a', 'B', '#4ade80'],
    patch: ['#fcd34d', '#d97706', 'P'], block: ['#c4b5fd', '#8b5cf6', 'b'],
  };
  const APPS = [
    { id: 'todo', name: 'Todo List' }, { id: 'homeroom', name: 'Homeroom' }, { id: 'gym', name: 'Gym Tracker' }, { id: 'recipe', name: 'RecipeBot' },
    { id: 'supply', name: 'Supply Line' }, { id: 'tier', name: 'Community Tier Lists' }, { id: 'mypage', name: 'MyPage' }, { id: 'gamecorner', name: 'Game Corner' },
  ];
  const DIRECTORY = [
    { id: 'gamecorner', name: 'Game Corner', users: 38, updated: '4d ago', pill: ['vote', '8 to vote'], joined: true, featured: true },
    { id: 'mypage', name: 'MyPage', users: 9, updated: '2d ago', pill: ['vote', '1 to vote'], joined: true, featured: true },
    { id: 'tier', name: 'Community Tier Lists', users: 8, updated: '8d ago', pill: ['vote', '2 to vote'], joined: true, featured: true },
    { id: 'recipe', name: 'RecipeBot', users: 15, updated: '9d ago', pill: ['vote', '14 to vote'], joined: true },
    { id: 'todo', name: 'Todo List', users: 10, updated: '9d ago', pill: ['issue', '2 issues'], joined: true },
    { id: 'sheep', name: 'Sheep countrr', users: 14, updated: '1h ago', pill: ['vote', '3 to vote'], joined: true, isNew: true },
    { id: 'snail', name: 'Snail Derby', users: 13, updated: '1d ago', pill: ['vote', '2 to vote'], joined: true },
    { id: 'pourover', name: 'Pourover Coffee', users: 11, updated: '1d ago', pill: ['issue', '23 issues'], joined: false },
    { id: 'bloom', name: 'BloomMoney', users: 11, updated: '20d ago', pill: ['invite', 'Invite-only build'], joined: false },
    { id: 'patch', name: 'Patch', users: 11, updated: '4d ago', pill: ['issue', '1 issue'], joined: false, isNew: true },
    { id: 'block', name: 'block-game', users: 10, updated: '5h ago', pill: ['vote', '3 to vote'], joined: true, isNew: true },
    { id: 'gym', name: 'Gym Tracker', users: 9, updated: '1d ago', pill: ['vote', '16 to vote'], joined: true },
  ];
  function appIcon(x, cls) {
    const [light, base, glyph, fg] = LOOKS[x.id] || ['#a1a1aa', '#52525b', x.name[0]];
    return '<span class="' + (cls || 'appicon') + '" style="background:linear-gradient(160deg,' + light + ',' + base + ');color:' + (fg || '#fff') + '">' + esc(glyph) + '</span>';
  }

  // Whether a community has a place: Hub, Needs you, Workshop and #general are in every one; topics vary.
  const hasPlace = (c, key) => !key.startsWith('ch:') || key === 'ch:general' || c.topics.includes(key.slice(3));
  function placeLabel(key) {
    if (key === 'hub') return 'Hub';
    if (key === 'needs') return 'Needs you';
    if (key === 'workshop') return 'Workshop';
    return '#' + key.slice(3);
  }
  // A community's places, in the sidebar's styling: Today's tray adds Switch community and leaves out the name.
  function placesHtml(c, here, today) {
    const page = (key, icon) => '<button type="button" class="place" data-place="' + key + '" aria-current="' + (here === key) + '">' + ic(icon) + '<span>' + placeLabel(key) + '</span>' +
      (key === 'needs' && c.votes ? '<span class="badge">' + c.votes + '</span>' : '') + '</button>';
    const chan = (name) => '<button type="button" class="place" data-place="ch:' + name + '" aria-current="' + (here === 'ch:' + name) + '">' + ic('hash') + '<span>' + name + '</span></button>';
    return (today ? '' : '<div class="who"><b>' + esc(c.name) + '</b><span>' + esc(c.meta) + '</span></div>') +
      page('hub', 'grid') + page('needs', 'inbox') + page('workshop', 'board') + '<hr>' +
      '<div class="sect">Channels</div>' + chan('general') +
      (c.topics.length ? '<div class="sect">Topics</div>' + c.topics.map(chan).join('') : '') +
      (today ? '<button type="button" class="place switch" data-act="sheet">' + ic('people') + '<span>Switch community</span></button>' : '');
  }
  // A place's page.
  function pageHtml(c, p) {
    if (p === 'hub') {
      return '<div class="hero">' + tile(c.t) + '<div><h3>' + esc(c.name) + '</h3><p>' + esc(c.meta) + '</p></div></div>' +
        '<div class="sect">For you</div><div class="card">' +
          '<button type="button" class="row" data-go="needs"><span class="tile" style="background:var(--lit-tint);color:var(--lit-ink)">' + ic('inbox') + '</span><span class="rt"><span class="rn">Needs you</span><span class="rp">' + esc(c.votes ? c.vote : 'Nothing waiting on you') + '</span></span>' + (c.votes ? '<span class="pill">' + c.votes + ' to vote</span>' : '') + '<span class="chev">' + ic('chevR') + '</span></button>' +
          '<button type="button" class="row" data-go="workshop"><span class="tile" style="background:var(--app-line);color:var(--app-ink)">' + ic('board') + '</span><span class="rt"><span class="rn">Your work</span><span class="rp">' + esc(c.work || 'No work in progress') + '</span></span><span class="chev">' + ic('chevR') + '</span></button>' +
          '<button type="button" class="row" data-go="ch:general"><span class="tile" style="background:var(--app-line);color:var(--app-ink)">' + ic('chat') + '</span><span class="rt"><span class="rn">#general</span><span class="rp">' + esc(c.said[0] + ': ' + c.said[1]) + '</span></span><span class="chev">' + ic('chevR') + '</span></button>' +
        '</div>';
    }
    if (p === 'needs') {
      if (!c.votes) return '<div class="card empty">Nothing in ' + esc(c.name) + ' is waiting on you.</div>';
      return '<div class="card deck"><span class="of">1 / ' + c.votes + ' · CHANGE · WAITING FOR YOUR APPROVAL</span><h4>' + esc(c.vote) + '</h4><p>0 of 1 approval · checks passed</p>' +
        '<div class="acts"><span class="act primary">Vote</span><span class="act">Ask</span><span class="act">Try it</span></div></div>';
    }
    if (p === 'workshop') {
      return '<div class="sect">What’s happening</div><div class="card">' +
        (c.work
          ? '<div class="row"><span class="tile" style="background:#111;color:#fff">H</span><span class="rt"><span class="rn">Remove the “Most open work is in” chips</span><span class="rp">Homeroom bot · Writing the plan</span></span></div>'
          : '<div class="empty">You have no work going on in ' + esc(c.name) + '.</div>') +
        '</div><div class="sect">What happened</div><div class="card"><div class="row"><span class="rt"><span class="rn">This week</span><span class="rp">Oct 12 → now</span></span><span class="pill">' + (c.id === 'homeroom' ? '365 live' : '3 live') + '</span></div></div>';
    }
    return '<div class="thead"><span class="tile" style="background:var(--app-line);color:var(--app-ink)">#</span><span class="rt"><span class="rn">#' + esc(p.slice(3)) + '</span><span class="rp">' + esc(c.name) + '</span></span></div>' +
      '<div class="bubbles"><div class="bub"><small>' + esc(c.said[0]) + '</small>' + esc(c.said[1]) + '</div><div class="bub mine">Thanks!</div></div>';
  }

  // Home and Discover, as the app draws them.
  function gridHtml(st) {
    const q = st.homeQ.trim().toLowerCase();
    const apps = APPS.filter((a) => !q || a.name.toLowerCase().includes(q));
    return apps.length ? apps.map((a) => '<button type="button" class="r1-app" data-app="' + a.id + '">' + appIcon(a) + '<span>' + esc(a.name) + '</span></button>').join('') : '<div class="empty">No apps match.</div>';
  }
  const challenge = (name, pts, progress, pct, icon) => '<div class="r1-chal"><span class="art">' + ic(icon) + '</span><span class="body"><span class="line"><b>' + esc(name) + '</b><span class="pts">' + esc(pts) + '</span></span>' +
    '<span class="prog"><i style="width:' + pct + '%"></i><span>' + esc(progress) + '</span></span></span></div>';
  function homeHtml(st) {
    return '<div class="r1-screen">' +
      '<label class="search">' + ic('search') + '<input data-role="homeq" type="search" placeholder="Search your apps…" autocomplete="off" value="' + esc(st.homeQ) + '"></label>' +
      '<div class="r1-h"><span>My apps</span></div>' +
      '<div class="r1-grid" data-role="grid">' + gridHtml(st) + '</div>' +
      '<div class="r1-row2"><button type="button" class="r1-link" data-stub="all-apps">Show all 21 apps</button><button type="button" class="r1-new" data-stub="new"><span class="dash">' + ic('plus') + '</span>New project</button></div>' +
      '<div class="r1-h"><span>Discover Communities</span><button type="button" class="r1-link" data-totab="discover">Browse all apps</button></div>' +
      '<button type="button" class="r1-empty-card" data-totab="discover"><span class="rt"><b>Nothing to discover right now</b><small>Browse the directory to find an app to try.</small></span><span class="chev">' + ic('chevR') + '</span></button>' +
      '<div class="r1-h"><span>Next challenges</span><button type="button" class="r1-link" data-stub="challenges">See all</button></div>' +
      challenge('Invite 3 people', 'Up to 750 pts', '2/3 joined', 66, 'people') + challenge('Connect X and GitHub', '500 pts', '1/2 connected', 50, 'grid') +
      '</div>';
  }
  const dirChips = (st) => [['all', 'All'], ['featured', 'Featured'], ['joined', 'Joined'], ['new', 'New']].map(([k, l]) =>
    '<button type="button" class="chip r1-chip" data-dirchip="' + k + '" aria-pressed="' + (st.dirFilter === k) + '">' + l + '</button>').join('');
  function dirList(st) {
    const q = st.dirQ.trim().toLowerCase();
    const keep = { all: () => true, featured: (d) => d.featured, joined: (d) => d.joined, new: (d) => d.isNew }[st.dirFilter];
    const rows = DIRECTORY.filter(keep).filter((d) => !q || d.name.toLowerCase().includes(q));
    if (!rows.length) return '<div class="empty">No apps match.</div>';
    return '<div class="sect">Not yet reviewed</div>' + rows.map((d) => '<button type="button" class="r1-drow" data-dir="' + d.id + '">' + appIcon(d) +
      '<span class="rt"><span class="rn">' + esc(d.name) + '</span><span class="rp">' + d.users + ' users · Updated ' + d.updated + '</span><span class="dpill ' + d.pill[0] + '">' + esc(d.pill[1]) + '</span></span>' +
      (d.joined ? '<span class="djoin">' + ic('check') + 'Joined</span>' : '<span class="djoin btn">' + ic('plus') + 'Join</span>') + '</button>').join('');
  }
  function dirHtml(st) {
    return '<div class="r1-screen">' +
      '<label class="search">' + ic('search') + '<input data-role="dirq" type="search" placeholder="Search all apps…" autocomplete="off" value="' + esc(st.dirQ) + '"></label>' +
      '<div class="chips r1-chips" data-role="dirchips">' + dirChips(st) + '</div>' +
      '<div class="r1-sort">Sort <span class="sel">Recommended ' + ic('chevD') + '</span></div>' +
      '<div class="r1-dir" data-role="dirlist">' + dirList(st) + '</div></div>';
  }

  // Messages: the list as cards (a page of its own), or as the sidebar (the drawer's left layer).
  function chatAvatar(c, mini) {
    if (c.group) return '<span class="faces' + (mini ? ' mini-faces' : '') + '">' + c.group.map((f) => '<span style="background:' + f.bg + '">' + f.l + '</span>').join('') + '</span>';
    return tile(c.t, mini ? 'tile mini' : 'tile');
  }
  const chatCardRow = (c) => '<button type="button" class="row" data-chat="' + c.id + '">' + chatAvatar(c) +
    '<span class="rt"><span class="rl"><span class="rn">' + esc(c.name) + '</span>' + (c.ai ? '<span class="ai">AI</span>' : '') + '<span class="rtime">' + c.time + '</span></span>' +
    '<span class="rl"><span class="rp">' + esc(c.preview) + '</span>' + (c.unread ? '<span class="badge">' + c.unread + '</span>' : '') + '</span></span></button>';
  const chatsAsCards = () => '<div class="sect">Agents</div><div class="card">' + CHATS.filter((c) => c.sect === 'agents').map(chatCardRow).join('') + '</div>' +
    '<div class="sect">Direct messages</div><div class="card">' + CHATS.filter((c) => c.sect === 'people').map(chatCardRow).join('') + '</div>';
  function chatsAsSidebar(current) {
    const row = (c) => '<button type="button" class="place r1-row" data-chat="' + c.id + '" aria-current="' + (c.id === current) + '">' + chatAvatar(c, true) +
      '<span class="two"><span>' + esc(c.name) + '</span><small>' + esc(c.preview) + '</small></span>' + (c.unread ? '<span class="badge">' + c.unread + '</span>' : '') + '</button>';
    return '<div class="places">' + '<div class="sect">Agents</div>' + CHATS.filter((c) => c.sect === 'agents').map(row).join('') +
      '<div class="sect">Direct messages</div>' + CHATS.filter((c) => c.sect === 'people').map(row).join('') + '</div>';
  }
  // A conversation. In phone 3's drawer the header names it, so the page leaves its own name out (noHead).
  const chatBodyHtml = (c, noHead) => (noHead ? '' : '<div class="thead">' + chatAvatar(c) + '<span class="rt"><span class="rl"><span class="rn">' + esc(c.name) + '</span>' + (c.ai ? '<span class="ai">AI</span>' : '') + '</span><span class="rp">' + esc(c.sub) + '</span></span></div>') +
    '<div class="bubbles">' + c.msgs.map(([text, mine, who]) => '<div class="bub' + (mine ? ' mine' : '') + '">' + (who ? '<small>' + esc(who) + '</small>' : '') + esc(text) + '</div>').join('') + '</div>';

  const youHtml = () => '<div class="hero"><span class="tile" style="background:#4f7cac;color:#fff;border-radius:50%">E</span><div><h3>evan</h3><p>Your account</p></div></div><div class="card">' +
    [['profile', 'person', 'Your profile'], ['work', 'board', 'Your work'], ['settings', 'grid', 'Settings']].map(([id, icon, label]) =>
      '<button type="button" class="row" data-stub="' + id + '"><span class="tile" style="background:var(--app-line);color:var(--app-ink)">' + ic(icon) + '</span><span class="rt"><span class="rn">' + label + '</span></span><span class="chev">' + ic('chevR') + '</span></button>').join('') + '</div>';

  // A generic page: an app, a directory entry, a conversation, or a placeholder.
  const STUBS = { new: 'New project', 'all-apps': 'All 21 apps', challenges: 'Challenges', profile: 'Your profile', work: 'Your work', settings: 'Settings' };
  function genericPageParts(pg) {
    if (pg.kind === 'app') {
      const a = APPS.find((x) => x.id === pg.id);
      const todos = [['Buy oat milk', 0], ['Book flights for December', 1], ['Call the plumber', 0], ['Send Lukas the notes', 1]];
      return { title: a.name, body: '<div class="r1-app-note">The app opens over Home. The chevron closes it.</div>' + (pg.id === 'todo'
        ? '<div class="card">' + todos.map(([text, done]) => '<div class="row"><span class="r1-check' + (done ? ' done' : '') + '">' + (done ? ic('check') : '') + '</span><span class="rt"><span class="rn">' + esc(text) + '</span></span></div>').join('') + '</div>'
        : '<div class="card empty">' + esc(a.name) + ' would run here, full screen.</div>') };
    }
    if (pg.kind === 'dir') {
      const d = DIRECTORY.find((x) => x.id === pg.id);
      return { title: d.name, body: '<div class="hero">' + appIcon(d, 'appicon big') + '<div><h3>' + esc(d.name) + '</h3><p>' + d.users + ' users · Updated ' + d.updated + '</p></div></div>' +
        '<span class="dpill ' + d.pill[0] + '">' + esc(d.pill[1]) + '</span>' +
        '<div class="acts">' + (d.joined ? '<span class="act primary">Open app</span><span class="act">Joined</span>' : '<span class="act primary">Join</span><span class="act">Open app</span>') + '</div>' };
    }
    if (pg.kind === 'chat') return { title: 'Messages', body: chatBodyHtml(chatById(pg.id)) };
    return { title: STUBS[pg.id] || 'Page', body: '<div class="card empty">' + esc(STUBS[pg.id] || 'This page') + ' opens here.</div>' };
  }

  // Your communities, as Stack's expanded rail: search, filters and the sectioned list.
  const FILTERS = [['all', 'All', () => true], ['votes', 'To vote', (c) => c.votes > 0], ['public', 'Public', (c) => c.aud === 'public'], ['private', 'Private', (c) => c.aud === 'private']];
  const communityRow = (c) => '<button type="button" class="row" data-res="' + c.id + '">' + tile(c.t) +
    '<span class="rt"><span class="rn">' + esc(c.name) + '</span><span class="rp">' + esc(c.meta) + '</span></span>' +
    (c.votes ? '<span class="pill">' + c.votes + ' to vote</span>' : '') + '<span class="chev">' + ic('chevR') + '</span></button>';
  const chipsHtml = (st) => FILTERS.map(([key, label, fn]) => '<button type="button" class="chip" data-filter="' + key + '" aria-pressed="' + (st.filter === key) + '">' + label + '<span>' + COMMUNITIES.filter(fn).length + '</span></button>').join('');
  function resultsHtml(st) {
    const q = st.q.trim().toLowerCase();
    const list = COMMUNITIES.filter(FILTERS.find((f) => f[0] === st.filter)[2]);
    if (q) {
      const found = list.filter((c) => c.name.toLowerCase().includes(q));
      const channels = [];
      list.forEach((c) => ['general'].concat(c.topics).forEach((name) => { if (name.includes(q)) channels.push([c, name]); }));
      let html = '';
      if (found.length) html += '<div class="sect">Communities</div><div class="card">' + found.map(communityRow).join('') + '</div>';
      if (channels.length) html += '<div class="sect">Channels and topics</div><div class="card">' + channels.slice(0, 8).map(([c, name]) =>
        '<button type="button" class="row" data-res="' + c.id + '" data-ch="' + name + '"><span class="tile" style="background:var(--app-line);color:var(--app-ink)">#</span>' +
        '<span class="rt"><span class="rn">#' + esc(name) + '</span><span class="rp">' + esc(c.name) + '</span></span><span class="chev">' + ic('chevR') + '</span></button>').join('') + '</div>';
      return (html || '<div class="card empty">None of your communities or their channels match “' + esc(st.q.trim()) + '”.</div>') +
        '<button type="button" class="discover">Look for “' + esc(st.q.trim()) + '” in Discover</button>';
    }
    const waiting = list.filter((c) => c.votes > 0).sort((a, b) => b.votes - a.votes);
    const rest = list.filter((c) => !c.votes).sort((a, b) => (a.recent || 99) - (b.recent || 99) || a.name.localeCompare(b.name));
    let html = '';
    if (waiting.length) html += '<div class="sect">Waiting on your vote</div><div class="card">' + waiting.map(communityRow).join('') + '</div>';
    if (rest.length) html += '<div class="sect">' + (waiting.length ? 'The rest, most recent first' : 'Most recent first') + '</div><div class="card">' + rest.map(communityRow).join('') + '</div>';
    return (html || '<div class="card empty">No communities here.</div>') + '<button type="button" class="discover">Find more communities in Discover</button>';
  }
  const browseHtml = (st) => '<div class="browse"><div class="browse-top">' +
    '<label class="search">' + ic('search') + '<input data-role="bq" type="search" placeholder="Search communities and channels" autocomplete="off" value="' + esc(st.q) + '"></label>' +
    '<div class="chips" data-role="bchips">' + chipsHtml(st) + '</div></div><div class="results" data-role="bresults">' + resultsHtml(st) + '</div></div>';

  // Stack (current): the rail, widened with names.
  function railHtml(cid) {
    let list = COMMUNITIES.filter((c) => c.recent).sort((a, b) => a.recent - b.recent);
    const picked = byId(cid);
    if (!list.includes(picked)) list = [picked].concat(list);
    return '<div class="stk-rail">' +
      '<button type="button" class="stk-item" data-act="browse"><span class="lead"><span class="all">' + ic('search') + '</span></span><span class="rt"><span class="rn">All your communities</span><span class="rp">Search, and what waits on your vote</span></span></button><hr>' +
      list.map((c) => communityItem(c, cid)).join('') + '</div>';
  }
  const communityItem = (c, cid) => '<button type="button" class="stk-item" data-pick="' + c.id + '" aria-current="' + (c.id === cid) + '"><span class="lead">' + tile(c.t) + (c.votes ? '<span class="badge">' + c.votes + '</span>' : '') + '</span>' +
    '<span class="rt"><span class="rn">' + esc(c.name) + '</span><span class="rp">' + esc(c.meta) + '</span></span></button>';

  // Stack with the changes: one outermost list of every community, its search at the top.
  function outerListHtml(st, cid) {
    const q = st.q.trim().toLowerCase();
    if (q) {
      const found = COMMUNITIES.filter((c) => c.name.toLowerCase().includes(q));
      const chans = [];
      COMMUNITIES.forEach((c) => ['general'].concat(c.topics).forEach((n) => { if (n.includes(q)) chans.push([c, n]); }));
      let h = '';
      if (found.length) h += '<div class="sect">Communities</div>' + found.map((c) => communityItem(c, cid)).join('');
      if (chans.length) h += '<div class="sect">Channels and topics</div>' + chans.slice(0, 8).map(([c, n]) => '<button type="button" class="stk-item" data-pick="' + c.id + '" data-ch="' + n + '">' +
        '<span class="lead"><span class="all">#</span></span><span class="rt"><span class="rn">#' + esc(n) + '</span><span class="rp">' + esc(c.name) + '</span></span></button>').join('');
      return h || '<div class="empty">Nothing matches “' + esc(st.q.trim()) + '”.</div>';
    }
    const waiting = COMMUNITIES.filter((c) => c.votes).sort((a, b) => b.votes - a.votes);
    const recent = COMMUNITIES.filter((c) => !c.votes && c.recent).sort((a, b) => a.recent - b.recent);
    const rest = COMMUNITIES.filter((c) => !c.votes && !c.recent).sort((a, b) => a.name.localeCompare(b.name));
    return '<div class="sect">Waiting on your vote</div>' + waiting.map((c) => communityItem(c, cid)).join('') +
      '<div class="sect">Recent</div>' + recent.map((c) => communityItem(c, cid)).join('') +
      '<div class="sect">More</div>' + rest.map((c) => communityItem(c, cid)).join('') +
      '<button type="button" class="discover">Find more communities in Discover</button>';
  }
  const outerHtml = (st, cid) => '<div class="outer"><div class="outer-top">' +
    '<label class="search">' + ic('search') + '<input data-role="oq" type="search" placeholder="Search communities and channels" autocomplete="off"></label>' +
    '<button type="button" class="ocancel" data-act="ocancel">Cancel</button></div>' +
    '<div class="outer-list" data-role="olist">' + outerListHtml(st, cid) + '</div></div>';

  // Swipe in from the left edge: back, or Today's tray.
  function edgeSwipe(el, onSwipe) {
    let start = null;
    el.addEventListener('pointerdown', (e) => {
      const r = el.getBoundingClientRect();
      start = e.clientX - r.left < 24 ? { x: e.clientX, y: e.clientY } : null;
    });
    el.addEventListener('pointerup', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = Math.abs(e.clientY - start.y);
      start = null;
      if (dx > 50 && dy < dx * 0.6) onSwipe();
    });
    el.addEventListener('pointercancel', () => { start = null; });
  }

  const TAB_TITLES = { home: 'Homeroom', discover: 'All apps', messages: 'Messages', workshop: 'Communities', you: 'You' };
  const STEP = 0.8; // each drawer layer's share of the screen

  /* ── One phone ── */
  // opts.communities: 'today' | 'stack' | 'next'; opts.messages: 'list' | 'drawer'; opts.drag: the pan follows a finger.
  function makePhone(root, opts) {
    const S = {
      tab: 'workshop',
      home: { page: null, homeQ: '' },
      discover: { page: null, dirQ: '', dirFilter: 'all' },
      you: { page: null },
      messages: { page: null, level: 0, chat: 'bot' },
      com: { cid: 'homeroom', place: 'workshop', level: 2, browsing: false, q: '', filter: 'all', tray: false, sheet: false },
    };
    const role = (r) => root.querySelector('[data-role="' + r + '"]');
    const todayCom = () => S.tab === 'workshop' && opts.communities === 'today';
    const drawerCom = () => S.tab === 'workshop' && opts.communities !== 'today';
    const drawerMsg = () => S.tab === 'messages' && opts.messages === 'drawer';
    const drawer = () => drawerCom() || drawerMsg();
    const level = () => (drawerCom() ? S.com.level : S.messages.level);
    // Where each level sits on the strip, in percent of the screen: the outermost layer's width can be set
    // (opts.outer), the places layer is 80%.
    const offsets = () => {
      const a = opts.outer || STEP * 100;
      return drawerCom() ? [0, a, a + STEP * 100] : [0, a];
    };
    const stripAttrs = () => (opts.outer ? ' var-strip" style="--w0:' + opts.outer + '%' : '');
    const maxLevel = () => (drawerCom() ? 2 : 1);
    let dragJustEnded = false;

    const topHtml = (brand) => '<div class="top' + (brand ? ' brand' : '') + '" data-role="top"><div class="hm-brand" data-role="hmb"></div>' + status() + '<div class="bar" data-role="bar"></div></div>';

    /* The header moving with the drawer (opts.headerMotion): one depth value f, from 0 (the outermost layer) to the
       deepest. A tap animates f over the pan's 300ms; a drag sets it from the finger. From f: the community colour
       blends in, the back arrow fades and slides in while the title moves over for it, a title that changes
       crossfades a short way in the pan's direction, and a title that stays (Homeroom, then Homeroom / Workshop)
       stays still while its small line fades in. Tab switches change the header at once. */
    const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let hmF = null;
    let hmRaf = 0;
    let P = null;
    function palette() {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      root.appendChild(probe);
      const read = (css) => { probe.style.color = ''; probe.style.color = css; const m = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] == null ? 1 : m[3]]; };
      const out = { ink: read('var(--app-ink)'), white: [255, 255, 255, 1], tint: read('var(--lit-tint)'), litInk: read('var(--lit-ink)'), soft: read('var(--brand-soft)') };
      probe.remove();
      return out;
    }
    const mix = (a, b, t) => 'rgba(' + [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)).join(',') + ',' + (a[3] + (b[3] - a[3]) * t).toFixed(3) + ')';
    function titleAt(lv) {
      // a conversation is named in the header: its name, and who it's with (or what the agent does) under it
      if (drawerMsg()) { if (lv === 0) return { main: 'Messages', sub: '' }; const ch = chatById(S.messages.chat); return { main: ch.name, sub: ch.sub }; }
      if (S.com.browsing || lv === 0) return { main: 'Communities', sub: '' };
      // on its places, the community alone; on a page, the page small under it
      const c = byId(S.com.cid);
      return lv === 1 ? { main: c.name, sub: '' } : { main: c.name, sub: placeLabel(S.com.place) };
    }
    function hmEnsure() {
      if (root.querySelector('.hm-back')) return;
      role('bar').innerHTML = '<button type="button" class="icbtn disc hm-back" data-act="back" aria-label="Back">' + ic('chevL') + '</button>' +
        '<div class="hm-titles" data-role="hmt"><span class="hm-t" data-role="ta"></span><span class="hm-t" data-role="tb"></span></div>' + bellMe;
      P = palette();
    }
    function setText(el, t) {
      const key = t.main + '|' + t.sub;
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.innerHTML = '<b>' + esc(t.main) + '</b><small>' + esc(t.sub) + '</small>';
    }
    function hmSet(f) {
      hmF = f;
      const move = RM ? 0 : 1;
      const b = Math.max(0, Math.min(1, f));
      const tint = drawerCom() && !S.com.browsing ? b : 0;
      role('hmb').style.opacity = tint;
      role('top').style.color = mix(P.ink, P.white, tint);
      const back = root.querySelector('.hm-back');
      back.style.opacity = b;
      // the arrow comes in from the right, with the drawer
      back.style.transform = 'translateX(' + (8 * (1 - b) * move) + 'px)';
      back.style.pointerEvents = b > 0.5 ? 'auto' : 'none';
      back.tabIndex = b > 0.5 ? 0 : -1;
      back.style.background = mix(P.tint, P.soft, tint);
      back.style.color = mix(P.litInk, P.white, tint);
      // The titles' box starts at the bar's left edge; a title sits 40px in when its level has an arrow. Every
      // movement goes the drawer's way: going in, the old title drifts left and the new one arrives from the right.
      role('hmt').style.transform = 'translateX(-40px)';
      const lo = Math.max(0, Math.min(maxLevel(), Math.floor(f)));
      const hi = Math.min(maxLevel(), lo + 1);
      const t = Math.max(0, Math.min(1, f - lo));
      const A = titleAt(lo), B = titleAt(hi);
      const xA = lo > 0 ? 40 : 0, xB = hi > 0 ? 40 : 0;
      const ta = role('ta'), tb = role('tb');
      if (A.main === B.main && xA === xB) {
        // The same name in the same place (a community's places, then one of its pages): the name stays, rising to
        // make room, and the page's name slides in under it the way the drawer goes, from the right; going back,
        // it slides back out to the right.
        const subOp = (A.sub ? 1 : 0) + ((B.sub ? 1 : 0) - (A.sub ? 1 : 0)) * t;
        setText(ta, { main: A.main, sub: B.sub || A.sub });
        ta.style.opacity = 1;
        ta.style.transform = 'translate(' + xA + 'px,' + 7 * (1 - subOp) + 'px)';
        const small = ta.querySelector('small');
        small.style.opacity = subOp * 0.78;
        // the name rises 7px as it makes room; the page's name cancels that, so it travels only sideways
        small.style.transform = 'translate(' + 24 * (1 - subOp) * move + 'px,' + -7 * (1 - subOp) + 'px)';
        tb.style.opacity = 0;
      } else {
        // A new title: going in, the old one drifts left as it fades and the new one arrives from the right into
        // its place; going back, the reverse. The same words moving over for the arrow fade out before they fade
        // back in, so they never show twice.
        const same = A.main === B.main;
        setText(ta, A);
        setText(tb, B);
        ta.style.opacity = same ? Math.max(0, 1 - 2 * t) : 1 - t;
        ta.style.transform = 'translate(' + (xA - 12 * t * move) + 'px,' + (A.sub ? 0 : 7) + 'px)';
        ta.querySelector('small').style.opacity = A.sub ? 0.78 : 0;
        ta.querySelector('small').style.transform = '';
        tb.style.opacity = same ? Math.max(0, 2 * t - 1) : t;
        tb.style.transform = 'translate(' + (xB + 24 * (1 - t) * move) + 'px,' + (B.sub ? 0 : 7) + 'px)';
        tb.querySelector('small').style.opacity = B.sub ? 0.78 : 0;
        tb.querySelector('small').style.transform = '';
      }
    }
    function hmAnimateTo(target) {
      cancelAnimationFrame(hmRaf);
      const from = hmF == null ? target : hmF;
      if (from === target) { hmSet(target); return; }
      const t0 = performance.now();
      const dur = RM ? 150 : 300;
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        hmSet(from + (target - from) * (1 - Math.pow(1 - k, 3)));
        if (k < 1) hmRaf = requestAnimationFrame(tick);
      };
      hmRaf = requestAnimationFrame(tick);
    }
    // the drawer's position, as a depth: 0 at the outermost layer, 1 at the next, and so on between
    function depthAt(px, w) {
      const p = -px / w * 100;
      const o = offsets();
      let k = 0;
      while (k < o.length - 2 && p > o[k + 1]) k++;
      return Math.max(0, Math.min(maxLevel(), k + (p - o[k]) / (o[k + 1] - o[k])));
    }
    function tabbarHtml() {
      const tabs = [['home', 'home', 'Home'], ['discover', 'search', 'Discover'], ['messages', 'chat', 'Messages'], ['workshop', 'people', 'Communities'], ['you', 'person', 'You']];
      return '<nav class="tabbar">' + tabs.map(([key, icon, label]) => '<button type="button" class="tab' + (S.tab === key ? ' lit' : '') + '" data-tab="' + key + '"' + (S.tab === key ? ' aria-current="page"' : '') + '>' +
        ic(icon) + label + (key === 'messages' && UNREAD ? '<span class="tab-badge">' + UNREAD + '</span>' : '') + '</button>').join('') + '</nav>';
    }

    /* the header: one bar, its words follow the tab and the level */
    function barHtml() {
      const c = byId(S.com.cid);
      if (todayCom()) {
        return '<button type="button" class="icbtn" data-act="tray" aria-label="Places">' + ic('tray') + '<span class="dot"></span></button>' + tile(c.t, 'ctile') +
          '<button type="button" class="today-name" data-act="sheet"><span>' + esc(c.name) + '</span>' + ic('chevD') + '</button>' +
          '<span class="placepill">' + esc(placeLabel(S.com.place)) + '</span><span style="flex:1"></span>' + bellMe;
      }
      if (drawerCom()) {
        if (S.com.browsing || S.com.level === 0) return title('Communities') + bellMe;
        if (S.com.level === 1) return backBtn + title(c.name) + bellMe;
        return backBtn + (opts.bigCommunity ? hdrCommunity(c.name, placeLabel(S.com.place)) : hdr(c.name, placeLabel(S.com.place))) + bellMe;
      }
      if (drawerMsg()) return (S.messages.level ? backBtn : '') + title('Messages') + bellMe;
      const pg = S[S.tab].page;
      if (!pg) return title(TAB_TITLES[S.tab], S.tab === 'home' ? 'wordmark' : '') + bellMe;
      return backBtn + title(genericPageParts(pg).title) + bellMe;
    }
    function paintBar(instant) {
      if (opts.headerMotion && drawer()) {
        hmEnsure();
        role('top').classList.remove('brand');
        const target = drawerCom() && S.com.browsing ? 0 : level();
        if (instant || hmF == null) { cancelAnimationFrame(hmRaf); hmSet(target); } else hmAnimateTo(target);
        return;
      }
      hmF = null;
      const brand = todayCom() || (drawerCom() && !S.com.browsing && S.com.level > 0);
      role('top').classList.toggle('brand', brand);
      role('bar').innerHTML = barHtml();
    }

    function render() {
      if (todayCom()) renderToday();
      else if (drawerCom()) renderComDrawer();
      else if (drawerMsg()) renderMsgDrawer();
      else renderGeneric();
    }

    /* Home, Discover, You, and Messages as a list: a page slides over the tab's list */
    function genericListHtml() {
      if (S.tab === 'home') return homeHtml(S.home);
      if (S.tab === 'discover') return dirHtml(S.discover);
      if (S.tab === 'messages') return chatsAsCards();
      return youHtml();
    }
    function renderGeneric() {
      root.innerHTML = topHtml(false) + '<div class="stage"><div class="view" data-role="list">' + genericListHtml() + '</div>' +
        '<div class="view" data-role="push" style="transform:translateX(104%)"></div></div>' + tabbarHtml();
      if (S[S.tab].page) showGeneric(false); else paintBar();
    }
    function slide(on, animate) {
      const list = role('list'), push = role('push');
      if (!animate) { list.style.transition = 'none'; push.style.transition = 'none'; }
      list.style.transform = on ? 'translateX(-30%)' : 'none';
      push.style.transform = on ? 'none' : 'translateX(104%)';
      if (!animate) { void push.offsetWidth; list.style.transition = ''; push.style.transition = ''; }
    }
    function showGeneric(animate) {
      const push = role('push');
      push.innerHTML = genericPageParts(S[S.tab].page).body;
      push.scrollTop = 0;
      slide(true, animate);
      paintBar();
    }
    const openGeneric = (pg) => { S[S.tab].page = pg; showGeneric(true); };
    function backGeneric() {
      if (!S[S.tab].page) return;
      S[S.tab].page = null;
      slide(false, true);
      paintBar();
    }

    /* Today's Communities: the place's page, a tray over everything that snaps shut, the switcher sheet */
    function renderToday() {
      const c = byId(S.com.cid);
      root.innerHTML = topHtml(true) + '<div class="stage"><div class="view" data-role="tview">' + pageHtml(c, S.com.place) + '</div></div>' + tabbarHtml() +
        '<div class="scrim" data-role="scrim" style="top:0"></div><aside class="tray today" data-role="tray" style="top:0;padding-top:40px"></aside><div class="sheet" data-role="sheet"></div>';
      paintBar();
    }
    function setTray(open) {
      S.com.tray = open;
      const tray = role('tray');
      if (open) tray.innerHTML = '<div class="places">' + placesHtml(byId(S.com.cid), S.com.place, true) + '</div>';
      tray.classList.toggle('open', open);
      role('scrim').classList.toggle('on', open || S.com.sheet);
    }
    function setSheet(open) {
      S.com.sheet = open;
      const sheet = role('sheet');
      if (open) {
        sheet.innerHTML = '<div class="grab"></div><h4>Your communities</h4><div class="card">' + COMMUNITIES.slice(0, 7).map((c) =>
          '<button type="button" class="row" data-sheetpick="' + c.id + '">' + tile(c.t) + '<span class="rt"><span class="rn">' + esc(c.name) + '</span><span class="rp">' + esc(c.meta) + '</span></span>' +
          (c.votes ? '<span class="pill">' + c.votes + ' to vote</span>' : '') + '</button>').join('') + '</div>';
      }
      sheet.classList.toggle('open', open);
      role('scrim').classList.toggle('on', open || S.com.tray);
    }
    function goToday(cid, place) {
      S.com.cid = cid; S.com.place = place;
      const v = role('tview');
      v.innerHTML = pageHtml(byId(cid), place);
      v.scrollTop = 0;
      paintBar();
    }

    /* the drawers: layers side by side on one strip; each sidebar layer is 80% wide */
    function renderComDrawer() {
      const c = byId(S.com.cid);
      const outer = opts.communities === 'stack' ? (S.com.browsing ? browseHtml(S.com) : railHtml(S.com.cid)) : outerHtml(S.com, S.com.cid);
      root.innerHTML = topHtml(false) + '<div class="stage"><div class="stk-strip' + (S.com.browsing ? ' browsing' : '') + stripAttrs() + '" data-role="strip">' +
        '<div class="stk-layer stk-l0' + (S.com.browsing ? ' expanded' : '') + '" data-i="0" data-role="l0">' + outer + '</div>' +
        '<div class="stk-layer stk-l1" data-i="1" data-role="l1"><div class="places">' + placesHtml(c, S.com.place) + '</div></div>' +
        '<div class="stk-layer stk-l2" data-i="2" data-role="l2"><div class="stk-page" data-role="page">' + pageHtml(c, S.com.place) + '</div></div>' +
        '</div></div>' + tabbarHtml();
      afterDrawer();
    }
    function renderMsgDrawer() {
      root.innerHTML = topHtml(false) + '<div class="stage"><div class="stk-strip' + stripAttrs() + '" data-role="strip">' +
        '<div class="stk-layer stk-l0 msg-l0" data-i="0" data-role="l0">' + chatsAsSidebar(S.messages.chat) + '</div>' +
        '<div class="stk-layer msg-l1" data-i="1" data-role="l1"><div class="stk-page" data-role="page">' + chatBodyHtml(chatById(S.messages.chat), opts.headerMotion) + '</div></div>' +
        '</div></div>' + tabbarHtml();
      afterDrawer();
    }
    function afterDrawer() {
      position(false);
      hmF = null;
      paintBar(true);
      if (opts.drag) enableDrag(role('strip'));
    }
    function position(animate) {
      const strip = role('strip');
      if (!animate) strip.style.transition = 'none';
      strip.style.transform = 'translateX(' + (-offsets()[level()]) + '%)';
      if (!animate) { void strip.offsetWidth; strip.style.transition = ''; }
      const browsing = drawerCom() && S.com.browsing;
      root.querySelectorAll('.stk-layer').forEach((el) => el.classList.toggle('peeking', !browsing && Number(el.dataset.i) === level() + 1));
    }
    function go(to) {
      to = Math.max(0, Math.min(maxLevel(), to));
      if (drawerCom()) {
        if (to < S.com.level) { if (to <= 1) paintPlaces(); if (to === 0) paintOuter(); }
        S.com.level = to;
      } else {
        if (to < S.messages.level) role('l0').innerHTML = chatsAsSidebar(S.messages.chat);
        S.messages.level = to;
      }
      position(true);
      paintBar();
    }
    const paintPlaces = () => { role('l1').innerHTML = '<div class="places">' + placesHtml(byId(S.com.cid), S.com.place) + '</div>'; };
    function paintOuter() {
      if (opts.communities === 'stack') role('l0').innerHTML = S.com.browsing ? browseHtml(S.com) : railHtml(S.com.cid);
      else role('olist').innerHTML = outerListHtml(S.com, S.com.cid);
    }
    function paintPage() {
      const el = role('page');
      el.innerHTML = pageHtml(byId(S.com.cid), S.com.place);
      el.scrollTop = 0;
    }
    // Stack (current): "All your communities" grows the rail; it is the outermost level, so it has no back.
    function setBrowsing(open) {
      S.com.browsing = open;
      role('strip').classList.toggle('browsing', open);
      if (open) { S.com.q = ''; S.com.filter = 'all'; }
      role('l0').innerHTML = open ? browseHtml(S.com) : railHtml(S.com.cid);
      position(false);
      paintBar();
    }
    // With the changes: the outermost list widens while you search, and Cancel or a pick narrows it.
    function setExpanded(open) {
      S.com.browsing = open;
      role('strip').classList.toggle('browsing', open);
      role('l0').classList.toggle('expanded', open);
      if (!open) {
        S.com.q = '';
        const input = role('oq');
        if (input) { input.value = ''; input.blur(); }
        role('olist').innerHTML = outerListHtml(S.com, S.com.cid);
      }
      position(false);
      paintBar();
    }
    function pickCommunity(cid, ch) {
      S.com.cid = cid;
      // keep the place you were on if this community has it too, or open its Hub
      if (ch) S.com.place = 'ch:' + ch;
      else if (!hasPlace(byId(cid), S.com.place)) S.com.place = 'hub';
      paintPage();
      if (opts.communities === 'stack' && S.com.browsing) setBrowsing(false);
      if (opts.communities === 'next' && S.com.browsing) setExpanded(false);
      paintPlaces();
      paintOuter();
      go(ch ? 2 : 1);
    }
    function back() {
      if (drawerCom()) {
        if (S.com.browsing) { if (opts.communities === 'next') setExpanded(false); return; }
        go(S.com.level - 1);
      } else if (drawerMsg()) go(S.messages.level - 1);
      else if (!todayCom()) backGeneric();
    }

    // The pan follows a finger: drag sideways, and let go past a quarter of a step to land on the next level.
    function enableDrag(strip) {
      let st = null;
      strip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || (drawerCom() && S.com.browsing)) return;
        st = { x: e.clientX, y: e.clientY, id: e.pointerId, drag: false, w: strip.clientWidth };
        st.base = -offsets()[level()] / 100 * st.w;
        st.min = -offsets()[maxLevel()] / 100 * st.w;
      });
      strip.addEventListener('pointermove', (e) => {
        if (!st || e.pointerId !== st.id) return;
        const dx = e.clientX - st.x, dy = e.clientY - st.y;
        if (!st.drag) {
          if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            st.drag = true;
            try { strip.setPointerCapture(e.pointerId); } catch (_) { /* not every pointer can be captured */ }
            strip.style.transition = 'none';
          } else return;
        }
        const x = Math.min(0, Math.max(st.min, st.base + dx));
        strip.style.transform = 'translateX(' + x + 'px)';
        if (opts.headerMotion) { cancelAnimationFrame(hmRaf); hmSet(depthAt(x, st.w)); }
      });
      const end = (e) => {
        if (!st) return;
        const s0 = st;
        st = null;
        if (!s0.drag) return;
        dragJustEnded = true;
        setTimeout(() => { dragJustEnded = false; }, 0);
        strip.style.transition = '';
        // where the strip was let go, in percent; a quarter of the way into the next layer is enough
        const dx = e.clientX - s0.x;
        const p = -Math.min(0, Math.max(s0.min, s0.base + dx)) / s0.w * 100;
        const o = offsets();
        let t = level();
        if (dx < 0) { while (t < maxLevel() && p > o[t] + 0.25 * (o[t + 1] - o[t])) t++; }
        else { while (t > 0 && p < o[t] - 0.25 * (o[t] - o[t - 1])) t--; }
        go(t);
      };
      strip.addEventListener('pointerup', end);
      strip.addEventListener('pointercancel', end);
    }

    /* presses */
    root.addEventListener('click', (e) => {
      if (dragJustEnded) { e.preventDefault(); e.stopPropagation(); dragJustEnded = false; return; }
      const at = (sel) => e.target.closest(sel);
      let el;
      if ((el = at('[data-tab]'))) {
        const key = el.dataset.tab;
        if (key !== S.tab) { S.tab = key; S.com.tray = false; S.com.sheet = false; render(); return; }
        // the current tab, tapped again: back to its list. In a drawer, all the way out, or (opts.retapOne)
        // one level at a time, with a widened search narrowed first.
        if (drawerCom()) {
          if (opts.retapOne) {
            if (S.com.browsing) { if (opts.communities === 'next') setExpanded(false); }
            else if (S.com.level > 0) go(S.com.level - 1);
          } else if (!S.com.browsing && S.com.level > 0) go(0);
        }
        else if (drawerMsg()) go(0);
        else if (!todayCom()) backGeneric();
        return;
      }
      if (at('[data-act="back"]')) { back(); return; }
      if (todayCom()) {
        if ((el = at('[data-place]'))) { goToday(S.com.cid, el.dataset.place); setTray(false); return; }
        if ((el = at('[data-sheetpick]'))) { goToday(el.dataset.sheetpick, 'hub'); setTray(false); setSheet(false); return; }
        if (at('[data-act="sheet"]')) { if (S.com.tray) setTray(false); setSheet(true); return; }
        if (at('[data-act="tray"]')) { setTray(!S.com.tray); return; }
        if ((el = at('[data-go]'))) { goToday(S.com.cid, el.dataset.go); return; }
        if (at('[data-role="scrim"]')) { setTray(false); setSheet(false); }
        return;
      }
      if (drawer()) {
        // a press on the layer peeking in from the right goes to it
        const layer = at('.stk-layer');
        if (layer && layer.classList.contains('peeking')) { go(Number(layer.dataset.i)); return; }
      }
      if (drawerMsg()) {
        if ((el = at('[data-chat]'))) {
          S.messages.chat = el.dataset.chat;
          role('page').innerHTML = chatBodyHtml(chatById(S.messages.chat), opts.headerMotion);
          role('l0').innerHTML = chatsAsSidebar(S.messages.chat);
          go(1);
        }
        return;
      }
      if (drawerCom()) {
        if (at('[data-act="browse"]')) { setBrowsing(true); return; }
        if (at('[data-act="ocancel"]')) { setExpanded(false); return; }
        if (at('.outer-top .search')) { if (!S.com.browsing && S.com.level === 0) setExpanded(true); return; }
        if ((el = at('[data-pick]'))) { pickCommunity(el.dataset.pick, el.dataset.ch); return; }
        if ((el = at('[data-res]'))) { pickCommunity(el.dataset.res, el.dataset.ch); return; }
        if ((el = at('[data-filter]'))) {
          S.com.filter = el.dataset.filter;
          role('bchips').innerHTML = chipsHtml(S.com);
          role('bresults').innerHTML = resultsHtml(S.com);
          return;
        }
        if ((el = at('[data-place]'))) { S.com.place = el.dataset.place; paintPage(); paintPlaces(); go(2); return; }
        if ((el = at('[data-go]'))) { S.com.place = el.dataset.go; paintPage(); paintPlaces(); paintBar(); }
        return;
      }
      // Home, Discover, Messages as a list, You
      if ((el = at('[data-app]'))) { openGeneric({ kind: 'app', id: el.dataset.app }); return; }
      if ((el = at('[data-totab]'))) { S.tab = el.dataset.totab; render(); return; }
      if ((el = at('[data-stub]'))) { openGeneric({ kind: 'stub', id: el.dataset.stub }); return; }
      if ((el = at('[data-dirchip]'))) {
        S.discover.dirFilter = el.dataset.dirchip;
        role('dirchips').innerHTML = dirChips(S.discover);
        role('dirlist').innerHTML = dirList(S.discover);
        return;
      }
      if ((el = at('[data-dir]'))) { openGeneric({ kind: 'dir', id: el.dataset.dir }); return; }
      if ((el = at('[data-chat]'))) openGeneric({ kind: 'chat', id: el.dataset.chat });
    });
    root.addEventListener('input', (e) => {
      const r = e.target.dataset.role;
      if (r === 'homeq') { S.home.homeQ = e.target.value; role('grid').innerHTML = gridHtml(S.home); }
      else if (r === 'dirq') { S.discover.dirQ = e.target.value; role('dirlist').innerHTML = dirList(S.discover); }
      else if (r === 'bq') { S.com.q = e.target.value; role('bresults').innerHTML = resultsHtml(S.com); }
      else if (r === 'oq') { S.com.q = e.target.value; role('olist').innerHTML = outerListHtml(S.com, S.com.cid); }
    });
    root.addEventListener('focusin', (e) => {
      if (e.target.dataset.role === 'oq' && drawerCom() && S.com.level === 0 && !S.com.browsing) setExpanded(true);
    });
    edgeSwipe(root, () => {
      if (todayCom()) { if (!S.com.tray && !S.com.sheet) setTray(true); return; }
      if (opts.drag && drawer()) return; // the drag already moves the drawer
      back();
    });
    render();
    return {
      // the outermost layer's width, in percent; a drawer on screen is redrawn at the new width
      setOuter(v) { opts.outer = v; if (drawer()) render(); },
    };
  }

  makePhone(document.getElementById('ph-today'), { communities: 'today', messages: 'list' });
  makePhone(document.getElementById('ph-stack'), { communities: 'stack', messages: 'list' });
  const next = makePhone(document.getElementById('ph-next'), { communities: 'next', messages: 'drawer', drag: true, outer: 85, retapOne: true, bigCommunity: true, headerMotion: true });
  document.querySelectorAll('[data-outer]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-outer]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    next.setOuter(Number(b.dataset.outer));
  }));
})();
