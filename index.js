// index.js
// Bot de controle de horários (multiusuário) – Node 20+, CommonJS
// Railway/Windows-friendly
// 1) npm i discord.js better-sqlite3 luxon dotenv
// 2) .env => DISCORD_TOKEN=seu_token
// 3) Rode: node index.js   |   Publique o painel com: !panel

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');

// ===================== Config =====================
const TZ = 'America/Sao_Paulo';
const AUTO_START_NEXT_DAY = true;         // inicia automaticamente no novo dia
const AUTO_START_DELAY_SECONDS = 5;       // atraso p/ nova sessão após 00:00
const PANEL_PREFIX = '!panel';            // comando para publicar o painel
const PAUSE_REMINDER_MINUTES = 15;        // ⏰ lembrete se pausa > X min (0 desativa)

// ===================== DB =========================
const db = new Database('./timesheet.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  lastChannelId TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  date TEXT NOT NULL,              -- AAAA-MM-DD (data local do usuário)
  status TEXT NOT NULL,            -- working | paused | finished
  createdAt TEXT NOT NULL,         -- ISO
  finishedAt TEXT,                 -- ISO
  UNIQUE(userId, date)
);
CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- work | pause
  start TEXT NOT NULL,             -- ISO
  end TEXT,                        -- ISO
  lastReminderAt TEXT,             -- ISO, evita lembrete duplicado por pausa
  FOREIGN KEY(sessionId) REFERENCES sessions(id)
);
`);

// migração defensiva (se o banco antigo não tinha a coluna)
try { db.exec('ALTER TABLE periods ADD COLUMN lastReminderAt TEXT'); } catch { /* ok */ }

// Prepared statements
const upsertUserStmt = db.prepare(
  `INSERT INTO users(userId, lastChannelId) VALUES(?, ?)
   ON CONFLICT(userId) DO UPDATE SET lastChannelId=excluded.lastChannelId`
);
const getUserStmt = db.prepare('SELECT * FROM users WHERE userId = ?');

const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE userId = ? AND date = ?');
const insertSessionStmt = db.prepare(
  `INSERT INTO sessions(userId, date, status, createdAt) VALUES(?, ?, ?, ?)`
);
const updateSessionStatusStmt = db.prepare('UPDATE sessions SET status = ? WHERE id = ?');
const finishSessionStmt = db.prepare('UPDATE sessions SET status = ?, finishedAt = ? WHERE id = ?');

const insertPeriodStmt = db.prepare(`INSERT INTO periods(sessionId, kind, start) VALUES(?, ?, ?)`);
const endOpenPeriodsStmt = db.prepare(`UPDATE periods SET end = ? WHERE sessionId = ? AND end IS NULL`);
const getPeriodsStmt = db.prepare(`SELECT * FROM periods WHERE sessionId = ? ORDER BY start ASC`);
const getOpenWorkPeriodStmt = db.prepare(
  `SELECT * FROM periods WHERE sessionId = ? AND end IS NULL AND kind = 'work' ORDER BY id DESC LIMIT 1`
);
const getOpenPausePeriodStmt = db.prepare(
  `SELECT * FROM periods WHERE sessionId = ? AND end IS NULL AND kind = 'pause' ORDER BY id DESC LIMIT 1`
);
const getActiveSessionsFromDateStmt = db.prepare(
  `SELECT * FROM sessions WHERE date = ? AND status IN ('working','paused')`
);

// Pausas abertas do dia para lembretes
const getPausedSessionsTodayStmt = db.prepare(`
  SELECT s.id as sessionId, s.userId, s.date, p.id as periodId, p.start as pauseStart, p.lastReminderAt
  FROM sessions s
  JOIN periods p ON p.sessionId = s.id AND p.kind = 'pause' AND p.end IS NULL
  WHERE s.date = ? AND s.status = 'paused'
`);
const updatePeriodReminderStmt = db.prepare('UPDATE periods SET lastReminderAt = ? WHERE id = ?');

// ===================== Discord ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const buttonsRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('start_work').setLabel('Começar').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId('pause').setLabel('Pausar').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId('resume').setLabel('Voltar').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId('finish').setLabel('Finalizar').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId('status').setLabel('Status').setStyle(ButtonStyle.Secondary),
);

client.once(Events.ClientReady, () => {
  console.log(`🔥 Logado como ${client.user.tag}`);
  scheduleMidnightRollover();
  schedulePauseReminder();
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.trim().toLowerCase().startsWith(PANEL_PREFIX)) return;
  await msg.channel.send({
    content: 'Controle de horários — use os botões abaixo. Cada clique afeta **apenas você**.',
    components: [buttonsRow],
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const userId = interaction.user.id;
  const now = DateTime.now().setZone(TZ);
  const today = now.toFormat('yyyy-MM-dd');

  // memoriza o canal para relatórios automáticos
  try { upsertUserStmt.run(userId, interaction.channelId); } catch {}

  if (interaction.customId === 'start_work') {
    const res = startWork(userId, today, now);
    return interaction.reply({ content: res.message, ephemeral: true });
  }
  if (interaction.customId === 'pause') {
    const res = pauseWork(userId, today, now);
    return interaction.reply({ content: res.message, ephemeral: true });
  }
  if (interaction.customId === 'resume') {
    const res = resumeWork(userId, today, now);
    return interaction.reply({ content: res.message, ephemeral: true });
  }
  if (interaction.customId === 'finish') {
    const res = finishWork(userId, today, now);
    if (res.session) {
      const embed = buildSummaryEmbed(interaction.user, res.session.id);
      await interaction.channel.send({ embeds: [embed] });
    }
    return interaction.reply({ content: res.message, ephemeral: true });
  }
  if (interaction.customId === 'status') {
    const session = ensureSession(userId, today, now);
    const embed = buildSummaryEmbed(interaction.user, session.id, { compact: true });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ===================== Core logic =================
function ensureSession(userId, date, now) {
  let s = getSessionStmt.get(userId, date);
  if (!s) {
    const createdAt = now.toISO();
    insertSessionStmt.run(userId, date, 'paused', createdAt);
    s = getSessionStmt.get(userId, date);
  }
  return s;
}

function startWork(userId, date, now) {
  const s = ensureSession(userId, date, now);
  if (s.status === 'working') return { ok: false, message: 'Você já está em **trabalho**.' };
  if (getOpenWorkPeriodStmt.get(s.id)) return { ok: false, message: 'Já existe um período de trabalho aberto.' };
  // fecha pausa se existir
  const openPause = getOpenPausePeriodStmt.get(s.id);
  if (openPause) endOpenPeriodsStmt.run(now.toISO(), s.id);

  insertPeriodStmt.run(s.id, 'work', now.toISO());
  updateSessionStatusStmt.run('working', s.id);
  return { ok: true, message: '✅ Trabalho **iniciado**.' };
}

function pauseWork(userId, date, now) {
  const s = ensureSession(userId, date, now);
  if (s.status !== 'working') return { ok: false, message: 'Você não está em **trabalho**.' };
  // fecha trabalho e abre pausa
  endOpenPeriodsStmt.run(now.toISO(), s.id);
  insertPeriodStmt.run(s.id, 'pause', now.toISO());
  updateSessionStatusStmt.run('paused', s.id);
  return { ok: true, message: '⏸️ **Pausado**.' };
}

function resumeWork(userId, date, now) {
  const s = ensureSession(userId, date, now);
  if (s.status !== 'paused') return { ok: false, message: 'Você não está **pausado**.' };
  // fecha pausa e abre trabalho
  endOpenPeriodsStmt.run(now.toISO(), s.id);
  insertPeriodStmt.run(s.id, 'work', now.toISO());
  updateSessionStatusStmt.run('working', s.id);
  return { ok: true, message: '▶️ Retomou o **trabalho**.' };
}

function finishWork(userId, date, now) {
  const s = ensureSession(userId, date, now);
  if (s.status === 'finished') return { ok: false, message: 'Este dia já foi **finalizado**.' };
  endOpenPeriodsStmt.run(now.toISO(), s.id);
  finishSessionStmt.run('finished', now.toISO(), s.id);
  return { ok: true, message: '🏁 Dia **finalizado**.', session: getSessionStmt.get(userId, date) };
}

function buildSummaryEmbed(user, sessionId, { compact = false } = {}) {
  const periods = getPeriodsStmt.all(sessionId);
  const totals = summarizePeriods(periods);

  const fields = [
    { name: 'Trabalho', value: fmtDuration(totals.work), inline: true },
    { name: 'Pausa', value: fmtDuration(totals.pause), inline: true },
    { name: 'Períodos', value: periods.length.toString(), inline: true },
  ];

  if (!compact) {
    const lines = periods.map(p => {
      const start = DateTime.fromISO(p.start, { zone: TZ }).toFormat('HH:mm');
      const end = p.end ? DateTime.fromISO(p.end, { zone: TZ }).toFormat('HH:mm') : '…';
      const kind = p.kind === 'work' ? '💼' : '☕';
      return `${kind} ${start}–${end}`;
    });
    if (lines.length) fields.push({ name: 'Linha do tempo', value: lines.join('\n') });
  }

  return new EmbedBuilder()
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL?.() })
    .setTitle('Resumo do dia')
    .addFields(fields)
    .setTimestamp(new Date())
    .setColor(0x2ecc71);
}

function summarizePeriods(periods) {
  let work = 0, pause = 0;
  for (const p of periods) {
    const start = DateTime.fromISO(p.start, { zone: TZ });
    const end = p.end ? DateTime.fromISO(p.end, { zone: TZ }) : DateTime.now().setZone(TZ);
    const dur = Math.max(0, end.diff(start, 'seconds').seconds);
    if (p.kind === 'work') work += dur; else pause += dur;
  }
  return { work, pause };
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ===================== Rollover ===================
function scheduleMidnightRollover() {
  let lastDate = DateTime.now().setZone(TZ).toFormat('yyyy-MM-dd');
  setInterval(() => {
    const now = DateTime.now().setZone(TZ);
    const today = now.toFormat('yyyy-MM-dd');
    if (today !== lastDate) {
      const prevDate = lastDate;
      lastDate = today;
      handleRollover(prevDate, now);
    }
  }, 60 * 1000);
}

function handleRollover(prevDate, now) {
  const prevEnd = DateTime.fromFormat(prevDate + ' 23:59:59', 'yyyy-MM-dd HH:mm:ss', { zone: TZ });
  const sessions = getActiveSessionsFromDateStmt.all(prevDate);
  if (!sessions.length) return;

  const tx = db.transaction((list) => {
    for (const s of list) {
      endOpenPeriodsStmt.run(prevEnd.toISO(), s.id);
      finishSessionStmt.run('finished', prevEnd.toISO(), s.id);

      if (AUTO_START_NEXT_DAY) {
        const today = now.toFormat('yyyy-MM-dd');
        const createdAt = now.plus({ seconds: AUTO_START_DELAY_SECONDS }).toISO();
        insertSessionStmt.run(s.userId, today, 'working', createdAt);
        const newSession = getSessionStmt.get(s.userId, today);
        insertPeriodStmt.run(newSession.id, 'work', createdAt);
      }
    }
  });
  tx(sessions);

  // Envia resumos no canal usado por cada usuário
  for (const s of sessions) {
    const userRow = getUserStmt.get(s.userId);
    const channelId = userRow?.lastChannelId;
    if (!channelId) continue;
    const ch = client.channels.cache.get(channelId);
    if (!ch) continue;
    const embed = buildSummaryEmbed({ username: `<@${s.userId}>`, displayAvatarURL: () => undefined }, s.id);
    ch.send({ content: `<@${s.userId}> encerramos seu dia de ${prevDate}.`, embeds: [embed] }).catch(() => {});
    if (AUTO_START_NEXT_DAY) {
      ch.send({ content: `<@${s.userId}> novo dia iniciado automaticamente. Bom trabalho! ✅` }).catch(() => {});
    }
  }
}

// ===================== Pause Reminder =============
function schedulePauseReminder() {
  if (!PAUSE_REMINDER_MINUTES || PAUSE_REMINDER_MINUTES <= 0) return;
  const every = 30 * 1000; // checa a cada 30s
  setInterval(() => {
    try { checkPauseReminders(); } catch { /* noop */ }
  }, every);
}

function checkPauseReminders() {
  const now = DateTime.now().setZone(TZ);
  const today = now.toFormat('yyyy-MM-dd');
  const rows = getPausedSessionsTodayStmt.all(today);
  for (const row of rows) {
    const pauseStart = DateTime.fromISO(row.pauseStart, { zone: TZ });
    const minutes = now.diff(pauseStart, 'minutes').minutes;
    const already = row.lastReminderAt ? DateTime.fromISO(row.lastReminderAt, { zone: TZ }) : null;
    if (minutes >= PAUSE_REMINDER_MINUTES && !already) {
      const userRow = getUserStmt.get(row.userId);
      const channelId = userRow?.lastChannelId;
      if (channelId) {
        const ch = client.channels.cache.get(channelId);
        if (ch) {
          ch.send({ content: `<@${row.userId}> você está em pausa há ${Math.floor(minutes)} min. Deseja **voltar** ao trabalho?` })
            .catch(() => {});
        }
      }
      updatePeriodReminderStmt.run(now.toISO(), row.periodId);
    }
  }
}

// ===================== Login =====================
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Defina DISCORD_TOKEN no .env');
  process.exit(1);
}
client.login(token);
