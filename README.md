# 🤖 Discord General Chat Tracker Bot

Sistem pelacak keaktifan **General Chat** Discord berbasis **Node.js (`discord.js` v14) + SQLite** yang dirancang khusus untuk memantau keaktifan Admin/Staff/Role tertentu beserta **bukti log pesan**, **filter minimal 4 kata + anti-spam**, **target harian (misal 100 pesan/hari)**, dan **pengiriman log lintas server**.

---

## ✨ Fitur Utama

1. **Pelacakan Role & User Tertentu (`/target-role` & `/target-user`)**
   - Hanya melacak member yang memiliki role yang terdaftar atau user spesifik yang kamu tentukan.
2. **Filter Channel Spesifik (`/channel`)**
   - Bisa dikunci agar hanya menghitung pesan di `#general-chat` (atau beberapa channel yang kamu pilih).
3. **Syarat Minimal 4 Kata & Anti-Spam Pintar**
   - Pesan di bawah 4 kata otomatis diabaikan.
   - Link (`https://...`), mention (`@user`), dan emoji tidak dihitung sebagai kata.
   - Mengabaikan command bot (`!`, `/`, `.`, dll), kata berulang (`"tes tes tes tes"`), huruf sampah (`"a b c d"`), dan copy-paste kalimat duplikat beruntun.
4. **Target Harian (Default: 100 Pesan/Hari)**
   - Dilengkapi indikator progress bar visual (`[██████░░░░] 60/100 (60%)`) yang otomatis reset setiap pukul `00:00 WIB`.
   - Bisa diubah kapan saja lewat `/config daily-target jumlah:100`.
5. **Bukti Log Lintas Server (Tetap Berjalan Walau Server Log Belum Diset)**
   - Seluruh pesan valid langsung tersimpan di database lokal (`data/tracker.db`) lengkap dengan isi pesan dan **Link Bukti Pesan Discord**.
   - Jika channel di **Server Khusus Log** sudah diset (`/config set-log-channel`), bot akan mengirim bukti log real-time beserta tombol **"🔗 Lihat Bukti Pesan di Discord"** dan notifikasi saat target harian tercapai.
   - Kamu bisa mengecek `/stats`, `/leaderboard`, `/logs`, dan `/export` langsung dari dalam **Server Khusus Log** tanpa terlihat oleh member di server utama!

---

## 🚀 Cara Menjalankan Bot

### 1. Persiapan di Discord Developer Portal
1. Buka [Discord Developer Portal](https://discord.com/developers/applications) dan pilih aplikasi bot kamu.
2. Masuk ke menu **Bot**, lalu **WAJIB aktifkan** kedua opsi di bagian *Privileged Gateway Intents*:
   - ✅ **SERVER MEMBERS INTENT**
   - ✅ **MESSAGE CONTENT INTENT**
3. Salin **Token** bot kamu dan **Application ID (Client ID)**.
4. Undang bot ke **Server Utama** dan (jika sudah ada) ke **Server Khusus Log**.

### 2. Konfigurasi File `.env`
Salin file `.env.example` menjadi `.env`:
```powershell
Copy-Item .env.example .env
```
Lalu isi `DISCORD_TOKEN`, `CLIENT_ID`, dan `OWNER_IDS` (User ID Discord kamu) di dalam file `.env`.

### 3. Jalankan Bot
```powershell
npm start
```
*(Slash Commands akan otomatis terdaftar saat bot menyala).*

---

## 📋 Daftar Slash Commands

| Command | Fungsi |
| :--- | :--- |
| `/config view` | Melihat seluruh pengaturan aktif (Server Utama, Channel Log, Target Harian, Role, Channel) |
| `/config set-main-server` | Mengunci Server Utama yang dilacak |
| `/config set-log-channel` | Mengatur channel pengiriman bukti log (bisa dijalankan di **Server Khusus Log** atau ketik `off` untuk mematikan) |
| `/config daily-target jumlah:100` | Mengatur target jumlah pesan per hari (misal `100` pesan/hari) |
| `/config min-words jumlah:4` | Mengatur syarat minimal kata per pesan (default `4` kata) |
| `/config anti-monolog [cooldown_detik] [max_beruntun]` | Mengatur **Filter Anti-Monolog & Cooldown** (default: jeda `5 detik` & maks `3 pesan` beruntun tanpa diselingi orang lain) |
| `/config auto-recap status:on/off` | Mengatur pengiriman **Laporan Tutup Buku Harian + CSV otomatis** setiap pukul `00:00 WIB` ke Server Log |
| `/config reminder status:on/off [jam] [channel_id]` | Mengatur **Auto-Reminder Malam Hari** (default pukul `20:00 WIB`) untuk me-mention anggota yang belum mencapai target |
| `/command-role add / remove / list` | **Mengatur Role mana saja yang diizinkan memakai command bot** (Member biasa otomatis ditolak) |
| `/target-role add / remove / list` | Menambah, menghapus, atau melihat daftar Role yang dilacak chatnya |
| `/target-user add / remove / list` | Menambah, menghapus, atau melihat daftar User spesifik yang dilacak |
| `/channel add / remove / list` | Mengatur channel `#general-chat` mana saja yang dihitung |
| `/stats [user] [tanggal]` | Melihat progress target harian (`X/100`), total mingguan/keseluruhan, & 5 bukti pesan terakhir |
| `/monitor [periode] [tanggal]` | Memantau ketuntasan target & keaktifan General Chat secara internal (`Hari Ini`, `7 Hari`, `Bulan Ini`, `Semua Waktu`, termasuk anggota yang masih 0 pesan) |
| `/logs [user] [tanggal] [jumlah]` | Melihat daftar bukti log pesan lengkap dengan isi chat & link bukti |
| `/export [tanggal] [user]` | Mengunduh laporan bukti log lengkap dalam bentuk file `.csv` (Excel / Google Sheets) |
| `/reset <cakupan> [user]` | Mereset data perhitungan (`today`, `user`, atau `all`) |

