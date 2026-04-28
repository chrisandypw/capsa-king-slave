const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Constants ──────────────────────────────────────────────────────────────────
const SUITS = ['d', 'c', 'h', 's'];
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const SESSION_TTL = 10 * 60 * 1000;
const AUTO_PASS_DELAY = 15 * 1000;

// ── Card helpers ───────────────────────────────────────────────────────────────
const cardVal = c => RANKS.indexOf(c.rank) * 4 + SUITS.indexOf(c.suit);
const sortCards = cards => [...cards].sort((a, b) => cardVal(a) - cardVal(b));

function createDeck() {
  const d = [];
  for (const rank of RANKS)
    for (const suit of SUITS)
      d.push({ rank, suit, id: `${rank}${suit}` });
  return d;
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function deal(deck, n) {
  const hands = Array.from({ length: n }, () => []);
  deck.forEach((c, i) => hands[i % n].push(c));
  return hands.map(sortCards);
}

// ── Combo validation ───────────────────────────────────────────────────────────
const COMBO_RANK = {
  single:1, pair:2, triple:3, straight:4,
  flush:5, full_house:6, four_of_a_kind:7, bomb:8, straight_flush:9
};

function getCombo(cards) {
  if (!cards || !cards.length) return null;
  const n = cards.length;
  const s = sortCards(cards);

  if (n === 1) return { type: 'single', value: cardVal(s[0]) };

  if (n === 2) {
    if (s[0].rank === s[1].rank) return { type: 'pair', value: cardVal(s[1]) };
    return null;
  }

  if (n === 3) {
    if (s[0].rank === s[1].rank && s[1].rank === s[2].rank)
      return { type: 'triple', value: cardVal(s[2]) };
    return null;
  }

  if (n === 4) {
    const rc = {};
    s.forEach(c => rc[c.rank] = (rc[c.rank] || 0) + 1);
    if (Object.values(rc).includes(4)) {
      const q = Object.keys(rc).find(r => rc[r] === 4);
      return { type: 'four_of_a_kind', value: RANKS.indexOf(q) * 4 + 3 };
    }
    return null;
  }

  if (n === 5) {
    const rc = {};
    s.forEach(c => rc[c.rank] = (rc[c.rank] || 0) + 1);
    const counts = Object.values(rc).sort((a, b) => b - a);
    const ri = s.map(c => RANKS.indexOf(c.rank)).sort((a, b) => a - b);
    const isFlush = s.every(c => c.suit === s[0].suit);
    const isStraight = ri.every((r, i) => i === 0 || r === ri[i-1] + 1);

    if (isFlush && isStraight) return { type: 'straight_flush', value: cardVal(s[4]) };
    if (counts[0] === 4) {
      const q = Object.keys(rc).find(r => rc[r] === 4);
      return { type: 'bomb', value: RANKS.indexOf(q) * 10 + 1000 };
    }
    if (counts[0] === 3 && counts[1] === 2) {
      const t = Object.keys(rc).find(r => rc[r] === 3);
      return { type: 'full_house', value: RANKS.indexOf(t) * 10 + 500 };
    }
    if (isFlush) return { type: 'flush', value: cardVal(s[4]) };
    if (isStraight) return { type: 'straight', value: cardVal(s[4]) };
    return null;
  }
  return null;
}

function isValidPlay(cards, lastPlay) {
  const combo = getCombo(cards);
  if (!combo) return { valid: false, reason: 'Kombinasi tidak valid' };
  if (!lastPlay || !lastPlay.length) return { valid: true, combo };

  const last = getCombo(lastPlay);
  if (!last) return { valid: true, combo };

  if (combo.type === 'bomb' || combo.type === 'straight_flush') {
    if (last.type === 'bomb' || last.type === 'straight_flush') {
      if (COMBO_RANK[combo.type] > COMBO_RANK[last.type]) return { valid: true, combo };
      if (combo.type === last.type && combo.value > last.value) return { valid: true, combo };
      return { valid: false, reason: 'Nilai terlalu kecil' };
    }
    return { valid: true, combo };
  }

  if (combo.type !== last.type) return { valid: false, reason: `Harus main ${last.type}` };
  if (cards.length !== lastPlay.length) return { valid: false, reason: 'Jumlah kartu harus sama' };
  if (combo.value > last.value) return { valid: true, combo };
  return { valid: false, reason: 'Nilai terlalu kecil' };
}

// ── Stores ─────────────────────────────────────────────────────────────────────
const sessions = {}; // sid -> { name, roomId, disconnectedAt }
const rooms    = {}; // roomId -> Room

// ── Helpers ────────────────────────────────────────────────────────────────────
function getSocketBySid(sid) {
  for (const [, sock] of io.sockets.sockets)
    if (sock.data.sid === sid) return sock;
  return null;
}

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.players.forEach(p => {
    const sock = getSocketBySid(p.sid);
    if (!sock) return;
    sock.emit('room_update', {
      id: room.id,
      host: room.host,
      state: room.state,
      players: room.players,
      currentTurn: room.currentTurn,
      lastPlay: room.lastPlay,
      lastPlayerId: room.lastPlayerId,
      positions: room.positions,
      scores: room.scores,
      roundNum: room.roundNum,
      finishOrder: room.finishOrder || [],
      exchangeDone: room.exchangeDone || {},
      myHand: room.hands[p.sid] || [],
      allHandCounts: Object.fromEntries(
        Object.entries(room.hands).map(([k, h]) => [k, h.length])
      )
    });
  });
}

function nextTurn(room) {
  const order = room.turnOrder;
  const idx = order.indexOf(room.currentTurn);
  let next = (idx + 1) % order.length;
  let tries = 0;
  while ((room.finishOrder || []).includes(order[next]) && tries < order.length) {
    next = (next + 1) % order.length;
    tries++;
  }
  room.currentTurn = order[next];
}

function startGame(roomId) {
  const room = rooms[roomId];
  const players = room.players;
  const hands = deal(shuffle(createDeck()), players.length);

  room.hands = {};
  players.forEach((p, i) => room.hands[p.sid] = hands[i]);
  room.lastPlay = [];
  room.lastPlayerId = null;
  room.passCount = 0;
  room.finishOrder = [];

  let firstSid = players[0].sid;
  players.forEach(p => {
    if (room.hands[p.sid].some(c => c.rank === '3' && c.suit === 'd')) firstSid = p.sid;
  });

  const fi = players.findIndex(p => p.sid === firstSid);
  room.turnOrder = [
    ...players.slice(fi).map(p => p.sid),
    ...players.slice(0, fi).map(p => p.sid)
  ];
  room.currentTurn = firstSid;
  room.state = 'playing';

  broadcastRoom(roomId);
  io.to(roomId).emit('game_started', { firstSid, roundNum: room.roundNum });
}

function checkRoundEnd(room) {
  const active = room.players.filter(p => !(room.finishOrder || []).includes(p.sid));
  if (active.length > 1) return false;

  if (active.length === 1) room.finishOrder.push(active[0].sid);

  const labels = ['king','minister','peasant','slave'];
  room.positions = {};
  room.finishOrder.forEach((sid, i) => { room.positions[sid] = labels[i] || 'slave'; });

  // Capsa biasa: count wins
  room.players.forEach(p => {
    if (!room.scores[p.sid]) room.scores[p.sid] = 0;
    if (room.positions[p.sid] === 'king') room.scores[p.sid]++;
  });

  room.state = 'round_end';
  room.exchangeDone = {};

  broadcastRoom(room.id);
  io.to(room.id).emit('round_end', {
    positions: room.positions,
    finishOrder: room.finishOrder,
    scores: room.scores
  });
  return true;
}

function removeFromRoom(sid, roomId, kicked = false) {
  const room = rooms[roomId];
  if (!room) return;
  const name = sessions[sid]?.name || '?';

  room.players = room.players.filter(p => p.sid !== sid);
  delete room.hands[sid];
  room.turnOrder = (room.turnOrder || []).filter(id => id !== sid);
  if (room.finishOrder) room.finishOrder = room.finishOrder.filter(id => id !== sid);

  if (room.players.length === 0) { delete rooms[roomId]; return; }
  if (room.host === sid) room.host = room.players[0].sid;

  if (kicked) io.to(roomId).emit('player_left', { sid, name });

  // If it was their turn, advance
  if (room.state === 'playing' && room.currentTurn === sid) {
    if (room.turnOrder.length > 0) {
      nextTurn(room);
      io.to(roomId).emit('turn_changed', { currentTurn: room.currentTurn });
    }
  }
  broadcastRoom(roomId);
}

// Purge expired disconnected sessions
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.disconnectedAt && now - s.disconnectedAt > SESSION_TTL) {
      if (s.roomId) removeFromRoom(sid, s.roomId, true);
      delete sessions[sid];
    }
  }
}, 30_000);

// ── Socket events ──────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('register_session', ({ sid }) => {
    const existing = sid && sessions[sid];

    if (existing && existing.roomId && rooms[existing.roomId]) {
      const room = rooms[existing.roomId];
      const player = room.players.find(p => p.sid === sid);
      if (player) {
        socket.join(existing.roomId);
        socket.data.sid = sid;
        socket.data.roomId = existing.roomId;
        socket.data.name = existing.name;
        existing.disconnectedAt = null;

        io.to(existing.roomId).emit('player_reconnected', { name: existing.name });
        broadcastRoom(existing.roomId);
        socket.emit('session_ok', { sid, roomId: existing.roomId, name: existing.name });
        return;
      }
    }

    // New or expired session
    const newSid = uuidv4();
    sessions[newSid] = { name: '', roomId: null, disconnectedAt: null };
    socket.data.sid = newSid;
    socket.emit('session_ok', { sid: newSid, roomId: null, name: '' });
  });

  socket.on('create_room', ({ name }) => {
    const { sid } = socket.data;
    if (!sid) return;
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();

    sessions[sid] = { name, roomId, disconnectedAt: null };
    socket.data.name = name;
    socket.data.roomId = roomId;

    rooms[roomId] = {
      id: roomId, host: sid, state: 'waiting',
      players: [{ sid, name, ready: false }],
      hands: {}, currentTurn: null,
      lastPlay: [], lastPlayerId: null, passCount: 0,
      turnOrder: [], finishOrder: [],
      positions: {}, exchangeDone: {}, scores: {},
      roundNum: 1, chat: []
    };

    socket.join(roomId);
    socket.emit('room_created', { roomId });
    broadcastRoom(roomId);
  });

  socket.on('join_room', ({ roomId, name }) => {
    const { sid } = socket.data;
    if (!sid) return;
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { msg: 'Room tidak ditemukan' });
    if (room.state !== 'waiting') return socket.emit('error', { msg: 'Game sudah dimulai' });
    if (room.players.length >= 4) return socket.emit('error', { msg: 'Room penuh (maks 4 pemain)' });
    if (room.players.find(p => p.sid === sid)) return;

    sessions[sid] = { name, roomId, disconnectedAt: null };
    socket.data.name = name;
    socket.data.roomId = roomId;

    room.players.push({ sid, name, ready: false });
    socket.join(roomId);
    io.to(roomId).emit('player_joined', { sid, name });
    broadcastRoom(roomId);
  });

  socket.on('set_ready', () => {
    const { sid, roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players.find(p => p.sid === sid);
    if (p) { p.ready = !p.ready; broadcastRoom(roomId); }
  });

  socket.on('start_game', () => {
    const { sid, roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.host !== sid) return;
    if (room.players.length < 2) return socket.emit('error', { msg: 'Minimal 2 pemain' });
    startGame(roomId);
  });

  socket.on('play_cards', ({ cards }) => {
    const { sid, roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    if (room.currentTurn !== sid) return socket.emit('error', { msg: 'Bukan giliran kamu' });

    const hand = room.hands[sid];
    for (const c of cards)
      if (!hand.find(h => h.id === c.id)) return socket.emit('error', { msg: 'Kartu tidak valid' });

    const result = isValidPlay(cards, room.lastPlay);
    if (!result.valid) return socket.emit('error', { msg: result.reason });

    room.hands[sid] = hand.filter(c => !cards.find(x => x.id === c.id));
    room.lastPlay = cards;
    room.lastPlayerId = sid;
    room.passCount = 0;

    io.to(roomId).emit('cards_played', { playerSid: sid, cards, combo: result.combo });

    if (room.hands[sid].length === 0) {
      room.finishOrder.push(sid);
      io.to(roomId).emit('player_finished', { playerSid: sid, position: room.finishOrder.length });
      if (checkRoundEnd(room)) return;
      room.lastPlay = [];
      room.lastPlayerId = null;
    }

    nextTurn(room);
    broadcastRoom(roomId);
    io.to(roomId).emit('turn_changed', { currentTurn: room.currentTurn });
  });

  socket.on('pass_turn', () => {
    const { sid, roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    if (room.currentTurn !== sid) return socket.emit('error', { msg: 'Bukan giliran kamu' });
    if (!room.lastPlay.length) return socket.emit('error', { msg: 'Tidak bisa pass di awal ronde' });

    room.passCount++;
    io.to(roomId).emit('player_passed', { playerSid: sid });

    const active = room.players.filter(p => !(room.finishOrder || []).includes(p.sid));
    if (room.passCount >= active.length - 1) {
      room.lastPlay = []; room.lastPlayerId = null; room.passCount = 0;
      io.to(roomId).emit('table_cleared');
    }

    nextTurn(room);
    broadcastRoom(roomId);
    io.to(roomId).emit('turn_changed', { currentTurn: room.currentTurn });
  });

  socket.on('ready_next_round', () => {
    const { sid, roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.state !== 'round_end') return;
    room.exchangeDone[sid] = true;
    broadcastRoom(roomId);

    const connected = room.players.filter(p => getSocketBySid(p.sid));
    if (connected.every(p => room.exchangeDone[p.sid])) {
      room.roundNum++;
      startGame(roomId);
    }
  });

  socket.on('end_game', () => {
    const { sid, roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.host !== sid) return;
    io.to(roomId).emit('game_ended', { scores: room.scores });
    Object.assign(room, {
      state: 'waiting', hands: {}, lastPlay: [], lastPlayerId: null,
      passCount: 0, positions: {}, exchangeDone: {}, finishOrder: [],
      turnOrder: [], currentTurn: null, scores: {}, roundNum: 1
    });
    room.players.forEach(p => p.ready = false);
    broadcastRoom(roomId);
  });

  socket.on('leave_room', () => {
    const { sid, roomId } = socket.data;
    if (!roomId || !rooms[roomId]) return;
    socket.leave(roomId);
    socket.data.roomId = null;
    if (sessions[sid]) sessions[sid].roomId = null;
    removeFromRoom(sid, roomId, true);
  });

  socket.on('send_chat', ({ msg }) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || !msg?.trim()) return;
    const name = socket.data.name || '?';
    const chatMsg = { name, msg: msg.trim(), time: Date.now() };
    room.chat = [...(room.chat || []).slice(-49), chatMsg];
    io.to(roomId).emit('chat_message', chatMsg);
  });

  socket.on('disconnect', () => {
    const { sid, roomId } = socket.data;
    if (!sid) return;

    if (!roomId || !rooms[roomId]) {
      if (sessions[sid]) sessions[sid].disconnectedAt = Date.now();
      return;
    }

    const room = rooms[roomId];

    if (room.state === 'waiting') {
      removeFromRoom(sid, roomId, true);
      if (sessions[sid]) sessions[sid].roomId = null;
    } else {
      // Keep in game during SESSION_TTL window
      if (sessions[sid]) sessions[sid].disconnectedAt = Date.now();
      io.to(roomId).emit('player_disconnected', {
        name: socket.data.name,
        sid,
        reconnectSecs: Math.floor(SESSION_TTL / 1000)
      });

      // Auto-pass if it's their turn
      if (room.state === 'playing' && room.currentTurn === sid) {
        setTimeout(() => {
          const r = rooms[roomId];
          if (!r || r.state !== 'playing' || r.currentTurn !== sid) return;
          if (getSocketBySid(sid)) return; // reconnected already
          r.passCount++;
          io.to(roomId).emit('player_passed', { playerSid: sid });
          const active = r.players.filter(p => !(r.finishOrder || []).includes(p.sid));
          if (r.passCount >= active.length - 1) {
            r.lastPlay = []; r.lastPlayerId = null; r.passCount = 0;
            io.to(roomId).emit('table_cleared');
          }
          nextTurn(r);
          broadcastRoom(roomId);
          io.to(roomId).emit('turn_changed', { currentTurn: r.currentTurn });
        }, AUTO_PASS_DELAY);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Capsa server on :${PORT}`));
