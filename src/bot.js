const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
} = require('discord.js');
const CFXPortal = require('./cfx-portal');
require('dotenv').config();

// Configuration
const config = {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    forumCookie: process.env.CFX_FORUM_COOKIE,
    logChannelId: process.env.LOG_CHANNEL_ID,
    allowedRoles: process.env.ALLOWED_ROLES?.split(',').filter(Boolean) || [],
    allowedChannels: process.env.ALLOWED_CHANNELS?.split(',').filter(Boolean) || [],
};

// Validate config
if (!config.token || !config.clientId || !config.forumCookie) {
    console.error('Missing required environment variables!');
    console.error('Required: DISCORD_TOKEN, DISCORD_CLIENT_ID, CFX_FORUM_COOKIE');
    process.exit(1);
}

// Initialize CFX Portal client
const cfxPortal = new CFXPortal(config.forumCookie);

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
    ],
});

// Slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('escrow')
        .setDescription('Upload a resource to CFX escrow')
        .addAttachmentOption(option =>
            option.setName('file')
                .setDescription('The .zip file to upload')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('type')
                .setDescription('New asset or update existing?')
                .setRequired(true)
                .addChoices(
                    { name: '🆕 New Asset', value: 'new' },
                    { name: '🔄 Update Existing', value: 'update' }
                )
        )
        .addStringOption(option =>
            option.setName('name_or_id')
                .setDescription('Asset name (for new) or Asset name/ID (for update)')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('escrow-list')
        .setDescription('List all your escrowed assets'),

    new SlashCommandBuilder()
        .setName('escrow-status')
        .setDescription('Check CFX Portal connection status'),
];

// Register slash commands
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(config.token);

    try {
        console.log('Registering slash commands...');

        if (config.guildId) {
            await rest.put(
                Routes.applicationGuildCommands(config.clientId, config.guildId),
                { body: commands.map(c => c.toJSON()) }
            );
            console.log(`Commands registered for guild: ${config.guildId}`);
        } else {
            await rest.put(
                Routes.applicationCommands(config.clientId),
                { body: commands.map(c => c.toJSON()) }
            );
            console.log('Global commands registered');
        }
    } catch (error) {
        console.error('Failed to register commands:', error);
    }
}

// Permission check
function hasPermission(interaction) {
    if (config.allowedRoles.length === 0 && config.allowedChannels.length === 0) {
        return true;
    }

    if (config.allowedChannels.length > 0 && !config.allowedChannels.includes(interaction.channelId)) {
        return false;
    }

    if (config.allowedRoles.length > 0) {
        const memberRoles = interaction.member?.roles?.cache?.map(r => r.id) || [];
        return config.allowedRoles.some(roleId => memberRoles.includes(roleId));
    }

    return true;
}

// Create status embed
function createStatusEmbed(status, message, details = null) {
    const colors = {
        success: 0x00ff00,
        error: 0xff0000,
        pending: 0xffff00,
        info: 0x0099ff,
    };

    const embed = new EmbedBuilder()
        .setColor(colors[status] || colors.info)
        .setTitle(
            status === 'success' ? '✅ Success' : 
            status === 'error' ? '❌ Error' : 
            status === 'pending' ? '⏳ Processing' : 'ℹ️ Info'
        )
        .setDescription(message)
        .setFooter({ text: 'Crafted by Laith' })
        .setTimestamp();

    if (details) {
        Object.entries(details).forEach(([key, value]) => {
            embed.addFields({ name: key, value: String(value), inline: true });
        });
    }

    return embed;
}

// Send log to log channel
async function sendLog(embed) {
    if (!config.logChannelId) return;
    
    try {
        const channel = await client.channels.fetch(config.logChannelId);
        if (channel) {
            await channel.send({ embeds: [embed] });
        }
    } catch (error) {
        console.error('Failed to send log:', error.message);
    }
}

// Create log embed
function createLogEmbed(action, user, details = {}) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`📋 ${action}`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .addFields(
            { name: 'User', value: `${user.tag} (<@${user.id}>)`, inline: true },
            { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
        )
        .setFooter({ text: 'Crafted by Laith' })
        .setTimestamp();

    Object.entries(details).forEach(([key, value]) => {
        embed.addFields({ name: key, value: String(value), inline: true });
    });

    return embed;
}

// Handle /escrow command
async function handleEscrow(interaction) {
    if (!hasPermission(interaction)) {
        return interaction.reply({
            embeds: [createStatusEmbed('error', 'You do not have permission to use this command.')],
            ephemeral: true,
        });
    }

    if (!cfxPortal.authenticated) {
        return interaction.reply({
            embeds: [createStatusEmbed('error', 'CFX Portal not authenticated. Please restart the bot and check your cookie.')],
            ephemeral: true,
        });
    }

    const file = interaction.options.getAttachment('file');
    const type = interaction.options.getString('type');
    const nameOrId = interaction.options.getString('name_or_id');

    // Validate file
    if (!file.name.endsWith('.zip')) {
        return interaction.reply({
            embeds: [createStatusEmbed('error', 'Please upload a .zip file.')],
            ephemeral: true,
        });
    }

    // Check file size (100MB limit)
    if (file.size > 100 * 1024 * 1024) {
        return interaction.reply({
            embeds: [createStatusEmbed('error', 'File size exceeds 100MB limit.')],
            ephemeral: true,
        });
    }

    await interaction.deferReply();

    try {
        // Download the file
        const axios = require('axios');
        const response = await axios.get(file.url, { responseType: 'arraybuffer' });
        const zipBuffer = Buffer.from(response.data);

        if (type === 'new') {
            // Check if asset already exists
            const existingAsset = await cfxPortal.findAssetByName(nameOrId);
            if (existingAsset) {
                return interaction.editReply({
                    embeds: [createStatusEmbed('error', `Asset "${nameOrId}" already exists! Use "Update Existing" instead.`, {
                        'Existing Asset ID': existingAsset.id,
                    })],
                });
            }

            // Create new asset and upload in one go
            await interaction.editReply({
                embeds: [createStatusEmbed('pending', `Creating and uploading new asset "${nameOrId}"...`, {
                    'File': file.name,
                    'File Size': `${(file.size / 1024).toFixed(2)} KB`,
                })],
            });

            try {
                const newAsset = await cfxPortal.createAndUploadAsset(nameOrId, zipBuffer, file.name);
                
                // Send log
                await sendLog(createLogEmbed('New Asset Created', interaction.user, {
                    'Asset Name': nameOrId,
                    'Asset ID': newAsset.id,
                    'File': file.name,
                    'File Size': `${(file.size / 1024).toFixed(2)} KB`,
                }));

                return interaction.editReply({
                    embeds: [createStatusEmbed('success', 'New asset created and uploaded!', {
                        'Asset Name': nameOrId,
                        'Asset ID': newAsset.id,
                        'File': file.name,
                        'Uploaded By': interaction.user.tag,
                    })],
                });
            } catch (createError) {
                console.error('Create asset error:', createError);
                
                // Log error
                await sendLog(createLogEmbed('Asset Creation Failed', interaction.user, {
                    'Asset Name': nameOrId,
                    'Error': createError.message,
                }));

                return interaction.editReply({
                    embeds: [createStatusEmbed('error', `Failed to create asset: ${createError.message}`)],
                });
            }

        } else {
            // Find existing asset
            let asset = null;
            
            // Try by ID first (if it looks like a number)
            if (/^\d+$/.test(nameOrId)) {
                asset = await cfxPortal.findAssetById(nameOrId);
            }
            
            // Try by name if not found
            if (!asset) {
                asset = await cfxPortal.findAssetByName(nameOrId);
            }

            if (!asset) {
                return interaction.editReply({
                    embeds: [createStatusEmbed('error', `Asset "${nameOrId}" not found. Use /escrow-list to see your assets.`)],
                });
            }

            // Show uploading status
            await interaction.editReply({
                embeds: [createStatusEmbed('pending', 'Uploading to CFX Portal...', {
                    'Asset': asset.name || nameOrId,
                    'Asset ID': asset.id,
                    'File Size': `${(file.size / 1024).toFixed(2)} KB`,
                })],
            });

            // Upload the file
            await cfxPortal.uploadAsset(asset.id, zipBuffer, file.name);

            // Send log
            await sendLog(createLogEmbed('Asset Updated', interaction.user, {
                'Asset Name': asset.name || nameOrId,
                'Asset ID': asset.id,
                'File': file.name,
                'File Size': `${(file.size / 1024).toFixed(2)} KB`,
            }));

            return interaction.editReply({
                embeds: [createStatusEmbed('success', 'Asset updated successfully!', {
                    'Asset Name': asset.name || nameOrId,
                    'Asset ID': asset.id,
                    'File': file.name,
                    'Uploaded By': interaction.user.tag,
                })],
            });
        }

    } catch (error) {
        console.error('Escrow error:', error);
        return interaction.editReply({
            embeds: [createStatusEmbed('error', `Upload failed: ${error.message}`)],
        });
    }
}

// Handle /escrow-list command
async function handleEscrowList(interaction) {
    if (!hasPermission(interaction)) {
        return interaction.reply({
            embeds: [createStatusEmbed('error', 'You do not have permission to use this command.')],
            ephemeral: true,
        });
    }

    if (!cfxPortal.authenticated) {
        return interaction.reply({
            embeds: [createStatusEmbed('error', 'CFX Portal not authenticated. Please restart the bot and check your cookie.')],
            ephemeral: true,
        });
    }

    await interaction.deferReply();

    try {
        const assets = await cfxPortal.getAssets();

        if (!assets || assets.length === 0) {
            return interaction.editReply({
                embeds: [createStatusEmbed('info', 'No assets found.')],
            });
        }

        // Discord has a limit of 25 fields per embed, so we'll create multiple embeds if needed
        const embeds = [];
        const assetsPerEmbed = 25;
        const totalPages = Math.ceil(assets.length / assetsPerEmbed);

        for (let i = 0; i < Math.min(totalPages, 4); i++) { // Discord allows max 10 embeds, we'll use 4 max (100 assets)
            const start = i * assetsPerEmbed;
            const end = Math.min(start + assetsPerEmbed, assets.length);
            const pageAssets = assets.slice(start, end);

            const embed = new EmbedBuilder()
                .setColor(0x0099ff)
                .setFooter({ text: 'Crafted by Laith' })
                .setTimestamp();

            if (i === 0) {
                embed.setTitle('📦 Your Escrowed Assets');
                embed.setDescription(`Found **${assets.length}** asset(s). Use \`/escrow\` with the asset name or ID to update.`);
            } else {
                embed.setTitle(`📦 Assets (continued ${i + 1}/${totalPages})`);
            }

            pageAssets.forEach(asset => {
                embed.addFields({
                    name: asset.name || 'Unnamed',
                    value: `ID: \`${asset.id}\``,
                    inline: true,
                });
            });

            embeds.push(embed);
        }

        if (assets.length > 100) {
            embeds[embeds.length - 1].setFooter({ 
                text: `Showing 100 of ${assets.length} assets • Crafted by Laith` 
            });
        }

        return interaction.editReply({ embeds });

    } catch (error) {
        console.error('List error:', error);
        return interaction.editReply({
            embeds: [createStatusEmbed('error', `Failed to fetch assets: ${error.message}`)],
        });
    }
}

// Handle /escrow-status command
async function handleEscrowStatus(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        if (!cfxPortal.authenticated) {
            return interaction.editReply({
                embeds: [createStatusEmbed('error', 'Not connected to CFX Portal. Check your forum cookie and restart the bot.')],
            });
        }

        const assets = await cfxPortal.getAssets();

        return interaction.editReply({
            embeds: [createStatusEmbed('success', 'Connected to CFX Portal!', {
                'Total Assets': assets.length,
                'Status': 'Authenticated',
            })],
        });

    } catch (error) {
        return interaction.editReply({
            embeds: [createStatusEmbed('error', `Connection failed: ${error.message}`)],
        });
    }
}

// Event handlers
client.once('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}`);
    
    // Register commands first
    await registerCommands();

    // Authenticate with CFX Portal
    console.log('Authenticating with CFX Portal...');
    const authSuccess = await cfxPortal.authenticate();
    
    if (authSuccess) {
        console.log('CFX Portal authentication successful!');
        // Close the browser after auth - we have the cookies now
        await cfxPortal.close();
    } else {
        console.warn('CFX Portal authentication failed. Check your cookie.');
    }

    console.log('Bot is ready!');
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
        case 'escrow':
            await handleEscrow(interaction);
            break;
        case 'escrow-list':
            await handleEscrowList(interaction);
            break;
        case 'escrow-status':
            await handleEscrowStatus(interaction);
            break;
    }
});

// Error handling
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Login
client.login(config.token);