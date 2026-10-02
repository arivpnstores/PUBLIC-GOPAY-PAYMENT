# GoPay QRIS Payment Server

Local server untuk generate QRIS dan cek status pembayaran GoPay.

## Instalasi

```bash
npm install
```

## Menjalankan Server

```bash
node server.js
```

Server berjalan di `http://localhost:2234`

---

## Endpoint

### 1. Generate QRIS

**GET** `/createqris/amount=:amount`

| Parameter | Type | Description |
|-----------|------|-------------|
| `amount` | integer | Nominal base amount (misal: 1000) |

**Response Sukses:**
```json
{
  "success": true,
  "message": "QRIS berhasil dibuat",
  "data": {
    "amount": 1186,
    "baseAmount": 1000,
    "uniqueNumber": 186,
    "qr_url": "https://api.qrserver.com/...",
    "qr_string": "00020101021126610014COM.GO-JEK...",
    "check_id": "check_170929364739_73itqwsku",
    "check_url": "http://localhost:2234/cekpembayaran/check_170929364739_73itqwsku",
    "start_time": "2026-10-02T08:14:08.773Z",
    "timeout_minutes": 15
  }
}
```

**Contoh:**
```bash
curl http://localhost:2234/createqris/amount=1000
curl http://localhost:2234/createqris/amount=5000
curl http://localhost:2234/createqris/amount=25000
```

---

### 2. Cek Status Pembayaran

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

// Error
{
  "success": false,
  "status": "ERROR",
  "message": "Gagal ambil mutasi."
}
```

**Contoh:**
```bash
curl http://localhost:2234/cekpembayaran/check_170929364739_73itqwsku
```

---

## Alur Penggunaan

1. **Generate QRIS** → dapatkan `check_id` dan `qr_url`
2. **Tampilkan QR** ke user (via `qr_url` atau `qr_string`)
3. **Polling cek pembayaran** setiap 1-2 detik menggunakan `check_id`
4. **Stop polling** saat status `PAID` atau timeout 15 menit

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
  } else if (result.status === 'ERROR') {
    clearInterval(interval);
    console.error('Error:', result.message);
  }
}, 2000);

// Timeout 15 menit
setTimeout(() => clearInterval(interval), 15 * 60 * 1000);
```

---

## Catatan

- QRIS berlaku **15 menit** (timeout)
- Amount yang dikirim ke user sudah ditambah **unique code** (100-200) untuk identifikasi
- Server otomatis hapus `check_id` yang expired
- Token akses otomatis di-refresh jika expired