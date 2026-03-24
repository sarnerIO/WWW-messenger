import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { Resend } from "resend";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

/* ========= ВСТАВЬ СЮДА СВОЙ API КЛЮЧ ========= */
const resend = new Resend("re_KJ7aAMrd_6GLczU4g7JX3Hpnq7gLnte6W");

/* ========= ВРЕМЕННЫЕ ХРАНИЛИЩА ========= */
let codes = {};
let users = [];

/* ========= ОТПРАВКА КОДА ========= */
app.post("/send-code", async (req, res) => {
  const { email } = req.body;

  const code = Math.floor(100000 + Math.random() * 900000);

  codes[email] = {
    code,
    expires: Date.now() + 5 * 60 * 1000
  };

  try {
    await resend.emails.send({
      from: "WWW <onboarding@resend.dev>",
      to: email,
      subject: "Код входа WWW",
      html: `<h2>Ваш код: ${code}</h2>`
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Ошибка отправки" });
  }
});

/* ========= ПРОВЕРКА КОДА ========= */
app.post("/verify-code", (req, res) => {
  const { email, code } = req.body;

  const record = codes[email];

  if (!record) return res.status(400).json({ error: "Код не найден" });

  if (record.expires < Date.now()) {
    return res.status(400).json({ error: "Код истёк" });
  }

  if (record.code != code) {
    return res.status(400).json({ error: "Неверный код" });
  }

  res.json({ success: true });
});

/* ========= СОЗДАНИЕ АККАУНТА ========= */
app.post("/complete", (req, res) => {
  const { email, username } = req.body;

  const user = {
    email,
    username,
    role: "user"
  };

  users.push(user);

  res.json({ success: true });
});

/* ========= ЧАТ ========= */
io.on("connection", (socket) => {
  socket.on("send_message", (data) => {
    io.emit("receive_message", data);
  });
});

app.get("/", (req, res) => {
  res.send("WWW server работает");
});

server.listen(3000, () => {
  console.log("Server running");
});
