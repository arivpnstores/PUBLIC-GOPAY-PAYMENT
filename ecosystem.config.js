// PM2 Ecosystem - GoPay QRIS Payment Server
// Jalankan:  pm2 start ecosystem.config.js
//           pm2 restart gopay-qris-server --update-env
//
// CATATAN: instances HARUS 1 (exec_mode "fork").
// activeChecks disimpan di memory + ditulis ke checks.json, jadi kalau
// dijalankan multi-instance, request /createqris bisa nyantol di instance A
// sementara polling /cekpembayaran nyantol di instance B -> selalu UNPAID.

module.exports = {
  apps: [
    {
      name: 'gopay-qris-server',
      script: 'server.js',
      cwd: __dirname,

      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: '300M',
      watch: false,
      time: true,

      kill_timeout: 5000,

      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
