import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import * as db from './db.js';
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
function mainMenu(u) {
  const rows = [
    [btn('🔍 Все пулы', 'pools:0'), btn('📚 Мои подписки', 'my:0')],
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
      `Я сообщу одногруппникам, что <b>берут аттенданс</b> 🔔\n` +
      `Вступай в пул нужного предмета — и уведомления придут тебе.\n\n` +
      `Твоя роль: ${ROLE_LABEL[u.role]}`,
    mainMenu(u),
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

  const status = member
    ? owner
      ? '🛡 Это ваш пул — уведомления без ограничений'
      : `✅ Вы в пуле · уведомления раз в ${fmtWait(config.notifyCooldownSec)}`
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
  await clearState(ctx.from.id);
  await showMenu(ctx);
});
bot.command('menu', async (ctx) => {
  await clearState(ctx.from.id);
  await showMenu(ctx);
});
bot.command('cancel', async (ctx) => {
  await clearState(ctx.from.id);
  await showMenu(ctx);
});
bot.command('admin', async (ctx) => {
  await clearState(ctx.from.id);
  if (!isAdmin(ctx.state.user)) {
    return ctx.reply('⛔ Команда доступна только администраторам.');
  }
  await renderAdmin(ctx);
});
bot.command('users', async (ctx) => {
  await clearState(ctx.from.id);
  if (!isAdmin(ctx.state.user)) {
    return ctx.reply('⛔ Команда доступна только администраторам.');
  }
  await renderUsers(ctx, 0);
});

act(/^menu$/, async (ctx) => {
  await clearState(ctx.from.id);
  await showMenu(ctx);
});
act(/^cancel$/, async (ctx) => {
  await clearState(ctx.from.id);
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
  const text =
    `🔔 <b>Берут аттенданс!</b>\n\n` +
    `📚 Пул: <b>${esc(pool.name)}</b>\n` +
    `👤 От: ${esc(displayName(u))}\n\n` +
    `Скорее отмечайся! 🏃‍♂️💨`;
  const { sent, failed } = await broadcast(ids, text);

  if (!unlimited && ids.length > 0 && sent === 0) await releaseCooldown(id, u.id); // ничего не ушло — не штрафуем

  await renderPool(
    ctx,
    id,
    kind,
    `✅ Уведомление отправлено: ${sent} 👥` + (failed ? `\n⚠️ Не доставлено: ${failed} (заблокировали бота)` : ''),
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
  await setState(ctx.from.id, { type: 'create_pool' });
  await show(
    ctx,
    '✏️ <b>Новый пул</b>\n\nОтправьте название предмета одним сообщением (до 40 символов).\nНапример: <i>Unity Game Engine</i>',
    Markup.inlineKeyboard([[btn('❌ Отмена', 'cancel')]]),
  );
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
    `📊 <b>Статистика</b>\n\n👤 Пользователей: ${s.users}\n👑 Админов: ${s.admins}\n🛡 Модераторов: ${s.moderators}\n📚 Пулов: ${s.pools}\n🔗 Подписок: ${s.memberships}`,
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
  const state = await getState(u.id);
  if (!state) return showMenu(ctx);

  const text = ctx.message.text.trim();

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
  await redis.quit().catch(() => {});
  await db.pgPool.end().catch(() => {});
}
