import { config } from './config.js';
import { initDb, ensureEnvAdmins } from './db.js';
import { bot, shutdown, setBotUsername } from './bot.js';

await initDb();

if (await ensureEnvAdmins(config.adminIds)) {
  console.log(`👑 Админов в базе не было — назначены из ENV: ${config.adminIds.join(', ')}`);
}

const me = await bot.telegram.getMe();
setBotUsername(me.username);
console.log(`🤖 Бот @${me.username} запущен`);

// Команды для личных сообщений
await bot.telegram
  .setMyCommands(
    [
      { command: 'menu', description: '🏠 Главное меню' },
      { command: 'pools', description: '🔍 Все пулы предметов' },
      { command: 'attestation', description: '📊 Оценки за аттестацию Uninet' },
      { command: 'autoattend', description: '🤖 Авто-аттенданс PGE' },
      { command: 'autowatch', description: '🎬 Автопросмотр лекций Uninet' },
      { command: 'cancel', description: '❌ Отмена текущего действия' },
    ],
    { scope: { type: 'all_private_chats' } },
  )
  .catch(() => {});

// Команды для групп
await bot.telegram
  .setMyCommands(
    [
      { command: 'menu', description: '🔔 Меню группы' },
      { command: 'pools', description: '📋 Список пулов и вступление' },
      { command: 'create', description: '➕ Создать пул (/create Название)' },
      { command: 'alert', description: '🚨 Сообщить об аттендансе' },
      { command: 'help', description: 'ℹ️ Как получать уведомления' },
    ],
    { scope: { type: 'all_group_chats' } },
  )
  .catch(() => {});

bot.launch();

const stop = async (signal) => {
  bot.stop(signal);
  await shutdown();
  process.exit(0);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
