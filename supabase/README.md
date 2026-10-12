# Menyiapkan akun bersama di Supabase

Backend ini menyimpan akun secara terpusat agar username yang sama dapat dipakai
dari perangkat dan browser berbeda. File `resources/supabase-config.js` hanya
memuat Project URL dan publishable key; jangan pernah meletakkan `service_role`
key atau kunci setup admin di file yang dipublikasikan ke GitHub Pages.

## Deploy backend lewat GitHub

Workflow `.github/workflows/deploy-supabase.yml` menerapkan migrasi database
dan deploy Edge Function secara otomatis ketika perubahan `supabase/` masuk ke
branch `main`. Workflow juga bisa dijalankan manual melalui tab **Actions**.

Sebelum workflow dijalankan, tambahkan Repository secrets di GitHub:

1. Buka **Settings → Secrets and variables → Actions → New repository secret**.
2. Tambahkan `SUPABASE_ACCESS_TOKEN` dengan Personal Access Token dari Supabase.
3. Tambahkan `SUPABASE_DB_PASSWORD` dengan password database proyek Supabase.
4. Untuk setup admin pertama, tambahkan juga `INITIAL_ADMIN_SETUP_KEY` dengan
   nilai acak panjang. Jangan gunakan nilai yang pernah dikirim di chat.

Jangan membuat atau menyimpan `service_role` key di GitHub, workflow, atau file
situs. Supabase menyediakan key itu hanya sebagai environment secret Edge
Function.

Setelah file workflow masuk ke branch `main`, buka **Actions → Deploy Supabase
account backend → Run workflow**. Pastikan langkah **Apply database migrations**
dan **Deploy account Edge Function** berhasil.

### Jika muncul “Failed to send a request to the Edge Function”

Endpoint proyek saat ini membalas `404 NOT_FOUND` dengan pesan
`Requested function was not found`. Itu berarti fungsi `account-api` belum
ter-deploy ke proyek Supabase ini; perubahan file lokal saja belum memasang
fungsi di server. Setelah perintah deploy di atas berhasil, pastikan fungsi
terdaftar:

```powershell
supabase functions list
```

Harus terlihat `account-api`. Pastikan juga output `supabase db push` sukses,
karena endpoint menggunakan tabel `account_setup_state` dan
`account_profiles`. Jika deployment masih gagal, cek log server:

```powershell
supabase functions logs account-api
```

## Buat admin pertama

Setelah backend selesai di-deploy, buka GitHub Pages, isi username, password,
serta setup key dari repository secret `INITIAL_ADMIN_SETUP_KEY`. Pembuatan
admin pertama hanya berhasil sekali; database menegakkan batas tersebut
meskipun beberapa perangkat mencoba bersamaan.

Sesudah admin pertama berhasil dibuat, hapus repository secret
`INITIAL_ADMIN_SETUP_KEY`, lalu nonaktifkan secret di Supabase Dashboard →
**Edge Functions → Secrets**. Ini mencegah kunci setup dipakai lagi.

Jika endpoint menjawab `404 Requested function was not found`, pastikan workflow
berhasil dan `account-api` ter-deploy. Jika fungsi gagal, periksa log di
Supabase Dashboard → **Edge Functions → account-api → Logs**.

Login dan pengelolaan akun setelahnya menggunakan Supabase Auth dan tabel profil
bersama. Pengguna tambahan dibuat oleh admin dari menu **Kelola Akun**.
