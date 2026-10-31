import Redis from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.redisUrl);

// ---------- состояние диалога (ожидаем текстовый ввод) ----------
const stateKey = (uid) => `state:${uid}`;

export const setState = (uid, state) =>
  redis.set(stateKey(uid), JSON.stringify(state), 'EX', 600);

export async function getState(uid) {
  const raw = await redis.get(stateKey(uid));
  return raw ? JSON.parse(raw) : null;
}

export const clearState = (uid) => redis.del(stateKey(uid));

// ---------- кулдаун уведомлений (на пользователя в рамках пула) ----------
const cdKey = (poolId, userId) => `cooldown:${poolId}:${userId}`;

/** Сколько секунд осталось до следующего уведомления (0 — можно). Ничего не занимает. */
export async function cooldownLeft(poolId, userId) {
  const ttl = await redis.ttl(cdKey(poolId, userId));
  return ttl > 0 ? ttl : 0;
}

/** Атомарно занимает кулдаун. Возвращает 0, если получилось, иначе — сколько секунд ждать. */
export async function acquireCooldown(poolId, userId) {
  const ok = await redis.set(cdKey(poolId, userId), '1', 'EX', config.notifyCooldownSec, 'NX');
  if (ok) return 0;
  return Math.max(await redis.ttl(cdKey(poolId, userId)), 1);
}

export const releaseCooldown = (poolId, userId) => redis.del(cdKey(poolId, userId));
