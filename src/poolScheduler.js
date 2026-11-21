import { config } from './config.js';
import * as db from './db.js';
import * as aa from './attendance.js';

export const DAY_SHORT = {
  1: 'Пн',
  2: 'Вт',
  3: 'Ср',
  4: 'Чт',
  5: 'Пт',
  6: 'Сб',
  7: 'Вс',
};

export const DAY_FULL = {
  1: 'Понедельник',
  2: 'Вторник',
  3: 'Среда',
  4: 'Четверг',
  5: 'Пятница',
  6: 'Суббота',
  7: 'Воскресенье',
};

const WEEKDAY_MAP = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const TICK_INTERVAL_MS = 15_000;
const MIN_WINDOW_MINUTES = 5;
const MAX_WINDOW_MINUTES = 240;

// ---------- Pure time & selection helpers ----------

export function getZonedNow(date = new Date(), timeZone = config.timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }

  const dayOfWeek = WEEKDAY_MAP[parts.weekday] || 1;
  const rawHour = Number(parts.hour);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const minuteOfDay = hour * 60 + minute;
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  return { dayOfWeek, hour, minute, second, minuteOfDay, dateKey, timeLabel };
}

export function formatMinute(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatScheduleWindow(sched) {
  const day = DAY_SHORT[sched.day_of_week] || '?';
  return `${day} ${formatMinute(sched.start_minute)}–${formatMinute(sched.end_minute)}`;
}

export function parseTimeRange(raw) {
  const s = String(raw || '').trim();
  const match = s.match(/^(\d{1,2}):(\d{2})\s*(?:[-–—]|\s+)\s*(\d{1,2}):(\d{2})$/);
  if (!match) {
    return {
      ok: false,
      error: 'Неверный формат времени. Используйте формат <code>ЧЧ:ММ-ЧЧ:ММ</code>, например <code>10:00-11:00</code>.',
    };
  }

  const sh = Number(match[1]);
  const sm = Number(match[2]);
  const eh = Number(match[3]);
  const em = Number(match[4]);

  if (sh < 0 || sh > 23 || sm < 0 || sm > 59) {
    return { ok: false, error: 'Некорректное время начала (часы 00–23, минуты 00–59).' };
  }
  if (eh < 0 || eh > 24 || em < 0 || em > 59 || (eh === 24 && em !== 0)) {
    return { ok: false, error: 'Некорректное время окончания (часы 00–24, минуты 00–59).' };
  }

  const startMinute = sh * 60 + sm;
  const endMinute = eh * 60 + em;

  if (endMinute <= startMinute) {
    return {
      ok: false,
      error: 'Время окончания должно быть позже времени начала в пределах одного дня.',
    };
  }

  const duration = endMinute - startMinute;
  if (duration < MIN_WINDOW_MINUTES) {
    return {
      ok: false,
      error: `Минимальная длительность окна — ${MIN_WINDOW_MINUTES} минут.`,
    };
  }
  if (duration > MAX_WINDOW_MINUTES) {
    return {
      ok: false,
      error: `Максимальная длительность окна — ${MAX_WINDOW_MINUTES / 60} часа (${MAX_WINDOW_MINUTES} мин).`,
    };
  }

  return { ok: true, startMinute, endMinute };
}

export function isScheduleInWindow(sched, now) {
  return (
    Number(sched.day_of_week) === now.dayOfWeek &&
    now.minuteOfDay >= Number(sched.start_minute) &&
    now.minuteOfDay < Number(sched.end_minute)
  );
}

export function chooseScoutCandidate(
  candidates,
  preferredUserId = null,
  excludedUserIds = new Set(),
  randomFn = Math.random,
) {
  const eligible = (candidates || []).filter((c) => !excludedUserIds.has(c.user_id));
  if (eligible.length === 0) {
    return {
      scout: null,
      usedFallback: false,
      preferredUnavailable: Boolean(preferredUserId),
    };
  }

  if (preferredUserId != null) {
    const preferred = eligible.find((c) => Number(c.user_id) === Number(preferredUserId));
    if (preferred) {
      return { scout: preferred, usedFallback: false, preferredUnavailable: false };
    }
    const idx = Math.floor(randomFn() * eligible.length);
    return { scout: eligible[idx], usedFallback: true, preferredUnavailable: true };
  }

  const idx = Math.floor(randomFn() * eligible.length);
  return { scout: eligible[idx], usedFallback: false, preferredUnavailable: false };
}

export function abortableSleep(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function scheduleFingerprint(sched) {
  return [
    sched.pool_id,
    sched.day_of_week,
    sched.start_minute,
    sched.end_minute,
    sched.scout_user_id ?? 'rand',
    sched.stop_on_detect ? 1 : 0,
  ].join(':');
}

// ---------- Scheduler Engine (supports DI for unit testing) ----------

export function createPoolScheduler(deps = {}) {
  const dDb = deps.db || db;
  const dAa = deps.attendance || aa;
  const dConfig = deps.config || config;
  const nowFn = deps.nowFn || (() => getZonedNow(new Date(), dConfig.timezone));
  const randomFn = deps.randomFn || Math.random;

  /** @type {Map<number, any>} */
  const activeWatchers = new Map();
  const exhaustedWindows = new Set(); // `${scheduleId}:${windowKey}` — no eligible scout left in this window
  const fallbackNotified = new Set(); // `${scheduleId}:${windowKey}`

  let callbacks = {};
  let tickTimer = null;
  let started = false;
  let stopping = false;
  let syncing = false;
  let syncRequested = false;
  let lastPrunedDateKey = null;

  function pruneDailySets(dateKey) {
    if (lastPrunedDateKey === dateKey) return;
    lastPrunedDateKey = dateKey;
    const suffix = `:${dateKey}`;
    for (const key of exhaustedWindows) {
      if (!key.endsWith(suffix)) exhaustedWindows.delete(key);
    }
    for (const key of fallbackNotified) {
      if (!key.endsWith(suffix)) fallbackNotified.delete(key);
    }
  }

  async function runWatcherLoop(schedule, windowKey, watcher) {
    const { signal } = watcher.abortController;
    const excludedUserIds = new Set();
    let session = null;
    let currentScout = null;
    let consecutiveErrors = 0;
    let lastPollDurationMs = 0;

    const closeSession = async () => {
      if (!session) return;
      const s = session;
      session = null;
      await s.close().catch(() => {});
    };

    try {
      while (!signal.aborted && !stopping) {
        const now = nowFn();
        if (now.dateKey !== windowKey || !isScheduleInWindow(schedule, now)) {
          break;
        }

        // Ensure we have an active scout session
        if (!session || !session.isAlive()) {
          await closeSession();
          watcher.state = 'starting';

          const candidates = await dDb.listEligibleScoutsForPool(schedule.pool_id);
          const pick = chooseScoutCandidate(candidates, schedule.scout_user_id, excludedUserIds, randomFn);

          if (!pick.scout) {
            const winTag = `${schedule.id}:${windowKey}`;
            await dDb
              .updatePoolScheduleStatus(schedule.id, '⚠️ Нет доступных разведчиков')
              .catch(() => {});
            if (!exhaustedWindows.has(winTag)) {
              exhaustedWindows.add(winTag);
              callbacks.onNoEligibleScout?.({ schedule, windowKey })?.catch?.(() => {});
            }
            break;
          }

          currentScout = pick.scout;
          watcher.scout = {
            user_id: currentScout.user_id,
            username: currentScout.username,
            first_name: currentScout.first_name,
            login_mask: currentScout.login_mask,
          };

          if (pick.usedFallback) {
            const winTag = `${schedule.id}:${windowKey}`;
            if (!fallbackNotified.has(winTag)) {
              fallbackNotified.add(winTag);
              callbacks
                .onScoutFallback?.({
                  schedule,
                  assignedUserId: schedule.scout_user_id,
                  fallbackScout: currentScout,
                })
                ?.catch?.(() => {});
            }
          }

          try {
            session = await dAa.openPgeScoutSession({
              encCredentials: currentScout.enc_credentials,
            });
            consecutiveErrors = 0;
            watcher.lastError = null;
          } catch (err) {
            if (err instanceof dAa.InvalidCredentialsError || err instanceof dAa.DecryptionError) {
              excludedUserIds.add(currentScout.user_id);
              await dDb.setAutoAttendanceEnabled(currentScout.user_id, false).catch(() => {});
              await dDb.updateAutoAttendanceRun(currentScout.user_id, '❌ Ошибка входа (пауза)').catch(() => {});

              const remaining = candidates.filter((c) => !excludedUserIds.has(c.user_id));
              const nextPick = chooseScoutCandidate(remaining, null, excludedUserIds, randomFn);

              callbacks
                .onScoutFailed?.({
                  schedule,
                  failedScout: currentScout,
                  reason: err.message,
                  nextScout: nextPick.scout,
                })
                ?.catch?.(() => {});

              if (!nextPick.scout) {
                const winTag = `${schedule.id}:${windowKey}`;
                exhaustedWindows.add(winTag);
                await dDb
                  .updatePoolScheduleStatus(schedule.id, '❌ Ошибка входа у всех разведчиков')
                  .catch(() => {});
                break;
              }
              continue;
            }

            consecutiveErrors++;
            watcher.lastError = err.message;
            const backoff = Math.min(30_000, dConfig.poolPollIntervalMs * Math.min(consecutiveErrors, 3));
            await abortableSleep(backoff, signal);
            continue;
          }

          if (signal.aborted || stopping) {
            await closeSession();
            break;
          }

          // Immediate check right after login so we don't wait 10s if Check in is already open
          watcher.state = 'polling';
          let initialResult = null;
          try {
            initialResult = await session.checkNow();
            watcher.pollsCount++;
            watcher.lastPollAt = Date.now();
            watcher.lastError = null;
          } catch (err) {
            consecutiveErrors++;
            watcher.lastError = err.message;
            await closeSession();
            await abortableSleep(dConfig.poolPollIntervalMs, signal);
            continue;
          }

          if (initialResult?.detected) {
            const stoppedAfterDetect = Boolean(schedule.stop_on_detect);
            await dDb
              .markPoolScheduleTriggered(
                schedule.id,
                windowKey,
                `✅ Найден (${initialResult.checkedCount})`,
              )
              .catch(() => {});

            if (stoppedAfterDetect) {
              // Free scout Chromium context immediately before mass check-in finishes
              await closeSession();
              callbacks
                .onAttendanceDetected?.({
                  schedule,
                  scout: currentScout,
                  scoutResult: initialResult,
                  stoppedAfterDetect: true,
                })
                ?.catch?.((e) => console.error('[PoolScheduler] onAttendanceDetected error:', e.message));
              break;
            }

            callbacks
              .onAttendanceDetected?.({
                schedule,
                scout: currentScout,
                scoutResult: initialResult,
                stoppedAfterDetect: false,
              })
              ?.catch?.((e) => console.error('[PoolScheduler] onAttendanceDetected error:', e.message));

            watcher.state = 'cooldown';
            await abortableSleep(dConfig.poolRetriggerCooldownMs, signal);
            continue;
          }
        }

        // Wait until next 10s poll (compensating for previous poll latency, min 1s gap)
        watcher.state = 'polling';
        const waitMs = Math.max(1000, dConfig.poolPollIntervalMs - lastPollDurationMs);
        await abortableSleep(waitMs, signal);
        if (signal.aborted || stopping) break;

        const afterSleepNow = nowFn();
        if (afterSleepNow.dateKey !== windowKey || !isScheduleInWindow(schedule, afterSleepNow)) {
          break;
        }

        const pollStarted = Date.now();
        try {
          const pollRes = await session.pollOnce();
          lastPollDurationMs = Date.now() - pollStarted;
          watcher.pollsCount++;
          watcher.lastPollAt = Date.now();
          watcher.lastError = null;
          consecutiveErrors = 0;

          if (pollRes?.detected) {
            const stoppedAfterDetect = Boolean(schedule.stop_on_detect);
            await dDb
              .markPoolScheduleTriggered(
                schedule.id,
                windowKey,
                `✅ Найден (${pollRes.checkedCount})`,
              )
              .catch(() => {});

            if (stoppedAfterDetect) {
              await closeSession();
              callbacks
                .onAttendanceDetected?.({
                  schedule,
                  scout: currentScout,
                  scoutResult: pollRes,
                  stoppedAfterDetect: true,
                })
                ?.catch?.((e) => console.error('[PoolScheduler] onAttendanceDetected error:', e.message));
              break;
            }

            callbacks
              .onAttendanceDetected?.({
                schedule,
                scout: currentScout,
                scoutResult: pollRes,
                stoppedAfterDetect: false,
              })
              ?.catch?.((e) => console.error('[PoolScheduler] onAttendanceDetected error:', e.message));

            watcher.state = 'cooldown';
            lastPollDurationMs = 0;
            await abortableSleep(dConfig.poolRetriggerCooldownMs, signal);
            continue;
          }
        } catch (err) {
          if (err instanceof dAa.InvalidCredentialsError || err instanceof dAa.DecryptionError) {
            await closeSession();
            excludedUserIds.add(currentScout.user_id);
            await dDb.setAutoAttendanceEnabled(currentScout.user_id, false).catch(() => {});
            await dDb.updateAutoAttendanceRun(currentScout.user_id, '❌ Ошибка входа (пауза)').catch(() => {});

            const candidates = await dDb.listEligibleScoutsForPool(schedule.pool_id).catch(() => []);
            const nextPick = chooseScoutCandidate(candidates, null, excludedUserIds, randomFn);

            callbacks
              .onScoutFailed?.({
                schedule,
                failedScout: currentScout,
                reason: err.message,
                nextScout: nextPick.scout,
              })
              ?.catch?.(() => {});

            if (!nextPick.scout) {
              const winTag = `${schedule.id}:${windowKey}`;
              exhaustedWindows.add(winTag);
              await dDb
                .updatePoolScheduleStatus(schedule.id, '❌ Ошибка входа у всех разведчиков')
                .catch(() => {});
              break;
            }
            continue;
          }

          consecutiveErrors++;
          watcher.lastError = err.message;
          if (consecutiveErrors >= 3 || !session?.isAlive()) {
            await closeSession();
          }
          const backoff = Math.min(30_000, dConfig.poolPollIntervalMs * Math.min(consecutiveErrors, 3));
          await abortableSleep(backoff, signal);
        }
      }
    } catch (err) {
      console.error(`[PoolScheduler] Unhandled watcher error for schedule #${schedule.id}:`, err.message);
    } finally {
      watcher.state = 'stopping';
      await closeSession();
      if (activeWatchers.get(schedule.id) === watcher) {
        activeWatchers.delete(schedule.id);
      }
      if (watcher.restartAfterStop && !stopping) {
        void syncNow();
      }
    }
  }

  async function syncInternal() {
    if (stopping) return;
    const now = nowFn();
    pruneDailySets(now.dateKey);

    let enabledSchedules = [];
    try {
      enabledSchedules = await dDb.listEnabledPoolSchedules();
    } catch (err) {
      console.error('[PoolScheduler] Failed to query pool_schedules:', err.message);
      return;
    }

    const activeById = new Map();
    for (const sched of enabledSchedules) {
      if (isScheduleInWindow(sched, now)) {
        activeById.set(sched.id, sched);
      }
    }

    // 1. Stop watchers that are no longer active or whose config changed
    for (const [schedId, watcher] of activeWatchers.entries()) {
      const sched = activeById.get(schedId);
      if (!sched) {
        watcher.abortController.abort();
        continue;
      }
      if (sched.stop_on_detect && sched.last_window_key === now.dateKey) {
        watcher.abortController.abort();
        continue;
      }
      const fp = scheduleFingerprint(sched);
      if (watcher.fingerprint !== fp || watcher.windowKey !== now.dateKey) {
        watcher.restartAfterStop = true;
        watcher.abortController.abort();
      }
    }

    // 2. Start watchers for active windows not yet running
    for (const sched of activeById.values()) {
      if (activeWatchers.has(sched.id)) continue;
      if (sched.stop_on_detect && sched.last_window_key === now.dateKey) continue;

      const winTag = `${sched.id}:${now.dateKey}`;
      if (exhaustedWindows.has(winTag)) continue;

      if (activeWatchers.size >= dConfig.maxPoolWatchers) {
        console.warn(
          `[PoolScheduler] Reached MAX_POOL_WATCHERS (${dConfig.maxPoolWatchers}), delaying schedule #${sched.id}`,
        );
        break;
      }

      const abortController = new AbortController();
      const watcher = {
        scheduleId: sched.id,
        poolId: sched.pool_id,
        poolName: sched.pool_name,
        windowKey: now.dateKey,
        fingerprint: scheduleFingerprint(sched),
        abortController,
        startedAt: Date.now(),
        pollsCount: 0,
        lastPollAt: null,
        lastError: null,
        scout: null,
        state: 'starting',
        restartAfterStop: false,
        promise: null,
      };

      activeWatchers.set(sched.id, watcher);
      watcher.promise = runWatcherLoop(sched, now.dateKey, watcher);
    }
  }

  async function syncNow() {
    if (stopping) return;
    if (syncing) {
      syncRequested = true;
      return;
    }
    syncing = true;
    try {
      do {
        syncRequested = false;
        await syncInternal();
      } while (syncRequested && !stopping);
    } finally {
      syncing = false;
    }
  }

  function start(cbs = {}) {
    if (started) return;
    started = true;
    stopping = false;
    callbacks = cbs;

    tickTimer = setInterval(() => {
      void syncNow();
    }, TICK_INTERVAL_MS);
    tickTimer.unref?.();

    void syncNow();
  }

  async function stop() {
    stopping = true;
    started = false;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    const promises = [];
    for (const watcher of activeWatchers.values()) {
      watcher.restartAfterStop = false;
      watcher.abortController.abort();
      if (watcher.promise) promises.push(watcher.promise);
    }
    await Promise.allSettled(promises);
    activeWatchers.clear();
  }

  function clearWindowExhaustion(scheduleId) {
    const prefix = `${scheduleId}:`;
    for (const key of exhaustedWindows) {
      if (key.startsWith(prefix)) exhaustedWindows.delete(key);
    }
    for (const key of fallbackNotified) {
      if (key.startsWith(prefix)) fallbackNotified.delete(key);
    }
  }

  function getActiveWatcher(scheduleId) {
    return activeWatchers.get(scheduleId) || null;
  }

  function getActiveWatchersForPool(poolId) {
    const list = [];
    for (const w of activeWatchers.values()) {
      if (w.poolId === poolId) list.push(w);
    }
    return list;
  }

  function activeWatchersCount() {
    return activeWatchers.size;
  }

  return {
    start,
    stop,
    syncNow,
    clearWindowExhaustion,
    getActiveWatcher,
    getActiveWatchersForPool,
    activeWatchersCount,
  };
}

// Default singleton instance used by the bot
export const poolScheduler = createPoolScheduler();
