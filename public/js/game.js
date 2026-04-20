// ── Config ────────────────────────────────────────────────────────────────────
const SERVER_URL = window.location.origin; // same origin when deployed

// ── State ─────────────────────────────────────────────────────────────────────
let socket;
let myId = null;
let myName = '';
let roomId = null;
let roomState = null; // full room object from server
let selectedCards = []; // card ids
let myIsHost = false;

// ── Suit symbols & color ──────────────────────────────────────────────────────
const SUIT_SYMBOL = { d: '♦', c: '♣', h: '♥', s: '♠' };
const SUIT_COLOR  = { d: 'red', c: 'black', h: 'red', s: 'black' };
const POS_EMOJI   = { king: '👑', minister: '🤵', peasant: '🧑', slave: '🔗' };
const POS_LABEL   = { king: 'Raja', minister: 'Menteri', peasant: 'Rakyat', slave: 'Budak' };

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Card Rendering ─────────────────────────────────────────────────────────────
function buildCard(card, opts = {}) {
  const { selectable = false, played = false } = opts;
  const color = SUIT_COLOR[card.suit];
  const sym   = SUIT_SYMBOL[card.suit];
  const isSelected = selectedCards.includes(card.id);

  const el = document.createElement('div');
  el.className = `card ${color}${played ? ' card-played' : ''}${isSelected ? ' selected' : ''}`;
  el.dataset.id = card.id;

  el.innerHTML = `
    <div class="card-rank">${card.rank}</div>
    <div class="card-suit">${sym}</div>
    <div class="card-center">${sym}</div>
    <div class="card-bottom"><div class="card-rank">${card.rank}</div><div class="card-suit">${sym}</div></div>
  `;

  if (selectable) {
    el.addEventListener('click', () => toggleCard(card.id));
  }
  return el;
}

function buildBackCard() {
  const el = document.createElement('div');
  el.className = 'card-back';
  el.textContent = '🂠';
  return el;
}

// ── Card Selection ─────────────────────────────────────────────────────────────
function toggleCard(cardId) {
  if (!roomState || roomState.currentTurn !== myId) return;
  const idx = selectedCards.indexOf(cardId);
  if (idx === -1) selectedCards.push(cardId);
  else selectedCards.splice(idx, 1);
  renderMyHand();
  updateActionBar();
}

function clearSelection() {
  selectedCards = [];
  renderMyHand();
  updateActionBar();
}

function updateActionBar() {
  const isMyTurn = roomState && roomState.currentTurn === myId;
  const hasSelection = selectedCards.length > 0;
  const hasLastPlay = roomState && roomState.lastPlay && roomState.lastPlay.length > 0;

  document.getElementById('btn-play').disabled = !isMyTurn || !hasSelection;
  document.getElementById('btn-pass').disabled = !isMyTurn || !hasLastPlay;

  if (isMyTurn) {
    document.getElementById('my-hand').classList.add('my-turn-glow');
  } else {
    document.getElementById('my-hand').classList.remove('my-turn-glow');
  }
}

// ── Render Functions ───────────────────────────────────────────────────────────
function renderMyHand() {
  if (!roomState) return;
  const hand = (roomState.hands && roomState.hands[myId]) || [];
  const el = document.getElementById('my-hand');
  el.innerHTML = '';
  hand.forEach(card => el.appendChild(buildCard(card, { selectable: true })));
}

function renderOpponents() {
  if (!roomState) return;
  const area = document.getElementById('opponents-area');
  area.innerHTML = '';

  const opponents = roomState.players.filter(p => p.id !== myId);
  opponents.forEach(p => {
    const count = (roomState.allHandCounts && roomState.allHandCounts[p.id]) || 0;
    const isActive = roomState.currentTurn === p.id;
    const badge = roomState.positions && roomState.positions[p.id]
      ? POS_EMOJI[roomState.positions[p.id]] + ' ' + POS_LABEL[roomState.positions[p.id]]
      : '';

    const block = document.createElement('div');
    block.className = `opponent-block${isActive ? ' active-turn' : ''}`;
    block.innerHTML = `
      <div class="opponent-name">${escHtml(p.name)}${isActive ? ' 🎯' : ''}</div>
      ${badge ? `<div class="opponent-badge">${badge}</div>` : ''}
    `;

    const handEl = document.createElement('div');
    handEl.className = 'opponent-hand';
    const show = Math.min(count, 13);
    for (let i = 0; i < show; i++) handEl.appendChild(buildBackCard());
    block.appendChild(handEl);

    const countEl = document.createElement('div');
    countEl.style.cssText = 'font-size:0.75rem;color:var(--text-dim);margin-top:2px;';
    countEl.textContent = count + ' kartu';
    block.appendChild(countEl);

    area.appendChild(block);
  });
}

function renderLastPlay() {
  if (!roomState) return;
  const area = document.getElementById('last-play-area');
  const info = document.getElementById('table-info');
  area.innerHTML = '';

  const lastPlay = roomState.lastPlay || [];
  if (lastPlay.length === 0) {
    info.textContent = 'Meja kosong — mainkan kartu pertama';
    return;
  }

  lastPlay.forEach(card => area.appendChild(buildCard(card, { played: true })));

  const playerName = roomState.players.find(p => p.id === roomState.lastPlayerId)?.name || '?';
  info.textContent = `${playerName} main`;
}

function renderMyInfo() {
  if (!roomState) return;
  const me = roomState.players.find(p => p.id === myId);
  if (!me) return;
  document.getElementById('my-name-display').textContent = me.name;
  const badge = roomState.positions && roomState.positions[myId]
    ? POS_EMOJI[roomState.positions[myId]] + ' ' + POS_LABEL[roomState.positions[myId]]
    : '';
  document.getElementById('my-badge').textContent = badge;
}

function renderAll() {
  renderMyHand();
  renderOpponents();
  renderLastPlay();
  renderMyInfo();
  updateActionBar();
}

// ── Waiting Room ───────────────────────────────────────────────────────────────
function renderWaiting() {
  if (!roomState) return;
  const container = document.getElementById('waiting-players');
  container.innerHTML = '';

  for (let i = 0; i < 4; i++) {
    const slot = document.createElement('div');
    const p = roomState.players[i];
    if (p) {
      slot.className = `player-slot${p.ready ? ' ready' : ''}`;
      slot.innerHTML = `
        <div class="player-slot-name">${escHtml(p.name)}${p.id === myId ? ' (Kamu)' : ''}</div>
        <div class="player-slot-status">${p.ready ? '✅ Siap' : 'Menunggu...'}</div>
      `;
    } else {
      slot.className = 'player-slot empty';
      slot.innerHTML = '<div class="player-slot-name">—</div><div class="player-slot-status">Slot kosong</div>';
    }
    container.appendChild(slot);
  }

  document.getElementById('btn-start').classList.toggle('hidden', !myIsHost);
  document.getElementById('room-code-display').textContent = roomId;
}

// ── Socket Setup ───────────────────────────────────────────────────────────────
function initSocket() {
  socket = io(SERVER_URL);

  socket.on('connect', () => {
    myId = socket.id;
    console.log('Connected as', myId);
  });

  socket.on('room_created', ({ roomId: rid }) => {
    roomId = rid;
    myIsHost = true;
    showScreen('screen-waiting');
    document.getElementById('room-code-display').textContent = rid;
  });

  socket.on('room_update', (room) => {
    roomState = room;
    myIsHost = room.host === myId;

    if (room.state === 'waiting') {
      renderWaiting();
    } else if (room.state === 'playing' || room.state === 'card_exchange') {
      showScreen('screen-game');
      renderAll();
    } else if (room.state === 'round_end') {
      renderAll();
    }
  });

  socket.on('game_started', ({ firstPlayer, roundNum }) => {
    showScreen('screen-game');
    clearSelection();
    addChatSystem(`Ronde ${roundNum} dimulai!`);
    if (firstPlayer === myId) showToast('Kamu main pertama! Wajib pakai 3♦');
  });

  socket.on('cards_played', ({ playerId, cards, combo }) => {
    const name = getPlayerName(playerId);
    const comboName = comboLabel(combo?.type);
    addChatSystem(`${name} main ${comboName}`);
    renderAll();
  });

  socket.on('player_passed', ({ playerId }) => {
    const name = getPlayerName(playerId);
    addChatSystem(`${name} pass`);
    renderAll();
  });

  socket.on('table_cleared', () => {
    addChatSystem('Meja dikosongkan — giliran baru dimulai');
    renderAll();
  });

  socket.on('turn_changed', ({ currentTurn }) => {
    if (currentTurn === myId) {
      showToast('Giliran kamu! 🎯');
    }
    renderAll();
  });

  socket.on('player_finished', ({ playerId, position }) => {
    const name = getPlayerName(playerId);
    const pos = ['', 'Raja 👑', 'Menteri 🤵', 'Rakyat 🧑', 'Budak 🔗'][position] || '';
    addChatSystem(`${name} selesai — ${pos}`);
  });

  socket.on('round_end', ({ positions, finishOrder, scores }) => {
    showRoundEnd(positions, finishOrder, scores);
  });

  socket.on('player_joined', ({ name }) => {
    if (roomState?.state === 'waiting') {
      addChatSystem(`${name} bergabung`);
    }
  });

  socket.on('player_left', ({ name }) => {
    addChatSystem(`${name} keluar`);
    renderAll();
  });

  socket.on('error', ({ msg }) => {
    showToast('⚠️ ' + msg);
  });

  socket.on('chat_message', ({ name, msg }) => {
    addChatMsg(name, msg);
  });
}

// ── Round End Modal ────────────────────────────────────────────────────────────
function showRoundEnd(positions, finishOrder, scores) {
  const modal = document.getElementById('modal-round-end');
  const posDiv = document.getElementById('modal-positions');
  const scoreDiv = document.getElementById('modal-scores');

  modal.classList.remove('hidden');

  const posOrder = ['king', 'minister', 'peasant', 'slave'];
  posDiv.innerHTML = '';
  posOrder.forEach(pos => {
    const pid = Object.keys(positions).find(id => positions[id] === pos);
    if (!pid) return;
    const name = getPlayerName(pid);
    const row = document.createElement('div');
    row.className = `pos-row ${pos}`;
    row.innerHTML = `
      <span class="pos-crown">${POS_EMOJI[pos]}</span>
      <span class="pos-name">${escHtml(name)}${pid === myId ? ' (Kamu)' : ''}</span>
      <span class="pos-label">${POS_LABEL[pos]}</span>
    `;
    posDiv.appendChild(row);
  });

  scoreDiv.innerHTML = '<strong style="color:var(--text-dim);letter-spacing:0.1em;font-size:0.8rem">SKOR TOTAL</strong>';
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([pid, score]) => {
    const name = getPlayerName(pid);
    const row = document.createElement('div');
    row.className = 'score-row';
    row.innerHTML = `<span>${escHtml(name)}</span><span class="score-val ${score >= 0 ? 'pos' : 'neg'}">${score >= 0 ? '+' : ''}${score}</span>`;
    scoreDiv.appendChild(row);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getPlayerName(id) {
  if (!roomState) return id;
  return roomState.players.find(p => p.id === id)?.name || id;
}

function comboLabel(type) {
  const map = {
    single: 'kartu tunggal', pair: 'pasangan', triple: 'tiga sejenis',
    straight: 'straight', flush: 'flush', full_house: 'full house',
    four_of_a_kind: 'four of a kind', bomb: 'bom', straight_flush: 'straight flush'
  };
  return map[type] || type || 'kartu';
}

let toastTimeout;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove('show'), 2500);
}

function addChatSystem(msg) {
  const el = document.createElement('div');
  el.className = 'chat-system';
  el.textContent = msg;
  appendChat(el);
}

function addChatMsg(name, msg) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="chat-name">${escHtml(name)}:</span> <span class="chat-text">${escHtml(msg)}</span>`;
  appendChat(el);
}

function appendChat(el) {
  const msgs = document.getElementById('chat-messages');
  if (!msgs) return;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Event Listeners ────────────────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  if (!name) { showToast('Masukkan nama dulu!'); return; }
  myName = name;
  socket.emit('create_room', { name });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-room').value.trim().toUpperCase();
  if (!name) { showToast('Masukkan nama dulu!'); return; }
  if (!code) { showToast('Masukkan kode room!'); return; }
  myName = name;
  roomId = code;
  socket.emit('join_room', { roomId: code, name });
});

document.getElementById('input-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-create').click();
});

document.getElementById('input-room').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

document.getElementById('btn-ready').addEventListener('click', () => {
  socket.emit('set_ready');
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start_game');
});

document.getElementById('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomId).then(() => showToast('Kode disalin!'));
});

document.getElementById('btn-play').addEventListener('click', () => {
  if (selectedCards.length === 0) return;
  const hand = roomState.hands[myId] || [];
  const cards = hand.filter(c => selectedCards.includes(c.id));
  socket.emit('play_cards', { cards });
  clearSelection();
});

document.getElementById('btn-pass').addEventListener('click', () => {
  socket.emit('pass_turn');
  clearSelection();
});

document.getElementById('btn-clear-sel').addEventListener('click', clearSelection);

document.getElementById('btn-next-round').addEventListener('click', () => {
  document.getElementById('modal-round-end').classList.add('hidden');
  socket.emit('ready_next_round');
});

document.getElementById('btn-send-chat').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('send_chat', { msg });
  input.value = '';
}

// ── Init ───────────────────────────────────────────────────────────────────────
initSocket();
