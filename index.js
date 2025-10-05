import dotenv from "dotenv";
import fs from "fs";
import { Client, GatewayIntentBits, Partials } from "discord.js";

dotenv.config();

// Chargement et sauvegarde des données
const DATA_FILE = "data.json";

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { trackedMessages: [], reportChannelId: null };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

// Initialisation du bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

client.once("ready", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  // Scan des 20 derniers messages au démarrage
  for (const [guildId, guild] of client.guilds.cache) {
    for (const [channelId, channel] of guild.channels.cache) {
      if (!channel.isTextBased()) continue;
      try {
        const messages = await channel.messages.fetch({ limit: 20 });
        for (const msg of messages.values()) {
          if (msg.content.includes("Mettez une réaction pour attester de votre prise d'information")) {
            const mentions = [
              ...msg.mentions.users.map(u => u.id),
              ...msg.mentions.roles.map(r => r),
            ];
            const roleMembers = [];
            for (const role of msg.mentions.roles.values()) {
              const r = guild.roles.cache.get(role.id);
              if (r) r.members.forEach(m => roleMembers.push(m.id));
            }
            const uniqueUsers = [...new Set([...mentions, ...roleMembers])];
            if (!data.trackedMessages.find(t => t.id === msg.id)) {
              data.trackedMessages.push({
                id: msg.id,
                firstLine: msg.content.split("\n")[0].slice(0, 80),
                requiredUsers: uniqueUsers,
              });
            }
          }
        }
      } catch (e) {}
    }
  }

  saveData();
});

// ✅ Commande pour configurer le salon des rapports
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith("!configrapport")) {
    data.reportChannelId = message.channel.id;
    saveData();
    await message.reply(`✅ Salon des rapports configuré : ${message.channel}`);
  }

  // ✅ Commande pour générer un rapport instantané
  if (message.content.startsWith("!rapport")) {
    const statusMsg = await message.reply("🕐 Génération du rapport en cours...");
    await generateReport();
    await statusMsg.edit("📊 Rapport envoyé !");
  }

  // ✅ Suivi automatique des nouveaux messages
  if (message.content.includes("Mettez une réaction pour attester de votre prise d'information")) {
    const mentions = [
      ...message.mentions.users.map(u => u.id),
      ...message.mentions.roles.map(r => r),
    ];
    const roleMembers = [];
    for (const role of message.mentions.roles.values()) {
      const r = message.guild.roles.cache.get(role.id);
      if (r) r.members.forEach(m => roleMembers.push(m.id));
    }
    const uniqueUsers = [...new Set([...mentions, ...roleMembers])];

    data.trackedMessages.push({
      id: message.id,
      firstLine: message.content.split("\n")[0].slice(0, 80),
      requiredUsers: uniqueUsers,
    });
    saveData();

    message.reply("👀 Message ajouté au suivi des réactions !");
  }
});

// ✅ Fonction principale : génération du rapport
async function generateReport() {
  if (!data.reportChannelId) return;
  const channel = await client.channels.fetch(data.reportChannelId).catch(() => null);
  if (!channel) return;

  if (!Array.isArray(data.trackedMessages) || data.trackedMessages.length === 0) {
    await channel.send("📊 Aucun message en attente de réaction pour le moment.");
    return;
  }

  // 🔁 Réinitialiser les stats à chaque rapport
  const userStats = {};

  let report = "📊 **Rapport des réactions**\n\n";
  let remainingMessages = [];

  for (const tracked of data.trackedMessages) {
    const requiredUsers = Array.isArray(tracked.requiredUsers) ? tracked.requiredUsers : [];
    let notReacted = [...requiredUsers];

    let msg = null;
    for (const guild of client.guilds.cache.values()) {
      for (const ch of guild.channels.cache.values()) {
        if (!ch.isTextBased()) continue;
        try {
          msg = await ch.messages.fetch(tracked.id);
          if (msg) break;
        } catch {}
      }
      if (msg) break;
    }

    if (msg) {
      for (const reaction of msg.reactions.cache.values()) {
        const users = await reaction.users.fetch();
        users.forEach(user => {
          if (notReacted.includes(user.id)) {
            notReacted = notReacted.filter(id => id !== user.id);
          }
        });
      }

      const messageLink = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
      const notReactedMentions = notReacted.length > 0
        ? notReacted.map(id => `<@${id}>`).join(', ')
        : 'Aucun';

      // ✅ Compteur individuel pour ce rapport seulement
      for (const userId of notReacted) {
        if (!userId) continue;
        if (!userStats[userId]) userStats[userId] = 0;
        userStats[userId]++;
      }

      if (notReacted.length === 0) {
        report += `✅ Tous les utilisateurs ont réagi pour le message : [${tracked.firstLine}](${messageLink})\n\n`;
      } else {
        report += `[${tracked.firstLine}](${messageLink})\n❌ Pas réagi : ${notReactedMentions}\n\n`;
        remainingMessages.push(tracked);
      }
    }
  }

  data.trackedMessages = remainingMessages;
  saveData();

  // ✅ Résumé individuel (basé uniquement sur ce rapport)
  let statsSection = "\n📈 **Compteur individuel de non-réaction (rapport actuel)**\n";
  const sortedStats = Object.entries(userStats).sort((a, b) => b[1] - a[1]);

  if (sortedStats.length === 0) {
    statsSection += "Aucun utilisateur avec des non-réactions.\n";
  } else {
    for (const [userId, count] of sortedStats) {
      statsSection += `<@${userId}> → ${count} fois\n`;
    }
  }

  await channel.send(report + statsSection);
}

client.login(process.env.TOKEN);
