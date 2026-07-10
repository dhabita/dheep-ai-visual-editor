# Prompt — Pasang "AI Visual Editor" ke project ini

Salin seluruh isi file ini ke Claude Code (atau Claude chat di VS Code) **di dalam project yang ingin kamu edit secara visual**. Claude akan memasang overlay-nya sendiri ke project ini.

> Tidak perlu mengisi apa pun: Claude mendeteksi `CONFIG` sendiri dan hanya bertanya kalau deteksinya gagal.

---

```
Kamu adalah senior developer. Tugasmu: memasang client overlay "AI Visual Editor"
ke project INI (project tempat kamu sedang berjalan sekarang), supaya saya bisa
mengklik elemen di browser, menulis perintah, dan Claude mengedit file project ini.

Overlay = satu file JS yang disajikan oleh server editor yang berjalan terpisah di
localhost. Project ini hanya perlu MEMUAT script itu saat development. Tidak ada
package yang perlu di-install di project ini.

## CONFIG (opsional — deteksi otomatis dulu, hanya tanya kalau gagal)
- EDITOR_URL  = http://localhost:3000
- PROJECT_ID  = (auto)

Deteksi otomatis SEBELUM bertanya apa pun:
1. PROJECT_ID: jalankan `basename "$(pwd)"` — nama folder project ini ADALAH
   PROJECT_ID (server menemukan folder lewat auto-discovery berdasarkan nama).
2. EDITOR_URL: coba `curl -s --max-time 3 http://localhost:3000/status`.
   - Kalau balasannya JSON dengan "ok":true → pakai http://localhost:3000.
   - Kalau gagal → TANYAKAN ke saya di port berapa server editor berjalan
     (atau minta saya menjalankan `npm start` di repo editor dulu).
Hanya bertanya kalau salah satu deteksi di atas gagal.

## YANG HARUS KAMU LAKUKAN

1) Deteksi jenis project ini (lihat package.json, config, struktur folder):
   static HTML / Vite / Next.js (App Router atau Pages) / CRA / Astro / SvelteKit /
   Nuxt / lainnya.

2) Suntik pemuatan overlay HANYA pada mode development (JANGAN sampai ikut ke
   production build), di lokasi yang benar untuk stack tersebut. Pakai resep di
   bawah. Snippet final selalu memuat:

       EDITOR_URL + "/overlay.js?project=" + PROJECT_ID

3) Idempoten: sebelum menambah, cari string `overlay.js?project=` di file target.
   Kalau sudah ada, JANGAN menambah lagi — cukup pastikan EDITOR_URL & PROJECT_ID benar.

4) Jangan mengubah hal lain. Jangan menghapus kode yang tidak diminta.

5) VERIFIKASI pemasangan sebelum melapor selesai:
   - Jalankan: curl -s --max-time 3 "EDITOR_URL/overlay.js?project=PROJECT_ID" | head -c 100
   - Sukses = balasannya JavaScript yang diawali komentar "AI Visual Editor overlay bundle".
   - Kalau GAGAL, diagnosis dan laporkan mana yang terjadi:
     a. Server editor tidak jalan → minta saya `npm start` di repo editor.
     b. Port salah → cocokkan EDITOR_URL dengan SERVER_PORT di .env editor.
     c. Folder project di luar workspace editor → jalankan `pwd`, cetak path
        absolutnya, dan beri tahu saya untuk menambahkannya ke WORKSPACE_ROOTS
        di .env editor atau mendaftarkannya via POST /register {id, root}.

6) Setelah selesai, cetak ringkasan:
   - file mana yang kamu ubah,
   - cara memakai: cukup jalankan dev server project ini lalu buka di browser.
     TIDAK perlu menyentuh server editor — project ini akan TERDAFTAR OTOMATIS
     (server menemukan folder ini lewat auto-discovery selama folder ini berada
     di dalam workspace editor; defaultnya folder induk repo editor, mis.
     ~/Documents/GitHub). Tekan Ctrl+Shift+E, klik elemen, tulis perintah.
   - HANYA jika folder project ini di LUAR workspace editor: beri tahu saya, lalu
     jalankan `pwd` dan cetak path absolutnya supaya saya bisa daftarkan manual
     (set WORKSPACE_ROOTS di .env editor, atau POST /register {id, root}).

## RESEP PENYUNTIKAN PER-STACK (pilih yang cocok)

### A. Static HTML (ada file .html dengan </body>)
Tambahkan tepat sebelum `</body>` di tiap halaman HTML utama:
    <!-- ai-visual-editor (dev only) -->
    <script src="EDITOR_URL/overlay.js?project=PROJECT_ID"></script>
(Kalau site ini punya proses build/serve terpisah dan kamu bisa membedakan dev vs
prod, batasi hanya ke dev. Kalau murni file statis, biarkan — tapi ingatkan saya
untuk menghapusnya sebelum deploy.)

### B. Vite (React/Vue/Svelte/dll)
Di entry file (`src/main.ts(x)` / `src/main.js`), tambahkan di paling atas:
    if (import.meta.env.DEV) {
      const s = document.createElement('script');
      s.src = 'EDITOR_URL/overlay.js?project=PROJECT_ID';
      document.body.appendChild(s);
    }

### C. Next.js — App Router (`app/layout.tsx`)
Import di atas:  import Script from 'next/script';
Lalu di dalam <body>, render dev-only:
    {process.env.NODE_ENV === 'development' && (
      <Script src="EDITOR_URL/overlay.js?project=PROJECT_ID" strategy="afterInteractive" />
    )}

### D. Next.js — Pages Router (`pages/_app.tsx`)
Di komponen App, tambahkan:
    import { useEffect } from 'react';
    // ...di dalam komponen:
    useEffect(() => {
      if (process.env.NODE_ENV !== 'development') return;
      const s = document.createElement('script');
      s.src = 'EDITOR_URL/overlay.js?project=PROJECT_ID';
      document.body.appendChild(s);
      return () => { s.remove(); };
    }, []);

### E. Create React App (`src/index.tsx` / `src/index.js`)
    if (process.env.NODE_ENV === 'development') {
      const s = document.createElement('script');
      s.src = 'EDITOR_URL/overlay.js?project=PROJECT_ID';
      document.body.appendChild(s);
    }

### F. Astro (layout `.astro`, mis. `src/layouts/*.astro`)
Sebelum `</body>`:
    {import.meta.env.DEV && (
      <script is:inline src="EDITOR_URL/overlay.js?project=PROJECT_ID"></script>
    )}

### G. SvelteKit (`src/routes/+layout.svelte`)
    <script>
      import { dev } from '$app/environment';
      import { onMount } from 'svelte';
      onMount(() => {
        if (!dev) return;
        const s = document.createElement('script');
        s.src = 'EDITOR_URL/overlay.js?project=PROJECT_ID';
        document.body.appendChild(s);
      });
    </script>

### H. Nuxt 3 (`app.vue`)
    <script setup>
    import { onMounted } from 'vue';
    onMounted(() => {
      if (!import.meta.dev) return;
      const s = document.createElement('script');
      s.src = 'EDITOR_URL/overlay.js?project=PROJECT_ID';
      document.body.appendChild(s);
    });
    </script>

### I2. Remix (`app/root.tsx`)
Di dalam <body> (mis. setelah {children}), render dev-only:
    {process.env.NODE_ENV === 'development' && (
      <script src="EDITOR_URL/overlay.js?project=PROJECT_ID" />
    )}

### I3. Angular (`src/main.ts`)
    import { isDevMode } from '@angular/core';
    // ...setelah bootstrap:
    if (isDevMode()) {
      const s = document.createElement('script');
      s.src = 'EDITOR_URL/overlay.js?project=PROJECT_ID';
      document.body.appendChild(s);
    }

### I4. SolidStart (`src/entry-client.tsx`)
    if (import.meta.env.DEV) {
      const s = document.createElement('script');
      s.src = 'EDITOR_URL/overlay.js?project=PROJECT_ID';
      document.body.appendChild(s);
    }

### Z. Stack lain
Pakai pola umum yang sama: pada saat halaman dimuat di DEVELOPMENT, buat elemen
<script> dengan src = EDITOR_URL + "/overlay.js?project=" + PROJECT_ID dan tambahkan
ke document.body. Pastikan dijaga agar tidak masuk ke production.

## CATATAN
- Tidak perlu API key di project ini. Editing dilakukan oleh Claude Code CLI di
  mesin saya (login langganan), dikoordinasikan oleh server editor.
- Overlay otomatis terhubung ke hot-reload server editor; tidak perlu konfigurasi
  WebSocket di sini.
- Ganti placeholder `EDITOR_URL` dan `PROJECT_ID` dengan nilai CONFIG di atas saat
  menulis kode (jangan biarkan literal "EDITOR_URL"/"PROJECT_ID").
- Kalau project ini tidak punya satu pun titik entry yang jelas, tanyakan ke saya
  file mana yang dimuat di setiap halaman.
- MONOREPO: PROJECT_ID = nama folder PACKAGE yang di-serve (mis. `apps/web` →
  "web"), bukan nama root repo. Kalau nama package tidak unik di workspace,
  beri tahu saya supaya saya daftarkan manual via POST /register.
- UNINSTALL: untuk melepas editor, hapus blok/snippet yang memuat
  "overlay.js?project=" dari file yang kamu ubah (cari string itu) — tidak ada
  jejak lain di project ini.
```

---

## Setelah Claude selesai

Tidak ada langkah manual di sisi server editor. Selama folder project ini berada di
dalam **workspace** editor (default: folder induk repo editor, mis. `~/Documents/GitHub`),
project akan **otomatis terdaftar** saat pertama kali overlay-nya dimuat — tanpa edit
`projects.json` dan tanpa restart.

1. Pastikan server editor (**ai-visual-editor**) sedang jalan: `npm start`.
2. Jalankan dev server project kamu, buka di browser.
3. Tekan **Ctrl+Shift+E**, klik elemen, tulis perintah. Selesai.

> Kalau project kamu di luar workspace default, tambahkan foldernya ke
> `WORKSPACE_ROOTS` di `.env` editor (mis. `WORKSPACE_ROOTS=~/Documents/GitHub,~/work`),
> atau daftarkan via `POST /register { "id", "root" }`.
