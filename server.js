require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 2234;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BASE_URL = process.env.BASE_URL || 'https://qris.adijayavpnpedia.cloud';
const MERCHANT_ID = process.env.MERCHANT_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const STATIC_QR = process.env.STATIC_QR;

const QRIS_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;

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

async function generateQris(amount) {
  if (!STATIC_QR || STATIC_QR === 'YOUR_STATIC_QR_STRING') {
    return { success: false, message: 'STATIC_QR belum diisi!' };
  }
  try {
    return await apiPost('/gomerch/api/qris/generate', { amount, static_qr: STATIC_QR });
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

app.get('/createqris/amount=:amount', async (req, res) => {
  try {
    const amount = parseInt(req.params.amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount harus berupa angka positif' });
    }

    const { uniqueAmount: uAmount, uniqueNumber } = uniqueAmount(amount);
    console.log(`[GoMerch] Generate QRIS untuk amount: ${amount}, unique: ${uAmount} (+${uniqueNumber})`);

    const qrisResult = await generateQris(uAmount);
    if (!qrisResult.success) {
      return res.status(500).json({ success: false, message: qrisResult.message });
    }

    const startTime = new Date().toISOString();
    const checkId = `check_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    activeChecks.set(checkId, {
      uAmount,
      startTime,
      createdAt: Date.now()
    });

    res.json({
      success: true,
      data: {
        amount: uAmount,
        baseAmount: amount,
        uniqueNumber,
        qr_url: qrisResult.qr_url,
        qr_string: qrisResult.qr_string,
        check_id: checkId,
        check_url: `http://localhost:${PORT}/cekpembayaran/${checkId}`,
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
      return res.json({
        success: true,
        status: 'PAID',
        message: result.message,
        transaction: result.transaction
      });
    }

    if (result.status === 'ERROR') {
      return res.status(500).json({
        success: false,
        status: 'ERROR',
        message: result.message
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
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/cekpembayaran', async (req, res) => {
  res.json({
    success: true,
    message: 'Gunakan endpoint /cekpembayaran/:checkId untuk mengecek status pembayaran',
    example: `http://localhost:${PORT}/cekpembayaran/check_1234567890_abc123`
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [checkId, data] of activeChecks.entries()) {
    if (now - data.createdAt > QRIS_TIMEOUT_MS) {
      activeChecks.delete(checkId);
    }
  }
}, 60000);

app.listen(PORT, () => {
  console.log(`[GoMerch] Server berjalan di http://localhost:${PORT}`);
  console.log(`[GoMerch] Endpoint create QRIS: http://localhost:${PORT}/createqris/amount=1000`);
  console.log(`[GoMerch] Endpoint cek pembayaran: http://localhost:${PORT}/cekpembayaran/:checkId`);
});