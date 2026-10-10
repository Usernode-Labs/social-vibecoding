/*
 * builder.js — the /builder.html page.
 *
 * A builder login (the password is a plain, hardcoded check; this is a
 * reference page for the build group, not an account system), behind which
 * sits an editable rooms and items reference for both games. Edits are kept
 * in this browser's localStorage, and the "Suggest a change" link in the top
 * bar hands proposed edits back to the Homeroom request flow.
 */
(() => {
  'use strict';

  const BUILDER_PASSWORD = 'Builder';
  const AUTH_KEY = 'builderAreaUnlocked';
  const DATA_KEY = 'builderReferenceDataV1';

  const GAMES = [
    { id: 'starways', name: 'Lost Starways' },
    { id: 'dracula', name: 'Escape from Dracula' },
  ];

  const ROOM_COLUMNS = [
    { key: 'name', label: 'Room', cls: 'b-cell-name' },
    { key: 'description', label: 'Description', cls: 'b-cell-wide' },
    { key: 'task', label: 'What needs doing', cls: 'b-cell-wide' },
    { key: 'exits', label: 'Exits', cls: 'b-cell-wide' },
  ];

  const ITEM_COLUMNS = [
    { key: 'name', label: 'Item', cls: 'b-cell-name' },
    { key: 'room', label: 'Room it is in', cls: '' },
    { key: 'why', label: 'Why needed', cls: 'b-cell-wide' },
    { key: 'effect', label: 'What it unlocks', cls: 'b-cell-wide' },
  ];

  const $ = (id) => document.getElementById(id);

  // ── The starter reference ───────────────────────────────────────────────

  function starterData() {
    return {
      starways: {
        rooms: [
          { name: 'Crash Site', description: 'The broken shuttle on a grey plain, wires still sparking.', task: 'Find a way inside the wreck and take stock of what survived.', exits: 'Ravine Trail (east), open plain (north)' },
          { name: 'Ravine Trail', description: 'A narrow ledge above a starlit gorge.', task: 'Climb down to the old probe wedged between the rocks.', exits: 'Crash Site (west), Kepler Outpost (south)' },
          { name: 'Kepler Outpost', description: 'A domed station, half buried in dust, its lights flickering.', task: 'Restore power so the airlock will open.', exits: 'Ravine Trail (north), The Drift (east), Starway Gate (south)' },
          { name: 'The Drift', description: 'An asteroid field crossed by a rope bridge of old tether line.', task: 'Cross the drift without losing the supply crate.', exits: 'Kepler Outpost (west), Old Observatory (east)' },
          { name: 'Old Observatory', description: 'A cracked dome with a telescope still pointed at the sky.', task: 'Read the star charts and work out the course home.', exits: 'The Drift (west), Starway Gate (south)' },
          { name: 'Starway Gate', description: 'The ancient ring gate, dormant, waiting for a key.', task: 'Power the gate and open the way home.', exits: 'Old Observatory (north), Kepler Outpost (west)' },
        ],
        items: [
          { name: 'Crew Keycard', room: 'Crash Site', why: 'The captain\'s card, still clipped to a suit.', effect: 'Opens the shuttle\'s locked locker.' },
          { name: 'Captain\'s Log', room: 'Crash Site', why: 'The captain\'s final entries, kept in the locked locker.', effect: 'Hints where the star chart fragments are kept.' },
          { name: 'Ring Spanner', room: 'Ravine Trail', why: 'A heavy tool from the old probe\'s kit.', effect: 'Repairs the outpost\'s broken conduit.' },
          { name: 'Power Cell', room: 'The Drift', why: 'A charged cell from the supply crate.', effect: 'Restores power at Kepler Outpost.' },
          { name: 'Star Chart Fragment', room: 'Old Observatory', why: 'A plate from the observatory\'s own charts.', effect: 'Sets the Starway Gate\'s destination.' },
        ],
      },
      dracula: {
        rooms: [
          { name: 'Village Inn', description: 'A warm room, low candles, and talk that keeps dropping to whispers.', task: 'Ask the innkeeper about the road to the castle.', exits: 'Forest Path (north)' },
          { name: 'Forest Path', description: 'A dark track between pines, the coach ruts still fresh.', task: 'Follow the coach tracks before the light goes.', exits: 'Village Inn (south), Chapel Steps (east)' },
          { name: 'Chapel Steps', description: 'A small stone chapel above the river bend.', task: 'Ask the priest for his blessing and something to read at the grave.', exits: 'Forest Path (west), Graveyard Gate (north)' },
          { name: 'Graveyard Gate', description: 'The old graveyard behind rusted iron railings.', task: 'Find the grave the rubbing names.', exits: 'Chapel Steps (south), Castle Road (east)' },
          { name: 'Castle Road', description: 'A cliff road climbing toward the pass.', task: 'Reach the castle before nightfall.', exits: 'Graveyard Gate (west), Castle Gate (north)' },
          { name: 'Castle Gate', description: 'The castle\'s great door, and no handle on the outside.', task: 'Find the way in.', exits: 'Castle Road (south), Great Hall (in)' },
          { name: 'Great Hall', description: 'A long hall of banners and cold hearths.', task: 'Find where the count rests before dawn comes.', exits: 'Castle Gate (out)' },
        ],
        items: [
          { name: 'Lantern', room: 'Village Inn', why: 'The innkeeper\'s lantern, lent for the road.', effect: 'Lights the forest path and the graveyard.' },
          { name: 'Coach Ticket', room: 'Village Inn', why: 'A passage ticket on the night coach.', effect: 'Lets you ride the coach up to the castle road.' },
          { name: 'Old Prayer Book', room: 'Chapel Steps', why: 'The priest\'s own book, thin and worn.', effect: 'Holds the words that hold the crypt door shut.' },
          { name: 'Iron Key', room: 'Graveyard Gate', why: 'The crypt key, buried with the old sexton.', effect: 'Opens the crypt below the ruined chapel.' },
          { name: 'Grave Rubbing', room: 'Graveyard Gate', why: 'A paper rubbing taken from the count\'s stone.', effect: 'Names the family crypt the way in hides in.' },
          { name: 'Silver Locket', room: 'Great Hall', why: 'A locket with a portrait, left out on the long table.', effect: 'Shows the name the grave rubbing lost.' },
        ],
      },
    };
  }

  // ── Storage ─────────────────────────────────────────────────────────────

  function loadData() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (!raw) return starterData();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return starterData();
      for (const g of GAMES) {
        const side = parsed[g.id];
        if (!side || !Array.isArray(side.rooms) || !Array.isArray(side.items)) return starterData();
      }
      return parsed;
    } catch (err) {
      return starterData();
    }
  }

  function saveData() {
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      setSaveState('Could not save in this browser');
      return false;
    }
  }

  let data = loadData();
  let game = GAMES[0].id;
  let saveTimer = null;

  function setSaveState(text) {
    $('builder-save-state').textContent = text;
  }

  function markDirty() {
    setSaveState('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (saveData()) setSaveState('Saved');
    }, 900);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (saveData()) setSaveState('Saved');
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  function renderTabs() {
    const host = $('builder-tabs');
    host.textContent = '';
    for (const g of GAMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'b-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', g.id === game ? 'true' : 'false');
      b.textContent = g.name;
      b.addEventListener('click', () => {
        game = g.id;
        renderTabs();
        renderTables();
      });
      host.appendChild(b);
    }
  }

  function buildTable(host, columns, rows, kind, emptyText) {
    host.textContent = '';
    const table = document.createElement('table');

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const col of columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = col.label;
      headRow.appendChild(th);
    }
    const thAction = document.createElement('th');
    thAction.scope = 'col';
    thAction.textContent = '';
    headRow.appendChild(thAction);
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns.length + 1;
      td.className = 'b-table-empty';
      td.textContent = emptyText;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    rows.forEach((row, index) => {
      const tr = document.createElement('tr');
      for (const col of columns) {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'b-cell ' + (col.cls || '');
        input.value = row[col.key] || '';
        input.setAttribute('aria-label', col.label + ' for ' + (row.name || 'row ' + (index + 1)));
        input.addEventListener('input', () => {
          row[col.key] = input.value;
          markDirty();
        });
        td.appendChild(input);
        tr.appendChild(td);
      }
      const tdAction = document.createElement('td');
      tdAction.className = 'b-cell-action';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'b-row-delete';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete ' + (row.name || 'row ' + (index + 1)));
      del.addEventListener('click', () => {
        const label = row.name || 'this ' + kind;
        if (!window.confirm('Delete ' + label + '? This cannot be undone.')) return;
        rows.splice(index, 1);
        saveNow();
        renderTables();
      });
      tdAction.appendChild(del);
      tr.appendChild(tdAction);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }

  function renderTables() {
    const side = data[game];
    buildTable(
      $('builder-rooms'), ROOM_COLUMNS, side.rooms, 'room',
      'No rooms yet for this game. Add one below.'
    );
    buildTable(
      $('builder-items'), ITEM_COLUMNS, side.items, 'item',
      'No items yet for this game. Add one below.'
    );
  }

  function render() {
    renderTabs();
    renderTables();
  }

  function focusNewRow(host) {
    const first = host.querySelector('tbody tr:last-child input');
    if (first) first.focus();
  }

  // ── Gate and area ───────────────────────────────────────────────────────

  function unlockArea() {
    $('builder-gate').hidden = true;
    $('builder-area').hidden = false;
    render();
    setSaveState('');
  }

  function isUnlocked() {
    try {
      return localStorage.getItem(AUTH_KEY) === 'yes';
    } catch (err) {
      return false;
    }
  }

  function wireGate() {
    $('builder-login-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const field = $('builder-password');
      if (field.value === BUILDER_PASSWORD) {
        try { localStorage.setItem(AUTH_KEY, 'yes'); } catch (err) { /* stay unlocked for this page view */ }
        unlockArea();
        return;
      }
      $('builder-gate-error').hidden = false;
      field.value = '';
      field.focus();
    });
  }

  function wireArea() {
    $('builder-save').addEventListener('click', saveNow);

    $('builder-add-room').addEventListener('click', () => {
      data[game].rooms.push({ name: 'New room', description: '', task: '', exits: '' });
      saveNow();
      renderTables();
      focusNewRow($('builder-rooms'));
    });

    $('builder-add-item').addEventListener('click', () => {
      data[game].items.push({ name: 'New item', room: '', why: '', effect: '' });
      saveNow();
      renderTables();
      focusNewRow($('builder-items'));
    });

    $('builder-reset').addEventListener('click', () => {
      if (!window.confirm('Replace your edits with the starter reference?')) return;
      data = starterData();
      saveNow();
      render();
    });

    $('builder-leave').addEventListener('click', () => {
      try { localStorage.removeItem(AUTH_KEY); } catch (err) { /* nothing to undo */ }
      window.location.reload();
    });
  }

  wireGate();
  wireArea();
  if (isUnlocked()) unlockArea();
})();
