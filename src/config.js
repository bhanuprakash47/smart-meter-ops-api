require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT) || 3000,
  cacheTtlMs: Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000,
  portal: {
    baseUrl: (process.env.URJA_BASE_URL || 'https://urja-ops.flockenergy.tech').replace(/\/$/, ''),
    username: process.env.URJA_USERNAME || 'operator@urja.local',
    password: process.env.URJA_PASSWORD || 'urja-ops-2026',
  },
};
