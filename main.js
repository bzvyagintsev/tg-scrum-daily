const TOKEN = process.env.TELEGRAM_TOKEN || 'TELEGRAM_DEVELOP_TOKEN';
let url = process.env.GOOGLE_CLOUD_PROJECT ? `https://${process.env.GOOGLE_CLOUD_PROJECT}.appspot.com` : '0';
const port = process.env.PORT || 80;
const proxy = process.env.GOOGLE_CLOUD_PROJECT ? undefined : '';
const env = process.env.NODE_ENV || 'development';

//  Настройки БД

const admin = require('firebase-admin');

if (process.env.NODE_ENV === 'production') {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  })
} else {
  const serviceAccount = require('./service-account.json');

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  })
}

const db = admin.firestore();

const table = env === "production" ? 'chats' : 'test_chats';

// Настройки
const defaultMessage = 'Привет! Уже 12 часов, а значит время Daily Scrum!';
const defaultSchedule = '0 12 * * 0-5';
const defaultLimit = 60;

// Настройка Крона
const schedule = require('node-schedule-tz');

// Настройки бота
const TelegramBot = require('node-telegram-bot-api');
// No need to pass any parameters as we will handle the updates with Express
const bot = new TelegramBot(TOKEN, proxy ? { request: { proxy } } : {});

// Запускаем приложение
(async () => {
  try {
    if (url === '0') {
      const ngrok = require('ngrok');

      url = await ngrok.connect(port);
    }

    await startWebHook();
    await getData();

    startCron();

    console.log('Bot is running');

    return true;
  } catch (err) {
    console.log(err);

    throw new Error(`Ошибка: ${err}`);
  }
})();

function startWebHook() {
  return new Promise((resolve, reject) => {
    bot.setWebHook(`${url}/bot${TOKEN}`).then(
      (res) => {
        console.log('Webhook started');

        resolve(res);
      },
      (err) => reject(err)
    );
  })
}

let data = [];

function getData() {
  return new Promise((resolve, reject) => {
    db.collection(table).get()
      .then((res) => {
        res.forEach(doc => {
          data.push(doc.data());
        });

        resolve(data);
      })
      .catch((err) => {
        console.log(err)
        reject(err);
      });
  })
}

// Запускает бота
bot.onText(/\/start/, onText = (msg) => {
  getChat(msg.chat.id.toString()).then((doc) => {
    if (!doc.exists) {
      const newDoc = {
        chat_id: msg.chat.id,
        type: msg.chat.type,
        started_by: msg.from.id,
        schedule: defaultSchedule,
        limit: defaultLimit,
        message: defaultMessage,
        active: true,
        lock: false
      }

      setChat(msg.chat.id.toString(), newDoc)
        .then((res) => {
          startJob(newDoc);

          return bot.sendMessage(msg.chat.id, 'Бот запущен');
        })
    } else {
      let chat = doc.data();

      if (chat.active) {
        return bot.sendMessage(msg.chat.id, 'Бот уже запущен');
      }

      return updateChat(msg.chat.id.toString(), { active: true })
        .then((res) => {
          startJob(chat);

          bot.sendMessage(msg.chat.id, 'Бот запущен');
        })
    }
  })
});

// Останавливает бота
bot.onText(/\/stop/, onText = (msg) => {
  getChat(msg.chat.id.toString()).then((doc) => {
    if (!doc.exists) {
      return bot.sendMessage(msg.chat.id, 'Бот ещё не запускался');
    }

    if (doc.data().active) {
      return updateChat(msg.chat.id.toString(), { active: false })
        .then((res) => {
          stopJob(msg.chat.id);

          bot.sendMessage(msg.chat.id, 'Бот остановлен');
        })
    }

    return bot.sendMessage(msg.chat.id, 'Бот уже остановлен');
  })
});

// Изменяет сообщение
bot.onText(/\/setmessage/, onText = (msg) => {
  const message = msg.text.slice(12);

  getChat(msg.chat.id.toString()).then((doc) => {
    if (!doc.exists) {
      return bot.sendMessage(msg.chat.id, 'Бот ещё не запускался');
    }

    updateChat(msg.chat.id.toString(), { message: message })
      .then((res) => {
        // Reschedule почему-то не срабатывал, поэтому через stop-start
        stopJob(msg.chat.id);
        startJob({ ...doc.data(), message });

        bot.sendMessage(msg.chat.id, 'Сообщение изменено на: ' + message);
      })

  });
});

// Изменяет расписание
bot.onText(/\/setschedule/, onText = (msg) => {
  const newSchedule = msg.text.slice(13);

  getChat(msg.chat.id.toString()).then((doc) => {
    if (!doc.exists) {
      return bot.sendMessage(msg.chat.id, 'Бот ещё не запускался');
    }

    return updateChat(msg.chat.id.toString(), { schedule: newSchedule })
      .then((res) => {
        if (schedule.scheduledJobs[msg.chat.id.toString()].reschedule(newSchedule)) {
          console.log(`${res}, Job ${msg.chat.id} updated`);

          return bot.sendMessage(msg.chat.id, `Расписание изменено на: ${newSchedule}`);
        }

        return updateChat(msg.chat.id.toString(), { schedule: doc.data().schedule })
          .then((res) => {
            bot.sendMessage(
              msg.chat.id,
              `Задайте расписание в правильном формате, сохранено прежнее расписание: ${doc.data().schedule}`
            );

            console.log(`${res}, Job ${msg.chat.id} not updated`);
          });
      })
  })
});

// Изменить чат
function updateChat(id, data) {
  return db.collection(table)
    .doc(id)
    .update(data);
}

// Получить чат
function getChat(id) {
  return db.collection(table)
    .doc(id).get();
}

// Создать чат
function setChat(id, data) {
  return db.collection(table)
    .doc(id).set(data);
}

// Запускает job`у
function startCron() {
  if (data && data.length > 0) {
    for (let chat of data) {
      if (checkChat(chat)) {
        const job = schedule.scheduleJob(chat.chat_id.toString(), chat.schedule, 'Europe/Moscow', () => {
          bot.sendMessage(chat.chat_id, chat.message || defaultMessage)
            .catch((err) => {
              errorHandler(err);
              botKicked(chat.chat_id);

              bot.sendMessage(chat.chat_id, 'не удалось запустить бота, попробуйте запустить его заново командой /start')
            });
        });
      }
    }
  }
}

// Запустить job`у
// Можно попробовать объединить с функцией startCron()
const startJob = (chat) => {
  if (chat) {
    const job = schedule.scheduleJob(chat.chat_id.toString(), chat.schedule, 'Europe/Moscow', () => {
      bot.sendMessage(chat.chat_id, chat.message || defaultMessage)
        .catch((err) => {
          errorHandler(err);
          botKicked(chat.chat_id);

          bot.sendMessage(chat.chat_id, 'не удалось запустить бота, попробуйте запустить его заново командой /start')
        });
    });

    return console.log(`Job ${chat.chat_id} started`);
  }
}

// Остановить job`у
function stopJob(id) {
  if (schedule.scheduledJobs[id.toString()] && schedule.scheduledJobs[id.toString()].cancel()) {
    return console.log(`Job ${id} stopped`);
  }
}

function botKicked(id) {
  stopJob(id);
}

function checkChat(chat) {
  if (chat && chat.schedule && (chat.type === 'group' || chat.type === 'supergroup') && chat.active) {
    return true;
  }

  return false;
}

// Обработчик ошибок
function errorHandler(error) {
  console.log(`Ошибка: ${error}`);
}

// Настройки сервера

const express = require('express');
const bodyParser = require('body-parser');

const app = express();

// parse the updates to JSON
app.use(bodyParser.json());

// We are receiving updates at the route below!
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Start Express Server
app.listen(port, () => {
  console.log(`Express server is listening on ${port}`);
});