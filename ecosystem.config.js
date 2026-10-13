'use strict';

// pm2 ile calistirma: pm2 start ecosystem.config.js
// webex SDK 2.60.0'in bilinen bellek sizintisina onlem: heap 1G'yi gecince pm2 temiz restart atar.
module.exports = {
  apps: [
    {
      name: 'osem-bot',
      script: 'index.js',
      cwd: __dirname,
      max_memory_restart: '1G',
      autorestart: true,
      restart_delay: 5000,
      min_uptime: '30s',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/osem-bot-out.log',
      error_file: './logs/osem-bot-error.log',
      merge_logs: true,
    },
  ],
};
