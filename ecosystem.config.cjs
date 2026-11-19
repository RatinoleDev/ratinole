// PM2 process file for the Hostinger VPS (HANDOFF section 3). Not deployed in Phase 1.
// Secrets come from the server's .env (never committed). Put Nginx in front of
// the web app on 3000; the API listens on 127.0.0.1:4000 and is reached through
// the web app's /api rewrite.
module.exports = {
  apps: [
    {
      name: "rationale-web",
      cwd: "apps/web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
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
      instances: 1,
      autorestart: true,
    },
  ],
};
