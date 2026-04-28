'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER_URL = window.location.origin;
const SESSION_KEY = 'capsa_sid';

// ── State ─────────────────────────────────────────────────────────────────────
let socket;
let mySid   = null;   // session id (persistent)
let myId    = null;   // socket.id (changes on reconnect)
let myName  = '';
let roomId  = null;
let room    = null;   // latest room_update snapshot
let selected = [];    // card ids selected

// ── Session storage ───────────────────────────────────────────────────────────
const getSid  = () => localStorage.getItem(SESSION_KEY);
const saveSid = sid => localStorage.setItem(SESSION_KEY, sid);
const clearSid = () => localStorage.removeItem(SESSION_KEY);

// ── Card constants ────────────────────────────────────────────────────────────
const SUIT_SYM   = { d:'♦', c:'♣', h:'♥', s:'♠' };
const SUIT_COLOR = { d:'red', c:'black', h:'red', s:'black' };
const RANKS      = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const SUITS      = ['d','c','h','s'];
const cardVal    = c => RANKS.indexOf(c.rank) * 4 + SUITS.indexOf(c.suit);
const sortC      = cs => [...cs].sort((a,b) => cardVal(a) - cardVal(b));

// ── Combo detection (client-side for label) ───────────────────────────────────
function detectCombo(cards) {
  if (!cards || !cards.length) return null;
  const n = cards.length;
  const s = sortC(cards);
  if (n === 1) return 'single';
  if (n === 2) return s[0].rank === s[1].rank ? 'pair' : null;
  if (n === 3) return (s[0].rank === s[1].rank && s[1].rank === s[2].rank) ? 'triple' : null;
  if (n === 4) {
    const rc = {};
    s.forEach(c => rc[c.rank] = (rc[c.rank]||0)+1);
    return Object.values(rc).includes(4) ? 'four_of_a_kind' : null;
  }
  if (n === 5) {
    const rc = {};
    s.forEach(c => rc[c.rank] = (rc[c.rank]||0)+1);
    const counts = Object.values(rc).sort((a,b)=>b-a);
    const ri = s.map(c => RANKS.indexOf(c.rank)).sort((a,b)=>a-b);
    const isFlush = s.every(c => c.suit === s[0].suit);
    const isStraight = ri.every((r,i) => i===0 || r===ri[i-1]+1);
    if (isFlush && isStraight) return 'straight_flush';
    if (counts[0] === 4) return 'bomb';
    if (counts[0] === 3 && counts[1] === 2) return 'full_house';
    if (isFlush) return 'flush';
    if (isStraight) return 'straight';
    return null;
  }
  return null;
}

const COMBO_LABEL = {
  single:'Kartu Tunggal', pair:'Pasangan', triple:'Tiga Sejenis',
  straight:'Straight', flush:'Flush', full_house:'Full House',
  four_of_a_kind:'Four of a Kind', bomb:'Bom 💣', straight_flush:'Straight Flush 🔥'
};
const POS_EMOJI = { king:'🥇', minister:'🥈', peasant:'🥉', slave:'4️⃣' };
const POS_LABEL = { king:'Menang', minister:'2nd', peasant:'3rd', slave:'Kalah' };

// ── Screen management ─────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Card rendering ────────────────────────────────────────────────────────────
function buildCard(card, { selectable = false, played = false } = {}) {
  const el = document.createElement('div');
  el.className = `card ${SUIT_COLOR[card.suit]}${played ? ' card-played' : ''}${selected.includes(card.id) ? ' selected' : ''}`;
  el.dataset.id = card.id;
  el.innerHTML = `
    <div class="card-rank">${card.rank}</div>
    <div class="card-suit">${SUIT_SYM[card.suit]}</div>
    <div class="card-center">${SUIT_SYM[card.suit]}</div>
  `;
  if (selectable) el.addEventListener('click', () => toggleCard(card.id));
  return el;
}

function buildBackCard() {
  const el = document.createElement('div');
  el.className = 'card-back';
  el.textContent = '🂠';
  return el;
}

// ── Selection ─────────────────────────────────────────────────────────────────
function toggleCard(id) {
  if (!room || room.currentTurn !== mySid) return;
  const idx = selected.indexOf(id);
  idx === -1 ? selected.push(id) : selected.splice(idx, 1);
  renderHand();
  renderComboLabel();
  updateButtons();
}

function clearSelection() {
  selected = [];
  renderHand();
  renderComboLabel();
  updateButtons();
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderHand() {
  const el = document.getElementById('my-hand');
  el.innerHTML = '';
  (room?.myHand || []).forEach(c => el.appendChild(buildCard(c, { selectable: true })));
}

function renderOpponents() {
  const area = document.getElementById('opponents-area');
  area.innerHTML = '';
  if (!room) return;

  room.players.filter(p => p.sid !== mySid).forEach(p => {
    const count   = room.allHandCounts?.[p.sid] ?? 0;
    const isMyTurn = room.currentTurn === p.sid;
    const block = document.createElement('div');
    block.className = `opponent-block${isMyTurn ? ' active-glow' : ''}`;

    const handEl = document.createElement('div');
    handEl.className = 'opponent-hand';
    const show = Math.min(count, 13);
    for (let i = 0; i < show; i++) handEl.appendChild(buildBackCard());

    block.innerHTML = `<div class="opponent-name">${esc(p.name)}${isMyTurn ? ' 🎯' : ''}</div>`;
    block.appendChild(handEl);
    block.innerHTML += `<div class="opponent-count">${count} kartu</div>`;
    // re-append handEl properly
    block.innerHTML = '';
    const nameEl = document.createElement('div');
    nameEl.className = 'opponent-name';
    nameEl.textContent = p.name + (isMyTurn ? ' 🎯' : '');
    block.appendChild(nameEl);
    block.appendChild(handEl);
    const cntEl = document.createElement('div');
    cntEl.className = 'opponent-count';
    cntEl.textContent = count + ' kartu';
    block.appendChild(cntEl);

    area.appendChild(block);
  });
}

function renderTable() {
  const area = document.getElementById('last-play-area');
  const info = document.getElementById('table-info');
  area.innerHTML = '';
  if (!room?.lastPlay?.length) {
    info.textContent = 'Meja kosong — mainkan kartu pertama';
    return;
  }
  room.lastPlay.forEach(c => area.appendChild(buildCard(c, { played: true })));
  const who = room.players.find(p => p.sid === room.lastPlayerId)?.name || '?';
  info.textContent = who + ' main';
}

function renderMyInfo() {
  const me = room?.players.find(p => p.sid === mySid);
  document.getElementById('my-name-display').textContent = me?.name || myName;
  const pos = room?.positions?.[mySid];
  document.getElementById('my-badge').textContent = pos ? POS_EMOJI[pos] + ' ' + POS_LABEL[pos] : '';
}

function renderComboLabel() {
  const el = document.getElementById('combo-label');
  if (!selected.length) { el.textContent = ''; return; }
  const hand = room?.myHand || [];
  const cards = hand.filter(c => selected.includes(c.id));
  const type = detectCombo(cards);
  if (type) {
    el.textContent = '✅ ' + (COMBO_LABEL[type] || type);
    el.style.color = 'var(--gold-light)';
  } else {
    el.textContent = '❌ Kombinasi tidak valid';
    el.style.color = 'var(--red-light)';
  }
}

function updateButtons() {
  const isMyTurn   = room?.currentTurn === mySid;
  const hasLastPlay = !!room?.lastPlay?.length;
  document.getElementById('btn-play').disabled  = !isMyTurn || !selected.length;
  document.getElementById('btn-pass').disabled  = !isMyTurn || !hasLastPlay;
  const hand = document.getElementById('my-hand');
  hand.classList.toggle('my-turn-glow', !!isMyTurn);
}

function renderAll() {
  renderHand();
  renderOpponents();
  renderTable();
  renderMyInfo();
  renderComboLabel();
  updateButtons();
}

function renderWaiting() {
  if (!room) return;
  document.getElementById('room-code-display').textContent = room.id;
  const isHost = room.host === mySid;
  document.getElementById('btn-start').classList.toggle('hidden', !isHost);

  const container = document.getElementById('waiting-players');
  container.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const p = room.players[i];
    const slot = document.createElement('div');
    if (p) {
      slot.className = `player-slot${p.ready ? ' ready' : ''}`;
      slot.innerHTML = `
        <div class="player-slot-name">${esc(p.name)}${p.sid === mySid ? ' (Kamu)' : ''}</div>
        <div class="player-slot-status">${p.ready ? '✅ Siap' : 'Menunggu...'}</div>
      `;
    } else {
      slot.className = 'player-slot empty';
      slot.innerHTML = '<div class="player-slot-name">—</div><div class="player-slot-status">Slot kosong</div>';
    }
    container.appendChild(slot);
  }
}

// ── Round end modal ───────────────────────────────────────────────────────────
function showRoundEnd(positions, finishOrder, scores) {
  const modal   = document.getElementById('modal-round-end');
  const posDiv  = document.getElementById('modal-positions');
  const scoreDiv = document.getElementById('modal-scores');

  modal.classList.remove('hidden');
  document.getElementById('btn-end-game').classList.toggle('hidden', room?.host !== mySid);

  posDiv.innerHTML = '';
  finishOrder.forEach((sid, i) => {
    const name = room?.players.find(p => p.sid === sid)?.name || sid;
    const pos  = positions[sid] || 'slave';
    const row  = document.createElement('div');
    row.className = `pos-row ${pos}`;
    row.innerHTML = `
      <span class="pos-crown">${POS_EMOJI[pos]}</span>
      <span class="pos-name">${esc(name)}${sid === mySid ? ' (Kamu)' : ''}</span>
      <span class="pos-label">${POS_LABEL[pos]}</span>
    `;
    posDiv.appendChild(row);
  });

  scoreDiv.innerHTML = '<strong style="color:var(--text-dim);font-size:0.78rem;letter-spacing:0.1em">TOTAL MENANG</strong>';
  Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .forEach(([sid, score]) => {
      const name = room?.players.find(p => p.sid === sid)?.name || sid;
      const row  = document.createElement('div');
      row.className = 'score-row';
      row.innerHTML = `<span>${esc(name)}</span><span class="score-val pos">${score} menang</span>`;
      scoreDiv.appendChild(row);
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let toastTid;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTid);
  toastTid = setTimeout(() => el.classList.remove('show'), 2600);
}

function chatSystem(msg) {
  const el = document.createElement('div');
  el.className = 'chat-system';
  el.textContent = msg;
  appendChat(el);
}

function chatMsg(name, msg) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="chat-name">${esc(name)}:</span> <span class="chat-text">${esc(msg)}</span>`;
  appendChat(el);
}

function appendChat(el) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function getName(sid) {
  return room?.players.find(p => p.sid === sid)?.name || sid;
}

function leaveRoom() {
  socket.emit('leave_room');
  room = null; roomId = null; selected = [];
  document.getElementById('modal-round-end').classList.add('hidden');
  document.getElementById('input-name').value = myName;
  document.getElementById('input-room').value = '';
  showScreen('screen-lobby');
}

// ── Socket init ───────────────────────────────────────────────────────────────
function initSocket() {
  socket = io(SERVER_URL, { reconnection: true, reconnectionDelay: 500 });

  // ── Connection ──
  socket.on('connect', () => {
    myId = socket.id;
    document.getElementById('overlay-reconnect').classList.add('hidden');
    // Always register with stored sid (may be null for first visit)
    socket.emit('register_session', { sid: getSid() });
  });

  socket.on('disconnect', () => {
    document.getElementById('overlay-reconnect').classList.remove('hidden');
  });

  // ── Session ──
  socket.on('session_ok', ({ sid, roomId: restoredRoom, name }) => {
    mySid = sid;
    saveSid(sid);
    if (restoredRoom) {
      roomId = restoredRoom;
      myName = name;
      toast('✅ Koneksi dipulihkan!');
      // room_update will follow and show the right screen
    }
  });

  // ── Room state ──
  socket.on('room_update', data => {
    room = data;
    if (room.state === 'waiting') {
      showScreen('screen-waiting');
      renderWaiting();
    } else if (['playing','card_exchange','round_end'].includes(room.state)) {
      showScreen('screen-game');
      renderAll();
    }
  });

  socket.on('room_created', ({ roomId: rid }) => {
    roomId = rid;
    showScreen('screen-waiting');
  });

  // ── Game events ──
  socket.on('game_started', ({ firstSid, roundNum }) => {
    selected = [];
    chatSystem(`Ronde ${roundNum} dimulai!`);
    if (firstSid === mySid) toast('🎯 Kamu main pertama! Wajib pakai 3♦');
    showScreen('screen-game');
  });

  socket.on('turn_changed', ({ currentTurn }) => {
    if (room) room.currentTurn = currentTurn;
    updateButtons();
    if (currentTurn === mySid) toast('🎯 Giliran kamu!');
    renderOpponents();
  });

  socket.on('cards_played', ({ playerSid, combo }) => {
    chatSystem(`${getName(playerSid)} main ${COMBO_LABEL[combo?.type] || ''}`);
  });

  socket.on('player_passed', ({ playerSid }) => {
    chatSystem(`${getName(playerSid)} pass`);
  });

  socket.on('table_cleared', () => {
    chatSystem('Meja dikosongkan');
  });

  socket.on('player_finished', ({ playerSid, position }) => {
    const medals = ['','🥇','🥈','🥉','4️⃣'];
    chatSystem(`${getName(playerSid)} selesai ${medals[position] || position}`);
  });

  socket.on('round_end', ({ positions, finishOrder, scores }) => {
    if (room) { room.positions = positions; room.scores = scores; }
    showRoundEnd(positions, finishOrder, scores);
  });

  socket.on('game_ended', () => {
    document.getElementById('modal-round-end').classList.add('hidden');
    toast('Game selesai!');
    setTimeout(() => showScreen('screen-waiting'), 800);
  });

  socket.on('player_joined', ({ name }) => {
    chatSystem(`${name} bergabung`);
  });

  socket.on('player_left', ({ name }) => {
    chatSystem(`${name} keluar`);
  });

  socket.on('player_reconnected', ({ name }) => {
    chatSystem(`✅ ${name} kembali terhubung`);
  });

  socket.on('player_disconnected', ({ name, reconnectSecs }) => {
    chatSystem(`⚠️ ${name} terputus — ${reconnectSecs}s untuk reconnect`);
  });

  socket.on('error', ({ msg }) => {
    toast('⚠️ ' + msg);
  });

  socket.on('chat_message', ({ name, msg }) => {
    chatMsg(name, msg);
  });
}

// ── UI Event Listeners ────────────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  if (!name) { toast('Masukkan nama dulu!'); return; }
  myName = name;
  socket.emit('create_room', { name });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-room').value.trim().toUpperCase();
  if (!name) { toast('Masukkan nama dulu!'); return; }
  if (!code) { toast('Masukkan kode room!'); return; }
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
document.getElementById('btn-waiting-leave').addEventListener('click', leaveRoom);

document.getElementById('btn-copy-code').addEventListener('click', () => {
  const code = document.getElementById('room-code-display').textContent;
  navigator.clipboard.writeText(code).then(() => toast('Kode disalin!'));
});

document.getElementById('btn-play').addEventListener('click', () => {
  if (!selected.length) return;
  const cards = (room?.myHand || []).filter(c => selected.includes(c.id));
  socket.emit('play_cards', { cards });
  clearSelection();
});

document.getElementById('btn-pass').addEventListener('click', () => {
  socket.emit('pass_turn');
  clearSelection();
});

document.getElementById('btn-clear-sel').addEventListener('click', clearSelection);
document.getElementById('btn-game-leave').addEventListener('click', () => {
  if (confirm('Keluar dari game?')) leaveRoom();
});

document.getElementById('btn-next-round').addEventListener('click', () => {
  document.getElementById('modal-round-end').classList.add('hidden');
  socket.emit('ready_next_round');
});
document.getElementById('btn-end-game').addEventListener('click', () => {
  if (!confirm('Akhiri game?')) return;
  document.getElementById('modal-round-end').classList.add('hidden');
  socket.emit('end_game');
});
document.getElementById('btn-leave-room').addEventListener('click', () => {
  if (!confirm('Keluar dari room?')) return;
  leaveRoom();
});

document.getElementById('btn-send-chat').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});
function sendChat() {
  const el = document.getElementById('chat-input');
  const msg = el.value.trim();
  if (!msg) return;
  socket.emit('send_chat', { msg });
  el.value = '';
}

// ── Boot ──────────────────────────────────────────────────────────────────────
initSocket();
