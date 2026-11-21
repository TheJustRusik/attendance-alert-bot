import test from 'node:test';
import assert from 'node:assert/strict';

// Required env vars for src/config.js import
process.env.BOT_TOKEN ||= 'test-token';
process.env.DATABASE_URL ||= 'postgres://bot:bot@localhost:5432/attendance';
process.env.CREDENTIALS_SECRET ||= 'test-secret-for-unit-tests';

const {
  getZonedNow,
  formatMinute,
  formatScheduleWindow,
  parseTimeRange,
  isScheduleInWindow,
  chooseScoutCandidate,
  createPoolScheduler,
} = await import('../src/poolScheduler.js');
const { InvalidCredentialsError, DecryptionError } = await import('../src/attendance.js');

const waitUntil = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for condition');
};

test('parseTimeRange validates valid and invalid ranges', () => {
  assert.deepEqual(parseTimeRange('10:00-11:00'), { ok: true, startMinute: 600, endMinute: 660 });
  assert.deepEqual(parseTimeRange('9:05 – 10:15'), { ok: true, startMinute: 545, endMinute: 615 });
  assert.deepEqual(parseTimeRange('14:00 15:30'), { ok: true, startMinute: 840, endMinute: 930 });
  assert.deepEqual(parseTimeRange('23:00-24:00'), { ok: true, startMinute: 1380, endMinute: 1440 });

  assert.equal(parseTimeRange('10:00-10:00').ok, false);
  assert.equal(parseTimeRange('11:00-10:00').ok, false);
  assert.equal(parseTimeRange('10:00-10:04').ok, false); // < 5 min
  assert.equal(parseTimeRange('08:00-13:00').ok, false); // > 240 min
  assert.equal(parseTimeRange('24:00-24:30').ok, false);
  assert.equal(parseTimeRange('10:60-11:00').ok, false);
  assert.equal(parseTimeRange('invalid').ok, false);
});

test('getZonedNow accurately handles Asia/Almaty (UTC+5) and midnight rollover', () => {
  // 2026-11-22T19:00:00Z (Sunday UTC) == 2026-11-23 00:00 Asia/Almaty (Monday)
  const d = new Date('2026-11-22T19:00:00Z');
  const z = getZonedNow(d, 'Asia/Almaty');
  assert.equal(z.dateKey, '2026-11-23');
  assert.equal(z.dayOfWeek, 1); // Monday
  assert.equal(z.hour, 0);
  assert.equal(z.minute, 0);
  assert.equal(z.minuteOfDay, 0);
  assert.equal(z.timeLabel, '00:00');

  // 2026-11-23T05:30:00Z == 2026-11-23 10:30 Asia/Almaty
  const d2 = new Date('2026-11-23T05:30:00Z');
  const z2 = getZonedNow(d2, 'Asia/Almaty');
  assert.equal(z2.dateKey, '2026-11-23');
  assert.equal(z2.dayOfWeek, 1);
  assert.equal(z2.minuteOfDay, 630);
  assert.equal(z2.timeLabel, '10:30');
});

test('formatMinute, formatScheduleWindow, and isScheduleInWindow', () => {
  assert.equal(formatMinute(0), '00:00');
  assert.equal(formatMinute(605), '10:05');
  assert.equal(formatMinute(1440), '24:00');

  const sched = { day_of_week: 1, start_minute: 600, end_minute: 660 };
  assert.equal(formatScheduleWindow(sched), 'Пн 10:00–11:00');

  assert.equal(isScheduleInWindow(sched, { dayOfWeek: 1, minuteOfDay: 599 }), false);
  assert.equal(isScheduleInWindow(sched, { dayOfWeek: 1, minuteOfDay: 600 }), true);
  assert.equal(isScheduleInWindow(sched, { dayOfWeek: 1, minuteOfDay: 659 }), true);
  assert.equal(isScheduleInWindow(sched, { dayOfWeek: 1, minuteOfDay: 660 }), false);
  assert.equal(isScheduleInWindow(sched, { dayOfWeek: 2, minuteOfDay: 620 }), false);
});

test('chooseScoutCandidate respects preferred scout, fallback, and exclusions', () => {
  const candidates = [
    { user_id: 1, username: 'alice' },
    { user_id: 2, username: 'bob' },
    { user_id: 3, username: 'carol' },
  ];

  // Preferred present
  const p1 = chooseScoutCandidate(candidates, 2, new Set(), () => 0);
  assert.equal(p1.scout.user_id, 2);
  assert.equal(p1.usedFallback, false);

  // Preferred absent -> fallback to random
  const p2 = chooseScoutCandidate(candidates, 99, new Set(), () => 0.99);
  assert.equal(p2.scout.user_id, 3);
  assert.equal(p2.usedFallback, true);
  assert.equal(p2.preferredUnavailable, true);

  // Random without preference, excluding user 1
  const p3 = chooseScoutCandidate(candidates, null, new Set([1]), () => 0);
  assert.equal(p3.scout.user_id, 2);
  assert.equal(p3.usedFallback, false);

  // All excluded
  const p4 = chooseScoutCandidate(candidates, null, new Set([1, 2, 3]));
  assert.equal(p4.scout, null);
});

test('scheduler detects attendance on poll, closes context, and stays idempotent (stop_on_detect=true)', async () => {
  const schedule = {
    id: 10,
    pool_id: 1,
    pool_name: 'Algorithms',
    day_of_week: 1,
    start_minute: 600,
    end_minute: 660,
    scout_user_id: 101,
    enabled: true,
    stop_on_detect: true,
    last_window_key: null,
  };

  let closedCount = 0;
  let openCount = 0;
  let pollCall = 0;
  const detectedEvents = [];

  const mockDb = {
    listEnabledPoolSchedules: async () => [schedule],
    listEligibleScoutsForPool: async () => [
      { user_id: 101, username: 'scout1', enc_credentials: 'enc1', login_mask: 'sc***1' },
    ],
    markPoolScheduleTriggered: async (id, winKey, status) => {
      schedule.last_window_key = winKey;
      schedule.last_status = status;
    },
    updatePoolScheduleStatus: async () => {},
    setAutoAttendanceEnabled: async () => {},
    updateAutoAttendanceRun: async () => {},
  };

  const mockAa = {
    InvalidCredentialsError,
    DecryptionError,
    openPgeScoutSession: async () => {
      openCount++;
      return {
        isAlive: () => true,
        checkNow: async () => ({ detected: false, checkedCount: 0, disciplines: [] }),
        pollOnce: async () => {
          pollCall++;
          if (pollCall === 2) {
            return { detected: true, checkedCount: 1, disciplines: ['CSCI2105 Algorithms'] };
          }
          return { detected: false, checkedCount: 0, disciplines: [] };
        },
        close: async () => {
          closedCount++;
        },
      };
    },
  };

  const scheduler = createPoolScheduler({
    db: mockDb,
    attendance: mockAa,
    config: { timezone: 'Asia/Almaty', poolPollIntervalMs: 20, maxPoolWatchers: 5, poolRetriggerCooldownMs: 30 },
    nowFn: () => ({ dayOfWeek: 1, minuteOfDay: 615, dateKey: '2026-11-23', timeLabel: '10:15' }),
  });

  // Override minimum 1s sleep check? Wait — waitMs is Math.max(1000, ...) so let's make sure we test real timing or keep check fast!
  // Let's trigger on initial checkNow in fast test, or wait up to 2.5s for 2 polls.
  scheduler.start({
    onAttendanceDetected: async (evt) => {
      detectedEvents.push(evt);
    },
  });

  await waitUntil(() => detectedEvents.length === 1 && scheduler.activeWatchersCount() === 0, 4000);

  assert.equal(openCount, 1);
  assert.equal(closedCount, 1);
  assert.equal(detectedEvents[0].scout.user_id, 101);
  assert.equal(detectedEvents[0].stoppedAfterDetect, true);
  assert.equal(schedule.last_window_key, '2026-11-23');

  // Re-syncing in the same window must NOT relaunch Chromium
  await scheduler.syncNow();
  assert.equal(scheduler.activeWatchersCount(), 0);
  assert.equal(openCount, 1);

  await scheduler.stop();
});

test('scheduler automatically fails over to another random scout on InvalidCredentialsError', async () => {
  const schedule = {
    id: 20,
    pool_id: 2,
    pool_name: 'Databases',
    day_of_week: 3,
    start_minute: 840,
    end_minute: 900,
    scout_user_id: 201,
    enabled: true,
    stop_on_detect: true,
    last_window_key: null,
  };

  const pausedUsers = [];
  const failedEvents = [];
  const detectedEvents = [];

  const mockDb = {
    listEnabledPoolSchedules: async () => [schedule],
    listEligibleScoutsForPool: async () =>
      [
        { user_id: 201, username: 'broken_scout', enc_credentials: 'bad', login_mask: 'br***1' },
        { user_id: 202, username: 'good_scout', enc_credentials: 'good', login_mask: 'go***2' },
      ].filter((u) => !pausedUsers.includes(u.user_id)),
    markPoolScheduleTriggered: async (id, winKey) => {
      schedule.last_window_key = winKey;
    },
    updatePoolScheduleStatus: async () => {},
    setAutoAttendanceEnabled: async (uid, enabled) => {
      if (!enabled) pausedUsers.push(uid);
    },
    updateAutoAttendanceRun: async () => {},
  };

  const mockAa = {
    InvalidCredentialsError,
    DecryptionError,
    openPgeScoutSession: async ({ encCredentials }) => {
      if (encCredentials === 'bad') {
        throw new InvalidCredentialsError('Неверный логин или пароль');
      }
      return {
        isAlive: () => true,
        checkNow: async () => ({ detected: true, checkedCount: 1, disciplines: ['Databases'] }),
        pollOnce: async () => ({ detected: false, checkedCount: 0, disciplines: [] }),
        close: async () => {},
      };
    },
  };

  const scheduler = createPoolScheduler({
    db: mockDb,
    attendance: mockAa,
    config: { timezone: 'Asia/Almaty', poolPollIntervalMs: 20, maxPoolWatchers: 5, poolRetriggerCooldownMs: 30 },
    nowFn: () => ({ dayOfWeek: 3, minuteOfDay: 850, dateKey: '2026-11-25', timeLabel: '14:10' }),
  });

  scheduler.start({
    onScoutFailed: async (evt) => failedEvents.push(evt),
    onAttendanceDetected: async (evt) => detectedEvents.push(evt),
  });

  await waitUntil(() => detectedEvents.length === 1 && scheduler.activeWatchersCount() === 0, 2000);

  assert.deepEqual(pausedUsers, [201]);
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].failedScout.user_id, 201);
  assert.equal(failedEvents[0].nextScout.user_id, 202);
  assert.equal(detectedEvents[0].scout.user_id, 202);

  await scheduler.stop();
});

test('scheduler notifies once when no eligible scouts exist and cleans up on disable', async () => {
  const schedule = {
    id: 30,
    pool_id: 3,
    pool_name: 'EmptyPool',
    day_of_week: 5,
    start_minute: 600,
    end_minute: 660,
    scout_user_id: null,
    enabled: true,
    stop_on_detect: true,
    last_window_key: null,
  };

  let noScoutCalls = 0;

  const mockDb = {
    listEnabledPoolSchedules: async () => [schedule],
    listEligibleScoutsForPool: async () => [],
    markPoolScheduleTriggered: async () => {},
    updatePoolScheduleStatus: async () => {},
    setAutoAttendanceEnabled: async () => {},
    updateAutoAttendanceRun: async () => {},
  };

  const scheduler = createPoolScheduler({
    db: mockDb,
    attendance: { InvalidCredentialsError, DecryptionError },
    config: { timezone: 'Asia/Almaty', poolPollIntervalMs: 20, maxPoolWatchers: 5, poolRetriggerCooldownMs: 30 },
    nowFn: () => ({ dayOfWeek: 5, minuteOfDay: 610, dateKey: '2026-11-27', timeLabel: '10:10' }),
  });

  scheduler.start({
    onNoEligibleScout: async () => {
      noScoutCalls++;
    },
  });

  await waitUntil(() => noScoutCalls === 1 && scheduler.activeWatchersCount() === 0, 2000);

  // Repeated sync must not spam admins again in the same window
  await scheduler.syncNow();
  await scheduler.syncNow();
  assert.equal(noScoutCalls, 1);

  await scheduler.stop();
});

test('scheduler continues monitoring in stop_on_detect=false mode and aborts cleanly when disabled', async () => {
  let enabled = true;
  const schedule = {
    id: 40,
    pool_id: 4,
    pool_name: 'LabClass',
    day_of_week: 2,
    start_minute: 600,
    end_minute: 720,
    scout_user_id: null,
    enabled: true,
    stop_on_detect: false,
    last_window_key: null,
  };

  let closed = false;
  const detectedEvents = [];

  const mockDb = {
    listEnabledPoolSchedules: async () => (enabled ? [schedule] : []),
    listEligibleScoutsForPool: async () => [
      { user_id: 401, username: 'lab_scout', enc_credentials: 'enc', login_mask: 'la***1' },
    ],
    markPoolScheduleTriggered: async (id, winKey) => {
      schedule.last_window_key = winKey;
    },
    updatePoolScheduleStatus: async () => {},
    setAutoAttendanceEnabled: async () => {},
    updateAutoAttendanceRun: async () => {},
  };

  const mockAa = {
    InvalidCredentialsError,
    DecryptionError,
    openPgeScoutSession: async () => ({
      isAlive: () => !closed,
      checkNow: async () => ({ detected: true, checkedCount: 1, disciplines: ['Lab 1'] }),
      pollOnce: async () => ({ detected: false, checkedCount: 0, disciplines: [] }),
      close: async () => {
        closed = true;
      },
    }),
  };

  const scheduler = createPoolScheduler({
    db: mockDb,
    attendance: mockAa,
    config: { timezone: 'Asia/Almaty', poolPollIntervalMs: 20, maxPoolWatchers: 5, poolRetriggerCooldownMs: 60_000 },
    nowFn: () => ({ dayOfWeek: 2, minuteOfDay: 615, dateKey: '2026-11-24', timeLabel: '10:15' }),
  });

  scheduler.start({
    onAttendanceDetected: async (evt) => detectedEvents.push(evt),
  });

  // Watcher should detect, enter cooldown, and remain active (not closed)
  await waitUntil(() => detectedEvents.length === 1 && scheduler.getActiveWatcher(40)?.state === 'cooldown', 2000);
  assert.equal(detectedEvents[0].stoppedAfterDetect, false);
  assert.equal(closed, false);

  // Admin pauses schedule mid-cooldown -> watcher aborts immediately and closes Chromium context
  enabled = false;
  await scheduler.syncNow();
  await waitUntil(() => scheduler.activeWatchersCount() === 0 && closed === true, 2000);

  await scheduler.stop();
});
