import crypto from 'node:crypto';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Encryption (AES-256-GCM) ----------
if (!config.credentialsSecret) {
  console.warn(
    '⚠️ [AutoAttendance] CREDENTIALS_SECRET не задан в .env — используется производный ключ от BOT_TOKEN. Рекомендуется задать отдельный CREDENTIALS_SECRET.',
  );
}

const ENC_KEY = crypto.scryptSync(
  config.credentialsSecret || config.botToken,
  'attendance-alert-bot:pge-aes256gcm:v1',
  32,
);

export function normalizeLogin(raw) {
  return String(raw || '')
    .trim()
    .replace(/@kbtu\.kz$/i, '');
}

export function maskLogin(login) {
  const s = normalizeLogin(login);
  if (s.length <= 3) return `${s[0] || '*'}***`;
  if (s.length <= 6) return `${s.slice(0, 2)}***${s.slice(-1)}`;
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

export function encryptCredentials(login, password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const payload = JSON.stringify({ login: normalizeLogin(login), password: String(password) });
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptCredentials(encoded) {
  const parts = String(encoded || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new DecryptionError('Неподдерживаемый формат зашифрованных данных.');
  }
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed?.login || !parsed?.password) {
      throw new Error('Empty login or password');
    }
    return { login: String(parsed.login), password: String(parsed.password) };
  } catch {
    throw new DecryptionError(
      'Не удалось расшифровать сохранённые данные (возможно, изменился CREDENTIALS_SECRET). Привяжите аккаунт заново.',
    );
  }
}

// ---------- Errors ----------
export class AttendanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AttendanceError';
  }
}

export class InvalidCredentialsError extends AttendanceError {
  constructor(message = 'Неверный логин или пароль от портала pge.kbtu.kz.') {
    super(message);
    this.name = 'InvalidCredentialsError';
  }
}

export class DecryptionError extends AttendanceError {
  constructor(message) {
    super(message);
    this.name = 'DecryptionError';
  }
}

// ---------- In-memory ONLY setup prompt state ----------
const AUTH_PROMPT_TTL_MS = 5 * 60 * 1000;
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
  pendingAuth.set(userId, { step: 'password', login: normalizeLogin(login), timer });
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

// ---------- Browser & Concurrency Queue ----------
const IDLE_BROWSER_TTL_MS = 15_000;
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

/** @type {import('playwright').Browser | null} */
let pgeBrowser = null;
/** @type {Promise<import('playwright').Browser> | null} */
let pgeBrowserLaunching = null;
let idleCloseTimer = null;
let shuttingDown = false;

let runningSlots = 0;
const waitQueue = [];
/** @type {Map<number, Promise<any>>} */
const inFlightByUser = new Map();

function clearIdleCloseTimer() {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }
}

function scheduleIdleBrowserClose() {
  clearIdleCloseTimer();
  if (runningSlots > 0 || waitQueue.length > 0 || !pgeBrowser) return;
  idleCloseTimer = setTimeout(async () => {
    idleCloseTimer = null;
    if (runningSlots === 0 && waitQueue.length === 0 && pgeBrowser) {
      const b = pgeBrowser;
      pgeBrowser = null;
      await b.close().catch(() => {});
    }
  }, IDLE_BROWSER_TTL_MS);
  idleCloseTimer.unref?.();
}

async function ensurePgeBrowser() {
  clearIdleCloseTimer();
  if (pgeBrowser?.isConnected()) return pgeBrowser;
  if (pgeBrowserLaunching) return pgeBrowserLaunching;

  pgeBrowserLaunching = (async () => {
    const baseOpts = { headless: config.playwrightHeadless, args: LAUNCH_ARGS };
    const attempts = [];
    if (config.playwrightExecutablePath) {
      attempts.push(() => chromium.launch({ ...baseOpts, executablePath: config.playwrightExecutablePath }));
    }
    for (const sysPath of ['/usr/bin/chromium-browser', '/usr/bin/chromium']) {
      if (sysPath !== config.playwrightExecutablePath && fs.existsSync(sysPath)) {
        attempts.push(() => chromium.launch({ ...baseOpts, executablePath: sysPath }));
      }
    }
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
          if (pgeBrowser === b) pgeBrowser = null;
        });
        pgeBrowser = b;
        return b;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Failed to launch Chromium for PGE');
  })().finally(() => {
    pgeBrowserLaunching = null;
  });

  return pgeBrowserLaunching;
}

async function withConcurrencySlot(fn) {
  if (shuttingDown) throw new AttendanceError('Сервер перезапускается, попробуйте через минуту.');
  if (runningSlots >= config.maxAttendanceConcurrency) {
    await new Promise((resolve) => waitQueue.push(resolve));
  }
  runningSlots++;
  clearIdleCloseTimer();
  try {
    return await fn();
  } finally {
    runningSlots--;
    const next = waitQueue.shift();
    if (next) {
      next();
    } else {
      scheduleIdleBrowserClose();
    }
  }
}

export function activeJobsCount() {
  return runningSlots + waitQueue.length;
}

export function isUserJobRunning(userId) {
  return inFlightByUser.has(userId);
}

// ---------- Vaadin Synchronization & PGE Automation ----------

/**
 * Waits until Vaadin 7/8 client finishes all pending UIDL requests, layout passes,
 * and hides `.v-loading-indicator`.
 */
async function waitVaadinIdle(page, timeoutMs = 15000) {
  await sleep(120);
  await page
    .waitForFunction(
      () => {
        const indicators = Array.from(document.querySelectorAll('.v-loading-indicator'));
        const loadingVisible = indicators.some((el) => {
          const st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
        });
        if (loadingVisible) return false;

        const clients = window.vaadin && window.vaadin.clients;
        if (!clients) return false;
        const list = Object.values(clients);
        if (list.length === 0) return false;
        return list.every((c) => !c.initializing && (typeof c.isActive !== 'function' || !c.isActive()));
      },
      { timeout: timeoutMs },
    )
    .catch(() => {});
}

async function switchToEnglishIfNeeded(page) {
  const alreadyEn = await page
    .evaluate(() => {
      const txt = document.body?.innerText || '';
      return /\b(Username|Log in|Attendance mark|No disciplines available|Check in)\b/i.test(txt);
    })
    .catch(() => false);

  if (alreadyEn) return;

  const gbImg = page.locator('img[src*="/flags/gb.png"]').first();
  if ((await gbImg.count()) > 0) {
    await gbImg.click({ timeout: 5000 }).catch(() => {});
    await waitVaadinIdle(page, 10000);
    await page
      .waitForFunction(
        () => /\b(Username|Log in|Attendance mark)\b/i.test(document.body?.innerText || ''),
        { timeout: 8000 },
      )
      .catch(() => {});
  }
}

/**
 * Safely fills Vaadin's VFilterSelect (ComboBox) username input and password field,
 * ensuring VFilterSelect commits the username instead of wiping it on blur.
 */
async function performPgeLogin(page, login, password) {
  const userInput = page.locator('input.v-filterselect-input, input[type="text"].v-textfield').first();
  const passInput = page.locator('input[type="password"]').first();

  await userInput.waitFor({ state: 'visible', timeout: 15000 });
  await passInput.waitFor({ state: 'visible', timeout: 10000 });

  for (let attempt = 0; attempt < 3; attempt++) {
    await userInput.click({ timeout: 5000 });
    await userInput.fill('');
    await userInput.fill(login);
    await sleep(250);
    await waitVaadinIdle(page, 8000);
    // Commit new/filtered item in Vaadin ComboBox before blurring to Password
    await userInput.press('Enter');
    await waitVaadinIdle(page, 8000);

    const committed = (await userInput.inputValue().catch(() => '')).trim();
    if (committed.toLowerCase() === login.toLowerCase()) break;
  }

  await passInput.click({ timeout: 5000 });
  await passInput.fill(password);
  await sleep(100);

  // Double-check Vaadin didn't clear Username when Password focused
  const afterBlurVal = (await userInput.inputValue().catch(() => '')).trim();
  if (afterBlurVal.toLowerCase() !== login.toLowerCase()) {
    await userInput.click({ timeout: 5000 });
    await userInput.fill(login);
    await userInput.press('Enter');
    await waitVaadinIdle(page, 8000);
    await passInput.fill(password);
  }

  const loginBtn = page.locator('.v-button-primary').first();

  if ((await loginBtn.count()) > 0) {
    await loginBtn.click({ timeout: 5000 });
  } else {
    await passInput.press('Enter');
  }

  await waitVaadinIdle(page, 15000);

  const authDeadline = Date.now() + 20000;
  while (Date.now() < authDeadline) {
    const state = await page
      .evaluate(() => {
        const bodyText = document.body?.innerText || '';
        const passInputs = document.querySelectorAll('input[type="password"]').length;
        const hasInvalidError =
          /invalid login or password|неверный логин или пароль|қате логин|логин немесе құпия сөз|authentication failed/i.test(
            bodyText,
          );
        const onAttendanceView =
          /attendance mark|no disciplines available|check in|отметка посещаемости|сабаққа қатысуды белгілеу/i.test(
            bodyText,
          );
        const hasLogoutBtn = !!document.querySelector('img[src*="logout"], img[src*="exit"]');
        return { passInputs, hasInvalidError, onAttendanceView, hasLogoutBtn };
      })
      .catch(() => null);

    if (state) {
      if (state.hasInvalidError) {
        throw new InvalidCredentialsError('Неверный логин или пароль от портала pge.kbtu.kz.');
      }
      if (state.passInputs >= 2) {
        throw new AttendanceError(
          'Портал pge.kbtu.kz требует смену пароля. Войдите через браузер, обновите пароль и привяжите его заново.',
        );
      }
      if (state.passInputs === 0 && (state.onAttendanceView || state.hasLogoutBtn)) {
        return;
      }
    }
    await sleep(350);
  }

  throw new AttendanceError('Превышено время ожидания ответа при входе на pge.kbtu.kz.');
}

async function waitForRegistrationViewReady(page) {
  if (!page.url().includes('/RegistrationOnline')) {
    await page.goto(`${config.pgeUrl}/RegistrationOnline`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
  }
  await waitVaadinIdle(page, 15000);
  await switchToEnglishIfNeeded(page);

  await page
    .waitForFunction(
      () => {
        const txt = document.body?.innerText || '';
        if (/no disciplines available|check in|нет доступных дисциплин|пәндер жоқ/i.test(txt)) return true;
        return !!document.querySelector('.v-max-width-500, .v-information-component-info');
      },
      { timeout: 12000 },
    )
    .catch(() => {});

  await waitVaadinIdle(page, 8000);
}

async function countEnabledCheckIns(page) {
  return page
    .evaluate(() => {
      const CHECK_IN_RE = /^(check\s*in|отметиться|белгілену)$/i;
      const buttons = Array.from(document.querySelectorAll('.v-button[role="button"], button'));
      return buttons.filter((btn) => {
        if (btn.classList.contains('v-disabled') || btn.getAttribute('aria-disabled') === 'true') return false;
        const st = window.getComputedStyle(btn);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const caption = ((btn.querySelector('.v-button-caption') || btn).textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        return CHECK_IN_RE.test(caption);
      }).length;
    })
    .catch(() => 0);
}

/**
 * Clicks EVERY enabled "Check in" button currently present on /RegistrationOnline,
 * waiting for Vaadin's UIDL round-trip after each click.
 */
async function clickAllCheckIns(page) {
  const disciplines = [];
  const notifications = [];
  let checkedCount = 0;

  for (let step = 0; step < 12; step++) {
    const target = await page.evaluate(() => {
      const CHECK_IN_RE = /^(check\s*in|отметиться|белгілену)$/i;
      const buttons = Array.from(document.querySelectorAll('.v-button[role="button"], button'));

      for (const btn of buttons) {
        if (btn.getAttribute('data-aa-clicked') === '1') continue;
        if (btn.classList.contains('v-disabled') || btn.getAttribute('aria-disabled') === 'true') continue;
        const st = window.getComputedStyle(btn);
        if (st.display === 'none' || st.visibility === 'hidden') continue;

        const captionEl = btn.querySelector('.v-button-caption') || btn;
        const caption = (captionEl.textContent || '').replace(/\s+/g, ' ').trim();
        if (!CHECK_IN_RE.test(caption)) continue;

        const token = `aa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        btn.setAttribute('data-aa-target', token);

        let card = btn.parentElement;
        let label = '';
        while (card && !card.classList.contains('v-max-width-500') && card !== document.body) {
          const lines = (card.innerText || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !CHECK_IN_RE.test(l) && !/^attendance mark$/i.test(l));
          if (lines.length > 0) {
            label = lines.slice(0, 3).join(' · ');
            if (label.length >= 6) break;
          }
          card = card.parentElement;
        }

        return { token, discipline: label ? label.slice(0, 140) : null };
      }
      return null;
    });

    if (!target) break;

    const btnLocator = page.locator(`[data-aa-target="${target.token}"]`).first();
    await page
      .evaluate((tok) => {
        const el = document.querySelector(`[data-aa-target="${tok}"]`);
        if (el) el.setAttribute('data-aa-clicked', '1');
      }, target.token)
      .catch(() => {});

    try {
      await btnLocator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await btnLocator.click({ timeout: 6000 });
    } catch {
      continue;
    }

    await waitVaadinIdle(page, 12000);
    await sleep(250);

    const postClick = await page
      .evaluate((tok) => {
        const CHECK_IN_RE = /^(check\s*in|отметиться|белгілену)$/i;
        const notifEls = Array.from(document.querySelectorAll('.v-Notification'));
        const notifTexts = notifEls.map((n) => (n.innerText || '').trim()).filter(Boolean);
        // Click error/warning notifications if Vaadin keeps them open
        notifEls.forEach((n) => n.click?.());

        const el = document.querySelector(`[data-aa-target="${tok}"]`);
        if (!el) return { transitioned: true, notifTexts };
        const st = window.getComputedStyle(el);
        if (
          st.display === 'none' ||
          st.visibility === 'hidden' ||
          el.classList.contains('v-disabled') ||
          el.getAttribute('aria-disabled') === 'true'
        ) {
          return { transitioned: true, notifTexts };
        }
        const caption = ((el.querySelector('.v-button-caption') || el).textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        return { transitioned: !CHECK_IN_RE.test(caption), notifTexts };
      }, target.token)
      .catch(() => ({ transitioned: true, notifTexts: [] }));

    if (postClick.notifTexts?.length) {
      notifications.push(...postClick.notifTexts);
    }

    if (postClick.transitioned) {
      checkedCount++;
      if (target.discipline) disciplines.push(target.discipline);
    }
  }

  return { checkedCount, disciplines, notifications };
}

async function executePgeFlow({ login, password, mode = 'checkin', retryIfEmpty = false }) {
  return withConcurrencySlot(async () => {
    const browser = await ensurePgeBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      ignoreHTTPSErrors: true,
    });

    try {
      const page = await context.newPage();
      await page.goto(`${config.pgeUrl}/RegistrationOnline`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await page.waitForSelector('input[type="password"], img[src*="/flags/"], .v-panel-caption', {
        timeout: 25000,
      });
      await waitVaadinIdle(page, 15000);
      await switchToEnglishIfNeeded(page);

      const needsLogin = (await page.locator('input[type="password"]').count()) > 0;
      if (needsLogin) {
        await performPgeLogin(page, login, password);
      }
      login = '';
      password = '';

      await waitForRegistrationViewReady(page);

      if (mode === 'verify') {
        const activeCount = await countEnabledCheckIns(page);
        return { status: 'verified', activeCount };
      }

      let { checkedCount, disciplines, notifications } = await clickAllCheckIns(page);

      // If triggered by a pool alert right before the teacher's session appeared, retry once after 4.5s
      if (checkedCount === 0 && retryIfEmpty && !shuttingDown) {
        await sleep(4500);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await page
          .waitForSelector('input[type="password"], img[src*="/flags/"], .v-panel-caption', { timeout: 20000 })
          .catch(() => {});
        await waitForRegistrationViewReady(page);
        const secondPass = await clickAllCheckIns(page);
        checkedCount += secondPass.checkedCount;
        disciplines.push(...secondPass.disciplines);
        notifications.push(...secondPass.notifications);
      }

      await waitVaadinIdle(page, 5000);
      await sleep(300);

      return {
        status: checkedCount > 0 ? 'checked' : 'none',
        checkedCount,
        disciplines,
        notifications: [...new Set(notifications)],
      };
    } catch (err) {
      login = '';
      password = '';
      if (err instanceof AttendanceError) throw err;
      console.error('[AutoAttendance] Playwright error:', err.message);
      throw new AttendanceError('Не удалось подключиться к порталу pge.kbtu.kz (таймаут или сбой сети).');
    } finally {
      await context.close().catch(() => {});
    }
  });
}

// ---------- Public API ----------

/**
 * Verifies login & password against pge.kbtu.kz/RegistrationOnline before saving.
 */
export async function verifyPgeCredentials(rawLogin, rawPassword) {
  const normalized = normalizeLogin(rawLogin);
  const res = await executePgeFlow({
    login: normalized,
    password: String(rawPassword),
    mode: 'verify',
    retryIfEmpty: false,
  });
  return {
    normalizedLogin: normalized,
    loginMask: maskLogin(normalized),
    activeCount: res.activeCount,
  };
}

/**
 * Decrypts credentials and runs attendance check-in for a user (deduplicating concurrent runs per user).
 */
export async function runCheckInForUser(userId, encCredentials, { retryIfEmpty = false } = {}) {
  const existing = inFlightByUser.get(userId);
  if (existing) return existing;

  const task = (async () => {
    let creds = null;
    try {
      creds = decryptCredentials(encCredentials);
      const login = creds.login;
      const password = creds.password;
      creds = null;

      return await executePgeFlow({
        login,
        password,
        mode: 'checkin',
        retryIfEmpty,
      });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        return { status: 'invalid_credentials', checkedCount: 0, disciplines: [], error: err.message };
      }
      if (err instanceof DecryptionError) {
        return { status: 'decryption_error', checkedCount: 0, disciplines: [], error: err.message };
      }
      const message =
        err instanceof AttendanceError ? err.message : 'Ошибка при подключении к порталу pge.kbtu.kz.';
      return { status: 'error', checkedCount: 0, disciplines: [], error: message };
    }
  })().finally(() => {
    inFlightByUser.delete(userId);
  });

  inFlightByUser.set(userId, task);
  return task;
}

export async function shutdownAttendance() {
  shuttingDown = true;
  clearIdleCloseTimer();
  for (const [, entry] of pendingAuth) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pendingAuth.clear();

  if (pgeBrowser) {
    const b = pgeBrowser;
    pgeBrowser = null;
    await b.close().catch(() => {});
  }
}
