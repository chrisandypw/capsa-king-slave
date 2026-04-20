# ♠ Capsa King & Slave — Online Multiplayer

Game kartu Capsa Banting dengan sistem King & Slave yang bisa dimainkan online bersama teman-teman.

## 🎮 Fitur
- Multiplayer real-time (2–4 pemain)
- Sistem posisi: Raja 👑 → Menteri 🤵 → Rakyat 🧑 → Budak 🔗
- Tukar kartu otomatis antar ronde (King & Slave)
- Chat real-time
- Papan skor per ronde
- Desain meja poker yang immersive

## 🃏 Cara Main
1. Masukkan nama → **Buat Room** atau masukkan kode untuk **Masuk**
2. Bagikan kode room ke teman
3. Host klik **Mulai Game** (min. 2 pemain)
4. Yang punya **3♦** main duluan
5. Buang kombinasi yang lebih tinggi atau **Pass**
6. Yang habis kartu pertama = **Raja**, terakhir = **Budak**

## 🏆 Sistem King & Slave
| Posisi | Skor | Tukar Kartu |
|--------|------|-------------|
| Raja 👑 | +3 | Terima 2 kartu terbaik dari Budak |
| Menteri 🤵 | +1 | Terima 1 kartu terbaik dari Rakyat |
| Rakyat 🧑 | -1 | Kasih 1 kartu terbaik ke Menteri |
| Budak 🔗 | -3 | Kasih 2 kartu terbaik ke Raja |

## 🚀 Deploy ke Railway (Gratis)

### Langkah 1 — Push ke GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/USERNAME/capsa-king-slave.git
git push -u origin main
```

### Langkah 2 — Deploy di Railway
1. Buka [railway.app](https://railway.app) → Login dengan GitHub
2. Klik **New Project** → **Deploy from GitHub repo**
3. Pilih repo `capsa-king-slave`
4. Railway otomatis detect Node.js & deploy!
5. Klik **Generate Domain** → dapat URL publik

### Alternatif: Render.com (Gratis)
1. Buka [render.com](https://render.com) → Login dengan GitHub
2. **New** → **Web Service** → pilih repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Klik **Create Web Service**

## 🛠 Jalankan Lokal
```bash
npm install
npm start
# Buka http://localhost:3000
```

## 📁 Struktur Project
```
capsa-king-slave/
├── server/
│   └── index.js        # Server + game logic (Socket.io)
├── public/
│   ├── index.html      # UI utama
│   ├── css/style.css   # Styling
│   └── js/game.js      # Client game logic
├── package.json
└── README.md
```
