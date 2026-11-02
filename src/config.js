import 'dotenv/config';

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Не задана переменная окружения ${key}`);
  return value;
};

export const config = {
  botToken: required('BOT_TOKEN'),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number),
  notifyCooldownSec: Number(process.env.NOTIFY_COOLDOWN_SEC || 600),
  uninetUrl: (process.env.UNINET_URL || 'https://uninet.kbtu.kz').replace(/\/+$/, ''),
  maxWatchSessions: Number(process.env.MAX_WATCH_SESSIONS || 5),
  playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
  playwrightExecutablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '',
};
