require('dotenv').config();
const { Client, IntentsBitField, Partials, EmbedBuilder } = require('discord.js');

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildMessageReactions,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Phrase clé pour détecter les messages
const PHRASE_CLE = "Mettez une réaction pour attester de votre prise d'information";

const suiviMessages = new Map(); // messageId -> { guildId, channelId, requiredUsers: [], reactedUsers: Set() }
const compteurNonReaction = {}; // userId -> nombre de non-réaction

client.once('clientReady', async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  // Scanner les 20 derniers messages de chaque salon pour détecter la phrase clé
  client.guilds.cache.forEach(guild => {
    guild.channels.cache.filter(c => c.isTextBased()).forEach(async channel => {
      try {
        const messages = await channel.messages.fetch({ limit: 20 });
        messages.forEach(message => {
          if (message.content.includes(PHRASE_CLE)) {
            const requiredUsers = getRequiredUsers(message);
            suiviMessages.set(message.id, {
              guildId: guild.id,
              channelId: channel.id,
              requiredUsers,
              reactedUsers: new Set(message.reactions.cache.flatMap(r => r.users.cache.map(u => u.id)))
            });
          }
        });
      } catch (err) {
        // pas de permission sur ce salon
      }
    });
  });
});

client.on('messageCreate', async message => {
  if (message.content.includes(PHRASE_CLE)) {
    const requiredUsers = getRequiredUsers(message);
    suiviMessages.set(message.id, {
      guildId: message.guild.id,
      channelId: message.channel.id,
      requiredUsers,
      reactedUsers: new Set(),
    });
  }

  if (message.content === '!rapport') {
    message.channel.send('📊 Génération du rapport...');
    generateReport(message.channel);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  const data = suiviMessages.get(reaction.message.id);
  if (data) {
    data.reactedUsers.add(user.id);

    // Supprimer le suivi si tout le monde a réagi
    const nonReacted = data.requiredUsers.filter(u => !data.reactedUsers.has(u));
    if (nonReacted.length === 0) {
      suiviMessages.delete(reaction.message.id);
    }
  }
});

function getRequiredUsers(message) {
  // Utilisateurs directement mentionnés
  const userIds = message.mentions.users.map(u => u.id);

  // Membres des rôles mentionnés
  const roleMemberIds = [];
  for (const role of message.mentions.roles.values()) {
    const guildRole = message.guild.roles.cache.get(role.id);
    if (guildRole) {
      guildRole.members.forEach(member => {
        if (!member.user.bot) {
          roleMemberIds.push(member.id);
        }
      });
    }
  }

  // Fusion et suppression des doublons
  return [...new Set([...userIds, ...roleMemberIds])];
}

async function generateReport(channel) {
  if (suiviMessages.size === 0) {
    return channel.send('📊 Aucun message en attente de réaction pour le moment.');
  }

  let reportText = '';
  let compteurTemp = {};

  for (const [msgId, data] of suiviMessages.entries()) {
    const guild = client.guilds.cache.get(data.guildId);
    if (!guild) continue;
    const ch = guild.channels.cache.get(data.channelId);
    if (!ch) continue;
    let msg;
    try {
      msg = await ch.messages.fetch(msgId);
    } catch {
      continue;
    }

    const nonReacted = data.requiredUsers.filter(u => !data.reactedUsers.has(u));
    if (nonReacted.length === 0) continue;

    reportText += `\n**Message:** ${msg.content.split('\n')[0]}\n`;
    reportText += `**Lien:** ${msg.url}\n`;
    reportText += `**Personnes n'ayant pas réagi:**\n`;

    for (const uid of nonReacted) {
      const member = guild.members.cache.get(uid);
      if (!member) continue;
      reportText += `- ${member.user.tag}\n`;
      compteurTemp[uid] = (compteurTemp[uid] || 0) + 1;
    }
    reportText += '\n';
  }

  // Ajouter le compteur individuel sous le rapport
  if (Object.keys(compteurTemp).length > 0) {
    reportText += '📌 **Compteur individuel de non-réaction**\n';
    for (const [uid, count] of Object.entries(compteurTemp)) {
      let memberTag = '';
      client.guilds.cache.forEach(g => {
        const m = g.members.cache.get(uid);
        if (m) memberTag = m.user.tag;
      });
      reportText += `- ${memberTag}: ${count}\n`;
    }
  }

  if (reportText === '') reportText = '📊 Aucun message en attente de réaction pour le moment.';
  channel.send(reportText);
}

client.login(process.env.TOKEN);
