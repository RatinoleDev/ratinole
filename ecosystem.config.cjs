// PM2 process file for the Hostinger VPS (HANDOFF section 3). Not deployed in Phase 1.
// Secrets come from the server's .env (never committed). Both servers listen on
// 127.0.0.1 only; Nginx (deploy/nginx.conf) sends /api to 4000 and the rest to 3000.
// Steps: docs/deploy.md.
module.exports = {
  apps: [
    {
      name: "rationale-web",
      cwd: "apps/web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000 -H 127.0.0.1",
      env: { NODE_ENV: "production" },
    },
    {
      name: "rationale-api",
      cwd: "apps/api",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "--env-file=../../.env src/main.ts",
      env: { NODE_ENV: "production" },
    },
    {
      // Exactly one engine instance: it owns the hourly schedule.
      name: "rationale-engine",
      cwd: "apps/engine",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "--env-file=../../.env src/main.ts",
      env: { NODE_ENV: "production" },
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
    },
  ],
};
