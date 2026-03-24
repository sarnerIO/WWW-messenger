// Добавим глобальные переменные
let currentEditMessageId = null;
let mediaRecorder;
let audioChunks = [];
let isRecording = false;

// В функции init добавим обработчики
function setupEventListeners() {
  // ... существующие обработчики
  document.getElementById('file-btn').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', uploadFile);
  document.getElementById('voice-btn').addEventListener('click', toggleVoiceRecording);
  document.getElementById('chat-info-btn').addEventListener('click', showChatInfo);
  document.getElementById('copy-invite-btn').addEventListener('click', copyInviteLink);
  document.getElementById('save-edit-btn').addEventListener('click', saveEditedMessage);
  document.getElementById('promote-member').addEventListener('click', promoteMember);
  document.getElementById('kick-member').addEventListener('click', kickMember);
}

// Загрузка файла
async function uploadFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/upload', { method: 'POST', body: formData });
  const { filePath, originalName } = await res.json();
  sendMessageWithFile(filePath, originalName);
}

function sendMessageWithFile(filePath, originalName) {
  const message = {
    roomId: currentRoom.id,
    userId: currentUser.id,
    content: originalName,
    type: 'file',
    filePath
  };
  socket.emit('send-message', message);
}

// Голосовые сообщения
function toggleVoiceRecording() {
  if (isRecording) {
    mediaRecorder.stop();
    document.getElementById('voice-btn').classList.remove('recording');
    isRecording = false;
  } else {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          const formData = new FormData();
          formData.append('file', audioBlob, 'voice.webm');
          fetch('/upload', { method: 'POST', body: formData })
            .then(res => res.json())
            .then(({ filePath }) => {
              sendMessageWithFile(filePath, 'Голосовое сообщение');
            });
          stream.getTracks().forEach(track => track.stop());
        };
        mediaRecorder.start();
        document.getElementById('voice-btn').classList.add('recording');
        isRecording = true;
      });
  }
}

// Редактирование сообщения (долгое нажатие)
function setupMessageContextMenu() {
  messagesDiv.addEventListener('contextmenu', (e) => {
    const messageDiv = e.target.closest('.message');
    if (!messageDiv) return;
    e.preventDefault();
    const messageId = messageDiv.dataset.id;
    const messageContent = messageDiv.querySelector('.message-bubble').innerText;
    if (messageDiv.classList.contains('message-own')) {
      currentEditMessageId = messageId;
      document.getElementById('edit-message-input').value = messageContent;
      document.getElementById('edit-message-modal').classList.remove('hidden');
    }
  });
}

async function saveEditedMessage() {
  const newContent = document.getElementById('edit-message-input').value;
  await fetch(`/messages/${currentEditMessageId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: currentUser.id, content: newContent })
  });
  document.getElementById('edit-message-modal').classList.add('hidden');
}

// Умные уведомления
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission !== 'denied') {
    Notification.requestPermission();
  }
}

function showNotification(title, body) {
  if (Notification.permission === 'granted' && document.hidden) {
    new Notification(title, { body });
  }
}

// При получении нового сообщения
socket.on('new-message', (message) => {
  addMessageToChat(message);
  if (message.room_id === currentRoom?.id) {
    appendMessageToDOM(message);
  } else {
    showNotification('Новое сообщение', message.content);
  }
});

// Приглашения
async function showChatInfo() {
  const res = await fetch(`/rooms/${currentRoom.id}/info?userId=${currentUser.id}`);
  const info = await res.json();
  document.getElementById('invite-link').value = `${window.location.origin}/join/${info.inviteCode}`;
  document.getElementById('chat-members-list').innerHTML = info.members.map(m => `<div>${m.username} (${m.role})</div>`).join('');
  if (info.canModerate) {
    document.getElementById('moderation-section').classList.remove('hidden');
    const select = document.getElementById('member-select');
    select.innerHTML = info.members.filter(m => m.id !== currentUser.id).map(m => `<option value="${m.id}">${m.username}</option>`).join('');
  }
  document.getElementById('chat-info-modal').classList.remove('hidden');
}

async function copyInviteLink() {
  const link = document.getElementById('invite-link');
  link.select();
  document.execCommand('copy');
}

async function promoteMember() {
  const memberId = document.getElementById('member-select').value;
  await fetch(`/rooms/${currentRoom.id}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: currentUser.id, targetId: memberId, role: 'moderator' })
  });
  showChatInfo(); // обновить
}

async function kickMember() {
  const memberId = document.getElementById('member-select').value;
  await fetch(`/rooms/${currentRoom.id}/kick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: currentUser.id, targetId: memberId })
  });
  showChatInfo();
}

// Шифрование (простейшее симметричное, ключ по паролю)
let encryptionKey = null;

async function setEncryptionKey(password) {
  const encoder = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  encryptionKey = await window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('salt'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}

async function encryptMessage(text) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, encryptionKey, encoded
  );
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) };
}

async function decryptMessage(encryptedObj) {
  const iv = new Uint8Array(encryptedObj.iv);
  const data = new Uint8Array(encryptedObj.data);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, encryptionKey, data
  );
  return new TextDecoder().decode(decrypted);
}

// В sendMessage перед отправкой шифруем, если ключ установлен
async function sendMessage() {
  let text = messageInput.value.trim();
  if (!text || !currentRoom) return;
  let finalText = text;
  if (encryptionKey) {
    const encrypted = await encryptMessage(text);
    finalText = JSON.stringify(encrypted);
  }
  const message = {
    roomId: currentRoom.id,
    userId: currentUser.id,
    content: finalText,
    type: 'text',
    isEncrypted: !!encryptionKey
  };
  socket.emit('send-message', message);
  messageInput.value = '';
  // локальное добавление
  const localMsg = { ...message, timestamp: new Date().toISOString(), id: Date.now() };
  addMessageToChat(localMsg);
  appendMessageToDOM(localMsg);
  updateChatPreview(currentRoom.id, text);
  // ripple эффект
  sendBtn.classList.add('ripple');
  setTimeout(() => sendBtn.classList.remove('ripple'), 200);
}

// При получении сообщения расшифровываем
socket.on('new-message', async (message) => {
  if (message.type === 'text' && message.isEncrypted && encryptionKey) {
    try {
      const encrypted = JSON.parse(message.content);
      message.content = await decryptMessage(encrypted);
    } catch (e) {
      message.content = '[Зашифрованное сообщение]';
    }
  }
  addMessageToChat(message);
  if (message.room_id === currentRoom?.id) {
    appendMessageToDOM(message);
  } else {
    showNotification('Новое сообщение', message.content);
  }
});

// Регистрация с email
async function registerWithEmail() {
  const email = document.getElementById('reg-email').value;
  const username = document.getElementById('reg-username').value;
  const password = document.getElementById('reg-password').value;
  const code = document.getElementById('reg-code').value;
  const res = await fetch('/verify-and-register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, username, password })
  });
  if (res.ok) {
    const data = await res.json();
    currentUser = data;
    localStorage.setItem('userId', data.userId);
    localStorage.setItem('username', data.username);
    await connectSocket();
    loadRooms();
    showMessenger();
  } else {
    const err = await res.json();
    document.querySelector('#register-form .error-message').textContent = err.error;
  }
}

// В HTML добавьте поля email и код в форму регистрации
