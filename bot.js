const { Client, Events, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '.env');
if (!process.env.DISCORD_TOKEN && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
        if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
}
if (!process.env.DISCORD_TOKEN) {
    console.error('No DISCORD_TOKEN found. Put DISCORD_TOKEN=token in a .env file next to bot.js');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
    ]
});

// guilds.json = per-server settings and ban lists: { "<guildId>": { "modRoleId": "...", "channelId": "...", "banList": ["name", ...] } }
// Writes go to a temp file first to avoid corruption
const guildsFile = path.join(__dirname, 'guilds.json');

function getConsoleTimestamp() {
    return `[${new Date().toLocaleString()}]`;
}

function loadJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (error) {
        console.error(`${getConsoleTimestamp()} Could not read ${path.basename(file)}:`, error);
        process.exit(1); // Don't run with an empty list and then overwrite the real one
    }
}

function saveJson(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
}

let guildSettings = loadJson(guildsFile, {});

function getSettings(guildId) {
    return guildSettings[guildId] || {};
}

function updateSettings(guildId, changes) {
    guildSettings[guildId] = { ...getSettings(guildId), ...changes };
    saveJson(guildsFile, guildSettings);
}

function getBanList(guildId) {
    return getSettings(guildId).banList || [];
}

function saveBanList(guild, banList) {
    updateSettings(guild.id, { banList });
    console.log(`${getConsoleTimestamp()} Ban list saved for ${guild.name}`);
}

function isAdmin(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
}

function isMod(member) {
    const { modRoleId } = getSettings(member.guild.id);
    return isAdmin(member) || (modRoleId && member.roles.cache.has(modRoleId));
}

// for multiple names at once seperated by newlines
function getNamesFromMessage(message) {
    const text = message.content.trim().replace(/^\S+/, '');
    const names = text.split(/\r?\n/).map(name => name.trim().toLowerCase()).filter(Boolean);
    return [...new Set(names)];
}

// Discord caps messages at 2000 characters, so long lists get split up
async function sendLong(channel, text) {
    const lines = text.split('\n');
    let chunk = '';
    for (const line of lines) {
        if (chunk.length + line.length + 1 > 1900) {
            await channel.send(chunk);
            chunk = '';
        }
        chunk += (chunk ? '\n' : '') + line;
    }
    if (chunk) await channel.send(chunk);
}

// Bans
function findMatch(member) {
    const username = member.user.username.toLowerCase();
    const displayName = member.user.globalName ? member.user.globalName.toLowerCase() : '';
    return getBanList(member.guild.id).find(target =>
        username.includes(target.toLowerCase()) || displayName.includes(target.toLowerCase())
    );
}

// Turns a Discord error into a plain reason for why a ban failed
function banFailReason(error) {
    if (error.code === 50013) return 'missing permissions (the bot needs Ban Members, and its role must be above the user\'s highest role)';
    if (error.code === 10007) return 'they already left the server';
    if (error.status === 429) return 'Discord rate limit, try banning them manually';
    if (error.status >= 500) return 'Discord is having problems right now';
    return error.message;
}

async function notifyAndBanUser(member) {
    if (!findMatch(member)) return;
    const guild = member.guild;
    const who = `${member.user.username} (${member.user.globalName || 'no display name'})`;

    let result;
    try {
        await member.ban({ reason: 'STOP' });
        console.log(`${getConsoleTimestamp()} Banned ${member.user.tag} in ${guild.name}`);
        result = `${who} has been banned`;
    } catch (error) {
        const reason = banFailReason(error);
        console.error(`${getConsoleTimestamp()} Failed to ban ${member.user.tag} in ${guild.name} (${guild.id}): ${reason}`);
        result = `Failed to ban ${who}: ${reason}`;
    }

    try {
        const { channelId } = getSettings(guild.id);
        if (channelId) {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) await channel.send(result);
        }
    } catch (error) {
        console.error(`${getConsoleTimestamp()} Could not send ban notice in ${guild.name} (${guild.id}):`, error.message);
    }
}

client.on('guildMemberAdd', async (member) => {
    await notifyAndBanUser(member);
});

// Commands
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild || !message.member) return;

    const args = message.content.trim().split(/\s+/);
    const command = args[0].toLowerCase();
    if (!command.startsWith('!')) return;

    // Commands only work in the set channel and only for mods/admins
    // Admins can run these commands in any channel
    const { channelId: botChannelId } = getSettings(message.guild.id);
    const adminAnywhereCommands = ['!setmodrole', '!setchannel', '!help', '!settings'];
    const adminAnywhere = adminAnywhereCommands.includes(command) && isAdmin(message.member);
    if (!adminAnywhere) {
        if (message.channel.id !== botChannelId) return;
        if (!isMod(message.member)) return;
    }

    try {
        // Admin commands
        if (command === '!setmodrole') {
            if (!isAdmin(message.member)) return await message.reply('Only administrators can set the mod role');
            if (args[1] && args[1].toLowerCase() === 'none') {
                updateSettings(message.guild.id, { modRoleId: null });
                return await message.channel.send('Mod role cleared (only administrators can use the bot now)');
            }
            // Accepts a @role mention, a role ID, or a role name typed as text (can have spaces)
            const roleName = args.slice(1).join(' ').replace(/^@/, '').toLowerCase();
            const role = message.mentions.roles.first()
                || message.guild.roles.cache.get(args[1])
                || message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName);
            if (!role) return await message.reply('Usage: `!setmodrole role` - use the role\'s name, @mention, or ID (or `none` to clear)');
            updateSettings(message.guild.id, { modRoleId: role.id });
            return await message.channel.send(`Mod role set to **${role.name}**`);
        }

        if (command === '!setchannel') {
            if (!isAdmin(message.member)) return await message.reply('Only administrators can set the channel');
            if (args[1] && args[1].toLowerCase() === 'none') {
                updateSettings(message.guild.id, { channelId: null });
                return await message.channel.send('Channel cleared (ban notifications are off for this server)');
            }

            const channelName = (args[1] || '').replace(/^#/, '').toLowerCase();
            const channel = message.mentions.channels.first()
                || message.guild.channels.cache.get(args[1])
                || message.guild.channels.cache.find(c => c.isTextBased() && c.name.toLowerCase() === channelName);
            if (!channel || !channel.isTextBased()) return await message.reply('Usage: `!setchannel channel` - use the channel\'s name, #mention, or ID (or `none` to clear)');
            updateSettings(message.guild.id, { channelId: channel.id });
            return await message.channel.send(`Ban notifications will go to ${channel}`);
        }

        // Mod commands
        // Admins can run !settings and !help anywhere
        if (command === '!settings') {
            const { modRoleId, channelId } = getSettings(message.guild.id);
            return await message.channel.send({
                content:
                    `**Settings for ${message.guild.name}**\n` +
                    `Mod role: ${modRoleId ? `<@&${modRoleId}>` : 'not set (admins only)'}\n` +
                    `Channel: ${channelId ? `<#${channelId}>` : 'not set'}`,
                allowedMentions: { parse: [] } // Show the role without pinging it
            });
        }

        if (command === '!listnames') {
            const banList = getBanList(message.guild.id);
            if (banList.length === 0) {
                return await message.channel.send('The ban list is empty');
            }
            return await sendLong(message.channel, `Ban list:\n${banList.join('\n')}`);
        }

        if (command === '!addname') {
            const names = getNamesFromMessage(message);
            if (names.length === 0) return await message.reply('You did not provide a name');
            const banList = getBanList(message.guild.id);
            const added = names.filter(name => !banList.includes(name));
            const skipped = names.filter(name => banList.includes(name));
            if (added.length > 0) saveBanList(message.guild, [...banList, ...added]);
            return await sendLong(message.channel, [
                added.length ? `${added.join(', ')} ${added.length === 1 ? 'has' : 'have'} been added to the ban list` : '',
                skipped.length ? `${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} already on the ban list` : ''
            ].filter(Boolean).join('\n'));
        }

        if (command === '!removename') {
            const names = getNamesFromMessage(message);
            if (names.length === 0) return await message.reply('You did not provide a name');
            const banList = getBanList(message.guild.id);
            const removed = names.filter(name => banList.includes(name));
            const missing = names.filter(name => !banList.includes(name));
            if (removed.length > 0) saveBanList(message.guild, banList.filter(name => !removed.includes(name)));
            return await sendLong(message.channel, [
                removed.length ? `${removed.join(', ')} ${removed.length === 1 ? 'has' : 'have'} been removed from the ban list` : '',
                missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the ban list` : ''
            ].filter(Boolean).join('\n'));
        }

        if (command === '!help') {
            return await message.channel.send(`
**Available commands:**
1. **!listnames** - Displays this server's list of banned names
2. **!addname name** - Adds a name to the ban list (put more names on new lines to add several)
3. **!removename name** - Removes a name from the ban list (put more names on new lines to remove several)
4. **!settings** - Shows this server's mod role and channel

**Administrator only:**
5. **!setmodrole role** - Sets which role can use the bot in this server. Use the role's name, @mention, or ID (\`none\` to clear)
6. **!setchannel channel** - Sets where ban notifications go in this server. Use the channel's name, #mention, or ID (\`none\` to clear)
            `);
        }
    } catch (error) {
        console.error(`${getConsoleTimestamp()} Error handling ${command} in ${message.guild.name}:`, error);
    }
});

// Log unexpected errors instead of letting them crash the bot
client.on('error', (error) => {
    console.error(`${getConsoleTimestamp()} Discord client error:`, error.message);
});
process.on('unhandledRejection', (error) => {
    console.error(`${getConsoleTimestamp()} Unhandled error:`, error);
});

client.on('guildCreate', (guild) => {
    console.log(`${getConsoleTimestamp()} Joined new server: ${guild.name} (${guild.id}). An admin should run !setmodrole and !setchannel there.`);
});

client.once(Events.ClientReady, () => {
    console.log(`${getConsoleTimestamp()} Bot is online in ${client.guilds.cache.size} server(s)`);
});

client.login(process.env.DISCORD_TOKEN).catch((error) => {
    if (error.message.includes('disallowed intents')) {
        console.error(
            'Could not start: the bot needs two settings turned on.\n' +
            'Go to https://discord.com/developers/applications, open your bot, click "Bot",\n' +
            'and under "Privileged Gateway Intents" turn on "Server Members Intent" and\n' +
            '"Message Content Intent". Save, then start the bot again.'
        );
    } else if (error.code === 'TokenInvalid' || error.message.includes('invalid token')) {
        console.error('Could not start: the DISCORD_TOKEN in your .env file is wrong.');
    } else {
        console.error('Could not start the bot:', error.message);
    }
    process.exit(1);
});
