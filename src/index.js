import { config } from './config.js';
import { initDb, ensureEnvAdmins } from './db.js';
import { bot, shutdown } from './bot.js';

await initDb();

if (await ensureEnvAdmins(config.adminIds)) {
  console.log(`👑 Админов в базе не было — назначены из ENV: ${config.adminIds.join(', ')}`);
}

await bot.telegram.setMyCommands([
  { command: 'menu', description: '🏠 Главное меню' },
  { command: 'cancel', description: '❌ Отмена действия' },
]);

const me = await bot.telegram.getMe();
console.log(`🤖 Бот @${me.username} запущен`);
bot.launch();

const stop = async (signal) => {
  bot.stop(signal);
  await shutdown();
  process.exit(0);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
