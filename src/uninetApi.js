import crypto from 'node:crypto';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const UNINET_BASE_URL = (config.uninetUrl || 'https://uninet.kbtu.kz').replace(/\/+$/, '');
export const KEYCLOAK_BASE = 'https://key.kbtu.kz/realms/uninet';
export const CLIENT_ID = 'uninet-frontend';
export const REDIRECT_URI = `${UNINET_BASE_URL}/callback`;
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const DEFAULT_ACCEPT_LANGUAGE = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

// ---------- Error classes ----------
export class UninetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UninetError';
  }
}

export class UninetAuthError extends UninetError {
  constructor(message = 'Сессия авторизации истекла или недействительна.') {
    super(message);
    this.name = 'UninetAuthError';
  }
}

export class InvalidCredentialsError extends UninetError {
  constructor(message = 'Неверный логин или пароль от портала Uninet / KBTU.') {
    super(message);
    this.name = 'InvalidCredentialsError';
  }
}

export class UserFacingError extends UninetError {
  constructor(message) {
    super(message);
    this.name = 'UserFacingError';
  }
}

// ---------- Helper functions ----------
function base64url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function extractCookies(res, prev = {}) {
  const cookies = { ...prev };
  const raw = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);

  for (const item of raw) {
    const part = item.split(';')[0];
    const eq = part.indexOf('=');
    if (eq !== -1) {
      cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

function cookieString(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function normalizeLogin(raw) {
  return String(raw || '')
    .trim()
    .replace(/@kbtu\.kz$/i, '');
}

// ---------- PKCE Keycloak Direct API Login ----------
/**
 * Logs into Uninet via official Keycloak OpenID Connect PKCE flow over pure HTTP.
 * No Playwright or browser instance is used.
 *
 * @param {string} rawUsername
 * @param {string} rawPassword
 * @returns {Promise<{ accessToken: string, refreshToken: string | null, expiresIn: number, username: string }>}
 */
export async function loginWithCredentials(rawUsername, rawPassword) {
  const username = normalizeLogin(rawUsername);
  const password = String(rawPassword || '').trim();

  if (!username || !password) {
    throw new InvalidCredentialsError('Логин и пароль не могут быть пустыми.');
  }

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const authUrl = new URL(`${KEYCLOAK_BASE}/protocol/openid-connect/auth`);
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  let res1;
  try {
    res1 = await fetch(authUrl.toString(), {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new UserFacingError(`Не удалось связаться с сервером авторизации KBTU: ${err.message}`);
  }

  if (!res1.ok && res1.status !== 200) {
    throw new UserFacingError(`Сервер авторизации вернул ошибку HTTP ${res1.status}`);
  }

  const cookies = extractCookies(res1);
  const html1 = await res1.text();
  const actionMatch = html1.match(/action="([^"]+)"/i);
  if (!actionMatch) {
    throw new UserFacingError('Не удалось найти форму входа Keycloak.');
  }
  const actionUrl = actionMatch[1].replace(/&amp;/g, '&');

  const body = new URLSearchParams({
    username,
    password,
    credentialId: '',
  });

  let res2;
  try {
    res2 = await fetch(actionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        'Cookie': cookieString(cookies),
      },
      body: body.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new UserFacingError(`Ошибка при отправке учётных данных: ${err.message}`);
  }

  // If 302/303 redirect, Keycloak accepted credentials and issued auth code
  if (res2.status === 302 || res2.status === 303) {
    const location = res2.headers.get('location');
    if (!location) {
      throw new UserFacingError('Сервер авторизации не вернул адрес перенаправления.');
    }

    let locUrl;
    try {
      locUrl = new URL(location);
    } catch {
      throw new UserFacingError(`Некорректный адрес перенаправления: ${location}`);
    }

    const err = locUrl.searchParams.get('error');
    if (err) {
      const desc = locUrl.searchParams.get('error_description') || err;
      throw new UserFacingError(`Ошибка авторизации: ${desc}`);
    }

    const code = locUrl.searchParams.get('code');
    if (!code) {
      throw new UserFacingError('Код авторизации не получен от Keycloak.');
    }

    const tokenData = await exchangeCodeForToken(code, verifier);
    return { ...tokenData, username };
  }

  // If 200, check form validation/error message
  const html2 = await res2.text();
  if (
    html2.includes('Invalid username or password') ||
    html2.includes('Неверные имя пользователя или пароль') ||
    html2.includes('id="input-error"')
  ) {
    throw new InvalidCredentialsError('Неверный логин или пароль от портала Uninet / KBTU.');
  }

  if (html2.includes('password-new') || html2.includes('UPDATE_PASSWORD')) {
    throw new UserFacingError('Портал запрашивает смену пароля. Сначала войдите через браузер на uninet.kbtu.kz.');
  }

  if (html2.includes('otp') || html2.includes('totp')) {
    throw new UserFacingError('На аккаунте включено 2FA подтверждение. Вход через бота не поддерживается.');
  }

  throw new UserFacingError('Не удалось выполнить вход в Uninet. Проверьте логин/пароль.');
}

async function exchangeCodeForToken(code, verifier) {
  const tokenUrl = `${KEYCLOAK_BASE}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: verifier,
  });

  let res;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new UserFacingError(`Ошибка при получении токена авторизации: ${err.message}`);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const msg = data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new UserFacingError(`Ошибка обмена токена: ${msg}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in || 300,
  };
}

export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) return null;
  const tokenUrl = `${KEYCLOAK_BASE}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data?.access_token) return null;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in || 300,
    };
  } catch {
    return null;
  }
}

// ---------- Uninet API Endpoints ----------

/**
 * Fetches attestation records for the student.
 * API: /api/attestation/student/me?year=&period=
 *
 * @param {string} accessToken
 * @param {{ year?: string, period?: string | number }} options
 * @returns {Promise<{ semesters: Array<{ year?: string, period?: number, records: Array<any> }> }>}
 */
export async function fetchAttestation(accessToken, { year = '', period = '' } = {}) {
  const url = new URL(`${UNINET_BASE_URL}/api/attestation/student/me`);
  if (year) url.searchParams.set('year', String(year));
  if (period !== '' && period != null) url.searchParams.set('period', String(period));

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new UserFacingError(`Сбой сети при запросе оценок: ${err.message}`);
  }

  if (res.status === 401) {
    throw new UninetAuthError('Сессия авторизации истекла.');
  }

  if (!res.ok) {
    throw new UserFacingError(`Портал вернул ошибку при получении оценок: HTTP ${res.status}`);
  }

  const json = await res.json().catch(() => null);
  if (!json) {
    throw new UserFacingError('Пустой ответ от сервера Uninet.');
  }

  return json;
}

/**
 * Fetches available study semesters.
 * API: /api/schedule/subject/semesters
 *
 * @param {string} accessToken
 * @returns {Promise<Array<{ id: number, yearName: string, periodId: number, current: boolean }>>}
 */
export async function fetchSemesters(accessToken) {
  const url = `${UNINET_BASE_URL}/api/schedule/subject/semesters`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return [];
  }

  if (res.status === 401) {
    throw new UninetAuthError('Сессия авторизации истекла.');
  }

  if (!res.ok) return [];

  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

// ---------- In-memory Auth Prompt State ----------
const AUTH_PROMPT_TTL_MS = 5 * 60 * 1000;
const pendingAuth = new Map();
const tempCreds = new Map();

export function beginAuthPrompt(userId) {
  cancelAuthPrompt(userId);
  const timer = setTimeout(() => pendingAuth.delete(userId), AUTH_PROMPT_TTL_MS);
  timer.unref?.();
  pendingAuth.set(userId, { step: 'login', login: null, timer });
}

export function getAuthPromptStep(userId) {
  return pendingAuth.get(userId)?.step || null;
}

export function setPromptLogin(userId, login) {
  const cur = pendingAuth.get(userId);
  if (!cur) return;
  cur.step = 'password';
  cur.login = normalizeLogin(login);
}

export function consumePromptLogin(userId) {
  const cur = pendingAuth.get(userId);
  if (!cur) return null;
  clearTimeout(cur.timer);
  pendingAuth.delete(userId);
  return cur.login;
}

export function cancelAuthPrompt(userId) {
  const cur = pendingAuth.get(userId);
  if (cur?.timer) clearTimeout(cur.timer);
  pendingAuth.delete(userId);
  tempCreds.delete(userId);
}

export function setTempCreds(userId, login, password) {
  const timer = setTimeout(() => tempCreds.delete(userId), 10 * 60 * 1000);
  timer.unref?.();
  tempCreds.set(userId, { login: normalizeLogin(login), password, timer });
}

export function consumeTempCreds(userId) {
  const creds = tempCreds.get(userId);
  if (!creds) return null;
  clearTimeout(creds.timer);
  tempCreds.delete(userId);
  return { login: creds.login, password: creds.password };
}

export function peekTempCreds(userId) {
  const creds = tempCreds.get(userId);
  return creds ? { login: creds.login, password: creds.password } : null;
}

// ---------- In-memory Token Cache ----------
// Map<userId, { accessToken, refreshToken, expiresAt, login }>
const tokenCache = new Map();

export function getCachedToken(userId) {
  const entry = tokenCache.get(userId);
  if (!entry) return null;
  // If token has at least 30 seconds left before expiration
  if (entry.expiresAt > Date.now() + 30000) {
    return entry;
  }
  return null;
}

export function getCachedRefreshToken(userId) {
  return tokenCache.get(userId)?.refreshToken || null;
}

export function setCachedToken(userId, { accessToken, refreshToken, expiresIn, login }) {
  const expiresAt = Date.now() + (expiresIn || 300) * 1000;
  tokenCache.set(userId, {
    accessToken,
    refreshToken: refreshToken || tokenCache.get(userId)?.refreshToken || null,
    expiresAt,
    login: login || tokenCache.get(userId)?.login || '',
  });
}

export function clearCachedToken(userId) {
  tokenCache.delete(userId);
}
