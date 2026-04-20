const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Game State ───────────────────────────────────────────────────────────────
const rooms = {}; // roomId -> Room

const SUITS = ['d', 'c', 'h', 's']; // diamonds, clubs, hearts, spades
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];

function createDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push({ rank, suit, id: `${rank}${suit}` });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardValue(card) {
  return RANKS.indexOf(card.rank) * 4 + SUITS.indexOf(card.suit);
}

function sortCards(cards) {
  return [...cards].sort((a, b) => cardValue(a) - cardValue(b));
}

function dealCards(deck, numPlayers) {
  const hands = Array.from({ length: numPlayers }, () => []);
  deck.forEach((card, i) => hands[i % numPlayers].push(card));
  return hands.map(sortCards);
}

// ─── Combination Validation ────────────────────────────────────────────────
function getComboType(cards) {
  if (!cards || cards.length === 0) return null;
  const n = cards.length;
  const sorted = sortCards(cards);

  if (n === 1) return { type: 'single', value: cardValue(sorted[0]) };

  if (n === 2) {
    if (sorted[0].rank === sorted[1].rank)
      return { type: 'pair', value: cardValue(sorted[1]) };
    return null;
  }

  if (n === 3) {
    if (sorted[0].rank === sorted[1].rank && sorted[1].rank === sorted[2].rank)
      return { type: 'triple', value: cardValue(sorted[2]) };
    return null;
  }

  if (n === 4) {
    const rankCounts = {};
    sorted.forEach(c => rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1);
    const counts = Object.values(rankCounts);
    if (counts.includes(4)) {
      const quadRank = Object.keys(rankCounts).find(r => rankCounts[r] === 4);
      return { type: 'four_of_a_kind', value: RANKS.indexOf(quadRank) * 4 + 3 };
    }
    return null;
  }

  if (n === 5) {
    const rankCounts = {};
    sorted.forEach(c => rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1);
    const counts = Object.values(rankCounts).sort((a, b) => b - a);
    const ranks = sorted.map(c => RANKS.indexOf(c.rank));
    const suits = sorted.map(c => c.suit);
    const isFlush = suits.every(s => s === suits[0]);
    const ranksSorted = [...ranks].sort((a, b) => a - b);
    const isStraight = ranksSorted.every((r, i) => i === 0 || r === ranksSorted[i-1] + 1);

    if (isFlush && isStraight)
      return { type: 'straight_flush', value: cardValue(sorted[4]) };

    if (counts[0] === 4) {
      const quadRank = Object.keys(rankCounts).find(r => rankCounts[r] === 4);
      return { type: 'bomb', value: RANKS.indexOf(quadRank) * 10 + 1000 };
    }

    if (counts[0] === 3 && counts[1] === 2) {
      const triRank = Object.keys(rankCounts).find(r => rankCounts[r] === 3);
      return { type: 'full_house', value: RANKS.indexOf(triRank) * 10 + 500 };
    }

    if (isFlush)
      return { type: 'flush', value: cardValue(sorted[4]) * 10 + suits.filter(s => s === suits[0]).length };

    if (isStraight)
      return { type: 'straight', value: cardValue(sorted[4]) };

    return null;
  }

  return null;
}

const COMBO_RANK = {
  'single': 1, 'pair': 2, 'triple': 3,
  'straight': 4, 'flush': 5, 'full_house': 6,
  'four_of_a_kind': 7, 'bomb': 8, 'straight_flush': 9
};

function isValidPlay(cards, lastPlay) {
  const combo = getComboType(cards);
  if (!combo) return { valid: false, reason: 'Kombinasi kartu tidak valid' };

  if (!lastPlay || lastPlay.length === 0) return { valid: true, combo };

  const lastCombo = getComboType(lastPlay);
  if (!lastCombo) return { valid: true, combo };

  // bombs beat everything except higher bombs/straight flushes
  if (combo.type === 'bomb' || combo.type === 'straight_flush') {
    if (lastCombo.type === 'bomb' || lastCombo.type === 'straight_flush') {
      if (COMBO_RANK[combo.type] > COMBO_RANK[lastCombo.type]) return { valid: true, combo };
      if (combo.type === lastCombo.type && combo.value > lastCombo.value) return { valid: true, combo };
      return { valid: false, reason: 'Nilai kartu terlalu kecil' };
    }
    return { valid: true, combo };
  }

  if (combo.type !== lastCombo.type)
    return { valid: false, reason: `Harus main ${lastCombo.type}` };

  if (cards.length !== lastPlay.length)
    return { valid: false, reason: 'Jumlah kartu harus sama' };

  if (combo.value > lastCombo.value) return { valid: true, combo };
  return { valid: false, reason: 'Nilai kartu terlalu kecil' };
}

// ─── Room Management ───────────────────────────────────────────────────────
function createRoom(roomId, hostId, hostName) {
  return {
    id: roomId,
    host: hostId,
    players: [{ id: hostId, name: hostName, ready: false }],
    state: 'waiting', // waiting | card_exchange | playing | round_end
    deck: [],
    hands: {},
    currentTurn: null,
    lastPlay: [],
    lastPlayerId: null,
    passCount: 0,
    positions: {}, // king, minister, peasant, slave
    exchangePending: {}, // for king-slave card exchange
    exchangeDone: {},
    turnOrder: [],
    scores: {},
    roundNum: 1,
    chat: []
  };
}

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  // Send each player their own hand (private), shared state to all
  room.players.forEach(p => {
    const socket = io.sockets.sockets.get(p.id);
    if (!socket) return;
    socket.emit('room_update', {
      ...room,
      hands: { [p.id]: room.hands[p.id] || [] }, // only own hand
      allHandCounts: Object.fromEntries(
        Object.entries(room.hands).map(([pid, h]) => [pid, h.length])
      )
    });
  });
}

function startGame(roomId) {
  const room = rooms[roomId];
  const players = room.players;
  const n = players.length;

  const deck = shuffleDeck(createDeck());
  const dealtHands = dealCards(deck, n);

  room.hands = {};
  players.forEach((p, i) => room.hands[p.id] = dealtHands[i]);
  room.deck = deck;
  room.lastPlay = [];
  room.lastPlayerId = null;
  room.passCount = 0;

  // Find who has 3♦ - they go first
  let firstPlayer = players[0].id;
  players.forEach(p => {
    if (room.hands[p.id].some(c => c.rank === '3' && c.suit === 'd')) {
      firstPlayer = p.id;
    }
  });

  // Set turn order starting from firstPlayer
  const firstIdx = players.findIndex(p => p.id === firstPlayer);
  room.turnOrder = [
    ...players.slice(firstIdx).map(p => p.id),
    ...players.slice(0, firstIdx).map(p => p.id)
  ];
  room.currentTurn = firstPlayer;
  room.state = 'playing';
  room.finishOrder = [];

  broadcastRoom(roomId);
  io.to(roomId).emit('game_started', { firstPlayer, roundNum: room.roundNum });
}

function doCardExchange(roomId) {
  const room = rooms[roomId];
  if (room.state !== 'card_exchange') return;

  const positions = room.positions;
  const findId = pos => Object.keys(positions).find(id => positions[id] === pos);
  
  const kingId = findId('king');
  const ministerId = findId('minister');
  const peasantId = findId('peasant');
  const slaveId = findId('slave');

  const hasAll = kingId && ministerId && peasantId && slaveId;
  const allDone = room.players.every(p => room.exchangeDone[p.id]);

  if (!hasAll || !allDone) return;

  // King gets 2 best from Slave, Slave gets 2 worst from King
  const slaveHand = sortCards(room.hands[slaveId]);
  const kingHand = sortCards(room.hands[kingId]);
  const ministHand = sortCards(room.hands[ministerId]);
  const peasHand = sortCards(room.hands[peasantId]);

  const slaveBest2 = slaveHand.slice(-2);
  const kingWorst2 = kingHand.slice(0, 2);
  const minBest1 = ministHand.slice(-1);
  const peasWorst1 = peasHand.slice(0, 1);

  // Remove exchanged cards
  room.hands[slaveId] = slaveHand.filter(c => !slaveBest2.find(x => x.id === c.id));
  room.hands[slaveId] = sortCards([...room.hands[slaveId], ...kingWorst2]);

  room.hands[kingId] = kingHand.filter(c => !kingWorst2.find(x => x.id === c.id));
  room.hands[kingId] = sortCards([...room.hands[kingId], ...slaveBest2]);

  room.hands[ministerId] = ministHand.filter(c => !minBest1.find(x => x.id === c.id));
  room.hands[ministerId] = sortCards([...room.hands[ministerId], ...peasWorst1]);

  room.hands[peasantId] = peasHand.filter(c => !peasWorst1.find(x => x.id === c.id));
  room.hands[peasantId] = sortCards([...room.hands[peasantId], ...minBest1]);

  // Start new round
  room.roundNum++;
  startGame(roomId);
}

function nextTurn(room) {
  const order = room.turnOrder;
  const idx = order.indexOf(room.currentTurn);
  let next = (idx + 1) % order.length;
  // Skip players who already finished
  let tries = 0;
  while (room.finishOrder.includes(order[next]) && tries < order.length) {
    next = (next + 1) % order.length;
    tries++;
  }
  room.currentTurn = order[next];
}

function checkRoundEnd(room) {
  const activePlayers = room.players.filter(p => !room.finishOrder.includes(p.id));
  if (activePlayers.length <= 1) {
    // Last player is the slave
    if (activePlayers.length === 1) {
      room.finishOrder.push(activePlayers[0].id);
    }

    const posLabels = ['king', 'minister', 'peasant', 'slave'];
    room.positions = {};
    room.finishOrder.forEach((id, i) => {
      room.positions[id] = posLabels[i] || 'slave';
    });

    // Update scores
    room.players.forEach(p => {
      if (!room.scores[p.id]) room.scores[p.id] = 0;
      const pos = room.positions[p.id];
      if (pos === 'king') room.scores[p.id] += 3;
      else if (pos === 'minister') room.scores[p.id] += 1;
      else if (pos === 'peasant') room.scores[p.id] -= 1;
      else if (pos === 'slave') room.scores[p.id] -= 3;
    });

    room.state = 'round_end';
    room.exchangeDone = {};
    room.exchangePending = {};

    broadcastRoom(room.id);
    io.to(room.id).emit('round_end', {
      positions: room.positions,
      finishOrder: room.finishOrder,
      scores: room.scores
    });
    return true;
  }
  return false;
}

// ─── Socket Events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('create_room', ({ name }) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomId] = createRoom(roomId, socket.id, name);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;
    socket.emit('room_created', { roomId });
    broadcastRoom(roomId);
  });

  socket.on('join_room', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { msg: 'Room tidak ditemukan' });
    if (room.state !== 'waiting') return socket.emit('error', { msg: 'Game sudah dimulai' });
    if (room.players.length >= 4) return socket.emit('error', { msg: 'Room penuh (maks 4 pemain)' });
    if (room.players.find(p => p.id === socket.id)) return;

    room.players.push({ id: socket.id, name, ready: false });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    io.to(roomId).emit('player_joined', { id: socket.id, name });
    broadcastRoom(roomId);
  });

  socket.on('set_ready', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.ready = !player.ready;
    broadcastRoom(roomId);
  });

  socket.on('start_game', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error', { msg: 'Minimal 2 pemain' });
    startGame(roomId);
  });

  socket.on('play_cards', ({ cards }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    if (room.currentTurn !== socket.id) return socket.emit('error', { msg: 'Bukan giliran kamu' });

    const hand = room.hands[socket.id];
    // Verify cards are in hand
    for (const card of cards) {
      if (!hand.find(c => c.id === card.id)) return socket.emit('error', { msg: 'Kartu tidak valid' });
    }

    const result = isValidPlay(cards, room.lastPlay);
    if (!result.valid) return socket.emit('error', { msg: result.reason });

    // Remove cards from hand
    room.hands[socket.id] = hand.filter(c => !cards.find(x => x.id === c.id));
    room.lastPlay = cards;
    room.lastPlayerId = socket.id;
    room.passCount = 0;

    io.to(roomId).emit('cards_played', {
      playerId: socket.id,
      cards,
      combo: result.combo
    });

    // Check if this player finished
    if (room.hands[socket.id].length === 0) {
      room.finishOrder.push(socket.id);
      io.to(roomId).emit('player_finished', {
        playerId: socket.id,
        position: room.finishOrder.length
      });

      if (checkRoundEnd(room)) return;

      // Reset table if player who finished was last to play
      room.lastPlay = [];
      room.lastPlayerId = null;
    }

    nextTurn(room);
    broadcastRoom(roomId);
    io.to(roomId).emit('turn_changed', { currentTurn: room.currentTurn });
  });

  socket.on('pass_turn', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    if (room.currentTurn !== socket.id) return socket.emit('error', { msg: 'Bukan giliran kamu' });
    if (room.lastPlay.length === 0) return socket.emit('error', { msg: 'Tidak bisa pass di awal giliran' });

    room.passCount++;
    io.to(roomId).emit('player_passed', { playerId: socket.id });

    // Count active players
    const activePlayers = room.players.filter(p => !room.finishOrder.includes(p.id));
    
    // If all other active players passed, clear the table
    if (room.passCount >= activePlayers.length - 1) {
      room.lastPlay = [];
      room.lastPlayerId = null;
      room.passCount = 0;
      io.to(roomId).emit('table_cleared', { nextPlayer: room.lastPlayerId || socket.id });
    }

    nextTurn(room);
    broadcastRoom(roomId);
    io.to(roomId).emit('turn_changed', { currentTurn: room.currentTurn });
  });

  socket.on('ready_next_round', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.state !== 'round_end') return;
    room.exchangeDone[socket.id] = true;
    broadcastRoom(roomId);

    if (room.players.every(p => room.exchangeDone[p.id])) {
      room.state = 'card_exchange';
      broadcastRoom(roomId);
      doCardExchange(roomId);
    }
  });

  socket.on('send_chat', ({ msg }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    const name = socket.data.name || 'Unknown';
    const chatMsg = { name, msg, time: Date.now() };
    room.chat.push(chatMsg);
    if (room.chat.length > 50) room.chat.shift();
    io.to(roomId).emit('chat_message', chatMsg);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    room.players = room.players.filter(p => p.id !== socket.id);
    delete room.hands[socket.id];

    if (room.players.length === 0) {
      delete rooms[roomId];
      return;
    }

    if (room.host === socket.id) room.host = room.players[0].id;

    io.to(roomId).emit('player_left', { id: socket.id, name: socket.data.name });
    if (room.state === 'playing') {
      // If it was their turn, move on
      if (room.currentTurn === socket.id) {
        nextTurn(room);
        io.to(roomId).emit('turn_changed', { currentTurn: room.currentTurn });
      }
      room.turnOrder = room.turnOrder.filter(id => id !== socket.id);
    }
    broadcastRoom(roomId);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Capsa server running on port ${PORT}`));
