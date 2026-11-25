# IndoSub + TTS (YouTube, Udemy & All Video)

Ekstensi browser (Chrome / Edge / Brave — Manifest V3) untuk menerjemahkan subtitle video berbahasa Inggris ke bahasa Indonesia secara otomatis di **YouTube, Udemy, Coursera, edX, Vimeo, dan situs video HTML5 lainnya**, lengkap dengan **Text-to-Speech (Dubbing Bahasa Indonesia)**, **Auto Deteksi Kecepatan TTS**, dan **Penghilang Vokal Asli**.

## Fitur Utama

- **Multi-Platform Video**: mendukung YouTube (`timedtext`), Udemy, Coursera, edX, Vimeo, Pluralsight, Skillshare, Netflix, serta pemutar HTML5 `<video>` (WebVTT `.vtt`, `.srt`, TTML, dan `TextTrack`).
- **Filter Tag Non-Dialog Otomatis**: membersihkan tag seperti `[Music]`, `[musik]`, `[Applause]`, `(laughter)`, `>>`, dan `♪` agar tidak ikut dibacakan oleh suara TTS.
- **Dual Subtitle (Inggris + Indonesia)** atau hanya Indonesia, diterjemahkan secara progresif mulai dari detik video saat ini.
- **Text-to-Speech (Dubbing Bahasa Indonesia)** gratis tanpa API key dengan beberapa pilihan suara:
  - **Google — Wanita** (cepat & stabil)
  - **Putra — Pria Indonesia** (natural)
  - **Darma — Pria Indonesia** (hangat)
  - **Noor — Wanita Indonesia** (natural)
  - **Browser / Sistem TTS** (otomatis mendeteksi semua suara yang terpasang di browser/OS)
- **Auto Deteksi Kecepatan TTS**: otomatis menyesuaikan kecepatan suara agar sinkron dengan tempo pembicara (dengan `preservesPitch` agar suara tetap natural dan *anti-cutoff grace* agar akhir kata tidak terpotong).
- **Hilangkan Vokal Asli (BGM & SFX Tetap Ada)**: menggunakan Web Audio API 3-Band Mid/Side DSP secara real-time untuk meredam suara pembicara asli di kanal tengah sementara musik latar, bass, dan efek suara stereo tetap terdengar.
- **Auto Audio Ducking**: otomatis memelankan volume video asli saat dubbing aktif (ketika mode Hilangkan Vokal Asli tidak aktif) dan mengembalikannya saat dubbing dimatikan atau video dijeda.
- **Tombol Cepat di Player YouTube**: toggle **`ID`** dan **`TTS`** langsung di bar kontrol kanan YouTube.

## Cara Instalasi (Load Unpacked)

1. Clone atau download repository ini:
   ```bash
   git clone https://github.com/23041450154/teks-to-spech-english-to-indo-youtube-translation.git
   ```
2. Buka `chrome://extensions` (atau `brave://extensions` / `edge://extensions`).
3. Aktifkan **Developer mode** di pojok kanan atas.
4. Klik **Load unpacked** dan pilih folder repository ini.
5. Buka video YouTube berbahasa Inggris (yang memiliki caption/auto-caption) dan refresh halamannya.

## Struktur File

- `manifest.json` — Konfigurasi Manifest V3
- `page-bridge.js` — Interceptor caption YouTube (`MAIN` world)
- `background.js` — Service worker untuk batch translate & audio TTS
- `content.js` & `content.css` — Overlay subtitle, sinkronisasi TTS adaptif, audio ducking, dan tombol player
- `popup.html`, `popup.css`, `popup.js` — UI pengaturan ekstensi
- `icons/` — Ikon ekstensi (16px, 48px, 128px)
