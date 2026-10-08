require('dotenv').config();
const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 2234;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BASE_URL = process.env.BASE_URL || 'https://qris.adijayavpnpedia.cloud';
const MERCHANT_ID = process.env.MERCHANT_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const STATIC_QR = (process.env.STATIC_QR || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

const QRIS_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;
const CHECKS_FILE = path.join(__dirname, 'checks.json');
const START_TIME = Date.now();

const ENDPOINTS = {
  health: '/api/v1/health',
  createQris: '/createqris/amount=:amount',
  checkPayment: '/cekpembayaran/:checkId',
  qrImage: '/<checkId>.jpg',
};

function validateConfig() {
  const missing = [];
  if (!MERCHANT_ID) missing.push('MERCHANT_ID');
  if (!ACCESS_TOKEN) missing.push('ACCESS_TOKEN');
  if (!REFRESH_TOKEN) missing.push('REFRESH_TOKEN');
  if (!STATIC_QR) missing.push('STATIC_QR');
  
  if (missing.length > 0) {
    console.error('[GoMerch] Config berikut belum diisi di .env:', missing.join(', '));
    console.error('[GoMerch] Copy .env.example ke .env dan isi valuenya');
    process.exit(1);
  }
}

validateConfig();

const state = {
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  merchantId: MERCHANT_ID,
};

const activeChecks = new Map();

function loadChecks() {
  try {
    if (fs.existsSync(CHECKS_FILE)) {
      const data = fs.readFileSync(CHECKS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      const now = Date.now;
      for (const [checkId, checkData] of Object.entries(parsed)) {
        if (now() - checkData.createdAt < QRIS_TIMEOUT_MS) {
          activeChecks.set(checkId, checkData);
        }
      }
      console.log(`[GoMerch] Loaded ${activeChecks.size} checks from ${CHECKS_FILE}`);
    }
  } catch (e) {
    console.error('[GoMerch] Gagal load checks.json:', e.message);
  }
}

function saveChecks() {
  try {
    const data = Object.fromEntries(activeChecks);
    fs.writeFileSync(CHECKS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[GoMerch] Gagal save checks.json:', e.message);
  }
}

loadChecks();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiPost(path, body = {}) {
  const res = await axios.post(BASE_URL + path, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return res.data;
}

async function apiPostWithStatus(path, body = {}) {
  try {
    const res = await axios.post(BASE_URL + path, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return { data: res.data, statusCode: res.status };
  } catch (e) {
    if (e.response) {
      return { data: e.response.data, statusCode: e.response.status };
    }
    throw e;
  }
}

async function doRefreshToken() {
  if (!state.refreshToken) return false;
  try {
    const data = await apiPost('/gomerch/api/auth/refresh', { refresh_token: state.refreshToken });
    if (data.success && data.data?.access_token) {
      state.accessToken = data.data.access_token;
      if (data.data.refresh_token) state.refreshToken = data.data.refresh_token;
      console.log('[GoMerch] Token berhasil di-refresh.');
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function getMutasi(start_time = null, end_time = null) {
  if (!state.accessToken || !state.merchantId) {
    return { success: false, message: 'accessToken atau merchantId kosong!' };
  }
  const now = new Date();
  const s = new Date(now); s.setHours(0, 0, 0, 0);
  const e = new Date(now); e.setHours(23, 59, 59, 999);
  const body = {
    access_token: state.accessToken,
    merchant_id: state.merchantId,
    start_time: start_time || s.toISOString(),
    end_time: end_time || e.toISOString(),
  };
  try {
    const { data, statusCode } = await apiPostWithStatus('/gomerch/api/mutasi', body);
    if (statusCode === 401) {
      const ok = await doRefreshToken();
      if (ok) {
        body.access_token = state.accessToken;
        try {
          return await apiPost('/gomerch/api/mutasi', body);
        } catch (e2) {
          return { success: false, message: e2.message };
        }
      }
      return { success: false, message: 'Token expired dan gagal refresh!' };
    }
    return data;
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function uniqueAmount(base) {
  const n = Math.floor(Math.random() * 101) + 100;
  return { uniqueAmount: Math.floor(base) + n, uniqueNumber: n };
}

// ===== QRIS Dinamis (port dari https://github.com/verssache/QRIS-Dinamis, MIT) =====

function calculateCRC16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

const NESTED_TAGS = new Set([
  ...Array.from({ length: 26 }, (_, i) => String(i + 26).padStart(2, '0')),
  '62',
]);

function parseTLV(data) {
  const elements = [];
  let pos = 0;
  while (pos < data.length) {
    if (pos + 4 > data.length) break;
    const tag = data.substring(pos, pos + 2);
    const length = parseInt(data.substring(pos + 2, pos + 4), 10);
    if (isNaN(length) || pos + 4 + length > data.length) break;
    const value = data.substring(pos + 4, pos + 4 + length);
    const element = { tag, length, value };
    if (NESTED_TAGS.has(tag)) {
      element.children = parseTLV(value);
    }
    elements.push(element);
    pos += 4 + length;
  }
  return elements;
}

function buildTLV(elements) {
  return elements
    .map((el) => {
      const value = el.value;
      return `${el.tag}${value.length.toString().padStart(2, '0')}${value}`;
    })
    .join('');
}

function validateQris(qrisString) {
  const errors = [];
  const elements = parseTLV(qrisString);
  if (elements.length === 0) {
    errors.push('String kosong atau bukan TLV QRIS yang valid');
    return { valid: false, errors };
  }
  const parsedLen = elements.reduce((sum, el) => sum + 4 + el.length, 0);
  if (parsedLen !== qrisString.length) {
    errors.push('Struktur TLV tidak lengkap / ada sisa karakter');
  }
  const crcTag = elements.find((t) => t.tag === '63');
  if (!crcTag) {
    errors.push('Tag 63 (CRC) tidak ditemukan');
  } else if (qrisString.length >= 4) {
    const expected = calculateCRC16(qrisString.slice(0, -4));
    if (crcTag.value !== expected) {
      errors.push(`CRC mismatch: expected ${expected}, got ${crcTag.value}`);
    }
  }
  return { valid: errors.length === 0, errors, elements };
}

// Static -> Dynamic: tag 01 "11" -> "12", sisipkan tag 54 (amount), hitung ulang CRC16.
function convertQris(qrisString, amount) {
  const elements = parseTLV(qrisString);
  if (elements.length === 0) {
    throw new Error('STATIC_QR tidak bisa di-parse sebagai TLV QRIS');
  }

  const managedTags = new Set(['54', '55', '56', '57', '63']);
  const result = [];
  let amountInserted = false;

  for (const el of elements) {
    if (managedTags.has(el.tag)) continue;

    if (el.tag === '01') {
      result.push({ tag: '01', value: '12' });
      continue;
    }

    if (!amountInserted && (el.tag === '58' || el.tag === '59')) {
      result.push({ tag: '54', value: Math.floor(amount).toString() });
      amountInserted = true;
    }

    result.push({ tag: el.tag, value: el.value });
  }

  if (!amountInserted) {
    result.push({ tag: '54', value: Math.floor(amount).toString() });
  }

  const withoutCrc = buildTLV(result);
  const crcInput = withoutCrc + '6304';
  return crcInput + calculateCRC16(crcInput);
}

async function generateQris(amount) {
  if (!STATIC_QR || STATIC_QR === 'YOUR_STATIC_QR_STRING') {
    return { success: false, message: 'STATIC_QR belum diisi!' };
  }
  try {
    const validation = validateQris(STATIC_QR);
    if (!validation.valid) {
      return { success: false, message: 'STATIC_QR tidak valid: ' + validation.errors.join('; ') };
    }
    const qrisString = convertQris(STATIC_QR, amount);
    const check = validateQris(qrisString);
    if (!check.valid) {
      return { success: false, message: 'Hasil konversi QRIS tidak valid: ' + check.errors.join('; ') };
    }
    return { success: true, qris_string: qrisString };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function checkPayment(uAmount, startTime) {
  const tStart = new Date(startTime);
  const expected = Math.floor(uAmount);
  try {
    const data = await getMutasi();
    if (!data.success) {
      return { status: 'ERROR', message: data.message || 'Gagal ambil mutasi.' };
    }
    const transactions = data.data?.transactions;
    if (!transactions || !Array.isArray(transactions)) {
      return { status: 'ERROR', message: 'Format response mutasi tidak valid!' };
    }
    const match = transactions.find(t => {
      const amount = Math.floor(t.gross_amount || 0);
      const trxTime = new Date(t.transaction_time);
      const isSettled = t.transaction_status === 'SETTLEMENT';
      return amount === expected && trxTime >= tStart && isSettled;
    });
    if (match) {
      return { status: 'PAID', message: 'Ditemukan: ' + match.order_id, transaction: match };
    }
    return { status: 'UNPAID', message: 'Belum ditemukan!' };
  } catch (e) {
    return { status: 'ERROR', message: e.message };
  }
}

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

function publicUrl(suffix) {
  if (PUBLIC_URL) return PUBLIC_URL + suffix;
  const lanIp = getLanIp();
  return 'http://' + (lanIp || 'localhost') + ':' + PORT + suffix;
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function maskValue(value) {
  const str = String(value || '');
  if (str.length <= 6) return str ? 'set' : 'missing';
  return str.slice(0, 3) + '*'.repeat(str.length - 6) + str.slice(-3);
}

async function checkUpstream() {
  const startedAt = Date.now();
  try {
    const res = await axios.get(BASE_URL, { timeout: 5000, validateStatus: () => true });
    return { reachable: true, http_status: res.status, latency_ms: Date.now() - startedAt };
  } catch (e) {
    return { reachable: false, error: e.message, latency_ms: Date.now() - startedAt };
  }
}

function buildHealthPayload() {
  const claims = decodeJwtPayload(state.accessToken);
  const expiresAt = claims && claims.exp ? claims.exp * 1000 : null;
  const mem = process.memoryUsage();
  const mb = bytes => Math.round((bytes / 1024 / 1024) * 100) / 100;

  return {
    status: 'ok',
    service: 'gopay-qris-server',
    version: require('./package.json').version,
    timestamp: new Date().toISOString(),
    started_at: new Date(START_TIME).toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    active_checks: activeChecks.size,
    memory_mb: {
      rss: mb(mem.rss),
      heap_total: mb(mem.heapTotal),
      heap_used: mb(mem.heapUsed),
    },
    config: {
      base_url: BASE_URL,
      merchant_id: maskValue(state.merchantId),
      static_qr: STATIC_QR ? 'set' : 'missing',
      public_url: PUBLIC_URL || null,
      port: PORT,
    },
    token: {
      valid: expiresAt ? expiresAt - Date.now() > 60000 : null,
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      seconds_remaining: expiresAt ? Math.round((expiresAt - Date.now()) / 1000) : null,
    },
    endpoints: ENDPOINTS,
  };
}

app.get(['/health', '/api/health', '/api/v1/health'], async (req, res) => {
  const body = buildHealthPayload();
  if (req.query.deep) {
    body.upstream = await checkUpstream();
  }
  res.json(body);
});

async function renderQrPng(qrString) {
  return QRCode.toBuffer(qrString, {
    type: 'png',
    width: 900,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}

async function sendQrImage(res, checkId) {
  const checkData = activeChecks.get(checkId);
  if (!checkData) {
    return res.status(404).type('text/plain').send('QRIS tidak ditemukan atau sudah expired');
  }
  if (!checkData.qrString) {
    return res.status(404).type('text/plain').send('QR string tidak tersimpan untuk check ini');
  }
  try {
    const png = await renderQrPng(checkData.qrString);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store, max-age=0');
    res.send(png);
  } catch (e) {
    res.status(500).type('text/plain').send('Gagal render QR: ' + e.message);
  }
}

app.get(/^\/(?:qris\/)?([A-Za-z0-9_-]+)\.(?:jpg|jpeg|png)$/, (req, res) => {
  return sendQrImage(res, req.params[0]);
});

app.get('/createqris/amount=:amount', async (req, res) => {
  try {
    const amount = parseInt(req.params.amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount harus berupa angka positif' });
    }

    const { uniqueAmount: uAmount, uniqueNumber } = uniqueAmount(amount);
    console.log(`[GoMerch] Generate QRIS untuk amount: ${amount}, unique: ${uAmount} (+${uniqueNumber})`);

    const qrisResult = await generateQris(uAmount);
    if (!qrisResult.success || !qrisResult.qris_string) {
      return res.status(500).json({ success: false, message: qrisResult.message });
    }

    const startTime = new Date().toISOString();
    const checkId = `check_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    activeChecks.set(checkId, {
      uAmount,
      baseAmount: amount,
      uniqueNumber,
      qrString: qrisResult.qris_string,
      startTime,
      createdAt: Date.now()
    });
    saveChecks();

    res.json({
      success: true,
      data: {
        amount: uAmount,
        baseAmount: amount,
        uniqueNumber,
        qr_image: publicUrl('/' + checkId + '.jpg'),
        qr_url: publicUrl('/' + checkId + '.jpg'),
        qris_string: qrisResult.qris_string,
        qr_string: qrisResult.qris_string,
        check_id: checkId,
        check_url: publicUrl('/cekpembayaran/' + checkId),
        start_time: startTime,
        timeout_minutes: 15
      }
    });
  } catch (error) {
    console.error('[GoMerch] Error generate QRIS:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/cekpembayaran/:checkId', async (req, res) => {
  try {
    const { checkId } = req.params;
    const checkData = activeChecks.get(checkId);

    if (!checkData) {
      return res.status(404).json({ success: false, message: 'Check ID tidak ditemukan atau sudah expired' });
    }

    const { uAmount, startTime } = checkData;
    const result = await checkPayment(uAmount, startTime);

    if (result.status === 'PAID') {
      activeChecks.delete(checkId);
      saveChecks();
      return res.json({
        success: true,
        status: 'PAID',
        message: result.message,
        transaction: result.transaction
      });
    }

    if (result.status === 'ERROR') {
      console.error('[GoMerch] Cek pembayaran ERROR (dilaporkan UNPAID ke bot):', result.message);
      return res.json({
        success: true,
        status: 'UNPAID',
        message: result.message,
        check_id: checkId
      });
    }

    res.json({
      success: true,
      status: 'UNPAID',
      message: result.message,
      check_id: checkId
    });
  } catch (error) {
    console.error('[GoMerch] Error cek pembayaran:', error.message);
    res.json({
      success: true,
      status: 'UNPAID',
      message: error.message,
      check_url: req.originalUrl
    });
  }
});

app.get('/cekpembayaran', async (req, res) => {
  res.json({
    success: true,
    message: 'Gunakan endpoint /cekpembayaran/:checkId untuk mengecek status pembayaran',
    example: publicUrl('/cekpembayaran/check_1234567890_abc123')
  });
});

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [checkId, data] of activeChecks.entries()) {
    if (now - data.createdAt > QRIS_TIMEOUT_MS) {
      activeChecks.delete(checkId);
      changed = true;
    }
  }
  if (changed) saveChecks();
}, 60000);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.originalUrl} tidak terdaftar`,
    endpoints: ENDPOINTS,
  });
});

app.use((err, req, res, next) => {
  console.error('[GoMerch] Unhandled error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    error: err.name || 'INTERNAL_ERROR',
    message: err.message,
  });
});

app.listen(PORT, () => {
  console.log(`[GoMerch] Server berjalan di ${publicUrl('/')}`);
  console.log(`[GoMerch] Endpoint health      : ${publicUrl('/api/v1/health')}`);
  console.log(`[GoMerch] Endpoint create QRIS: ${publicUrl('/createqris/amount=1000')}`);
  console.log(`[GoMerch] Endpoint cek pembayaran: ${publicUrl('/cekpembayaran/:checkId')}`);
  console.log(`[GoMerch] Endpoint gambar QR  : ${publicUrl('/:checkId.jpg')}`);
  console.log(`[GoMerch] Persistensi: ${CHECKS_FILE}`);
  if (!PUBLIC_URL) {
    console.log(`[GoMerch] PUBLIC_URL kosong -> pakai IP LAN otomatis (${getLanIp() || 'localhost'}).`);
    console.log(`[GoMerch] User di jaringan yang sama bisa akses via ${publicUrl('/')}`);
  }
});
