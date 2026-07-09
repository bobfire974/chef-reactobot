import dotenv from "dotenv";
import fs from "fs";
import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

dotenv.config();

const PHRASE_CLE =
  "Mettez une réaction pour attester de votre prise d'information";
const DATA_FILE = "data.json";

/* =======================
   DATA
======================= */
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return {
      trackedMessages: [],
      reportChannelId: null,
      allowedCategories: [],
    };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();
data.trackedMessages ??= [];
data.allowedCategories ??= [];
data.trackedMessages.forEach((t) => {
  t.reminderMessageId ??= null;
  t.lastReminderAt ??= null;
});

const REMINDER_DELAY_MS = 24 * 60 * 60 * 1000; // 24h

/* =======================
   CLIENT
======================= */
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

/* =======================
   UTILS
======================= */
const guildMembersFetchedThisScan = new Set();

async function ensureGuildMembersFetched(guild) {
  if (guildMembersFetchedThisScan.has(guild.id)) return;
  try {
    await guild.members.fetch();
  } catch (err) {
    console.warn(
      `⚠️ Impossible de fetch les membres du serveur ${guild.name} : ${err.message}`
    );
  }
  guildMembersFetchedThisScan.add(guild.id);
}

/* =======================
   TRACK MESSAGE
======================= */
async function trackMessage(message) {
  const users = new Set();

  message.mentions.users.forEach((u) => users.add(u.id));

  if (message.mentions.roles.size > 0) {
    await ensureGuildMembersFetched(message.guild);

    for (const role of message.mentions.roles.values()) {
      const guildRole = message.guild.roles.cache.get(role.id);
      if (!guildRole) continue;

      guildRole.members.forEach((member) => {
        users.add(member.id);
      });
    }
  }

  if (users.size === 0) return false;

  if (!data.trackedMessages.find((m) => m.id === message.id)) {
    data.trackedMessages.push({
      id: message.id,
      channelId: message.channel.id,
      guildId: message.guild.id,
      title: message.content.split("\n")[0].slice(0, 80),
      requiredUsers: [...users],
      reminderMessageId: null,
      lastReminderAt: null,
    });
    saveData();
    return true;
  }

  return false;
}

/* =======================
   SCAN
======================= */
async function scanMessages() {
  const added = [];
  const removed = [];
  const channels = [];

  guildMembersFetchedThisScan.clear();

  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isTextBased()) continue;

      if (
        data.allowedCategories.length > 0 &&
        (!channel.parent ||
          !data.allowedCategories.includes(channel.parent?.name))
      )
        continue;

      channels.push(channel);
    }
  }

  for (const channel of channels) {
    let messages;
    try {
      messages = await channel.messages.fetch({ limit: 50 });
    } catch {
      continue;
    }

    for (const msg of messages.values()) {
      if (msg.content.includes(PHRASE_CLE)) {
        const isNew = await trackMessage(msg);
        if (isNew) added.push(msg);
      }
    }
    console.log(`✅ Scanné #${channel.name}`);
  }

  const stillValid = [];

  for (const tracked of data.trackedMessages) {
    try {
      const channel = await client.channels.fetch(tracked.channelId);
      const msg = await channel.messages.fetch(tracked.id);

      if (msg.content.includes(PHRASE_CLE)) {
        tracked.title = msg.content.split("\n")[0].slice(0, 80);
        stillValid.push(tracked);
      } else {
        removed.push(tracked);
      }
    } catch {
      removed.push(tracked);
    }
  }

  data.trackedMessages = stillValid;
  saveData();

  return { added, removed };
}

/* =======================
   REPORT
======================= */
async function generateReport(scanResult) {
  if (!data.reportChannelId) {
    console.log("⚠️ Aucun salon de rapport configuré (!configrapport).");
    return;
  }

  const reportChannel = await client.channels.fetch(data.reportChannelId);
  if (!reportChannel) return;

  if (data.trackedMessages.length === 0) {
    if (scanResult.removed.length > 0) {
      let emptyReport = "📊 **Rapport des réactions**\n\n";
      emptyReport += "🗑️ **Messages retirés du suivi :**\n";
      scanResult.removed.forEach((m) => (emptyReport += `• ${m.title}\n`));
      emptyReport += "\nAucun message en attente de réaction.";
      await reportChannel.send(emptyReport);
    }
    // Sinon (rien à signaler du tout) : silence total, pas de message envoyé.
    return;
  }

  let report = "📊 **Rapport des réactions**\n\n";
  const stats = {};

  if (scanResult.removed.length > 0) {
    report += "🗑️ **Messages retirés du suivi :**\n";
    scanResult.removed.forEach((m) => (report += `• ${m.title}\n`));
    report += "\n";
  }

  for (const tracked of data.trackedMessages) {
    const channel = await client.channels.fetch(tracked.channelId);
    const msg = await channel.messages.fetch(tracked.id);

    let missing = [...tracked.requiredUsers];

    for (const reaction of msg.reactions.cache.values()) {
      const users = await reaction.users.fetch();
      users.forEach((u) => {
        missing = missing.filter((id) => id !== u.id);
      });
    }

    const link = `https://discord.com/channels/${tracked.guildId}/${tracked.channelId}/${tracked.id}`;
    const isNew = scanResult.added.find((m) => m.id === tracked.id);

    report += `${isNew ? "🆕 " : ""}[${tracked.title}](${link})\n`;

    if (missing.length === 0) {
      report += "✅ Tous ont réagi\n\n";

      // Tout le monde a réagi : on nettoie un éventuel rappel existant.
      // On ne touche JAMAIS ici à `tracked.id` (le message original) — uniquement
      // à `reminderMessageId`, qui est un message distinct posté par le bot.
      if (tracked.reminderMessageId) {
        try {
          const oldReminder = await channel.messages.fetch(tracked.reminderMessageId);
          await oldReminder.delete();
        } catch {
          // Déjà supprimé manuellement ou introuvable : on ignore simplement.
        }
        tracked.reminderMessageId = null;
        tracked.lastReminderAt = null;
      }
    } else {
      report +=
        "❌ Pas réagi : " +
        missing.map((id) => `<@${id}>`).join(", ") +
        "\n\n";

      missing.forEach((id) => {
        stats[id] = (stats[id] || 0) + 1;
      });

      // Gestion du rappel dans le salon d'origine, toutes les 24h.
      const referenceTime = tracked.lastReminderAt
        ? new Date(tracked.lastReminderAt).getTime()
        : msg.createdTimestamp;

      if (Date.now() - referenceTime >= REMINDER_DELAY_MS) {
        // On supprime l'ancien rappel (jamais le message original `tracked.id`).
        if (tracked.reminderMessageId) {
          try {
            const oldReminder = await channel.messages.fetch(tracked.reminderMessageId);
            await oldReminder.delete();
          } catch {
            // Déjà supprimé ou introuvable : on ignore.
          }
        }

        try {
          const reminderText =
            `⏰ **Rappel** : n'ont pas encore réagi à ce message → ` +
            missing.map((id) => `<@${id}>`).join(", ") +
            `\n${link}`;
          const newReminder = await channel.send(reminderText);
          tracked.reminderMessageId = newReminder.id;
          tracked.lastReminderAt = new Date().toISOString();
        } catch (err) {
          console.warn(
            `⚠️ Impossible d'envoyer le rappel dans #${channel.name} : ${err.message}`
          );
        }
      }
    }
  }

  saveData(); // sauvegarde reminderMessageId / lastReminderAt mis à jour

  report += "\n📈 **Compteur individuel (rapport actuel)**\n";
  Object.keys(stats).length === 0
    ? (report += "Aucune non-réaction.\n")
    : Object.entries(stats).forEach(
        ([id, count]) => (report += `<@${id}> → ${count}\n`)
      );

  await reportChannel.send(report);
}

/* =======================
   RUN ONCE
======================= */
client.once("ready", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  try {
    const scanResult = await scanMessages();
    await generateReport(scanResult);
    console.log("✅ Scan + rapport terminés.");
  } catch (err) {
    console.error("❌ Erreur pendant le scan :", err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.TOKEN).catch((err) => {
  console.error("❌ Connexion échouée. Vérifie ton TOKEN :", err.message);
  process.exit(1);
});
