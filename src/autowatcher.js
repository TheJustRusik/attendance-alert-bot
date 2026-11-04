import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// KBTU AutoWatcher — plays unwatched lessons one after another at normal (1x) speed,
// then moves on to the next unlocked week until every unlocked week is fully watched.
// Executed in the browser page context via page.evaluate().
function runKbtuAutoWatcher() {
  if (window.__KBTU_AW__) { console.log("[AutoWatcher] already running"); return; }
  window.__KBTU_AW__ = true;

  const log = (...a) => console.log("%c[AutoWatcher]", "color:#50fa7b;font-weight:bold", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const NAV_SETTLE_MS = 6000;   // wait after switching week before judging its lessons
  const EMPTY_WEEK_MS = 12000;  // a week with no lesson buttons after this long has no videos

  let lastClickAt = 0;
  let lastNavAt = 0;
  let busy = false;
  const checkedWeeks = new Set(); // weeks verified as fully watched during this run

  const lessonButtons = () => Array.from(document.querySelectorAll("ol li button"));
  const isDone = (btn) => !!btn.querySelector("svg.text-status-success");

  // ---------- week helpers ----------
  const weekSelect = () => document.querySelector(".kb-dropdown select");

  function currentWeek() {
    const m = location.pathname.match(/course-materials\/[^/]+\/(\d+)/);
    if (m) return Number(m[1]);
    const s = weekSelect();
    return s ? Number(s.value) : null;
  }

  // Returns [{ n, locked, el }] for every week in the dropdown.
  // Note: the dropdown's green check only means "week is in the past", NOT "all videos watched",
  // so each week is opened and checked lesson by lesson.
  async function readWeeks() {
    const select = weekSelect();
    if (!select) return [];
    const numbers = Array.from(select.options).map((o) => Number(o.value));
    const trigger = select.parentElement.querySelector("button[role='combobox']");
    let optionEls = [];
    if (trigger) {
      if (trigger.getAttribute("aria-expanded") !== "true") { trigger.click(); await sleep(400); }
      const list = document.getElementById(trigger.getAttribute("aria-controls"));
      optionEls = list ? Array.from(list.querySelectorAll("[role='option']")) : [];
    }
    return numbers.map((n, i) => ({
      n,
      el: optionEls[i] || null,
      locked: optionEls[i] ? !!optionEls[i].querySelector("svg.text-gray-500") : false,
    }));
  }

  function closeDropdown() {
    const trigger = weekSelect()?.parentElement.querySelector("button[role='combobox']");
    if (trigger && trigger.getAttribute("aria-expanded") === "true") trigger.click();
  }

  async function goToWeek(week) {
    const targetN = typeof week === 'number' ? week : week.n;
    log(`📅 switching to week ${targetN}`);
    lastNavAt = Date.now();

    if (week.el && document.contains(week.el)) {
      week.el.click();
    } else {
      const select = weekSelect();
      const trigger = select?.parentElement?.querySelector("button[role='combobox']");
      if (trigger) {
        if (trigger.getAttribute("aria-expanded") !== "true") {
          trigger.click();
          await sleep(400);
        }
        const list = document.getElementById(trigger.getAttribute("aria-controls"));
        const options = list ? Array.from(list.querySelectorAll("[role='option']")) : [];
        const opt = options.find((o) => {
          const t = (o.innerText || '').trim();
          return t.startsWith(`Week ${targetN} `) || t.startsWith(`Week ${targetN}—`) || t.startsWith(`Week ${targetN}\n`);
        });
        if (opt) {
          opt.click();
        } else {
          closeDropdown();
        }
      }
    }

    await sleep(2000);
    if (currentWeek() !== targetN) {
      // Fallback: SPA navigation through the router (no page reload, script keeps running)
      closeDropdown();
      const path = /(course-materials\/[^/]+)(?:\/\d+)?/.test(location.pathname)
        ? location.pathname.replace(/(course-materials\/[^/]+)(?:\/\d+)?/, `$1/${targetN}`)
        : `/student/course-materials/${targetN}`;
      history.pushState({}, "", path + location.search);
      dispatchEvent(new PopStateEvent("popstate"));
    }
    lastNavAt = Date.now();
  }

  async function onWeekFinished() {
    const cur = currentWeek();
    checkedWeeks.add(cur);
    log(`✅ week ${cur} fully watched`);

    const weeks = await readWeeks();
    const open = weeks.filter((w) => !w.locked && !checkedWeeks.has(w.n));
    // Next weeks first, then go back and verify earlier ones
    const next = open.find((w) => w.n > cur) || open.find((w) => w.n < cur);

    if (!next) {
      closeDropdown();
      const locked = weeks.filter((w) => w.locked).map((w) => w.n);
      log(`🎉 All unlocked weeks are done!${locked.length ? " Locked: " + locked.join(", ") : ""}`);
      clearInterval(timer);
      window.__KBTU_AW__ = false;
      return;
    }
    await goToWeek(next);
  }

  // ---------- player helpers ----------
  // Find the Kinescope player instance React holds (the same one the site calls .play() on)
  function getPlayer() {
    const iframe = document.querySelector("iframe[id^='__kinescope_player']");
    if (!iframe) return null;
    // The iframe is injected by Kinescope's library (no React fiber) — walk up to the React-owned <span>
    let el = iframe, key = null;
    while (el && !(key = Object.keys(el).find((k) => k.startsWith("__reactFiber$")))) el = el.parentElement;
    let fiber = key ? el[key] : null;
    while (fiber) {
      const sn = fiber.stateNode;
      if (sn && typeof sn.play === "function" && !(sn instanceof Element)) return sn;
      const r = fiber.ref && fiber.ref.current;
      if (r && typeof r.play === "function" && !(r instanceof Element)) return r;
      fiber = fiber.return;
    }
    return null;
  }

  async function ensurePlaying() {
    const p = getPlayer();
    if (!p) { log("⚠️ player not found yet"); return; }
    try {
      const paused = typeof p.isPaused === "function" ? await p.isPaused() : true;
      if (paused) {
        await p.play();
        log("▶️ play");
      }
    } catch (e) {
      // Autoplay with sound blocked → mute and retry
      try { if (typeof p.mute === "function") await p.mute(); await p.play(); log("▶️ play (muted)"); } catch {}
    }
  }

  // ---------- main loop ----------
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const sinceNav = Date.now() - lastNavAt;
      if (sinceNav < NAV_SETTLE_MS) return;

      const buttons = lessonButtons();
      if (!buttons.length) {
        // Locked week, tests only, or still loading
        if (sinceNav > EMPTY_WEEK_MS) await onWeekFinished();
        return;
      }

      const remaining = buttons.filter((b) => !isDone(b));
      if (!remaining.length) { await onWeekFinished(); return; }

      const current = buttons.find((b) => b.getAttribute("aria-current") === "true");

      // Current lesson is finished (or none selected) → open the next unwatched one
      if (!current || isDone(current)) {
        if (Date.now() - lastClickAt > 5000) {
          const next = remaining[0];
          log(`➡️ week ${currentWeek()}: opening`, next.innerText.split("\n")[0]);
          next.click();
          lastClickAt = Date.now();
        }
        return;
      }

      // Give the new player a few seconds to load before pressing play
      if (Date.now() - lastClickAt > 4000) await ensurePlaying();
    } finally {
      busy = false;
    }
  }

  lastNavAt = Date.now() - NAV_SETTLE_MS; // don't wait on the page we started on
  const timer = setInterval(tick, 3000);
  log(`started on week ${currentWeek()} — ${lessonButtons().filter((b) => !isDone(b)).length} lessons left here`);
  tick();
}

const AUTH_PROMPT_TTL_MS = 5 * 60 * 1000;
const COURSE_SELECT_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;

export class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserFacingError';
  }
}

// ---------- In-memory ONLY credential prompt state (never persisted to DB/Redis) ----------
const pendingAuth = new Map();

export function beginAuthPrompt(userId) {
  cancelAuthPrompt(userId);
  const timer = setTimeout(() => pendingAuth.delete(userId), AUTH_PROMPT_TTL_MS);
  timer.unref?.();
  pendingAuth.set(userId, { step: 'login', login: null, timer });
}

export function setPromptLogin(userId, login) {
  const prev = pendingAuth.get(userId);
  if (prev?.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => pendingAuth.delete(userId), AUTH_PROMPT_TTL_MS);
  timer.unref?.();
  const normalized = String(login || '').trim().replace(/@kbtu\.kz$/i, '');
  pendingAuth.set(userId, { step: 'password', login: normalized, timer });
}

export function getAuthPromptStep(userId) {
  return pendingAuth.get(userId)?.step || null;
}

export function consumePromptLogin(userId) {
  const entry = pendingAuth.get(userId);
  if (!entry) return null;
  if (entry.timer) clearTimeout(entry.timer);
  pendingAuth.delete(userId);
  return entry.login;
}

export function cancelAuthPrompt(userId) {
  const entry = pendingAuth.get(userId);
  if (entry?.timer) clearTimeout(entry.timer);
  pendingAuth.delete(userId);
}

// ---------- Browser & Session Management ----------
/** @type {import('playwright').Browser | null} */
let sharedBrowser = null;
/** @type {Promise<import('playwright').Browser> | null} */
let browserLaunching = null;

/** @type {Map<number, any>} */
const sessions = new Map();

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

async function ensureBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (browserLaunching) return browserLaunching;

  browserLaunching = (async () => {
    const baseOpts = { headless: config.playwrightHeadless, args: LAUNCH_ARGS };
    const attempts = [];
    if (config.playwrightExecutablePath) {
      attempts.push(() => chromium.launch({ ...baseOpts, executablePath: config.playwrightExecutablePath }));
    }
    const candidatePaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const sysPath of candidatePaths) {
      if (sysPath !== config.playwrightExecutablePath && fs.existsSync(sysPath)) {
        attempts.push(() => chromium.launch({ ...baseOpts, executablePath: sysPath }));
      }
    }
    // Prefer full Chromium / Chrome / Edge builds so H.264/AAC (Kinescope) codecs are present
    attempts.push(
      () => chromium.launch({ ...baseOpts, channel: 'chromium' }),
      () => chromium.launch({ ...baseOpts, channel: 'chrome' }),
      () => chromium.launch({ ...baseOpts, channel: 'msedge' }),
      () => chromium.launch(baseOpts),
    );

    let lastErr;
    for (const tryLaunch of attempts) {
      try {
        const b = await tryLaunch();
        b.on('disconnected', () => {
          if (sharedBrowser === b) sharedBrowser = null;
        });
        sharedBrowser = b;
        return b;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Failed to launch Chromium');
  })().finally(() => {
    browserLaunching = null;
  });

  return browserLaunching;
}

async function maybeCloseIdleBrowser() {
  if (sessions.size === 0 && sharedBrowser) {
    const b = sharedBrowser;
    sharedBrowser = null;
    await b.close().catch(() => {});
  }
}

export function getSession(userId) {
  return sessions.get(userId) || null;
}

export function activeSessionCount() {
  return sessions.size;
}

export function canStartNewSession(userId) {
  if (sessions.has(userId)) return { ok: false, reason: 'already_running' };
  if (sessions.size >= config.maxWatchSessions) return { ok: false, reason: 'server_busy' };
  return { ok: true };
}

export async function stopSession(userId) {
  const session = sessions.get(userId);
  if (!session) return false;
  session.stopped = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.maxTimer) clearTimeout(session.maxTimer);
  sessions.delete(userId);
  await session.context?.close().catch(() => {});
  await maybeCloseIdleBrowser();
  return true;
}

export async function stopAllSessions() {
  for (const [, entry] of pendingAuth) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pendingAuth.clear();

  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => stopSession(id)));
  if (sharedBrowser) {
    const b = sharedBrowser;
    sharedBrowser = null;
    await b.close().catch(() => {});
  }
}

function pickLocalized(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'object') {
    const candidate = val.ru || val.en || val.kz || Object.values(val).find((v) => typeof v === 'string' && v.trim());
    return candidate ? String(candidate).trim() : '';
  }
  return String(val).trim();
}

function formatCourseTitle(course) {
  return course.code ? `${course.code} · ${course.title}` : course.title;
}

/**
 * Navigates within the /student SPA without full page reload when possible,
 * preserving the in-memory OIDC access token and avoiding redirect back to /student/ dashboard.
 */
async function navigateStudentSpa(page, targetPath) {
  const isInStudentSpa = await page
    .evaluate(() => location.pathname === '/student' || location.pathname.startsWith('/student/'))
    .catch(() => false);

  if (isInStudentSpa) {
    const clickedLink = await page
      .evaluate((p) => {
        const link = document.querySelector(`a[href="${p}"]`);
        if (link) {
          link.click();
          return true;
        }
        history.pushState({}, '', p);
        window.dispatchEvent(new PopStateEvent('popstate'));
        return true;
      }, targetPath)
      .catch(() => false);

    if (clickedLink) {
      await sleep(500);
      return;
    }
  }

  await page
    .goto(`${config.uninetUrl}${targetPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch(() => {});
}

/**
 * Logs into Uninet via Playwright using ephemeral credentials (never stored),
 * navigates to /student/course-materials, and returns the student's courses.
 */
export async function loginAndFetchCourses(userId, rawLogin, rawPassword, notify) {
  let login = String(rawLogin || '').trim().replace(/@kbtu\.kz$/i, '');
  let password = String(rawPassword || '').trim();
  if (sessions.has(userId)) {
    throw new UserFacingError('У вас уже запущена активная сессия автопросмотра.');
  }
  if (sessions.size >= config.maxWatchSessions) {
    throw new UserFacingError('Сейчас заняты все слоты браузера. Попробуйте чуть позже.');
  }

  const session = {
    userId,
    status: 'logging_in',
    startedAt: Date.now(),
    stopped: false,
    context: null,
    page: null,
    courses: [],
    currentCourse: null,
    lastLog: null,
    idleTimer: null,
    maxTimer: null,
    sendQueue: Promise.resolve(),
  };
  sessions.set(userId, session);

  const enqueueSend = (html, extra) => {
    if (session.stopped) return;
    session.sendQueue = session.sendQueue
      .then(() => {
        if (session.stopped) return;
        return notify(html, extra);
      })
      .catch(() => {});
  };
  session.enqueueSend = enqueueSend;

  try {
    const browser = await ensureBrowser();
    if (session.stopped) throw new UserFacingError('Сессия отменена.');

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'ru-RU',
      ignoreHTTPSErrors: true,
    });
    session.context = context;

    // Ensure portal never pauses Kinescope or ignores watch deltas due to headless tab visibility
    await context.addInitScript(() => {
      try {
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      } catch {}
    });

    const page = await context.newPage();
    session.page = page;

    let capturedApiCourses = null;
    page.on('response', async (res) => {
      try {
        if (res.status() === 200 && /\/courses\/student(\?|$)/.test(res.url())) {
          const data = await res.json();
          if (data && Array.isArray(data.courses)) {
            capturedApiCourses = data.courses.map((c) => ({
              id: String(c.id),
              code: c.code ? String(c.code).trim() : '',
              title: pickLocalized(c.name) || `Курс #${c.id}`,
              instructor: c.teacher ? String(c.teacher).trim() : '',
            }));
          }
        }
      } catch {}
    });

    await page.goto(`${config.uninetUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (session.stopped) throw new UserFacingError('Сессия отменена.');

    // Click "Sign in with KBTU" button on /login if not already redirected to Keycloak
    const ssoDeadline = Date.now() + 20000;
    while (Date.now() < ssoDeadline) {
      if (session.stopped) throw new UserFacingError('Сессия отменена.');
      const kcUser = await page.$('input[name="username"], #username');
      if (kcUser) break;

      const ssoError = await page.$('[data-testid="sso-error"], [data-testid="session-blocked-notice"]');
      if (ssoError) {
        const errText = (await ssoError.innerText().catch(() => '')).trim();
        if (errText) throw new UserFacingError(`Ошибка SSO портала: ${errText}`);
      }

      const ssoBtn = await page.$('[data-testid="sso-login"]');
      if (ssoBtn) {
        await ssoBtn.click().catch(() => {});
        await page.waitForSelector('input[name="username"], #username', { timeout: 15000 }).catch(() => {});
        break;
      }
      await sleep(300);
    }

    const userField = await page.waitForSelector('input[name="username"], #username', { timeout: 20000 }).catch(() => null);
    const passField = await page.waitForSelector('input[name="password"], #password', { timeout: 10000 }).catch(() => null);
    if (!userField || !passField) {
      throw new UserFacingError('Не удалось открыть форму входа Uninet / Keycloak. Попробуйте позже.');
    }

    // Fill credentials directly into Keycloak; credentials are never stored anywhere
    await userField.fill(login);
    await passField.fill(password);
    login = '';
    password = '';

    const submitBtn = await page.$('#kc-login, input[name="login"], button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await passField.press('Enter');
    }

    // Wait for redirect back to Uninet or Keycloak error
    const uninetHost = new URL(config.uninetUrl).host;
    const authDeadline = Date.now() + 25000;
    let authenticated = false;

    while (Date.now() < authDeadline) {
      if (session.stopped) throw new UserFacingError('Сессия отменена.');

      let currentUrl;
      try {
        currentUrl = new URL(page.url());
      } catch {
        await sleep(400);
        continue;
      }

      const errEl = await page.$(
        '#input-error, #input-error-username, #input-error-password, .alert-error, .kc-feedback-text',
      );
      if (errEl) {
        const msg = (await errEl.innerText().catch(() => '')).trim();
        throw new UserFacingError(
          msg ? `Ошибка входа: ${msg}` : 'Неверный логин или пароль от портала Uninet.',
        );
      }

      const actionField = await page.$('input[name="password-new"], input[name="otp"], input[name="totp"]');
      if (actionField) {
        throw new UserFacingError(
          'Портал запрашивает смену пароля или двухфакторное подтверждение. Сначала войдите вручную через браузер.',
        );
      }

      const stillOnAuthForm = await page.$('input[name="username"], #username, input[name="password"], #password');
      if (
        !stillOnAuthForm &&
        currentUrl.host === uninetHost &&
        !currentUrl.pathname.startsWith('/login') &&
        !currentUrl.pathname.startsWith('/callback')
      ) {
        authenticated = true;
        break;
      }

      await sleep(400);
    }

    if (!authenticated) {
      throw new UserFacingError('Превышено время ожидания входа в Uninet (проверьте логин/пароль или доступность портала).');
    }

    // Wait for RootRedirectPage (/ -> /student/) and student SPA silent OIDC init to finish
    const studentReadyDeadline = Date.now() + 20000;
    while (Date.now() < studentReadyDeadline) {
      if (session.stopped) throw new UserFacingError('Сессия отменена.');
      if (capturedApiCourses) break;

      const state = await page
        .evaluate(() => ({
          path: location.pathname,
          hasCourseLink: !!document.querySelector('a[href="/student/course-materials"]'),
          hasMainHeading: !!document.querySelector('h1'),
        }))
        .catch(() => ({ path: '', hasCourseLink: false, hasMainHeading: false }));

      if (
        (state.path === '/student' || state.path.startsWith('/student/')) &&
        (state.hasCourseLink || state.hasMainHeading)
      ) {
        break;
      }
      await sleep(400);
    }

    // Navigate inside the /student SPA to /student/course-materials (preserves in-memory OIDC token)
    if (!capturedApiCourses) {
      await navigateStudentSpa(page, '/student/course-materials');
    }

    const listDeadline = Date.now() + 20000;
    while (Date.now() < listDeadline && !capturedApiCourses) {
      if (session.stopped) throw new UserFacingError('Сессия отменена.');
      const curPath = await page.evaluate(() => location.pathname).catch(() => '');
      if (curPath === '/student' || curPath === '/student/') {
        // Student callback redirected back to dashboard; push to course-materials again
        await navigateStudentSpa(page, '/student/course-materials');
      }
      await sleep(500);
    }

    // Fallback DOM scraping ONLY if actually on /course-materials (never on /student dashboard!)
    let courses = capturedApiCourses;
    if (!courses) {
      courses = await page
        .evaluate(() => {
          if (!location.pathname.includes('/course-materials')) return null;
          const cards = Array.from(document.querySelectorAll('.grid h3'));
          return cards
            .map((h3, idx) => {
              const box = h3.parentElement;
              const code = box?.querySelector('.font-mono')?.textContent?.trim() || '';
              const title = h3.textContent?.trim() || '';
              if (!code && !title) return null;
              return { id: null, domIndex: idx, code, title: title || `Курс ${idx + 1}`, instructor: '' };
            })
            .filter(Boolean);
        })
        .catch(() => null);
    }

    if (!courses || courses.length === 0) {
      await stopSession(userId);
      throw new UserFacingError('На портале не найдено доступных курсов с лекциями за текущий семестр.');
    }

    session.courses = courses;
    session.status = 'selecting_course';
    session.idleTimer = setTimeout(async () => {
      if (session.status === 'selecting_course') {
        await stopSession(userId);
        await notify('⏱ Время выбора курса истекло, браузерная сессия закрыта.').catch(() => {});
      }
    }, COURSE_SELECT_TTL_MS);
    session.idleTimer.unref?.();

    return courses;
  } catch (err) {
    login = '';
    password = '';
    await stopSession(userId);
    if (err instanceof UserFacingError) throw err;
    console.error(`[AutoWatcher] Ошибка входа для user ${userId}:`, err.message);
    throw new UserFacingError('Произошла ошибка при подключении к порталу Uninet. Попробуйте ещё раз.');
  }
}

function attachConsoleForwarder(page, session) {
  let missingPlayerTicks = 0;
  let playLoggedForLesson = false;
  let courseDoneResolver = null;

  const waitCourseDone = () =>
    new Promise((resolve) => {
      courseDoneResolver = resolve;
    });

  const handler = async (msg) => {
    if (session.stopped) return;
    try {
      const rawText = msg.text();
      if (!rawText.includes('[AutoWatcher]')) return;

      const values = await Promise.all(
        msg.args().map((a) => a.jsonValue().catch(() => '')),
      );

      let body = '';
      if (values[0] === '%c[AutoWatcher]') {
        body = values.slice(2).map(String).join(' ').trim();
      } else {
        body = rawText
          .replace(/^%c\[AutoWatcher\]\s*color:[^ ]+\s*/i, '')
          .replace(/^\[AutoWatcher\]\s*/i, '')
          .trim();
      }

      if (!body || body === 'already running') return;

      // Suppress 3-second spam of "player not found yet"
      if (body.includes('player not found yet')) {
        missingPlayerTicks++;
        if (missingPlayerTicks === 15) {
          session.lastLog = body;
          session.enqueueSend(`🖥 <code>[AutoWatcher]</code> ${esc(body)} <i>(ожидаю плеер…)</i>`);
        }
        return;
      }

      missingPlayerTicks = 0;

      if (body.startsWith('▶️ play')) {
        if (playLoggedForLesson) return;
        playLoggedForLesson = true;
        session.lastLog = body;
        session.enqueueSend(`🖥 <code>[AutoWatcher]</code> ${esc(body)}`);
        return;
      }

      if (
        body.startsWith('started on week') ||
        body.startsWith('➡️') ||
        body.startsWith('📅')
      ) {
        playLoggedForLesson = false;
      }

      session.lastLog = body;
      session.enqueueSend(`🖥 <code>[AutoWatcher]</code> ${esc(body)}`);

      if (body.includes('All unlocked weeks are done!')) {
        const lockedMatch = body.match(/Locked:\s*([\d,\s]+)/);
        const lockedWeeks = lockedMatch ? lockedMatch[1].trim() : '';
        if (lockedWeeks) {
          session.enqueueSend(
            `🎉 <b>Все доступные недели курса уже просмотрены!</b>\n` +
            `🔒 Недели <code>${esc(lockedWeeks)}</code> ещё закрыты преподавателем на портале.`,
          );
        } else {
          session.enqueueSend(`🎉 <b>Все недели курса полностью просмотрены!</b>`);
        }
        courseDoneResolver?.('done');
      }
    } catch {}
  };

  page.on('console', handler);

  return {
    waitCourseDone,
    detach: () => page.off('console', handler),
  };
}

async function watchSingleCourse(session, course, indexLabel, stopKeyboard) {
  const { page, enqueueSend } = session;
  const label = formatCourseTitle(course);
  session.currentCourse = label;
  session.lastLog = 'открываю курс…';

  enqueueSend(
    `🎬 <b>${esc(indexLabel)}${esc(label)}</b>\nОткрываю материалы курса и запускаю скрипт…`,
    stopKeyboard,
  );

  // Navigate to the course page via SPA navigation to preserve in-memory OIDC token
  if (course.id) {
    await navigateStudentSpa(page, `/student/course-materials/${course.id}`);
  } else {
    await navigateStudentSpa(page, '/student/course-materials');
    await page.waitForSelector('.grid h3', { timeout: 15000 });
    await page.evaluate((idx) => {
      const h3 = document.querySelectorAll('.grid h3')[idx];
      h3?.closest('[class*="glass"]')?.click() || h3?.click();
    }, course.domIndex ?? 0);
  }

  // Wait until CourseDetailPage redirects to /course-materials/<id>/<week> and renders week header
  const readyDeadline = Date.now() + 25000;
  let hasWeekSelect = false;
  while (Date.now() < readyDeadline) {
    if (session.stopped) return;
    const state = await page
      .evaluate(() => ({
        hasWeekUrl: /course-materials\/[^/]+\/\d+/.test(location.pathname),
        hasSelect: !!document.querySelector('.kb-dropdown select'),
        hasWeekHeading: !!document.querySelector('h2.font-heading'),
        hasEmpty: !document.querySelector('.kb-dropdown select') && !!document.querySelector('h3.font-heading'),
      }))
      .catch(() => ({ hasWeekUrl: false, hasSelect: false, hasWeekHeading: false, hasEmpty: false }));

    if (state.hasSelect && (state.hasWeekHeading || state.hasWeekUrl)) {
      hasWeekSelect = true;
      break;
    }
    if (state.hasEmpty && Date.now() > readyDeadline - 12000) {
      break;
    }
    await sleep(500);
  }

  if (session.stopped) return;

  if (!hasWeekSelect) {
    enqueueSend(`📭 В курсе <b>${esc(label)}</b> пока нет доступных недель или видеолекций.`);
    return;
  }

  // Brief settle so lesson buttons (<ol><li><button>) finish rendering before initial tick
  await sleep(1500);
  if (session.stopped) return;

  const forwarder = attachConsoleForwarder(page, session);
  try {
    const donePromise = forwarder.waitCourseDone();
    await page.evaluate(runKbtuAutoWatcher);

    // Monitor until script signals completion (window.__KBTU_AW__ === false) or session stops
    while (!session.stopped) {
      const finished = await Promise.race([
        donePromise.then(() => true),
        sleep(4000).then(() => false),
      ]);
      if (finished || session.stopped) break;

      const url = page.url();
      if (url.includes('/login') || url.includes('key.kbtu.kz')) {
        throw new UserFacingError('Сессия на портале Uninet истекла.');
      }

      const flag = await page.evaluate(() => window.__KBTU_AW__).catch(() => true);
      if (flag === false) break;
      if (flag === undefined) {
        // Unexpected soft reload wiped window state -> re-inject script once settled
        await sleep(2000);
        if (!session.stopped) await page.evaluate(runKbtuAutoWatcher).catch(() => {});
      }
    }
  } finally {
    forwarder.detach();
  }
}

/**
 * Starts watching either a single course (courseIndex: number) or all courses ('all')
 * in the background and streams logs to Telegram.
 */
export function startWatchingSelection(userId, selection, stopKeyboard, doneKeyboard) {
  const session = sessions.get(userId);
  if (!session || session.status !== 'selecting_course') {
    throw new UserFacingError('Сессия выбора курса не найдена или истекла. Запустите автопросмотр заново.');
  }

  const targetCourses =
    selection === 'all'
      ? session.courses
      : [session.courses[Number(selection)]].filter(Boolean);

  if (!targetCourses.length) {
    throw new UserFacingError('Выбранный курс не найден.');
  }

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  session.status = 'watching';
  session.maxTimer = setTimeout(async () => {
    session.enqueueSend('⏱ Достигнут максимальный лимит времени сессии (12 ч). Автопросмотр остановлен.');
    await stopSession(userId);
  }, MAX_SESSION_MS);
  session.maxTimer.unref?.();

  // Run asynchronously in background
  (async () => {
    try {
      for (let i = 0; i < targetCourses.length; i++) {
        if (session.stopped) return;
        const prefix = targetCourses.length > 1 ? `[${i + 1}/${targetCourses.length}] ` : '';
        await watchSingleCourse(session, targetCourses[i], prefix, stopKeyboard);
      }

      if (!session.stopped) {
        session.enqueueSend(
          '✅ <b>Автопросмотр полностью завершён!</b>\nБраузер закрыт, учётные данные и сессия удалены.',
          doneKeyboard,
        );
      }
    } catch (err) {
      if (!session.stopped) {
        const msg =
          err instanceof UserFacingError
            ? err.message
            : 'Произошла ошибка во время работы браузера. Автопросмотр остановлен.';
        console.error(`[AutoWatcher] Ошибка во время просмотра (user ${userId}):`, err.message);
        session.enqueueSend(`⚠️ <b>${esc(msg)}</b>`, doneKeyboard);
      }
    } finally {
      await session.sendQueue.catch(() => {});
      await stopSession(userId);
    }
  })();
}
