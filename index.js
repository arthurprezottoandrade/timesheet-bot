// index.js
require("dotenv").config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const Database = require("better-sqlite3");
const { DateTime } = require("luxon");

// === CONFIGURAÇÕES ===
const db = new Database("timesheet.db");
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PAUSE_REMINDER_MINUTES = 60;

// === CRIA TABELA SE NÃO EXISTIR ===
db.prepare(`
  CREATE TABLE IF NOT EXISTS registros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT,
    acao TEXT,
    horario TEXT
  )
`).run();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// === BOTÕES ===
const botoes = new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("start").setLabel("Começar").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("pause").setLabel("Pausar").setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId("resume").setLabel("Voltar").setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId("finish").setLabel("Finalizar").setStyle(ButtonStyle.Danger)
);

// === FUNÇÃO DE REGISTRO ===
function registrar(usuario, acao) {
  const horario = DateTime.now().setZone("America/Sao_Paulo").toFormat("yyyy-MM-dd HH:mm:ss");
  db.prepare("INSERT INTO registros (usuario, acao, horario) VALUES (?, ?, ?)").run(usuario, acao, horario);
}

// === EVENTO DE LOGIN ===
client.once("ready", async () => {
  console.log(`✅ Bot logado como ${client.user.tag}`);

  const canal = await client.channels.fetch(CHANNEL_ID);
  if (canal) {
    const embed = new EmbedBuilder()
      .setTitle("Controle de Ponto")
      .setDescription("Use os botões abaixo para registrar suas ações.")
      .setColor("#2ecc71");

    await canal.send({ embeds: [embed], components: [botoes] });
  }

  // Lembrete de pausa
  setInterval(() => {
    const agora = DateTime.now().setZone("America/Sao_Paulo");
    if (agora.hour >= 9 && agora.hour <= 18) {
      if (canal) {
        canal.send("⏳ **Lembrete:** Faça uma pausa!");
      }
    }
  }, PAUSE_REMINDER_MINUTES * 60 * 1000);
});

// === EVENTO DE BOTÕES ===
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const usuario = interaction.user.username;
  let resposta = "";

  switch (interaction.customId) {
    case "start":
      registrar(usuario, "Começou");
      resposta = "🟢 Registro de início feito!";
      break;
    case "pause":
      registrar(usuario, "Pausou");
      resposta = "⏸ Registro de pausa feito!";
      break;
    case "resume":
      registrar(usuario, "Voltou");
      resposta = "▶ Registro de retorno feito!";
      break;
    case "finish":
      registrar(usuario, "Finalizou");
      resposta = "🔴 Registro de saída feito!";
      break;
  }

  await interaction.reply({ content: resposta, ephemeral: true });
});

// === LOGIN ===
client.login(TOKEN);
