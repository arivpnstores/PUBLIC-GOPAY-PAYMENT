# GoPay QRIS Payment Server

Local server untuk generate QRIS dan cek status pembayaran GoPay.

## 🚀 Install di VPS

```bash
git clone https://github.com/arivpnstores/PUBLIC-GOPAY-PAYMENT.git
cd PUBLIC-GOPAY-PAYMENT
chmod +x install.sh
./install.sh
```

**Yang dilakukan installer:**
- ✅ Clone repo / pull latest
- ✅ `npm install` dependencies
- ✅ Prompt interaktif isi `.env` (validasi wajib)
- ✅ Start server dengan **PM2** (auto-restart, logging, monitoring)

---

## Instalasi Manual (Local Development)

```bash
git clone https://github.com/arivpnstores/PUBLIC-GOPAY-PAYMENT.git
cd PUBLIC-GOPAY-PAYMENT
npm install
cp .env.example .env
# Edit .env isi konfigurasi GoMerch
node server.js
```

Server berjalan di `http://localhost:2234`

QRIS bisa dipindai dari HP user tanpa domain/Cloudflare Tunnel:
- Biarkan `PUBLIC_URL` kosong → server otomatis memakai **IP LAN** server
  (contoh `http://192.168.1.5:2234`), jadi HP di jaringan yang sama bisa mengaksesnya.
- Isi `PUBLIC_URL` hanya kalau kamu punya domain publik sendiri (mis. sudah ada server
  web / reverse proxy).

---

## Endpoint

### 0. Health Check

**GET** `/api/v1/health` (alias: `/health`, `/api/health`)

Endpoint buat monitoring (UptimeRobot, Cloudflare, PM2, dsb). Selalu balas `200`
selama proses server hidup, tanpa memanggil API GoMerch — jadi aman dipakai sebagai
heartbeat.

```bash
curl http://192.168.1.5:2234/api/v1/health
```

```json
{
  "status": "ok",
  "service": "gopay-qris-server",
  "version": "1.0.0",
  "timestamp": "2026-10-03T04:37:16.282Z",
  "started_at": "2026-10-03T04:37:13.382Z",
  "uptime_seconds": 3600,
  "active_checks": 2,
  "memory_mb": { "rss": 66.46, "heap_total": 20.42, "heap_used": 11.12 },
  "config": {
    "base_url": "https://qris.adijayavpnpedia.cloud",
    "merchant_id": "G44****934",
    "static_qr": "set",
    "public_url": null,
    "port": "2234"
  },
  "token": { "valid": true, "expires_at": "...", "seconds_remaining": 82800 },
  "endpoints": {
    "health": "/api/v1/health",
    "createQris": "/createqris/amount=:amount",
    "checkPayment": "/cekpembayaran/:checkId",
    "qrImage": "/<checkId>.jpg"
  }
}
```

Tambah `?deep=1` untuk sekaligus nge-ping server GoMerch (`BASE_URL`):

```bash
curl "http://192.168.1.5:2234/api/v1/health?deep=1"
```

```json
"upstream": { "reachable": true, "http_status": 200, "latency_ms": 312 }
```

> Route yang tidak dikenal sekarang balas JSON `404` (bukan halaman HTML
> `Cannot GET ...`), jadi gampang di-debug:
> `{"success":false,"error":"NOT_FOUND","message":"Route GET /x tidak terdaftar","endpoints":{...}}`

### 1. Generate QRIS

**GET** `/createqris/amount=:amount`

| Parameter | Type | Description |
|-----------|------|-------------|
| `amount` | integer | Nominal base amount (misal: 1000) |

**Response Sukses:**
```json
{
  "success": true,
  "data": {
    "amount": 1186,
    "baseAmount": 1000,
    "uniqueNumber": 186,
    "qr_image": "http://localhost:2234/check_170929364739_73itqwsku.jpg",
    "qr_url": "http://localhost:2234/check_170929364739_73itqwsku.jpg",
    "qris_string": "00020101021126610014COM.GO-JEK...",
    "qr_string": "00020101021126610014COM.GO-JEK...",
    "check_id": "check_170929364739_73itqwsku",
    "check_url": "http://localhost:2234/cekpembayaran/check_170929364739_73itqwsku",
    "start_time": "2026-10-02T08:14:08.773Z",
    "timeout_minutes": 15
  }
}
```

`qr_url`/`qr_image` menunjuk ke endpoint gambar QR di server ini sendiri (dirender lokal,
bukan layanan pihak ketiga).

**Contoh:**
```bash
curl http://localhost:2234/createqris/amount=1000
curl http://localhost:2234/createqris/amount=5000
curl http://localhost:2234/createqris/amount=25000
```

---

### 2. Gambar QR (PNG)

**GET** `/<checkId>.jpg` (alias: `/qris/<checkId>.jpg`, ekstensi `.jpeg`/`.png` juga diterima)

Gambar QR dirender **di server sendiri** dari `qr_string` — tidak bergantung pada `api.qrserver.com` atau layanan pihak ketiga lain.

```
curl -o qr.jpg http://192.168.1.5:2234/check_170929364739_73itqwsku.jpg
```

Spesifikasi gambar: PNG 900x900px, error correction level `M`, margin 2.
Berlaku selama `check_id` masih aktif (15 menit, atau sampai status `PAID`).

> Catatan: URL berakhiran `.jpg` tapi isinya PNG — dictated oleh `Content-Type` header, jadi tetap tampil benar di browser.

---

### 3. Cek Status Pembayaran

**GET** `/cekpembayaran/:checkId`

| Parameter | Type | Description |
|-----------|------|-------------|
| `checkId` | string | ID dari response generate QRIS |

**Response:**
```json
// Belum bayar
{
  "success": true,
  "status": "UNPAID",
  "message": "Belum ditemukan!",
  "check_id": "check_170929364739_73itqwsku"
}

// Berhasil bayar
{
  "success": true,
  "status": "PAID",
  "message": "Ditemukan: qr_muqord3952a01a7c",
  "transaction": { ... }
}
```

Kasus lain:

```json
// Check ID tidak ditemukan / expired → HTTP 404
{
  "success": false,
  "message": "Check ID tidak ditemukan atau sudah expired"
}

// Error dari GoMerch / exception → dilaporkan sebagai UNPAID (HTTP 200)
{
  "success": true,
  "status": "UNPAID",
  "message": "Gagal ambil mutasi.",
  "check_id": "check_170929364739_73itqwsku"
}
```

> Error upstream sengaja dilaporkan sebagai `UNPAID` (bukan status `ERROR`) supaya bot
>/frontend tetap lanjut polling sampai timeout, bukan berhenti karena false alarm.

**Contoh:**
```bash
curl http://localhost:2234/cekpembayaran/check_170929364739_73itqwsku
```

**GET** `/cekpembayaran` (tanpa `checkId`) hanya balas info/petunjuk pemakaian endpoint —
berguna buat cek apakah route terdaftar:

```json
{
  "success": true,
  "message": "Gunakan endpoint /cekpembayaran/:checkId untuk mengecek status pembayaran",
  "example": "http://localhost:2234/cekpembayaran/check_1234567890_abc123"
}
```

---

## Alur Penggunaan

1. **Generate QRIS** → dapatkan `check_id` dan `qr_url`
2. **Tampilkan QR** ke user (via `qr_url` atau `qr_string`)
3. **Polling cek pembayaran** setiap 1-2 detik menggunakan `check_id`
4. **Stop polling** saat status `PAID`, response `404` (check expired), atau timeout 15 menit

---

## PM2 Management (Production)

Project sudahinclude `ecosystem.config.js`, jadi start-nya:

```bash
pm2 start ecosystem.config.js       # Start (pertama kali / setelah edit)
pm2 restart gopay-qris-server      # Restart app
pm2 restart gopay-qris-server --update-env   # Restart + reload .env
pm2 status gopay-qris-server       # Cek status
pm2 logs gopay-qris-server         # Log real-time
pm2 monit                          # Dashboard monitoring
pm2 stop gopay-qris-server         # Stop app
pm2 save                           # Simpan daftar process biar auto-start
pm2 startup                        # Daemon PM2 saat boot
```

Log ditulis ke `logs/out.log` dan `logs/error.log`.

> **Penting:** `instances: 1` + `exec_mode: "fork"` itu wajib. `activeChecks` disimpan
> di memory, jadi kalau jalan multi-instance, `/createqris` bisa nyantol di satu
> instance sementara polling `/cekpembayaran` nyantol di instance lain -> selalu `UNPAID`.

---

## Contoh Implementasi Frontend (JavaScript)

```javascript
async function createPayment(amount) {
  const res = await fetch(`http://localhost:2234/createqris/amount=${amount}`);
  const data = await res.json();
  return data.data; // { check_id, qr_url, amount, ... }
}

async function checkPayment(checkId) {
  const res = await fetch(`http://localhost:2234/cekpembayaran/${checkId}`);
  return res.json();
}

// Usage
const payment = await createPayment(10000);
console.log('QR URL:', payment.qr_url);
console.log('Amount:', payment.amount);

// Polling
const interval = setInterval(async () => {
  const result = await checkPayment(payment.check_id);
  console.log('Status:', result.status);

  if (result.status === 'PAID') {
    clearInterval(interval);
    console.log('Pembayaran berhasil!', result.transaction);
  } else if (result.success === false) {
    // 404: check_id expired / tidak dikenal -> stop polling
    clearInterval(interval);
    console.error('Check ID tidak ditemukan:', result.message);
  }
}, 2000);

// Timeout 15 menit
setTimeout(() => clearInterval(interval), 15 * 60 * 1000);
```

---

## Konfigurasi (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `BASE_URL` | Ya | GoMerch API URL |
| `MERCHANT_ID` | Ya | Merchant ID dari GoMerch |
| `ACCESS_TOKEN` | Ya | JWT Access Token |
| `REFRESH_TOKEN` | Ya | JWT Refresh Token |
| `STATIC_QR` | Ya | Static QR string dari GoMerch |
| `PUBLIC_URL` | Tidak | Domain publik opsional untuk `qr_image` & `check_url`. Kosongkan = otomatis pakai IP LAN server (tanpa domain/Cloudflare Tunnel) |
| `PORT` | Tidak | Port server (default: 2234) |

Copy `.env.example` ke `.env` dan isi valuenya.

---

## Catatan

- QRIS berlaku **15 menit** (timeout)
- **Tanpa perlu domain/Cloudflare Tunnel**: biarkan `PUBLIC_URL` kosong, server otomatis
  mendeteksi IP LAN dan `qr_image`/`check_url` bisa diakses HP di jaringan yang sama
- Gambar QR dirender lokal (900x900 PNG, ECC `M`) — tidak ada ketergantungan ke QR generator pihak ketiga
- Amount yang dikirim ke user sudah ditambah **unique code** (100-200) untuk identifikasi
- Server otomatis hapus `check_id` yang expired
- Check aktif dipersistensi ke `checks.json` — kalau server restart (mis. via PM2),
  check yang masih hidup di-load ulang; yang sudah lewat 15 menit langsung dibuang saat load
- Token akses otomatis di-refresh jika expired
- `.env` tidak di-commit ke git (ada di `.gitignore`)

---

## 🔄 Perubahan Terbaru (Internal / Backend)

| Versi | Tanggal | Perubahan |
|-------|---------|-----------|
| **1.1.0** | 2026-10-08 | **Auto-refresh token** saat response mutasi mengandung "Invalid/Expired token" (meski `success:true`). Menghindari 500/UNPAID loop saat token GoMerch expired. |
| | | **Error handling `getMutasi` ditingkatkan**: validasi statusCode, format response, log raw response keys + full data untuk debugging. |
| | | **Error reporting `cekpembayaran`**: upstream error (token expired, network, format response) sekarang balas `UNPAID` (HTTP 200) bukan `ERROR` (500) — bot tetap polling, alasan error tetap tercatat di log server. |
| | | **Log detail `checkPayment`**: log `UNPAID` dengan alasan spesifik (token expired, format response invalid, dll) — memudahin debug tanpa cek log server terpisah. |
| | | **QR image delivery**: bot sekarang **download + kirim gambar QR** (`replyWithPhoto`) bukan cuma link teks — user langsung scan, fallback ke link kalau download gagal. |
| | | **404 handling di bot**: QRIS yang tidak ditemukan/dropped (mis. API restart) → bot hapus deposit + notif user "QRIS tidak berlaku, silakan ulangi" — tidak stuck error 404 tiap 3 detik. |
| | | **Backup otomatis**: 1 file `backup-<timestamp>.tar.gz` (semua DB digabung), auto **24 jam**, **tidak di startup**, auto-clean file lama (keep 3 terbaru). Manual backup via Admin Hub. |
| | | **Expired notification fix**: cek silang ke `list_accounts` sebelum notif expired — akun yang sudah diperpanjang (list_accounts aktif & expired masa depan) tidak dikirim notif "expired" lagi. |

---

## Repository

- **GitHub:** https://github.com/arivpnstores/PUBLIC-GOPAY-PAYMENT
- **Install Script:** https://github.com/arivpnstores/PUBLIC-GOPAY-PAYMENT/blob/master/install.sh
