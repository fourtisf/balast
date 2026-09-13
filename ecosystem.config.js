/**
 * PM2 process definition for the Hostinger VPS (§2).
 *
 * Deploy is a manual step for now: no credentials for the box are in this
 * repository and none should be. See "Deploy" in README.md.
 */
module.exports = {
  apps: [
    {
      name: 'depth-web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      cwd: '/var/www/depth',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // P1 flips this to "live" once the indexer is up.
        DATA_SOURCE: 'sim',
      },
      error_file: '/var/log/depth/web.error.log',
      out_file: '/var/log/depth/web.out.log',
      time: true,
    },
  ],
};
