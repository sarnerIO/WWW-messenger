const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(16).toString('hex');
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Подключение к SQLite
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) console.error(err.message);
  console.log('Connected to SQLite database.');
});

// Создание таблиц
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    email TEXT,
    password TEXT,
    role TEXT DEFAULT 'user',
    online INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT,
    type TEXT,
    created_by TEXT,
    is_private INTEGER DEFAULT 0,
    invite_code TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT,
    user_id TEXT,
    role TEXT DEFAULT 'member',
    PRIMARY KEY (room_id, user_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT,
    user_id TEXT,
    content TEXT,
    type TEXT,
    file_path TEXT,
    is_encrypted INTEGER DEFAULT 0,
    edited INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
    email TEXT PRIMARY KEY,
    code TEXT,
    expires DATETIME
  )`);
});

// Хранилище активных сокетов
const usersSockets = new Map();

// Генерация ID пользователя
function generateUserId(username) {
  return `${username}#${Math.floor(Math.random() * 10000)}`;
}

// Проверка глобального администратора
function isGlobalAdmin(userId, callback) {
  db.get('SELECT role FROM users WHERE id = ?', [userId], (err, row) => {
    callback(err ? false : row && row.role === 'admin');
  });
}

// Отправка email через Resend
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendVerificationEmail(email, code) {
  await resend.emails.send({
    from: 'onboarding@resend.dev',
    to: email,
    subject: 'Подтверждение регистрации в WWW',
    html: `<p>Ваш код подтверждения: <strong>${code}</strong></p>`
  });
}

// API: отправка кода
app.post('/send-verification', async (req, res) => {
  const { email } = req.body;
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 10 * 60000).toISOString(); // 10 минут
  db.run('INSERT OR REPLACE INTO email_verifications (email, code, expires) VALUES (?, ?, ?)',
    [email, code, expires], async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      try {
        await sendVerificationEmail(email, code);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Failed to send email' });
      }
    });
});

// API: проверка кода и регистрация
app.post('/verify-and-register', async (req, res) => {
  const { email, code, username, password } = req.body;
  db.get('SELECT * FROM email_verifications WHERE email = ? AND code = ? AND expires > datetime("now")',
    [email, code], async (err, row) => {
      if (err || !row) return res.status(400).json({ error: 'Invalid or expired code' });
      const hashedPassword = await bcrypt.hash(password, 10);
      const userId = generateUserId(username);
      db.run('INSERT INTO users (id, username, email, password) VALUES (?, ?, ?, ?)',
        [userId, username, email, hashedPassword], function(err) {
          if (err) return res.status(400).json({ error: 'Username already exists' });
          db.run('DELETE FROM email_verifications WHERE email = ?', [email]);
          res.json({ userId, username });
        });
    });
});

// Остальные API (логин, поиск и т.д.) остаются, но с учётом бана
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.is_banned) return res.status(403).json({ error: 'You are banned' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ userId: user.id, username: user.username, role: user.role });
  });
});

// Загрузка файла
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ filePath: `/uploads/${req.file.filename}`, originalName: req.file.originalname });
});

// Создание приватной комнаты с invite-кодом
app.post('/create-private-room', (req, res) => {
  const { name, creatorId, inviteCode } = req.body;
  const roomId = `private_${Date.now()}`;
  const code = inviteCode || crypto.randomBytes(4).toString('hex');
  db.run('INSERT INTO rooms (id, name, type, created_by, is_private, invite_code) VALUES (?, ?, ?, ?, ?, ?)',
    [roomId, name, 'private', creatorId, 1, code], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.run('INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)', [roomId, creatorId, 'admin']);
      res.json({ roomId, inviteCode: code });
    });
});

// Присоединение по invite-коду
app.post('/join-by-invite', (req, res) => {
  const { inviteCode, userId } = req.body;
  db.get('SELECT id FROM rooms WHERE invite_code = ?', [inviteCode], (err, room) => {
    if (err || !room) return res.status(404).json({ error: 'Invalid invite code' });
    db.run('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)', [room.id, userId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ roomId: room.id });
    });
  });
});

// Удаление сообщения (только для автора, модератора или глобального админа)
app.delete('/messages/:messageId', (req, res) => {
  const { messageId } = req.params;
  const { userId } = req.body;
  db.get('SELECT * FROM messages WHERE id = ?', [messageId], (err, msg) => {
    if (err || !msg) return res.status(404).json({ error: 'Message not found' });
    isGlobalAdmin(userId, (isAdmin) => {
      if (isAdmin || msg.user_id === userId) {
        db.run('DELETE FROM messages WHERE id = ?', [messageId]);
        io.emit('message-deleted', messageId);
        res.json({ success: true });
      } else {
        db.get('SELECT role FROM room_members WHERE room_id = ? AND user_id = ?', [msg.room_id, userId], (err, member) => {
          if (member && (member.role === 'admin' || member.role === 'moderator')) {
            db.run('DELETE FROM messages WHERE id = ?', [messageId]);
            io.emit('message-deleted', messageId);
            res.json({ success: true });
          } else {
            res.status(403).json({ error: 'Not allowed' });
          }
        });
      }
    });
  });
});

// Редактирование сообщения
app.put('/messages/:messageId', (req, res) => {
  const { messageId } = req.params;
  const { userId, content } = req.body;
  db.get('SELECT * FROM messages WHERE id = ? AND user_id = ?', [messageId, userId], (err, msg) => {
    if (err || !msg) return res.status(404).json({ error: 'Message not found or not yours' });
    db.run('UPDATE messages SET content = ?, edited = 1 WHERE id = ?', [content, messageId]);
    io.emit('message-edited', { id: messageId, content });
    res.json({ success: true });
  });
});

// Бан пользователя (только глобальный админ)
app.post('/ban-user', (req, res) => {
  const { adminId, userIdToBan } = req.body;
  isGlobalAdmin(adminId, (isAdmin) => {
    if (!isAdmin) return res.status(403).json({ error: 'Only global admin can ban' });
    db.run('UPDATE users SET is_banned = 1 WHERE id = ?', [userIdToBan]);
    // Разорвать соединение
    const socketId = usersSockets.get(userIdToBan);
    if (socketId) io.to(socketId).emit('banned');
    res.json({ success: true });
  });
});

// Socket.io
io.on('connection', (socket) => {
  let currentUserId = null;

  socket.on('register-user', (userId) => {
    currentUserId = userId;
    usersSockets.set(userId, socket.id);
    db.run('UPDATE users SET online = 1 WHERE id = ?', [userId]);
    io.emit('user-online', userId);
  });

  socket.on('send-message', async (data) => {
    const { roomId, userId, content, type, filePath } = data;
    // Проверка бана
    db.get('SELECT is_banned FROM users WHERE id = ?', [userId], (err, user) => {
      if (err || user?.is_banned) return;
      db.run('INSERT INTO messages (room_id, user_id, content, type, file_path) VALUES (?, ?, ?, ?, ?)',
        [roomId, userId, content, type, filePath], function(err) {
          if (err) return;
          const message = {
            id: this.lastID,
            room_id: roomId,
            user_id: userId,
            content,
            type,
            file_path: filePath,
            edited: 0,
            timestamp: new Date().toISOString()
          };
          db.all('SELECT user_id FROM room_members WHERE room_id = ?', [roomId], (err, members) => {
            members.forEach(m => {
              const memberSocketId = usersSockets.get(m.user_id);
              if (memberSocketId) io.to(memberSocketId).emit('new-message', message);
            });
          });
        });
    });
  });

  socket.on('typing', (data) => {
    const { roomId, userId, isTyping } = data;
    db.all('SELECT user_id FROM room_members WHERE room_id = ?', [roomId], (err, members) => {
      members.forEach(m => {
        if (m.user_id !== userId) {
          const memberSocketId = usersSockets.get(m.user_id);
          if (memberSocketId) io.to(memberSocketId).emit('user-typing', { roomId, userId, isTyping });
        }
      });
    });
  });

  socket.on('disconnect', () => {
    if (currentUserId) {
      usersSockets.delete(currentUserId);
      db.run('UPDATE users SET online = 0 WHERE id = ?', [currentUserId]);
      io.emit('user-offline', currentUserId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
