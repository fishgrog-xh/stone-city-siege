const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const BOARD_SIZE = 11;

function isInStarLine(kRow, kCol, row, col) {
  const dr = row - kRow;
  const dc = col - kCol;
  return (dr === 0) || (dc === 0) || (Math.abs(dr) === Math.abs(dc));
}

function isTrapped(board, row, col) {
  const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
  for (let d of dirs) {
    const nr = row + d[0];
    const nc = col + d[1];
    if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] === null) {
      return false;
    }
  }
  return true;
}

function resetRoom(room) {
  room.stones = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(null));
  room.kings = { host: null, guest: null };
  room.phase = 'set-king';
  room.currentTurn = null;
  room.stoneCount = { host: 0, guest: 0 };
  room.moveCount = { host: 0, guest: 0 };
  room.gameOver = false;
  room.rematchVotes = { host: false, guest: false };
  if (room.resetTimer) clearTimeout(room.resetTimer);
}

const rooms = {};

io.on('connection', (socket) => {
  console.log('连接:', socket.id);

  socket.on('join-room', (roomId) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        players: [],
        host: null,
        guest: null,
        stones: Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(null)),
        kings: { host: null, guest: null },
        phase: 'set-king',
        currentTurn: null,
        stoneCount: { host: 0, guest: 0 },
        moveCount: { host: 0, guest: 0 },
        gameOver: false,
        rematchVotes: { host: false, guest: false },
        resetTimer: null,
      };
    }

    const room = rooms[roomId];
    if (room.players.length >= 2) {
      socket.emit('room-full');
      return;
    }

    socket.join(roomId);
    const role = room.players.length === 0 ? 'host' : 'guest';
    room.players.push(socket.id);
    room[role] = socket.id;
    socket.roomId = roomId;
    socket.role = role;

    socket.emit('room-joined', { roomId, role });

    if (room.players.length === 2) {
      room.phase = 'set-king';
      room.currentTurn = null;
      io.to(roomId).emit('phase-change', {
        phase: 'set-king',
        stones: room.stones,
        message: '请双方秘密设置国王位置（点击空格）'
      });
    } else {
      socket.emit('waiting-for-opponent');
    }
  });

  // 处理再来一局投票
  socket.on('rematch-vote', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.gameOver) return;
    const role = socket.role;
    room.rematchVotes[role] = true;
    socket.emit('rematch-voted', { role });
    
    // 通知对手有人投票了
    socket.to(roomId).emit('opponent-rematch-vote');
    
    // 检查双方是否都同意
    if (room.rematchVotes.host && room.rematchVotes.guest) {
      resetRoom(room);
      io.to(roomId).emit('phase-change', {
        phase: 'set-king',
        stones: room.stones,
        message: '双方同意再来一局！请重新设置国王'
      });
    }
  });

  socket.on('set-king', ({ roomId, row, col }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'set-king') return;
    const role = socket.role;
    if (room.stones[row][col] !== null) {
      socket.emit('error-message', '国王不能放在石头上');
      return;
    }
    room.kings[role] = { row, col };
    socket.emit('king-set-confirm', { row, col });
    console.log(`${role} 国王设置于 (${row},${col})`);

    socket.to(roomId).emit('opponent-king-set');

    if (room.kings.host && room.kings.guest) {
      room.phase = 'host-init-stones';
      room.currentTurn = 'host';
      room.stoneCount.host = 3;
      io.to(roomId).emit('phase-change', {
        phase: 'host-init-stones',
        currentTurn: 'host',
        stones: room.stones,
        message: '先手请在自己的国王米字方向上放置3个初始石头'
      });
    }
  });

  function handleGameOver(roomId, winner, reason) {
    const room = rooms[roomId];
    if (!room || room.gameOver) return;
    room.gameOver = true;
    room.rematchVotes = { host: false, guest: false };
    
    io.to(roomId).emit('game-over', {
      winner,
      reason,
      kingPositions: { host: room.kings.host, guest: room.kings.guest }
    });
  }

  socket.on('place-stone', ({ roomId, row, col }) => {
    const room = rooms[roomId];
    if (!room || room.gameOver) return;
    const role = socket.role;
    if (room.currentTurn !== role) {
      socket.emit('error-message', '还没轮到你');
      return;
    }

    if (room.stones[row][col] !== null) {
      socket.emit('error-message', '该位置已有石头');
      return;
    }

    const king = room.kings[role];
    if (!king) {
      socket.emit('error-message', '国王未设置');
      return;
    }
    
    if (king.row === row && king.col === col) {
      socket.emit('error-message', '不能将石头放在己方国王上');
      return;
    }

    if (!isInStarLine(king.row, king.col, row, col)) {
      socket.emit('error-message', '石头必须放在国王的米字方向线上');
      return;
    }

    const opponentRole = role === 'host' ? 'guest' : 'host';
    const oppKing = room.kings[opponentRole];
    if (oppKing && oppKing.row === row && oppKing.col === col) {
      handleGameOver(roomId, role, '精准定位！');
      return;
    }

    room.stones[row][col] = role;
    room.stoneCount[role]--;
    const remaining = room.stoneCount[role];

    io.to(roomId).emit('stone-placed', {
      row, col,
      owner: role,
      stones: room.stones,
      placedBy: role
    });

    if (room.phase === 'host-init-stones' && remaining === 0) {
      room.phase = 'guest-first-move';
      room.currentTurn = 'guest';
      room.moveCount.guest = 3;
      const guestKing = room.kings.guest;
      if (isTrapped(room.stones, guestKing.row, guestKing.col)) {
        handleGameOver(roomId, 'host', '后手初始困毙');
        return;
      }
      io.to(roomId).emit('phase-change', {
        phase: 'guest-first-move',
        currentTurn: 'guest',
        moveCount: 3,
        message: '后手首个回合：请移动国王3步'
      });
    } else if (room.phase === 'guest-first-place' && remaining === 0) {
      room.phase = 'standard-move';
      room.currentTurn = 'host';
      room.moveCount.host = 3;
      const hostKing = room.kings.host;
      if (isTrapped(room.stones, hostKing.row, hostKing.col)) {
        handleGameOver(roomId, 'guest', '先手困毙');
        return;
      }
      io.to(roomId).emit('phase-change', {
        phase: 'standard-move',
        currentTurn: 'host',
        moveCount: 3,
        message: '标准回合开始：先手请移动国王3步'
      });
    } else if (room.phase === 'standard-place' && remaining === 0) {
      const nextPlayer = role === 'host' ? 'guest' : 'host';
      room.phase = 'standard-move';
      room.currentTurn = nextPlayer;
      room.moveCount[nextPlayer] = 3;
      const nextKing = room.kings[nextPlayer];
      if (isTrapped(room.stones, nextKing.row, nextKing.col)) {
        handleGameOver(roomId, role, '十字困毙');
        return;
      }
      io.to(roomId).emit('phase-change', {
        phase: 'standard-move',
        currentTurn: nextPlayer,
        moveCount: 3,
        message: `${nextPlayer === 'host' ? '先手' : '后手'}请移动国王3步`
      });
    } else {
      io.to(roomId).emit('stone-count-update', { role, remaining });
    }
  });

  socket.on('finish-move', ({ roomId, finalRow, finalCol, path }) => {
    const room = rooms[roomId];
    if (!room || room.gameOver) return;
    const role = socket.role;
    const isFirstMove = (room.phase === 'guest-first-move');
    const isStandardMove = (room.phase === 'standard-move');
    if ((!isFirstMove && !isStandardMove) || room.currentTurn !== role) {
      socket.emit('error-message', '现在不能结束移动');
      return;
    }

    if (!path || path.length !== 4) {
      socket.emit('error-message', '必须移动恰好3步');
      return;
    }

    if (room.stones[finalRow][finalCol] !== null) {
      socket.emit('error-message', '终点不能有石头');
      return;
    }

    for (let i = 1; i < path.length; i++) {
      const prev = path[i-1];
      const curr = path[i];
      const dr = Math.abs(prev.row - curr.row);
      const dc = Math.abs(prev.col - curr.col);
      if ((dr !== 1 || dc !== 0) && (dr !== 0 || dc !== 1)) {
        socket.emit('error-message', '只能十字方向移动');
        return;
      }
      if (room.stones[curr.row][curr.col] !== null) {
        socket.emit('error-message', '移动路径上不能有石头');
        return;
      }
    }

    room.kings[role] = { row: finalRow, col: finalCol };
    console.log(`${role} 国王移动到 (${finalRow},${finalCol})`);

    if (isFirstMove) {
      room.phase = 'guest-first-place';
    } else {
      room.phase = 'standard-place';
    }
    room.stoneCount[role] = 3;

    io.to(roomId).emit('move-finished', {
      player: role,
      phase: room.phase,
      currentTurn: role,
      stoneCount: 3,
      message: `${role === 'host' ? '先手' : '后手'}移动完成，请放置3个石头`
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      room.players = room.players.filter(id => id !== socket.id);
      if (room.players.length === 0) {
        if (room.resetTimer) clearTimeout(room.resetTimer);
        delete rooms[roomId];
      } else {
        io.to(roomId).emit('opponent-left');
      }
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));