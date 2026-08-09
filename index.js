const { Client, GatewayIntentBits, Collection, REST, Routes, AuditLogEvent, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');

const config = require('./config.js');

// ضع بيانات التطبيق الخاصة بك هنا لتسجيل الدخول (OAuth2)
const CLIENT_ID = config.clientId || '1535766978554372207';
const CLIENT_SECRET = config.clientSecret || '7-XciLDRdMSX30Xpdudcl6T4cN4e9FbK';
const REDIRECT_URI = 'http://localhost:3000/auth/discord/callback'; // (تأكد من تعديلها عند الرفع للاستضافة الحقيقية)

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- مسارات تسجيل الدخول عبر ديسكورد (OAuth2) ---
app.get('/auth/discord', (req, res) => {
    res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send('❌ حدث خطأ أثناء تسجيل الدخول.');

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const oauthData = await tokenResponse.json();
        if (!oauthData.access_token) return res.send('❌ فشل التحقق من حساب ديسكورد.');

        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: { authorization: `${oauthData.token_type} ${oauthData.access_token}` },
        });
        const userGuilds = await guildsResponse.json();

        if (!Array.isArray(userGuilds)) {
            return res.send('❌ تعذر جلب سيرفراتك من ديسكورد.');
        }

        // فلترة السيرفرات: أن يكون المستخدم مالكاً أو لديه صلاحية Administrator (0x8) وأن بوت Gaza Security موجود فيها
        const managedGuilds = userGuilds.filter(guild => (guild.permissions & 0x8) === 0x8);
        const botGuilds = managedGuilds.filter(guild => client.guilds.cache.has(guild.id));

        res.redirect(`/dashboard.html?servers=${encodeURIComponent(JSON.stringify(botGuilds))}`);
    } catch (error) {
        console.error('OAuth2 Error:', error);
        res.send('❌ حدث خطأ داخلي أثناء تسجيل الدخول.');
    }
});

app.listen(PORT, () => {
    console.log(`[EXPRESS] Web server & Dashboard is running on port ${PORT}`);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildBans
    ]
});

client.commands = new Collection();
const commandsArray = [];

// تحميل الأوامر
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
            commandsArray.push(command.data.toJSON());
        }
    }
    console.log(`[COMMANDS] Loaded ${client.commands.size} commands successfully.`);
}

// دالة جلب وإرسال اللوج الموحد لكل الحمايات
function sendLog(guild, embed) {
    const logConfigPath = path.join(__dirname, 'log-config.json');
    if (!fs.existsSync(logConfigPath)) return;
    try {
        const data = JSON.parse(fs.readFileSync(logConfigPath, 'utf8'));
        const logChannelId = data[guild.id];
        if (!logChannelId) return;

        const logChannel = guild.channels.cache.get(logChannelId);
        if (logChannel) {
            logChannel.send({ embeds: [embed] }).catch(() => {});
        }
    } catch (err) {}
}

// دالة جلب حالة حماية البوتات Anti-Bot
function getAntiBotStatus(guildId) {
    const configPath = path.join(__dirname, 'antibot-config.json');
    if (!fs.existsSync(configPath)) return true;
    try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return data[guildId] ?? true;
    } catch {
        return true;
    }
}

client.once('clientReady', async () => {
    console.log(`[READY] Logged in as ${client.user.tag}! Gaza Security is online.`);
    client.user.setActivity('🛡️ /help | Gaza Security', { type: 3 });

    const rest = new REST({ version: '10' }).setToken(config.token);
    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commandsArray },
        );
        console.log('[REST] Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});

// 1️⃣ حماية ومراقبة حذف الرومات
client.on('channelDelete', async channel => {
    if (!channel.guild) return;
    const guild = channel.guild;
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete });
        const deleteLog = auditLogs.entries.first();
        if (!deleteLog) return;

        const { executor } = deleteLog;
        if (!executor || executor.bot || executor.id === guild.ownerId) return;

        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (!member) return;

        const botMember = guild.members.me;
        const isLowerRole = member.roles.highest.position < botMember.roles.highest.position;
        let action = 'لم يتم اتخاذ إجراء';

        if (isLowerRole && member.bannable) {
            await member.ban({ reason: 'Gaza Security: Channel Deletion Protection' });
            action = 'تم حظر المخرب بنجاح ⛔';
        }

        const embed = new EmbedBuilder()
            .setTitle('🚨 تنبيه أمني: حذف روم')
            .setColor('#ff0000')
            .addFields(
                { name: 'المستخدم:', value: `${executor.tag} (<@${executor.id}>)`, inline: true },
                { name: 'الروم المحذوف:', value: `${channel.name}`, inline: true },
                { name: 'الإجراء المتخذ:', value: action, inline: false }
            )
            .setTimestamp();

        sendLog(guild, embed);
    } catch (e) {}
});

// 2️⃣ حماية ومراقبة إنشاء الرومات
client.on('channelCreate', async channel => {
    if (!channel.guild) return;
    const guild = channel.guild;
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelCreate });
        const createLog = auditLogs.entries.first();
        if (!createLog) return;

        const { executor } = createLog;
        if (!executor || executor.bot || executor.id === guild.ownerId) return;

        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (!member) return;

        const botMember = guild.members.me;
        const isLowerRole = member.roles.highest.position < botMember.roles.highest.position;
        let action = 'لم يتم اتخاذ إجراء';

        if (isLowerRole && member.bannable) {
            await member.ban({ reason: 'Gaza Security: Channel Creation Protection' });
            action = 'تم حظر المخرب بنجاح ⛔';
        }

        const embed = new EmbedBuilder()
            .setTitle('🚨 تنبيه أمني: إنشاء روم جديد')
            .setColor('#f1c40f')
            .addFields(
                { name: 'المستخدم:', value: `${executor.tag} (<@${executor.id}>)`, inline: true },
                { name: 'الروم الجديد:', value: `${channel.name}`, inline: true },
                { name: 'الإجراء المتخذ:', value: action, inline: false }
            )
            .setTimestamp();

        sendLog(guild, embed);
    } catch (e) {}
});

// 3️⃣ حماية ومراقبة تغيير رابط السيرفر (Vanity URL)
client.on('guildUpdate', async (oldGuild, newGuild) => {
    const oldVanity = oldGuild.vanityURLCode;
    const newVanity = newGuild.vanityURLCode;

    if (oldVanity && oldVanity !== newVanity) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
            const auditLogs = await newGuild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.GuildUpdate });
            const updateLog = auditLogs.entries.first();
            if (!updateLog) return;

            const { executor } = updateLog;
            if (!executor || executor.id === newGuild.ownerId || executor.bot) return;

            const member = await newGuild.members.fetch(executor.id).catch(() => null);
            if (!member) return;

            try {
                await newGuild.edit({ vanityURLCode: oldVanity }, 'Gaza Security: Restored Vanity URL');
            } catch (err) {}

            const botMember = newGuild.members.me;
            const isLowerRole = member.roles.highest.position < botMember.roles.highest.position;
            let action = 'لم يتم الحظر (رتبة العضو أعلى)';

            if (isLowerRole && member.bannable) {
                await member.ban({ reason: 'Gaza Security: Vanity URL Stealing Attempt' });
                action = 'تم حظر المخرب واسترجاع الرابط ⛔';
            }

            const embed = new EmbedBuilder()
                .setTitle('🚨 تنبيه أمني: محاولة تغيير رابط السيرفر (Vanity)')
                .setColor('#ff0000')
                .addFields(
                    { name: 'المستخدم:', value: `${executor.tag} (<@${executor.id}>)`, inline: true },
                    { name: 'الرابط المسروق:', value: `${newVanity || 'تم حذفه'}`, inline: true },
                    { name: 'الإجراء المتخذ:', value: action, inline: false }
                )
                .setTimestamp();

            sendLog(newGuild, embed);
        } catch (e) {}
    }
});

// 4️⃣ حماية ومراقبة دخول البوتات (Anti-Bot)
client.on('guildMemberAdd', async member => {
    if (!member.user.bot) return;
    const guild = member.guild;

    if (!getAntiBotStatus(guild.id)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd });
        const botAddLog = auditLogs.entries.first();
        if (!botAddLog) return;

        const { executor } = botAddLog;
        if (!executor || executor.id === guild.ownerId) return;

        const adderMember = await guild.members.fetch(executor.id).catch(() => null);
        if (!adderMember) return;

        const botMember = guild.members.me;
        const isLowerRole = adderMember.roles.highest.position < botMember.roles.highest.position;

        if (isLowerRole) {
            if (member.bannable) {
                await member.ban({ reason: `Gaza Security: Unauthorized Bot Added by ${executor.tag}` });
            }
            if (adderMember.bannable) {
                await adderMember.ban({ reason: 'Gaza Security: Adding unauthorized bot to the server' });
            }

            const embed = new EmbedBuilder()
                .setTitle('🚨 تنبيه أمني: تم رصد بوت مضاف حديثاً')
                .setColor('#ff0000')
                .addFields(
                    { name: 'البوت المضاف:', value: `${member.user.tag} (<@${member.id}>)`, inline: true },
                    { name: 'الشخص الذي أضافه:', value: `${executor.tag} (<@${executor.id}>)`, inline: true },
                    { name: 'الإجراء المتخذ:', value: 'تم حظر البوت والشخص المخالف بنجاح ⛔', inline: false }
                )
                .setTimestamp();

            sendLog(guild, embed);
        }
    } catch (e) {}
});

// 5️⃣ تفاعلات الأوامر، الأزرار، والـ Modals (لأمر الـ Report والرد عليه)
client.on('interactionCreate', async interaction => {
    if (interaction.isButton() && interaction.customId.startsWith('reply_report_')) {
        const targetUserId = interaction.customId.split('_')[2];
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        
        const reportModal = new ModalBuilder()
            .setCustomId(`modal_report_${targetUserId}`)
            .setTitle('الرد على البلاغ');

        const responseInput = new TextInputBuilder()
            .setCustomId('report_response_text')
            .setLabel('اكتب الرد الذي سيصل للمستخدم عبر الخاص')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        reportModal.addComponents(new ActionRowBuilder().addComponents(responseInput));
        return await interaction.showModal(reportModal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_report_')) {
        const targetUserId = interaction.customId.split('_')[2];
        const replyText = interaction.fields.getTextInputValue('report_response_text');

        await interaction.reply({ content: '📤 جاري إرسال الرد للمستخدم في الخاص...', ephemeral: true });

        try {
            const targetUser = await client.users.fetch(targetUserId);
            const dmEmbed = new EmbedBuilder()
                .setTitle('📨 رد من فريق دعم البوت')
                .setColor('#2ecc71')
                .setDescription(replyText)
                .setTimestamp();

            await targetUser.send({ embeds: [dmEmbed] });
            await interaction.editReply({ content: '✅ تم إرسال الرد بنجاح إلى خاص المستخدم!' });

            const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
            originalEmbed.addFields({ name: 'حالة الرد:', value: `تم الرد بواسطة: ${interaction.user.tag}\nالرد: ${replyText}`, inline: false });
            await interaction.message.edit({ embeds: [originalEmbed], components: [] });

        } catch (error) {
            await interaction.editReply({ content: '❌ فشل إرسال الرد، قد يكون العضو مغلقاً للخاص (DMs closed).' });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'حدث خطأ أثناء تنفيذ هذا الأمر!', ephemeral: true });
        }
    }
});

// مسار إحصائيات الداشبورد (API)
app.get('/api/stats', (req, res) => {
    if (!client.isReady()) {
        return res.json({ online: false, servers: 0, users: 0, ping: 0 });
    }
    const totalUsers = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
    res.json({
        online: true,
        tag: client.user.tag,
        servers: client.guilds.cache.size,
        users: totalUsers,
        ping: client.ws.ping
    });
});

process.on('unhandledRejection', error => {});
process.on('uncaughtException', error => {});

if (!config.token || typeof config.token !== 'string') {
    console.error('❌ Error: Token is missing or invalid in config.js!');
} else {
    client.login(config.token);
}