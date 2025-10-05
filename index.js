require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const DATA_FILE = './data.json';
let data = { trackedMessages: [], reportChannelId: null };

// Charger les données
if (fs.existsSync(DATA_FILE)) {
    try {
        data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
        data = { trackedMessages: [], reportChannelId: null };
    }
}

// Sauvegarder les données
function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Suivre ou mettre à jour un message
async function followMessage(message) {
    if (message.author.bot) return;

    if (message.content.includes("Mettez une réaction pour attester de votre prise d'information")) {

        if (!Array.isArray(data.trackedMessages)) data.trackedMessages = [];

        let requiredUsers = [];

        // Ajouter les utilisateurs mentionnés
        message.mentions.users.forEach(user => requiredUsers.push(user.id));

        // Fetch complet de tous les membres du serveur
        await message.guild.members.fetch();

        // Ajouter les membres des rôles mentionnés
        for (const role of message.mentions.roles.values()) {
            message.guild.members.cache.forEach(member => {
                if (member.roles.cache.has(role.id) && !requiredUsers.includes(member.id)) {
                    requiredUsers.push(member.id);
                }
            });
        }

        // Vérifier si message déjà suivi
        const exists = data.trackedMessages.find(m => m.id === message.id);
        if (exists) {
            exists.firstLine = message.content.split('\n')[0];
            exists.requiredUsers = requiredUsers;
            saveData();
            console.log(`Message suivi mis à jour : "${exists.firstLine}"`);
        } else {
            data.trackedMessages.push({
                id: message.id,
                firstLine: message.content.split('\n')[0],
                requiredUsers: requiredUsers
            });
            saveData();
            console.log(`Message suivi ajouté : "${message.content.split('\n')[0]}" avec ${requiredUsers.length} utilisateurs`);
        }
    }
}

// Générer le rapport (uniquement les utilisateurs n'ayant pas réagi)
async function generateReport() {
    if (!data.reportChannelId) return;
    const channel = await client.channels.fetch(data.reportChannelId).catch(() => null);
    if (!channel) return;

    if (!Array.isArray(data.trackedMessages) || data.trackedMessages.length === 0) {
        channel.send('📊 Aucun message en attente de réaction pour le moment.');
        return;
    }

    let report = '📊 **Rapport des réactions**\n\n';
    let remainingMessages = [];

    for (const tracked of data.trackedMessages) {
        const requiredUsers = Array.isArray(tracked.requiredUsers) ? tracked.requiredUsers : [];
        let notReacted = [...requiredUsers];

        // Récupérer le message original
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
            const notReactedMentions = notReacted.map(id => `<@${id}>`).join(', ') || 'Aucun';

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
    channel.send(report);
}

// Commandes
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Configurer le salon des rapports
    if (message.content.startsWith('!configrapport')) {
        const channel = message.mentions.channels.first();
        if (!channel) return message.reply('Merci de mentionner un salon pour les rapports.');
        data.reportChannelId = channel.id;
        saveData();
        message.reply(`✅ Salon des rapports configuré : ${channel}`);
    }

    // Générer un rapport instantané
    if (message.content.startsWith('!rapport')) {
        if (!data.reportChannelId) return message.reply('❌ Le salon des rapports n’est pas configuré. Utilisez !configrapport #salon');

        // Message temporaire pour indiquer que le rapport est en cours
        const processingMsg = await message.reply('⏳ Génération du rapport en cours...');

        await generateReport();

        // Modifier le message pour indiquer que le traitement est terminé
        processingMsg.edit('✅ Rapport envoyé !');
    }

    // Suivre ce message
    await followMessage(message);
});

// Suivi des messages modifiés
client.on('messageUpdate', async (oldMessage, newMessage) => {
    await followMessage(newMessage);
});

// Scanner les 20 derniers messages au démarrage
client.on('ready', async () => {
    console.log(`✅ Connecté en tant que ${client.user.tag}`);

    for (const guild of client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
            if (!channel.isTextBased()) continue;
            const messages = await channel.messages.fetch({ limit: 20 }).catch(() => []);
            for (const msg of messages.values()) {
                await followMessage(msg);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN).then(() => {
    console.log('Bot lancé !');
}).catch(err => {
    console.error('Erreur de connexion :', err);
});
