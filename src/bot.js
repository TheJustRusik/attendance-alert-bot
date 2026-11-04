import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import * as db from './db.js';
import * as aw from './autowatcher.js';
import * as aa from './attendance.js';
import * as uninet from './uninetApi.js';
import { redis, setState, getState, clearState, acquireCooldown, cooldownLeft, releaseCooldown } from './redis.js';

export const bot = new Telegraf(config.botToken);

const PAGE = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const btn = Markup.button.callback;

const displayName = (u) => (u.username ? `@${u.username}` : u.first_name || `id${u.id}`);
const ownerName = (p) => (p.owner_username ? `@${p.owner_username}` : p.owner_first_name || `id${p.owner_id}`);
const isAdmin = (u) => u.role === 'admin';
const isStaff = (u) => u.role === 'admin' || u.role === 'moderator';
/** Владелец пула (и всё ещё модератор/админ) */
const owns = (u, pool) => pool.owner_id === u.id && isStaff(u);
/** Может управлять пулом: удалять его и убирать участников */
const canManage = (u, pool) => isAdmin(u) || owns(u, pool);

const ROLE_LABEL = { admin: '👑 Админ', moderator: '🛡 Модератор', user: '👤 Пользователь' };
const LIST_TITLE = { pools: '🔍 Все пулы', my: '📚 Мои подписки', own: '🛠 Мои пулы' };

const fmtWait = (s) => (s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} сек` : `${s} сек`);

// ---------- helpers ----------
async function show(ctx, text, keyboard) {
  const extra = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard };
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch (e) {
      if (String(e.description || e.message).includes('not modified')) return;
    }
  }
  await ctx.reply(text, extra);
}

async function send(userId, text, extra = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await bot.telegram.sendMessage(userId, text, { parse_mode: 'HTML', ...extra });
      return true;
    } catch (e) {
      const retry = e.response?.parameters?.retry_after;
      if (e.response?.error_code === 429 && retry) {
        await sleep(retry * 1000 + 100);
        continue;
      }
      return false; // заблокировал бота / удалил чат и т.п.
    }
  }
  return false;
}

async function broadcast(ids, text) {
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    (await send(id, text)) ? sent++ : failed++;
    await sleep(40); // ~25 сообщений/сек — в пределах лимитов Telegram
  }
  return { sent, failed };
}

const act = (re, fn) =>
  bot.action(re, async (ctx) => {
    try {
      await fn(ctx);
    } finally {
      ctx.answerCbQuery().catch(() => {});
    }
  });

const alert = (ctx, text) => ctx.answerCbQuery(text, { show_alert: true }).catch(() => {});

function pager(prefix, page, hasNext, suffix = '') {
  const row = [];
  if (page > 0) row.push(btn('◀️', `${prefix}:${page - 1}${suffix}`));
  if (hasNext) row.push(btn('▶️', `${prefix}:${page + 1}${suffix}`));
  return row;
}

// ---------- меню ----------
async function resetDialog(uid) {
  aw.cancelAuthPrompt(uid);
  aa.cancelAuthPrompt(uid);
  uninet.cancelAuthPrompt(uid);
  await clearState(uid);
}

async function buildMainMenu(u) {
  const activeAw = aw.getSession(u.id);
  const awTitle = activeAw
    ? '🎬 Автопросмотр лекций в портале Uninet (🟢)'
    : '🎬 Автопросмотр лекций в портале Uninet';

  const aaCfg = await db.getAutoAttendance(u.id);
  const aaTitle = aaCfg
    ? aaCfg.enabled
      ? '🤖 Авто-аттенданс в PGE (🟢 Вкл)'
      : '🤖 Авто-аттенданс в PGE (⏸ Пауза)'
    : '🤖 Авто-аттенданс в PGE';

  const rows = [
    [btn('🔍 Все пулы', 'pools:0'), btn('📚 Мои подписки', 'my:0')],
    [btn('📊 Оценки (Аттестация)', 'attestation')],
    [btn(aaTitle, 'autoattend')],
    [btn(awTitle, 'autowatch')],
  ];
  if (isStaff(u)) rows.push([btn('🛠 Мои пулы', 'own:0'), btn('➕ Создать пул', 'create')]);
  if (isAdmin(u)) rows.push([btn('👑 Админ-панель', 'admin')]);
  return Markup.inlineKeyboard(rows);
}

async function showMenu(ctx) {
  const u = ctx.state.user;
  await show(
    ctx,
    `👋 Привет, <b>${esc(u.first_name || displayName(u))}</b>!\n\n` +
      `Я сообщу одногруппникам, что <b>берут аттенданс</b> 🔔, и могу автоматически отметить тебя на <b>pge.kbtu.kz</b> 🤖\n` +
      `Вступай в пул нужного предмета — и уведомления придут тебе.\n\n` +
      `Твоя роль: ${ROLE_LABEL[u.role]}`,
    await buildMainMenu(u),
  );
}

// ---------- списки пулов ----------
async function renderList(ctx, kind, page) {
  const u = ctx.state.user;
  if (kind === 'own' && !isStaff(u)) return alert(ctx, '⛔ Только для модераторов');

  const rows = await db.listPools({ kind, userId: u.id, limit: PAGE + 1, offset: page * PAGE });
  const hasNext = rows.length > PAGE;
  const items = rows.slice(0, PAGE);

  const kb = items.map((p) => [btn(`📚 ${p.name} · 👥 ${p.members}`, `pool:${p.id}:${kind}`)]);
  const pg = pager(kind, page, hasNext);
  if (pg.length) kb.push(pg);
  if (kind === 'own') kb.push([btn('➕ Создать пул', 'create')]);
  kb.push([btn('🏠 Меню', 'menu')]);

  const empty = {
    pools: 'Пока нет ни одного пула 🤷',
    my: 'Вы пока не состоите ни в одном пуле 📭\nЗагляните в «Все пулы» 🔍',
    own: 'У вас пока нет пулов — создайте первый ➕',
  }[kind];

  await show(ctx, `<b>${LIST_TITLE[kind]}</b>\n\n${items.length ? 'Выберите пул:' : empty}`, Markup.inlineKeyboard(kb));
}

// ---------- карточка пула ----------
async function renderPool(ctx, poolId, kind = 'pools', note = '') {
  const u = ctx.state.user;
  const pool = await db.getPool(poolId);
  if (!pool) {
    return show(ctx, '😕 Пул не найден — возможно, его удалили.', Markup.inlineKeyboard([[btn('🔍 Все пулы', 'pools:0')]]));
  }
  const member = await db.isMember(poolId, u.id);
  const owner = owns(u, pool);
  const aaCfg = member ? await db.getAutoAttendance(u.id) : null;

  const rows = [];
  if (member) {
    rows.push([btn('📢 Уведомить всех: берут аттенданс', `notify:${poolId}:${kind}`)]);
    if (!owner) rows.push([btn('🚪 Выйти из пула', `leave:${poolId}:${kind}`)]);
  } else {
    rows.push([btn('✅ Вступить в пул', `join:${poolId}:${kind}`)]);
  }
  if (canManage(u, pool)) {
    rows.push([btn('👥 Участники', `members:${poolId}:0:${kind}`), btn('🗑 Удалить пул', `del:${poolId}:${kind}`)]);
  }
  rows.push([btn('⬅️ Назад', `${kind}:0`), btn('🏠 Меню', 'menu')]);

  const aaLine = member
    ? aaCfg
      ? aaCfg.enabled
        ? '\n🤖 Авто-аттенданс: <b>включён</b> 🟢'
        : '\n🤖 Авто-аттенданс: <i>на паузе</i> ⏸'
      : '\n🤖 Авто-аттенданс: <i>не настроен</i> (/autoattend)'
    : '';

  const status = member
    ? (owner
        ? '🛡 Это ваш пул — уведомления без ограничений'
        : `✅ Вы в пуле · уведомления раз в ${fmtWait(config.notifyCooldownSec)}`) + aaLine
    : 'Вы пока не в этом пуле';

  await show(
    ctx,
    `📚 <b>${esc(pool.name)}</b>\n\n👤 Модератор: ${esc(ownerName(pool))}\n👥 Участников: ${pool.members}\n\n${status}${note ? `\n\n${note}` : ''}`,
    Markup.inlineKeyboard(rows),
  );
}

// ---------- middleware ----------
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private' || !ctx.from) return; // работаем только в личке
  ctx.state.user = await db.upsertUser(ctx.from);
  return next();
});

// ---------- команды ----------
bot.start(async (ctx) => {
  await resetDialog(ctx.from.id);
  await showMenu(ctx);
});
bot.command('menu', async (ctx) => {
  await resetDialog(ctx.from.id);
  await showMenu(ctx);
});
bot.command('cancel', async (ctx) => {
  await resetDialog(ctx.from.id);
  await showMenu(ctx);
});
bot.command('autoattend', async (ctx) => {
  await resetDialog(ctx.from.id);
  await renderAutoAttend(ctx);
});
bot.command('autowatch', async (ctx) => {
  await resetDialog(ctx.from.id);
  await renderAutoWatch(ctx);
});
bot.command(['attestation', 'grades', 'att'], async (ctx) => {
  await resetDialog(ctx.from.id);
  await renderAttestation(ctx);
});
bot.command('admin', async (ctx) => {
  await resetDialog(ctx.from.id);
  if (!isAdmin(ctx.state.user)) {
    return ctx.reply('⛔ Команда доступна только администраторам.');
  }
  await renderAdmin(ctx);
});
bot.command('users', async (ctx) => {
  await resetDialog(ctx.from.id);
  if (!isAdmin(ctx.state.user)) {
    return ctx.reply('⛔ Команда доступна только администраторам.');
  }
  await renderUsers(ctx, 0);
});

act(/^menu$/, async (ctx) => {
  await resetDialog(ctx.from.id);
  await showMenu(ctx);
});
act(/^cancel$/, async (ctx) => {
  await resetDialog(ctx.from.id);
  await showMenu(ctx);
});

// ---------- списки ----------
act(/^(pools|my|own):(\d+)$/, (ctx) => renderList(ctx, ctx.match[1], Number(ctx.match[2])));
act(/^pool:(\d+):(pools|my|own)$/, (ctx) => renderPool(ctx, Number(ctx.match[1]), ctx.match[2]));

// ---------- вступить / выйти ----------
act(/^join:(\d+):(pools|my|own)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const pool = await db.getPool(id);
  if (!pool) return renderPool(ctx, id);
  await db.joinPool(id, ctx.state.user.id);
  await ctx.answerCbQuery('✅ Вы вступили в пул').catch(() => {});
  await renderPool(ctx, id, ctx.match[2]);
});

act(/^leave:(\d+):(pools|my|own)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const pool = await db.getPool(id);
  if (!pool) return renderPool(ctx, id);
  if (owns(ctx.state.user, pool)) return alert(ctx, '⛔ Владелец не может выйти из своего пула');
  await db.leavePool(id, ctx.state.user.id);
  await ctx.answerCbQuery('🚪 Вы вышли из пула').catch(() => {});
  await renderPool(ctx, id, ctx.match[2]);
});

// ---------- уведомление ----------
act(/^notify:(\d+):(pools|my|own)$/, async (ctx) => {
  const u = ctx.state.user;
  const id = Number(ctx.match[1]);
  const kind = ctx.match[2];
  const pool = await db.getPool(id);
  if (!pool) return renderPool(ctx, id);
  if (!(await db.isMember(id, u.id))) return alert(ctx, '⛔ Вы не состоите в этом пуле');

  if (!owns(u, pool)) {
    const left = await cooldownLeft(id, u.id);
    if (left > 0) return alert(ctx, `⏳ Слишком часто! Подождите ещё ${fmtWait(left)}`);
  }
  await show(
    ctx,
    `📢 Отправить уведомление <b>«берут аттенданс»</b> всем участникам пула <b>${esc(pool.name)}</b>?\n\n👥 Получателей: ${pool.members - 1}`,
    Markup.inlineKeyboard([
      [btn('✅ Да, отправить', `send:${id}:${kind}`)],
      [btn('❌ Отмена', `pool:${id}:${kind}`)],
    ]),
  );
});

act(/^send:(\d+):(pools|my|own)$/, async (ctx) => {
  const u = ctx.state.user;
  const id = Number(ctx.match[1]);
  const kind = ctx.match[2];
  const pool = await db.getPool(id);
  if (!pool) return renderPool(ctx, id);
  if (!(await db.isMember(id, u.id))) return alert(ctx, '⛔ Вы не состоите в этом пуле');

  const unlimited = owns(u, pool);
  if (!unlimited) {
    const wait = await acquireCooldown(id, u.id);
    if (wait > 0) return alert(ctx, `⏳ Слишком часто! Подождите ещё ${fmtWait(wait)}`);
  }
  await ctx.answerCbQuery('📨 Отправляю…').catch(() => {});

  const ids = await db.memberIds(id, u.id);
  const allPoolUserIds = [u.id, ...ids];
  const autoRows = await db.getAutoAttendanceForUsers(allPoolUserIds);
  const autoMap = new Map(autoRows.map((r) => [r.user_id, r]));

  const baseHeader =
    `🔔 <b>Берут аттенданс!</b>\n\n` +
    `📚 Пул: <b>${esc(pool.name)}</b>\n` +
    `👤 От: ${esc(displayName(u))}\n\n`;

  let sent = 0;
  let failed = 0;
  for (const memberId of ids) {
    const memberCfg = autoMap.get(memberId);
    let msgText = baseHeader + `Скорее отмечайся! 🏃‍♂️💨`;
    let msgExtra = Markup.inlineKeyboard([[btn('🤖 Авто-аттенданс', 'autoattend')]]);

    if (memberCfg?.enabled) {
      msgText =
        baseHeader +
        `🤖 <i>Авто-аттенданс запущен — захожу на pge.kbtu.kz, чтобы отметить вас…</i>`;
      msgExtra = {};
    } else if (memberCfg && !memberCfg.enabled) {
      msgText = baseHeader + `Скорее отмечайся! 🏃‍♂️💨\n<i>(Авто-аттенданс сейчас на паузе)</i>`;
      msgExtra = Markup.inlineKeyboard([[btn('⚡ Отметиться сейчас через бота', 'aa_run_now')]]);
    }

    (await send(memberId, msgText, msgExtra)) ? sent++ : failed++;
    await sleep(40);
  }

  if (!unlimited && ids.length > 0 && sent === 0) await releaseCooldown(id, u.id); // ничего не ушло — не штрафуем

  // Запускаем фоновый авто-аттенданс для всех участников пула с включённой опцией
  const enabledConfigs = autoRows.filter((r) => r.enabled);
  for (const cfg of enabledConfigs) {
    triggerAutoAttendanceForUser(cfg.user_id, cfg.enc_credentials, {
      poolName: pool.name,
      retryIfEmpty: true,
    });
  }

  const autoNote = enabledConfigs.length
    ? `\n🤖 Авто-аттенданс запущен для: ${enabledConfigs.length} чел.`
    : '';

  await renderPool(
    ctx,
    id,
    kind,
    `✅ Уведомление отправлено: ${sent} 👥` +
      (failed ? `\n⚠️ Не доставлено: ${failed} (заблокировали бота)` : '') +
      autoNote,
  );
});

// ---------- участники пула ----------
async function renderMembers(ctx, poolId, page, kind) {
  const u = ctx.state.user;
  const pool = await db.getPool(poolId);
  if (!pool) return renderPool(ctx, poolId);
  if (!canManage(u, pool)) return alert(ctx, '⛔ Нет доступа');

  const rows = await db.listMembers(poolId, PAGE + 1, page * PAGE);
  const hasNext = rows.length > PAGE;
  const items = rows.slice(0, PAGE);

  const kb = items.map((m) =>
    m.id === pool.owner_id
      ? [btn(`🛡 ${displayName(m)} (модератор)`, 'noop')]
      : [btn(`❌ ${displayName(m)}`, `kick:${poolId}:${m.id}:${kind}`)],
  );
  const pg = pager(`members:${poolId}`, page, hasNext, `:${kind}`);
  if (pg.length) kb.push(pg);
  kb.push([btn('⬅️ К пулу', `pool:${poolId}:${kind}`)]);

  await show(
    ctx,
    `👥 <b>Участники «${esc(pool.name)}»</b>\n\nНажмите на ❌, чтобы удалить участника из пула. Ему придёт уведомление.`,
    Markup.inlineKeyboard(kb),
  );
}

act(/^noop$/, async () => {});
act(/^members:(\d+):(\d+):(pools|my|own)$/, (ctx) =>
  renderMembers(ctx, Number(ctx.match[1]), Number(ctx.match[2]), ctx.match[3]),
);

act(/^kick:(\d+):(\d+):(pools|my|own)$/, async (ctx) => {
  const poolId = Number(ctx.match[1]);
  const userId = Number(ctx.match[2]);
  const kind = ctx.match[3];
  const pool = await db.getPool(poolId);
  if (!pool) return renderPool(ctx, poolId);
  if (!canManage(ctx.state.user, pool)) return alert(ctx, '⛔ Нет доступа');
  if (userId === pool.owner_id) return alert(ctx, '⛔ Нельзя удалить владельца пула');

  const removed = await db.leavePool(poolId, userId);
  if (removed) {
    await send(userId, `🚪 Вас удалили из пула <b>«${esc(pool.name)}»</b>.`);
    await ctx.answerCbQuery('✅ Участник удалён').catch(() => {});
  }
  await renderMembers(ctx, poolId, 0, kind);
});

// ---------- удаление пула ----------
act(/^del:(\d+):(pools|my|own)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const pool = await db.getPool(id);
  if (!pool) return renderPool(ctx, id);
  if (!canManage(ctx.state.user, pool)) return alert(ctx, '⛔ Нет доступа');
  await show(
    ctx,
    `🗑 Удалить пул <b>«${esc(pool.name)}»</b>?\n\n👥 Участников: ${pool.members}. Все они получат уведомление об удалении. Это действие необратимо.`,
    Markup.inlineKeyboard([
      [btn('🗑 Да, удалить', `delok:${id}:${ctx.match[2]}`)],
      [btn('❌ Отмена', `pool:${id}:${ctx.match[2]}`)],
    ]),
  );
});

act(/^delok:(\d+):(pools|my|own)$/, async (ctx) => {
  const u = ctx.state.user;
  const id = Number(ctx.match[1]);
  const pool = await db.getPool(id);
  if (!pool) return renderPool(ctx, id);
  if (!canManage(u, pool)) return alert(ctx, '⛔ Нет доступа');

  const memberIds = await db.deletePool(id);
  await ctx.answerCbQuery('🗑 Пул удалён').catch(() => {});
  for (const m of memberIds) {
    if (m === u.id) continue;
    await send(m, `🗑 Пул <b>«${esc(pool.name)}»</b> был удалён.`);
    await sleep(40);
  }
  await renderList(ctx, ctx.match[2] === 'own' && isStaff(u) ? 'own' : 'pools', 0);
});

// ---------- создание пула ----------
act(/^create$/, async (ctx) => {
  if (!isStaff(ctx.state.user)) return alert(ctx, '⛔ Создавать пулы могут только модераторы');
  aw.cancelAuthPrompt(ctx.from.id);
  aa.cancelAuthPrompt(ctx.from.id);
  await setState(ctx.from.id, { type: 'create_pool' });
  await show(
    ctx,
    '✏️ <b>Новый пул</b>\n\nОтправьте название предмета одним сообщением (до 40 символов).\nНапример: <i>Unity Game Engine</i>',
    Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
  );
});

// ---------- авто-аттенданс PGE ----------
function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(dt.getDate())}.${pad2(dt.getMonth() + 1)} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

function triggerAutoAttendanceForUser(
  userId,
  encCredentials,
  { poolName = null, retryIfEmpty = false, editMessageId = null } = {},
) {
  (async () => {
    const res = await aa.runCheckInForUser(userId, encCredentials, { retryIfEmpty });
    const poolLine = poolName ? `\n📚 Пул: <b>${esc(poolName)}</b>` : '';

    let statusSummary = '';
    let replyHtml = '';
    let replyKb = Markup.inlineKeyboard([
      [btn('⚙️ Авто-аттенданс', 'autoattend'), btn('🏠 Меню', 'menu')],
    ]);

    if (res.status === 'checked') {
      statusSummary = `✅ Отмечено: ${res.checkedCount}`;
      const discList = res.disciplines?.length
        ? `\n📖 Дисциплины:\n` + res.disciplines.map((d) => `• <i>${esc(d)}</i>`).join('\n')
        : '';
      replyHtml =
        `✅ <b>Авто-аттенданс успешно отмечен!</b>` +
        poolLine +
        `\n✔️ Нажато активных Check in: <b>${res.checkedCount}</b>` +
        discList;
    } else if (res.status === 'none') {
      statusSummary = 'ℹ️ Активных Check in не было';
      replyHtml =
        `ℹ️ <b>Авто-аттенданс проверил pge.kbtu.kz</b>` +
        poolLine +
        `\n\nАктивных кнопок <code>Check in</code> сейчас нет ` +
        `<i>(возможно, вы уже отмечены или преподаватель ещё не открыл / уже закрыл отметку)</i>.`;
      replyKb = Markup.inlineKeyboard([
        [btn('🔄 Проверить ещё раз', 'aa_run_now')],
        [btn('⚙️ Авто-аттенданс', 'autoattend'), btn('🏠 Меню', 'menu')],
      ]);
    } else if (res.status === 'invalid_credentials' || res.status === 'decryption_error') {
      statusSummary = '❌ Ошибка входа (пауза)';
      await db.setAutoAttendanceEnabled(userId, false).catch(() => {});
      replyHtml =
        `❌ <b>Авто-аттенданс не смог войти в pge.kbtu.kz</b>` +
        poolLine +
        `\nПричина: ${esc(res.error || 'Неверный логин или пароль.')}\n\n` +
        `⏸ Авто-аттенданс временно поставлен на паузу — обновите логин/пароль в настройках!`;
      replyKb = Markup.inlineKeyboard([
        [btn('🔑 Обновить данные PGE', 'aa_setup')],
        [btn('🏠 Меню', 'menu')],
      ]);
    } else {
      statusSummary = '⚠️ Ошибка сети/портала';
      replyHtml =
        `⚠️ <b>Авто-аттенданс: сбой при обращении к pge.kbtu.kz</b>` +
        poolLine +
        `\n<i>${esc(res.error || 'Портал временно недоступен.')}</i>\n\n` +
        `Проверьте отметку вручную или повторите попытку:`;
      replyKb = Markup.inlineKeyboard([
        [btn('🔄 Повторить сейчас', 'aa_run_now')],
        [btn('⚙️ Авто-аттенданс', 'autoattend'), btn('🏠 Меню', 'menu')],
      ]);
    }

    await db.updateAutoAttendanceRun(userId, statusSummary).catch(() => {});

    if (editMessageId) {
      await bot.telegram
        .editMessageText(userId, editMessageId, undefined, replyHtml, {
          parse_mode: 'HTML',
          ...replyKb,
        })
        .catch(() => send(userId, replyHtml, replyKb));
    } else {
      await send(userId, replyHtml, replyKb);
    }
  })().catch((err) => {
    console.error(`[AutoAttendance] Unhandled error for user ${userId}:`, err.message);
  });
}

async function renderAutoAttend(ctx, note = '') {
  const u = ctx.state.user;
  await resetDialog(u.id);

  const cfg = await db.getAutoAttendance(u.id);
  if (!cfg) {
    return show(
      ctx,
      `🤖 <b>Авто-аттенданс в портале PGE (pge.kbtu.kz)</b>\n\n` +
        `Бот может <b>автоматически</b> заходить за вас на <code>pge.kbtu.kz/RegistrationOnline</code> ` +
        `и нажимать все активные кнопки <code>Check in</code> каждый раз, когда в любом вашем пуле приходит алерт «берут аттенданс» 🔔\n\n` +
        `🔒 <i>Логин и пароль шифруются алгоритмом AES-256-GCM, сообщения с ними мгновенно удаляются из чата, а удалить привязку можно в любой момент.</i>` +
        (note ? `\n\n${note}` : ''),
      Markup.inlineKeyboard([
        [btn('🔑 Подключить аккаунт PGE', 'aa_setup')],
        [btn('🏠 Меню', 'menu')],
      ]),
    );
  }

  const running = aa.isUserJobRunning(u.id);
  const stateLabel = cfg.enabled
    ? '🟢 <b>Включён</b> (срабатывает автоматически при алерте в ваших пулах)'
    : '⏸ <b>На паузе</b> (автоматический вход временно отключён)';

  const lastRunBlock = cfg.last_run_at
    ? `\n🕒 Последний запуск: <code>${esc(fmtDateTime(cfg.last_run_at))}</code> · ${esc(cfg.last_status || '—')}`
    : '';

  const toggleBtn = cfg.enabled
    ? btn('⏸ Поставить на паузу', 'aa_toggle')
    : btn('▶️ Включить обратно', 'aa_toggle');

  await show(
    ctx,
    `🤖 <b>Авто-аттенданс (pge.kbtu.kz)</b>\n\n` +
      `Статус: ${stateLabel}\n` +
      `👤 Аккаунт PGE: <code>${esc(cfg.login_mask)}</code>` +
      lastRunBlock +
      (running ? '\n\n🔄 <i>Сейчас выполняется проверка на pge.kbtu.kz…</i>' : '') +
      (note ? `\n\n${note}` : ''),
    Markup.inlineKeyboard([
      [btn('⚡ Проверить и отметиться сейчас', 'aa_run_now')],
      [toggleBtn],
      [btn('🔑 Сменить логин/пароль', 'aa_setup'), btn('🗑 Удалить данные', 'aa_del_ask')],
      [btn('🏠 Меню', 'menu')],
    ]),
  );
}

act(/^autoattend$/, (ctx) => renderAutoAttend(ctx));

act(/^aa_setup$/, async (ctx) => {
  const u = ctx.state.user;
  await resetDialog(u.id);
  aa.beginAuthPrompt(u.id);
  await show(
    ctx,
    `🔑 <b>Привязка аккаунта pge.kbtu.kz</b>\n\n` +
      `Отправьте ваш <b>логин</b> от портала PGE / WSP (например, <code>i_ivanov</code>).\n\n` +
      `🔒 <i>Сообщение с логином сразу удалится из чата. Данные хранятся только в зашифрованном виде (AES-256-GCM).</i>`,
    Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
  );
});

act(/^aa_toggle$/, async (ctx) => {
  const u = ctx.state.user;
  const cfg = await db.getAutoAttendance(u.id);
  if (!cfg) return renderAutoAttend(ctx);
  const updated = await db.setAutoAttendanceEnabled(u.id, !cfg.enabled);
  await ctx
    .answerCbQuery(updated?.enabled ? '🟢 Авто-аттенданс включён' : '⏸ Авто-аттенданс поставлен на паузу')
    .catch(() => {});
  await renderAutoAttend(ctx);
});

act(/^aa_run_now$/, async (ctx) => {
  const u = ctx.state.user;
  const cfg = await db.getAutoAttendance(u.id);
  if (!cfg) return renderAutoAttend(ctx);
  if (aa.isUserJobRunning(u.id)) {
    return alert(ctx, '⏳ Проверка на pge.kbtu.kz уже выполняется, подождите несколько секунд!');
  }

  await ctx.answerCbQuery('🚀 Запускаю отметку на pge.kbtu.kz…').catch(() => {});
  const waitingText =
    `🔄 <b>Подключаюсь к pge.kbtu.kz…</b>\n` +
    `Вхожу в аккаунт <code>${esc(cfg.login_mask)}</code> и нажимаю все активные кнопки <code>Check in</code> <i>(обычно 5–10 сек)</i>.`;
  const waitingKb = Markup.inlineKeyboard([[btn('🏠 Меню', 'menu')]]);

  let editMsgId = null;
  if (ctx.callbackQuery?.message?.message_id) {
    editMsgId = ctx.callbackQuery.message.message_id;
    await ctx
      .editMessageText(waitingText, { parse_mode: 'HTML', ...waitingKb })
      .catch(async () => {
        const m = await ctx.reply(waitingText, { parse_mode: 'HTML', ...waitingKb });
        editMsgId = m.message_id;
      });
  } else {
    const m = await ctx.reply(waitingText, { parse_mode: 'HTML', ...waitingKb });
    editMsgId = m.message_id;
  }

  triggerAutoAttendanceForUser(u.id, cfg.enc_credentials, {
    retryIfEmpty: false,
    editMessageId: editMsgId,
  });
});

act(/^aa_del_ask$/, async (ctx) => {
  const cfg = await db.getAutoAttendance(ctx.state.user.id);
  if (!cfg) return renderAutoAttend(ctx);
  await show(
    ctx,
    `🗑 <b>Удалить данные авто-аттенданса?</b>\n\n` +
      `Зашифрованный логин и пароль (<code>${esc(cfg.login_mask)}</code>) будут полностью удалены из базы данных.`,
    Markup.inlineKeyboard([
      [btn('🗑 Да, удалить навсегда', 'aa_del_ok')],
      [btn('❌ Отмена', 'autoattend')],
    ]),
  );
});

act(/^aa_del_ok$/, async (ctx) => {
  await db.deleteAutoAttendance(ctx.state.user.id);
  await ctx.answerCbQuery('🗑 Данные авто-аттенданса удалены').catch(() => {});
  await renderAutoAttend(ctx, '✅ Ваши учётные данные полностью удалены из базы.');
});

// ---------- автопросмотр лекций Uninet ----------
function buildCoursePickerKeyboard(courses) {
  const short = (s, max = 46) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
  const rows = courses.map((c, idx) => {
    const label = c.code ? `${c.code} · ${c.title}` : c.title;
    return [btn(`📖 ${short(label)}`, `aw_pick:${idx}`)];
  });
  if (courses.length > 1) {
    rows.push([btn(`🚀 Все курсы подряд (${courses.length})`, 'aw_pick:all')]);
  }
  rows.push([btn('⏹ Отмена (закрыть браузер)', 'aw_stop')]);
  return Markup.inlineKeyboard(rows);
}

async function renderAutoWatch(ctx) {
  const u = ctx.state.user;
  await resetDialog(u.id);

  const session = aw.getSession(u.id);
  if (session) {
    if (session.status === 'logging_in') {
      return show(
        ctx,
        '🔄 <b>Выполняется вход в портал Uninet…</b>\nПодождите несколько секунд.',
        Markup.inlineKeyboard([[btn('⏹ Отмена', 'aw_stop')], [btn('🏠 Меню', 'menu')]]),
      );
    }
    if (session.status === 'selecting_course') {
      return show(
        ctx,
        `🎬 <b>Автопросмотр лекций Uninet</b>\n\n` +
          `Найдено курсов: <b>${session.courses.length}</b>.\n` +
          `Выберите предмет для автопросмотра (или запустите все по очереди):`,
        buildCoursePickerKeyboard(session.courses),
      );
    }
    const elapsedSec = Math.floor((Date.now() - session.startedAt) / 1000);
    return show(
      ctx,
      `🟢 <b>Автопросмотр лекций Uninet активен</b>\n\n` +
        `📖 Курс: <b>${esc(session.currentCourse || '—')}</b>\n` +
        `⏱ В работе: ${fmtWait(elapsedSec)}\n` +
        `📝 Последний лог: <code>${esc(session.lastLog || 'ожидание…')}</code>`,
      Markup.inlineKeyboard([
        [btn('🔄 Обновить', 'autowatch'), btn('⏹ Остановить', 'aw_stop')],
        [btn('🏠 Меню', 'menu')],
      ]),
    );
  }

  const check = aw.canStartNewSession(u.id);
  if (!check.ok) {
    return show(
      ctx,
      `⏳ <b>Свободных браузеров сейчас нет</b>\n\nЗапущено сессий: ${aw.activeSessionCount()} из ${config.maxWatchSessions}.\nПопробуйте немного позже.`,
      Markup.inlineKeyboard([[btn('🔄 Проверить снова', 'autowatch')], [btn('🏠 Меню', 'menu')]]),
    );
  }

  const cfg = await db.getAutoAttendance(u.id);
  if (cfg) {
    return show(
      ctx,
      `🎬 <b>Автопросмотр лекций в портале Uninet</b>\n\n` +
        `Найден сохранённый аккаунт KBTU: <code>${esc(cfg.login_mask)}</code>.\n\n` +
        `Войти под этим аккаунтом или ввести другой логин/пароль?`,
      Markup.inlineKeyboard([
        [btn(`▶️ Войти как ${cfg.login_mask}`, 'aw_use_saved')],
        [btn('🔑 Ввести другой логин/пароль', 'aw_prompt')],
        [btn('🏠 Меню', 'menu')],
      ]),
    );
  }

  aw.beginAuthPrompt(u.id);
  await show(
    ctx,
    `🎬 <b>Автопросмотр лекций в портале Uninet</b>\n\n` +
      `Отправьте ваш <b>логин</b> от портала Uninet (например, <code>i_ivanov</code>).\n\n` +
      `🔒 <i>Бот не хранит логин и пароль (ни в БД, ни на диске), а сообщения с ними сразу удаляются из чата.</i>`,
    Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
  );
}

act(/^autowatch$/, (ctx) => renderAutoWatch(ctx));

act(/^aw_prompt$/, async (ctx) => {
  const u = ctx.state.user;
  await resetDialog(u.id);
  aw.beginAuthPrompt(u.id);
  await show(
    ctx,
    `🎬 <b>Автопросмотр лекций в портале Uninet</b>\n\n` +
      `Отправьте ваш <b>логин</b> от портала Uninet (например, <code>i_ivanov</code>).\n\n` +
      `🔒 <i>Бот не хранит логин и пароль (ни в БД, ни на диске), а сообщения с ними сразу удаляются из чата.</i>`,
    Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
  );
});

act(/^aw_use_saved$/, async (ctx) => {
  const u = ctx.state.user;
  await resetDialog(u.id);
  const cfg = await db.getAutoAttendance(u.id);
  if (!cfg) return renderAutoWatch(ctx);

  const check = aw.canStartNewSession(u.id);
  if (!check.ok) {
    return alert(ctx, '⏳ Свободных браузеров сейчас нет. Попробуйте чуть позже.');
  }

  let creds;
  try {
    creds = aa.decryptCredentials(cfg.enc_credentials);
  } catch {
    return alert(ctx, '❌ Не удалось расшифровать сохранённые данные.');
  }

  const statusMsg = await ctx.reply(
    `🔄 Запускаю браузер и вхожу в Uninet под <code>${esc(cfg.login_mask)}</code>… <i>(обычно 10–20 сек)</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[btn('⏹ Отмена', 'aw_stop')]]),
    },
  );

  (async () => {
    try {
      const courses = await aw.loginAndFetchCourses(u.id, creds.login, creds.password, (html, extra) =>
        send(u.id, html, extra),
      );
      const pickerText =
        `✅ <b>Вход в Uninet выполнен!</b>\n\n` +
        `Найдено курсов: <b>${courses.length}</b>.\n` +
        `Выберите предмет для автопросмотра лекций (или запустите все подряд):`;
      const kb = buildCoursePickerKeyboard(courses);

      await bot.telegram
        .editMessageText(u.id, statusMsg.message_id, undefined, pickerText, {
          parse_mode: 'HTML',
          ...kb,
        })
        .catch(() => send(u.id, pickerText, kb));
    } catch (err) {
      const msg = err instanceof aw.UserFacingError ? err.message : 'Ошибка при входе в портал Uninet.';
      const errText = `❌ <b>${esc(msg)}</b>`;
      const errKb = Markup.inlineKeyboard([
        [btn('🔁 Попробовать снова', 'autowatch')],
        [btn('🏠 Меню', 'menu')],
      ]);
      await bot.telegram
        .editMessageText(u.id, statusMsg.message_id, undefined, errText, {
          parse_mode: 'HTML',
          ...errKb,
        })
        .catch(() => send(u.id, errText, errKb));
    }
  })();
});

act(/^aw_pick:(all|\d+)$/, async (ctx) => {
  const u = ctx.state.user;
  const pick = ctx.match[1];
  const stopKb = Markup.inlineKeyboard([
    [btn('📊 Статус', 'autowatch'), btn('⏹ Остановить автопросмотр', 'aw_stop')],
  ]);
  const doneKb = Markup.inlineKeyboard([[btn('🏠 Меню', 'menu')]]);

  try {
    aw.startWatchingSelection(u.id, pick, stopKb, doneKb);
    await show(
      ctx,
      `🚀 <b>Автопросмотр запущен!</b>\n\n` +
        `Браузер открывает лекции и запускает скрипт <code>AutoWatcher</code>.\n` +
        `Логи прогресса будут приходить в этот чат.`,
      Markup.inlineKeyboard([
        [btn('📊 Статус', 'autowatch'), btn('⏹ Остановить', 'aw_stop')],
        [btn('🏠 Меню', 'menu')],
      ]),
    );
  } catch (err) {
    const msg = err instanceof aw.UserFacingError ? err.message : 'Не удалось запустить просмотр.';
    await show(
      ctx,
      `⚠️ ${esc(msg)}`,
      Markup.inlineKeyboard([[btn('🔁 Запустить заново', 'autowatch')], [btn('🏠 Меню', 'menu')]]),
    );
  }
});

act(/^aw_stop$/, async (ctx) => {
  const u = ctx.state.user;
  aw.cancelAuthPrompt(u.id);
  const stopped = await aw.stopSession(u.id);
  await ctx.answerCbQuery(stopped ? '⏹ Автопросмотр остановлен' : 'Сессия уже завершена').catch(() => {});
  await show(
    ctx,
    stopped
      ? '⏹ <b>Автопросмотр остановлен.</b>\nБраузер закрыт, сессия полностью очищена.'
      : 'ℹ️ Активной сессии автопросмотра нет.',
    await buildMainMenu(u),
  );
});

// ---------- оценки за аттестацию Uninet ----------
const PERIOD_NAMES = {
  1: 'Осенний (Fall)',
  2: 'Весенний (Spring)',
  3: 'Летний (Summer)',
};

const PERIOD_SHORT = {
  1: '🍂 Осень',
  2: '🌱 Весна',
  3: '☀️ Лето',
};

function formatSubjectName(s) {
  if (!s) return '—';
  if (typeof s === 'string') return s;
  if (typeof s === 'object') {
    return s.ru || s.kz || s.en || s.name || 'Дисциплина';
  }
  return String(s);
}

function formatCourseBlock(rec) {
  const code = esc(rec.subjectCode || '').trim();
  const name = esc(formatSubjectName(rec.subjectName || rec.courseName || rec.disciplineName)).trim();
  const header = code && name ? `<b>${code}</b> · ${name}` : `<b>${code || name || 'Дисциплина'}</b>`;

  const lines = [header];

  const g1 = rec.grade1 != null ? String(rec.grade1) : '—';
  const g2 = rec.grade2 != null ? String(rec.grade2) : '—';
  const fin = rec.finalGrade != null ? String(rec.finalGrade) : '—';
  const letter = rec.letterGrade ? String(rec.letterGrade).trim() : '';
  const total = rec.digitGrade ?? rec.totalGrade ?? rec.total ?? null;

  lines.push(`  ├ 1-я аттестация: <b>${g1}</b>`);
  lines.push(`  ├ 2-я аттестация: <b>${g2}</b>`);

  let sumAtt = null;
  if (typeof rec.grade1 === 'number' && typeof rec.grade2 === 'number') {
    sumAtt = rec.grade1 + rec.grade2;
    lines.push(`  ├ Допуск (РД): <b>${sumAtt}</b> / 60`);
  }

  lines.push(`  ├ Экзамен (Финал): <b>${fin}</b>`);

  let finalSummary = '';
  if (total != null && letter) {
    finalSummary = `<b>${total}</b> (${letter})`;
  } else if (letter) {
    finalSummary = `<b>${letter}</b>`;
  } else if (total != null) {
    finalSummary = `<b>${total}</b>`;
  } else if (sumAtt != null && typeof rec.finalGrade === 'number') {
    finalSummary = `<b>${sumAtt + rec.finalGrade}</b>`;
  } else {
    finalSummary = '—';
  }

  lines.push(`  └ Итог: ${finalSummary}`);
  return lines.join('\n');
}

async function getOrFetchValidUninetToken(userId) {
  let token = uninet.getCachedToken(userId);
  if (token) return token;

  const refreshToken = uninet.getCachedRefreshToken(userId);
  if (refreshToken) {
    const refreshed = await uninet.refreshAccessToken(refreshToken).catch(() => null);
    if (refreshed) {
      const login = uninet.getCachedToken(userId)?.login || '';
      uninet.setCachedToken(userId, { ...refreshed, login });
      return { ...refreshed, login };
    }
  }

  // Проверяем сохранённые учётные данные KBTU в auto_attendance
  const cfg = await db.getAutoAttendance(userId);
  if (cfg) {
    try {
      const { login, password } = aa.decryptCredentials(cfg.enc_credentials);
      const tokenData = await uninet.loginWithCredentials(login, password);
      uninet.setCachedToken(userId, { ...tokenData, login });
      return { ...tokenData, login };
    } catch (err) {
      console.warn(`[Attestation] Auto-login with saved credentials failed for user ${userId}:`, err.message);
      return null;
    }
  }

  return null;
}

async function showAttestationGrades(
  ctx,
  userId,
  tokenData,
  { year = '', period = '' } = {},
  editMessageId = null,
) {
  try {
    let semesters = [];
    try {
      semesters = await uninet.fetchSemesters(tokenData.accessToken);
    } catch (e) {
      if (e instanceof uninet.UninetAuthError) throw e;
    }

    let selectedYear = year;
    let selectedPeriod = period;

    if (!selectedYear || !selectedPeriod) {
      const currentSem = semesters.find((s) => s.current) || semesters[0];
      if (currentSem) {
        selectedYear = selectedYear || currentSem.yearName;
        selectedPeriod = selectedPeriod || String(currentSem.periodId);
      }
    }

    const data = await uninet.fetchAttestation(tokenData.accessToken, {
      year: selectedYear,
      period: selectedPeriod,
    });

    const semesterList = Array.isArray(data)
      ? data
      : data?.semesters || (data?.records ? [data] : []);
    const records = semesterList.flatMap((s) => s.records || []);

    const periodLabel =
      PERIOD_NAMES[selectedPeriod] || (selectedPeriod ? `Период ${selectedPeriod}` : 'Текущий семестр');
    const semTitle = selectedYear ? `${selectedYear} · ${periodLabel}` : periodLabel;
    const loginTitle = tokenData.login ? `\n👤 Студент: <code>${esc(tokenData.login)}</code>` : '';

    let text = `📊 <b>Оценки за аттестацию (Uninet)</b>\n📅 Семестр: <b>${esc(semTitle)}</b>${loginTitle}\n\n`;

    if (!records.length) {
      text += `ℹ️ <i>За выбранный семестр записей об аттестации не найдено (возможно, семестр ещё не начался или оценки ещё не внесены).</i>`;
    } else {
      const courseBlocks = records.map(formatCourseBlock);
      text += courseBlocks.join('\n\n');
    }

    const kbRows = [];

    // Кнопки выбора семестров
    if (semesters.length > 1) {
      if (semesters.length <= 3) {
        const row = semesters.map((s) => {
          const isSelected =
            String(s.yearName) === String(selectedYear) && String(s.periodId) === String(selectedPeriod);
          const icon = PERIOD_SHORT[s.periodId] || '📅';
          const shortYear = s.yearName.replace(/^\d{2}(\d{2})-\d{2}(\d{2})$/, '$1/$2');
          const label = `${isSelected ? '✅ ' : ''}${icon} ${shortYear}`;
          return btn(label, `att_view:${s.yearName}:${s.periodId}`);
        });
        kbRows.push(row);
      } else {
        kbRows.push([btn('📅 Выбрать другой семестр', 'att_sem_pick')]);
      }
    }

    const refreshBtn = btn('🔄 Обновить', `att_view:${selectedYear || ''}:${selectedPeriod || ''}`);

    const cfg = await db.getAutoAttendance(userId);
    const hasSavedCreds = Boolean(cfg);
    const canSaveTemp = Boolean(uninet.peekTempCreds(userId));

    if (!hasSavedCreds && canSaveTemp) {
      kbRows.push([refreshBtn, btn('💾 Сохранить в боте', 'att_save_creds')]);
    } else if (hasSavedCreds) {
      kbRows.push([refreshBtn, btn('🚪 Сменить аккаунт', 'att_logout')]);
    } else {
      kbRows.push([refreshBtn, btn('🚪 Выйти', 'att_logout')]);
    }

    kbRows.push([btn('🏠 Меню', 'menu')]);

    const keyboard = Markup.inlineKeyboard(kbRows);

    if (editMessageId) {
      await bot.telegram
        .editMessageText(userId, editMessageId, undefined, text, {
          parse_mode: 'HTML',
          ...keyboard,
        })
        .catch(() => send(userId, text, keyboard));
    } else if (ctx.callbackQuery) {
      await show(ctx, text, keyboard);
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  } catch (err) {
    if (err instanceof uninet.UninetAuthError) {
      uninet.clearCachedToken(userId);
      const reText = '⚠️ <b>Сессия авторизации истекла.</b> Пожалуйста, войдите снова:';
      const reKb = Markup.inlineKeyboard([
        [btn('🔑 Войти в Uninet', 'att_setup')],
        [btn('🏠 Меню', 'menu')],
      ]);
      if (editMessageId) {
        await bot.telegram
          .editMessageText(userId, editMessageId, undefined, reText, {
            parse_mode: 'HTML',
            ...reKb,
          })
          .catch(() => send(userId, reText, reKb));
      } else {
        await show(ctx, reText, reKb);
      }
      return;
    }

    const msg = err instanceof uninet.UninetError ? err.message : 'Сбой при загрузке оценок из Uninet.';
    const errText = `❌ <b>${esc(msg)}</b>`;
    const errKb = Markup.inlineKeyboard([
      [btn('🔄 Повторить', `att_view:${year || ''}:${period || ''}`)],
      [btn('🏠 Меню', 'menu')],
    ]);
    if (editMessageId) {
      await bot.telegram
        .editMessageText(userId, editMessageId, undefined, errText, {
          parse_mode: 'HTML',
          ...errKb,
        })
        .catch(() => send(userId, errText, errKb));
    } else {
      await show(ctx, errText, errKb);
    }
  }
}

async function renderAttestation(ctx, { year = '', period = '', forcePrompt = false } = {}) {
  const u = ctx.state.user;
  await resetDialog(u.id);

  if (forcePrompt) {
    return show(
      ctx,
      `📊 <b>Оценки за аттестацию (Uninet)</b>\n\n` +
        `Отправьте логин и пароль от портала Uninet / KBTU, чтобы запросить оценки через официальное API.\n\n` +
        `⚡ <b>Без запуска браузера:</b> запрос выполняется напрямую к API портала, минимизируя нагрузку на сервер.\n` +
        `🔒 <i>Пароль удаляется из чата сразу после получения.</i>`,
      Markup.inlineKeyboard([
        [btn('🔑 Ввести логин и пароль', 'att_setup')],
        [btn('🏠 Меню', 'menu')],
      ]),
    );
  }

  const tokenData = await getOrFetchValidUninetToken(u.id);

  if (!tokenData) {
    const cfg = await db.getAutoAttendance(u.id);
    if (cfg) {
      return show(
        ctx,
        `📊 <b>Оценки за аттестацию (Uninet)</b>\n\n` +
          `Найден сохранённый аккаунт KBTU: <code>${esc(cfg.login_mask)}</code>.\n` +
          `Не удалось автоматически войти (возможно, пароль был изменён). Обновите данные:`,
        Markup.inlineKeyboard([
          [btn('🔑 Обновить логин/пароль', 'att_setup')],
          [btn('🏠 Меню', 'menu')],
        ]),
      );
    }

    return show(
      ctx,
      `📊 <b>Оценки за аттестацию (Uninet)</b>\n\n` +
        `Для просмотра оценок войдите под своей учётной записью KBTU (например, <code>i_ivanov</code>).\n\n` +
        `⚡ <b>Быстро и легко:</b> запрос идёт напрямую через официальное API портала без запуска браузера Playwright.\n` +
        `🔒 <i>Пароль удаляется из чата сразу после получения.</i>`,
      Markup.inlineKeyboard([
        [btn('🔑 Войти в Uninet', 'att_setup')],
        [btn('🏠 Меню', 'menu')],
      ]),
    );
  }

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('🔄 Загружаю оценки…').catch(() => {});
  }

  await showAttestationGrades(ctx, u.id, tokenData, { year, period });
}

act(/^attestation$/, (ctx) => renderAttestation(ctx));

act(/^att_setup$/, async (ctx) => {
  const u = ctx.state.user;
  await resetDialog(u.id);
  uninet.beginAuthPrompt(u.id);
  await show(
    ctx,
    `🔑 <b>Вход в Uninet</b>\n\n` +
      `Отправьте ваш <b>логин</b> от портала Uninet / KBTU (например, <code>i_ivanov</code>).\n\n` +
      `🔒 <i>Сообщение с логином сразу удалится из чата.</i>`,
    Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
  );
});

act(/^att_view:(.*):(.*)$/, async (ctx) => {
  const year = ctx.match[1] || '';
  const period = ctx.match[2] || '';
  await renderAttestation(ctx, { year, period });
});

act(/^att_sem_pick$/, async (ctx) => {
  const u = ctx.state.user;
  const tokenData = await getOrFetchValidUninetToken(u.id);
  if (!tokenData) return renderAttestation(ctx);

  const semesters = await uninet.fetchSemesters(tokenData.accessToken);
  if (!semesters.length) {
    return alert(ctx, 'Список семестров недоступен');
  }

  // University DB contains future placeholder years at start. Show current + past semesters (up to 10)
  const curIdx = semesters.findIndex((s) => s.current);
  const displaySemesters = curIdx !== -1 ? semesters.slice(curIdx, curIdx + 10) : semesters.slice(0, 10);

  const rows = displaySemesters.map((s) => {
    const icon = PERIOD_SHORT[s.periodId] || '📅';
    const curHint = s.current ? ' (текущий)' : '';
    return [
      btn(
        `${icon} ${s.yearName} · ${PERIOD_NAMES[s.periodId] || s.periodId}${curHint}`,
        `att_view:${s.yearName}:${s.periodId}`,
      ),
    ];
  });
  rows.push([btn('⬅️ Назад', 'attestation')]);

  await show(
    ctx,
    `📅 <b>Выберите семестр для просмотра оценок:</b>`,
    Markup.inlineKeyboard(rows),
  );
});

act(/^att_save_creds$/, async (ctx) => {
  const u = ctx.state.user;
  const creds = uninet.consumeTempCreds(u.id);
  if (!creds) {
    return alert(ctx, '⚠️ Время сохранения истекло. Введите данные заново.');
  }

  try {
    const encrypted = aa.encryptCredentials(creds.login, creds.password);
    await db.saveAutoAttendance(u.id, aa.maskLogin(creds.login), encrypted);
    await ctx
      .answerCbQuery('💾 Аккаунт сохранён! Теперь оценки доступны в 1 клик 🎉', { show_alert: true })
      .catch(() => {});
  } catch (err) {
    console.error(`[Attestation] Failed to save credentials for user ${u.id}:`, err);
    return alert(ctx, '❌ Не удалось сохранить аккаунт.');
  }

  await renderAttestation(ctx);
});

act(/^att_logout$/, async (ctx) => {
  const u = ctx.state.user;
  uninet.clearCachedToken(u.id);
  uninet.cancelAuthPrompt(u.id);

  const cfg = await db.getAutoAttendance(u.id);
  if (cfg) {
    await show(
      ctx,
      `👤 <b>Управление аккаунтом Uninet / KBTU</b>\n\n` +
        `Текущий аккаунт: <code>${esc(cfg.login_mask)}</code>\n\n` +
        `Что вы хотите сделать?`,
      Markup.inlineKeyboard([
        [btn('🔑 Войти под другим логином', 'att_setup')],
        [btn('🗑 Удалить сохранённый аккаунт', 'aa_del_ask')],
        [btn('🏠 Меню', 'menu')],
      ]),
    );
  } else {
    await ctx.answerCbQuery('🚪 Вы вышли из сессии').catch(() => {});
    await renderAttestation(ctx, { forcePrompt: true });
  }
});

// ---------- админ-панель ----------
const USERS_PAGE = 10;

function formatUsersTable(users) {
  if (!users.length) return 'Пользователей пока нет.';

  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => {
    if (!d) return '--.--.--';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '--.--.--';
    return `${pad2(dt.getDate())}.${pad2(dt.getMonth() + 1)}.${String(dt.getFullYear()).slice(-2)}`;
  };

  const truncate = (str, len) => {
    const s = String(str ?? '');
    return s.length > len ? s.slice(0, len - 1) + '…' : s.padEnd(len);
  };

  const header =
    'ID          Пользователь  Роль  Дата    \n' +
    '----------- ------------- ----- --------';

  const rows = users.map((u) => {
    const id = truncate(u.id, 11);
    const name = truncate(displayName(u), 13);
    const role = (u.role === 'moderator' ? 'moder' : u.role).padEnd(5);
    const date = fmtDate(u.created_at).padEnd(8);
    return `${id} ${name} ${role} ${date}`;
  });

  return `<pre>${esc([header, ...rows].join('\n'))}</pre>`;
}

async function renderUsers(ctx, page = 0) {
  if (!isAdmin(ctx.state.user)) return alert(ctx, '⛔ Только для админов');
  const total = await db.countUsers();
  const totalPages = Math.max(1, Math.ceil(total / USERS_PAGE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const users = await db.listUsers(USERS_PAGE, currentPage * USERS_PAGE);

  const table = formatUsersTable(users);
  const text =
    `👥 <b>Пользователи в системе</b>\n` +
    `Всего: <b>${total}</b> · Стр. <b>${currentPage + 1}</b> из <b>${totalPages}</b>\n\n` +
    table;

  const kb = [];
  const nav = [];
  if (currentPage > 0) nav.push(btn('◀️', `users:${currentPage - 1}`));
  if (totalPages > 1) nav.push(btn(`${currentPage + 1} / ${totalPages}`, 'noop'));
  if (currentPage + 1 < totalPages) nav.push(btn('▶️', `users:${currentPage + 1}`));
  if (nav.length) kb.push(nav);

  kb.push([btn('🔄 Обновить', `users:${currentPage}`)], [btn('⬅️ В админку', 'admin'), btn('🏠 Меню', 'menu')]);

  await show(ctx, text, Markup.inlineKeyboard(kb));
}

async function renderAdmin(ctx, note = '') {
  if (!isAdmin(ctx.state.user)) return alert(ctx, '⛔ Только для админов');
  await show(
    ctx,
    `👑 <b>Админ-панель</b>${note ? `\n\n${note}` : ''}`,
    Markup.inlineKeyboard([
      [btn('👥 Пользователи', 'users:0')],
      [btn('🛡 Модераторы', 'mods:0'), btn('➕ Назначить', 'addmod')],
      [btn('📊 Статистика', 'stats')],
      [btn('🏠 Меню', 'menu')],
    ]),
  );
}

act(/^admin$/, (ctx) => renderAdmin(ctx));
act(/^users:(\d+)$/, (ctx) => renderUsers(ctx, Number(ctx.match[1])));

act(/^stats$/, async (ctx) => {
  if (!isAdmin(ctx.state.user)) return alert(ctx, '⛔ Только для админов');
  const s = await db.stats();
  await show(
    ctx,
    `📊 <b>Статистика</b>\n\n` +
      `👤 Пользователей: ${s.users}\n` +
      `👑 Админов: ${s.admins}\n` +
      `🛡 Модераторов: ${s.moderators}\n` +
      `📚 Пулов: ${s.pools}\n` +
      `🔗 Подписок: ${s.memberships}\n` +
      `🤖 Авто-аттенданс PGE: ${s.auto_attendance_enabled} вкл / ${s.auto_attendance_total} всего (в работе: ${aa.activeJobsCount()})\n` +
      `🎬 Сессий Uninet: ${aw.activeSessionCount()} / ${config.maxWatchSessions}`,
    Markup.inlineKeyboard([[btn('⬅️ Назад', 'admin')]]),
  );
});

async function renderMods(ctx, page) {
  if (!isAdmin(ctx.state.user)) return alert(ctx, '⛔ Только для админов');
  const rows = await db.listModerators(PAGE + 1, page * PAGE);
  const hasNext = rows.length > PAGE;
  const items = rows.slice(0, PAGE);
  const kb = items.map((m) => [btn(`❌ ${displayName(m)}`, `demote:${m.id}`)]);
  const pg = pager('mods', page, hasNext);
  if (pg.length) kb.push(pg);
  kb.push([btn('➕ Назначить', 'addmod')], [btn('⬅️ Назад', 'admin')]);
  await show(
    ctx,
    `🛡 <b>Модераторы</b>\n\n${items.length ? 'Нажмите ❌, чтобы снять права:' : 'Модераторов пока нет.'}`,
    Markup.inlineKeyboard(kb),
  );
}

act(/^mods:(\d+)$/, (ctx) => renderMods(ctx, Number(ctx.match[1])));

act(/^demote:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.state.user)) return alert(ctx, '⛔ Только для админов');
  const target = await db.getUser(Number(ctx.match[1]));
  if (target && target.role === 'moderator') {
    await db.setRole(target.id, 'user');
    await send(target.id, '🛡 Вас сняли с роли модератора.');
    await ctx.answerCbQuery('✅ Права сняты').catch(() => {});
  }
  await renderMods(ctx, 0);
});

act(/^addmod$/, async (ctx) => {
  if (!isAdmin(ctx.state.user)) return alert(ctx, '⛔ Только для админов');
  aw.cancelAuthPrompt(ctx.from.id);
  aa.cancelAuthPrompt(ctx.from.id);
  await setState(ctx.from.id, { type: 'add_mod' });
  await show(
    ctx,
    '➕ <b>Новый модератор</b>\n\nОтправьте <code>@username</code> или Telegram ID пользователя.\n⚠️ Он должен хотя бы раз запустить бота (/start).',
    Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
  );
});

// ---------- текстовый ввод ----------
bot.on('text', async (ctx) => {
  const u = ctx.state.user;
  const rawText = ctx.message.text;
  const text = rawText.trim();

  // Ввод логина / пароля Uninet API для просмотра оценок аттестации (без браузера)
  const attStep = uninet.getAuthPromptStep(u.id);
  if (attStep === 'login') {
    await ctx.deleteMessage().catch(() => {});
    const normalized = uninet.normalizeLogin(text);
    if (normalized.length < 2 || normalized.length > 100 || /\s/.test(normalized)) {
      return ctx.reply('⚠️ Введите корректный логин от портала Uninet (без пробелов) или нажмите «Отмена».', {
        ...Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
      });
    }
    uninet.setPromptLogin(u.id, normalized);
    return ctx.reply(
      `✅ Логин принят <i>(сообщение удалено из чата)</i>.\n\n` +
        `🔑 Теперь отправьте <b>пароль</b> от портала Uninet / KBTU:\n` +
        `🔒 <i>Сообщение с паролем также будет сразу удалено. Вход выполняется напрямую в API.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
      },
    );
  }

  if (attStep === 'password') {
    await ctx.deleteMessage().catch(() => {});
    const login = uninet.consumePromptLogin(u.id);
    const password = rawText.trim();
    if (!login || !password) {
      return showMenu(ctx);
    }

    const statusMsg = await ctx.reply(
      `🔄 Пароль получен <i>(сообщение удалено из чата)</i>.\n` +
        `Подключаюсь к API Uninet… <i>(обычно 1–2 сек)</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[btn('🏠 Меню', 'menu')]]),
      },
    );

    (async () => {
      try {
        const tokenData = await uninet.loginWithCredentials(login, password);
        uninet.setCachedToken(u.id, { ...tokenData, login });
        uninet.setTempCreds(u.id, login, password);

        await showAttestationGrades(ctx, u.id, tokenData, {}, statusMsg.message_id);
      } catch (err) {
        const msg =
          err instanceof uninet.UninetError ? err.message : 'Не удалось выполнить вход в портал Uninet.';
        const errText = `❌ <b>${esc(msg)}</b>`;
        const errKb = Markup.inlineKeyboard([
          [btn('🔁 Попробовать снова', 'att_setup')],
          [btn('🏠 Меню', 'menu')],
        ]);
        await bot.telegram
          .editMessageText(u.id, statusMsg.message_id, undefined, errText, {
            parse_mode: 'HTML',
            ...errKb,
          })
          .catch(() => send(u.id, errText, errKb));
      }
    })();
    return;
  }

  // Ввод логина / пароля Uninet (только в оперативной памяти, без БД и Redis)
  const awStep = aw.getAuthPromptStep(u.id);
  if (awStep === 'login') {
    await ctx.deleteMessage().catch(() => {});
    if (text.length < 2 || text.length > 100 || /\s/.test(text)) {
      return ctx.reply('⚠️ Введите корректный логин от портала Uninet (без пробелов) или нажмите «Отмена».', {
        ...Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
      });
    }
    aw.setPromptLogin(u.id, text);
    return ctx.reply(
      `✅ Логин принят <i>(сообщение удалено из чата)</i>.\n\n` +
        `🔑 Теперь отправьте <b>пароль</b> от портала Uninet:\n` +
        `🔒 <i>Сообщение с паролем также будет сразу удалено, и данные нигде не сохранятся.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
      },
    );
  }

  if (awStep === 'password') {
    await ctx.deleteMessage().catch(() => {});
    const login = aw.consumePromptLogin(u.id);
    const password = rawText.trim();
    if (!login || !password) {
      return showMenu(ctx);
    }

    const statusMsg = await ctx.reply(
      `🔄 Пароль получен <i>(сообщение удалено из чата)</i>.\n` +
        `Запускаю браузер и вхожу в портал Uninet… <i>(обычно 10–20 сек)</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[btn('⏹ Отмена', 'aw_stop')]]),
      },
    );

    // Не блокируем очередь обновлений Telegraf пока Playwright логинится
    (async () => {
      try {
        const courses = await aw.loginAndFetchCourses(u.id, login, password, (html, extra) =>
          send(u.id, html, extra),
        );
        const pickerText =
          `✅ <b>Вход в Uninet выполнен!</b>\n\n` +
          `Найдено курсов: <b>${courses.length}</b>.\n` +
          `Выберите предмет для автопросмотра лекций (или запустите все подряд):`;
        const kb = buildCoursePickerKeyboard(courses);

        await bot.telegram
          .editMessageText(u.id, statusMsg.message_id, undefined, pickerText, {
            parse_mode: 'HTML',
            ...kb,
          })
          .catch(() => send(u.id, pickerText, kb));
      } catch (err) {
        const msg = err instanceof aw.UserFacingError ? err.message : 'Ошибка при входе в портал Uninet.';
        const errText = `❌ <b>${esc(msg)}</b>`;
        const errKb = Markup.inlineKeyboard([
          [btn('🔁 Попробовать снова', 'autowatch')],
          [btn('🏠 Меню', 'menu')],
        ]);
        await bot.telegram
          .editMessageText(u.id, statusMsg.message_id, undefined, errText, {
            parse_mode: 'HTML',
            ...errKb,
          })
          .catch(() => send(u.id, errText, errKb));
      }
    })();
    return;
  }

  // Ввод логина / пароля pge.kbtu.kz для Авто-аттенданса (промпт в RAM, хранение в PostgreSQL AES-256-GCM)
  const aaStep = aa.getAuthPromptStep(u.id);
  if (aaStep === 'login') {
    await ctx.deleteMessage().catch(() => {});
    const normalized = aa.normalizeLogin(text);
    if (normalized.length < 2 || normalized.length > 100 || /\s/.test(normalized)) {
      return ctx.reply('⚠️ Введите корректный логин от pge.kbtu.kz (без пробелов) или нажмите «Отмена».', {
        ...Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
      });
    }
    aa.setPromptLogin(u.id, normalized);
    return ctx.reply(
      `✅ Логин принят <i>(сообщение удалено из чата)</i>.\n\n` +
        `🔑 Теперь отправьте <b>пароль</b> от портала <code>pge.kbtu.kz</code>:\n` +
        `🔒 <i>Сообщение с паролем также будет сразу удалено, а перед сохранением бот проверит вход.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
      },
    );
  }

  if (aaStep === 'password') {
    await ctx.deleteMessage().catch(() => {});
    const login = aa.consumePromptLogin(u.id);
    const password = rawText.trim();
    if (!login || !password) {
      return showMenu(ctx);
    }

    const statusMsg = await ctx.reply(
      `🔄 Пароль получен <i>(сообщение удалено из чата)</i>.\n` +
        `Проверяю вход на <code>pge.kbtu.kz</code>… <i>(обычно 5–10 сек)</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[btn('🏠 Меню', 'menu')]]),
      },
    );

    (async () => {
      try {
        const verified = await aa.verifyPgeCredentials(login, password);
        const encrypted = aa.encryptCredentials(verified.normalizedLogin, password);
        await db.saveAutoAttendance(u.id, verified.loginMask, encrypted);

        const activeHint =
          verified.activeCount > 0
            ? `\n\n🔥 <b>Прямо сейчас на портале открыто активных аттендансов: ${verified.activeCount}!</b> Нажмите кнопку ниже, чтобы сразу отметиться:`
            : '';

        const okRows = [];
        if (verified.activeCount > 0) {
          okRows.push([btn(`⚡ Отметиться прямо сейчас (${verified.activeCount})`, 'aa_run_now')]);
        }
        okRows.push([btn('⚙️ Настройки авто-аттенданса', 'autoattend')], [btn('🏠 Меню', 'menu')]);
        const okKb = Markup.inlineKeyboard(okRows);

        const okText =
          `✅ <b>Аккаунт pge.kbtu.kz успешно подключён!</b>\n\n` +
          `👤 Аккаунт: <code>${esc(verified.loginMask)}</code>\n` +
          `🟢 Авто-аттенданс <b>включён</b> — теперь при алерте в любом вашем пуле бот автоматически отметит все активные дисциплины.` +
          activeHint;

        await bot.telegram
          .editMessageText(u.id, statusMsg.message_id, undefined, okText, {
            parse_mode: 'HTML',
            ...okKb,
          })
          .catch(() => send(u.id, okText, okKb));
      } catch (err) {
        const msg =
          err instanceof aa.AttendanceError ? err.message : 'Не удалось проверить вход на pge.kbtu.kz.';
        const errText = `❌ <b>${esc(msg)}</b>\n<i>Данные не сохранены.</i>`;
        const errKb = Markup.inlineKeyboard([
          [btn('🔁 Ввести заново', 'aa_setup')],
          [btn('🏠 Меню', 'menu')],
        ]);
        await bot.telegram
          .editMessageText(u.id, statusMsg.message_id, undefined, errText, {
            parse_mode: 'HTML',
            ...errKb,
          })
          .catch(() => send(u.id, errText, errKb));
      }
    })();
    return;
  }

  const state = await getState(u.id);
  if (!state) return showMenu(ctx);

  if (state.type === 'create_pool') {
    if (!isStaff(u)) return clearState(u.id);
    if (text.length < 2 || text.length > 40) {
      return ctx.reply('⚠️ Название должно быть от 2 до 40 символов. Попробуйте ещё раз или /cancel.');
    }
    try {
      const pool = await db.createPool(text, u.id);
      await clearState(u.id);
      await ctx.reply(
        `✅ Пул <b>«${esc(pool.name)}»</b> создан!\nТеперь студенты могут вступать в него 🎉`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [btn('📚 Открыть пул', `pool:${pool.id}:own`)],
            [btn('🏠 Меню', 'menu')],
          ]),
        },
      );
    } catch (e) {
      if (e.code === '23505') return ctx.reply('⚠️ Пул с таким названием уже существует. Придумайте другое или /cancel.');
      throw e;
    }
    return;
  }

  if (state.type === 'add_mod') {
    if (!isAdmin(u)) return clearState(u.id);
    const input = text.replace(/^@/, '');
    if (!/^(\d+|[A-Za-z0-9_]{3,32})$/.test(input)) {
      return ctx.reply('⚠️ Отправьте @username или числовой ID. Или /cancel.');
    }
    const target = await db.findUser(input);
    if (!target) {
      return ctx.reply('😕 Пользователь не найден. Он должен сначала запустить бота (/start). Попробуйте ещё раз или /cancel.');
    }
    if (target.role === 'admin') return ctx.reply('👑 Этот пользователь уже админ.');
    if (target.role === 'moderator') return ctx.reply('🛡 Этот пользователь уже модератор.');

    await db.setRole(target.id, 'moderator');
    await clearState(u.id);
    await send(
      target.id,
      '🎉 Вас назначили <b>модератором</b>! Теперь вы можете создавать пулы — откройте /menu.',
    );
    await ctx.reply(`✅ ${esc(displayName(target))} теперь модератор 🛡`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[btn('🛡 Модераторы', 'mods:0')], [btn('👑 Админ-панель', 'admin')]]),
    });
  }
});

bot.catch((err, ctx) => {
  console.error(`Ошибка в апдейте ${ctx.update?.update_id}:`, err);
  ctx.reply?.('😵 Что-то пошло не так. Попробуйте /menu').catch(() => {});
});

export async function shutdown() {
  await aw.stopAllSessions().catch(() => {});
  await aa.shutdownAttendance().catch(() => {});
  await redis.quit().catch(() => {});
  await db.pgPool.end().catch(() => {});
}
