/**
 * ELYTRAx V1 — Lightweight Esports Management Bot (Discord.js v14)
 * Built for Team Elytra (BGMI / Free Fire / Mobile Esports)
 *
 * Included Quotient Esports Modules (Zero Bloat, No Points Table Maker):
 *  1. Scrims Manager (/scrim)       — Auto-open (IST), mention checks, duplicate tag filter, reserved slots, bans, auto-slotlist
 *  2. Slot Manager (/slotm)         — Interactive Cancel / Claim / Transfer slot buttons with live slotlist & role sync
 *  3. Tournament Manager (/tourney) — Multi-slot tourneys, fake-tag check, auto group divider (Group A/B/C...), CSV export
 *  4. Tag Check (/tagcheck)         — Pre-registration format & mention validator channel
 *  5. EasyTag (/eztag)              — Converts plain text / mentions into copy-pasteable squad registration format
 *  6. SS-Verify (/ssverify)         — Screenshot count & image type verifier for auto-assigning Verified roles
 *  7. IDP Broadcaster (/idp)        — Formatted Room ID & Password embed sender with role ping and auto-delete timer
 *
 * Quick Setup (PowerShell or Linux):
 *  1. npm init -y
 *  2. npm install discord.js dotenv
 *  3. Create a .env file with:
 *       DISCORD_TOKEN=your_bot_token_here
 *       CLIENT_ID=your_application_client_id_here
 *  4. Enable "Message Content Intent" and "Server Members Intent" in Discord Developer Portal -> Bot.
 *  5. Run: node elytrax_v1.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  ChannelType,
} = require('discord.js');

// ============================================================================
// 1. JSON DATABASE (Zero External DB Dependencies — Low RAM Footprint)
// ============================================================================
const DB_FILE = path.join(__dirname, 'elytrax_db.json');

const defaultDB = {
  scrims: {},      // keyed by regChannelId
  tourneys: {},    // keyed by regChannelId
  tagcheck: {},    // keyed by channelId: { mentions: number }
  eztag: {},       // keyed by channelId: { enabled: boolean }
  ssverify: {},    // keyed by channelId: { roleId, requiredCount, submissions: { userId: count } }
};

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB, null, 2), 'utf8');
      return JSON.parse(JSON.stringify(defaultDB));
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return { ...defaultDB, ...JSON.parse(raw) };
  } catch (err) {
    console.error('[DB] Failed to load database, initializing fresh state:', err.message);
    return JSON.parse(JSON.stringify(defaultDB));
  }
}

let db = loadDB();

function saveDB() {
  try {
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[DB] Save error:', err.message);
  }
}

// ============================================================================
// 2. HELPER UTILITIES
// ============================================================================
const BRAND_COLOR = 0xe11d48; // Elytra Crimson Red
const SUCCESS_COLOR = 0x10b981;
const WARN_COLOR = 0xf59e0b;

function getISTTimeHHMM() {
  const now = new Date();
  const istString = now.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return istString.slice(0, 5);
}

function getISTDateKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

function extractTeamName(content) {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(?:team\s*name|team|squad\s*name|squad|clan)\s*[:\-=]\s*(.+)$/i);
    if (match && match[1]) {
      return match[1].replace(/<@!?\d+>/g, '').trim().slice(0, 40) || 'Unnamed Squad';
    }
  }
  const firstLine = (lines[0] || 'Unnamed Squad').replace(/<@!?\d+>/g, '').trim();
  return (firstLine || 'Unnamed Squad').slice(0, 40);
}

function extractUniqueUserMentions(message) {
  const regex = /<@!?(\d+)>/g;
  const ids = new Set();
  let match;
  while ((match = regex.exec(message.content)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

function buildScrimSlotlistEmbed(scrim) {
  const lines = [];
  for (let i = 1; i <= scrim.totalSlots; i++) {
    const slotEntry = scrim.slots.find((s) => s.slot === i);
    if (slotEntry) {
      const tag = slotEntry.reserved ? ' *(R)*' : '';
      lines.push(`\`Slot ${String(i).padStart(2, '0')}\`  **${slotEntry.teamName}** — <@${slotEntry.leaderId}>${tag}`);
    } else {
      lines.push(`\`Slot ${String(i).padStart(2, '0')}\`  *— Open —*`);
    }
  }

  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`${scrim.name} — Official Slotlist`)
    .setDescription(lines.join('\n') || 'No teams registered.')
    .addFields(
      {
        name: 'Filled Slots',
        value: `${scrim.slots.length} / ${scrim.totalSlots}`,
        inline: true,
      },
      {
        name: 'Status',
        value: scrim.isOpen ? '🟢 Registration Open' : '🔴 Registration Closed',
        inline: true,
      }
    )
    .setFooter({ text: 'ELYTRAx V1 Esports Manager' })
    .setTimestamp();
}

async function syncScrimSlotlistMessage(guild, scrim) {
  try {
    const slotChannel = await guild.channels.fetch(scrim.slotChannelId).catch(() => null);
    if (!slotChannel) return;
    const embed = buildScrimSlotlistEmbed(scrim);

    if (scrim.slotlistMessageId) {
      const existing = await slotChannel.messages.fetch(scrim.slotlistMessageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
    }
    const sent = await slotChannel.send({ embeds: [embed] });
    scrim.slotlistMessageId = sent.id;
    saveDB();
  } catch (err) {
    console.error('[Slotlist Sync Error]:', err.message);
  }
}

async function setChannelSendLock(guild, channelId, allowSend) {
  try {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: allowSend,
    });
  } catch (err) {
    console.error('[Channel Lock Error]:', err.message);
  }
}

async function openScrimRegistration(guild, scrim) {
  scrim.isOpen = true;
  // Reset non-reserved slots on fresh open
  scrim.slots = (scrim.slots || []).filter((s) => s.reserved);
  saveDB();

  const regChannel = await guild.channels.fetch(scrim.regChannelId).catch(() => null);
  if (!regChannel) return;

  if (scrim.autoClean) {
    try {
      const fetched = await regChannel.messages.fetch({ limit: 50 });
      const deletable = fetched.filter((m) => !m.pinned);
      if (deletable.size > 0) {
        await regChannel.bulkDelete(deletable, true).catch(() => null);
      }
    } catch (_) {}
  }

  await setChannelSendLock(guild, scrim.regChannelId, true);

  const openSlotsCount = scrim.totalSlots - scrim.slots.length;
  const pingText = scrim.pingRoleId ? `<@&${scrim.pingRoleId}>` : '';

  const embed = new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle(`🟢 ${scrim.name} — Registration Open`)
    .setDescription(
      [
        `**Available Slots:** \`${openSlotsCount}\` / \`${scrim.totalSlots}\``,
        `**Required Mentions:** \`${scrim.requiredMentions}\` unique players`,
        `**IDP Role:** <@&${scrim.idpRoleId}>`,
        '',
        '**Format:**',
        '```',
        'Team Name: Your Squad Name',
        '@Player1 @Player2 @Player3 @Player4',
        '```',
      ].join('\n')
    )
    .setFooter({ text: 'ELYTRAx V1 • Duplicate tags are automatically rejected' })
    .setTimestamp();

  await regChannel.send({ content: pingText || null, embeds: [embed] });
}

async function closeScrimRegistration(guild, scrim, reason = 'All slots filled or closed by staff.') {
  scrim.isOpen = false;
  saveDB();

  await setChannelSendLock(guild, scrim.regChannelId, false);

  const regChannel = await guild.channels.fetch(scrim.regChannelId).catch(() => null);
  if (regChannel) {
    const embed = new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle(`🔴 ${scrim.name} — Registration Closed`)
      .setDescription(`${reason}\nCheck <#${scrim.slotChannelId}> for the official slotlist.`)
      .setTimestamp();
    await regChannel.send({ embeds: [embed] }).catch(() => null);
  }

  await syncScrimSlotlistMessage(guild, scrim);
}

// ============================================================================
// 3. SLASH COMMAND DEFINITIONS
// ============================================================================
const commands = [
  // 1. SCRIM MANAGER
  new SlashCommandBuilder()
    .setName('scrim')
    .setDescription('Manage automated esports scrims (Quotient Scrims Manager)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new scrim configuration')
        .addStringOption((o) => o.setName('name').setDescription('Scrim title (e.g. Elytra Evening Scrims)').setRequired(true))
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addChannelOption((o) =>
          o.setName('slot_channel').setDescription('Slotlist & Cancel-Claim channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addRoleOption((o) => o.setName('idp_role').setDescription('Role given to registered captains').setRequired(true))
        .addIntegerOption((o) => o.setName('total_slots').setDescription('Total slots (e.g. 16, 20, 25)').setMinValue(2).setMaxValue(30).setRequired(true))
        .addIntegerOption((o) => o.setName('mentions').setDescription('Required @mentions per team (e.g. 4)').setMinValue(0).setMaxValue(6).setRequired(true))
        .addStringOption((o) => o.setName('open_time').setDescription('Daily auto-open time in IST 24h format (e.g. 14:00)'))
        .addRoleOption((o) => o.setName('ping_role').setDescription('Role to ping when registration opens'))
        .addBooleanOption((o) => o.setName('auto_clean').setDescription('Purge old messages in reg channel before opening'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Open scrim registration immediately')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Scrim registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Close scrim registration and publish slotlist')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Scrim registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('reserve')
        .setDescription('Reserve a specific slot number for a team')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Scrim registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addIntegerOption((o) => o.setName('slot_number').setDescription('Slot number to reserve').setMinValue(1).setMaxValue(30).setRequired(true))
        .addStringOption((o) => o.setName('team_name').setDescription('Reserved team name').setRequired(true))
        .addUserOption((o) => o.setName('leader').setDescription('Team captain to assign IDP role').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('ban')
        .setDescription('Ban or unban a user from registering in a scrim')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Scrim registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addUserOption((o) => o.setName('user').setDescription('Target user').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List all configured scrims in this server')
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Delete a scrim configuration')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Scrim registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    ),

  // 2. SLOT MANAGER (CANCEL / CLAIM / TRANSFER)
  new SlashCommandBuilder()
    .setName('slotm')
    .setDescription('Deploy interactive Cancel / Claim / Transfer slot panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Post the Cancel/Claim/Transfer slot panel for a scrim')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('The registration channel of the scrim').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    ),

  // 3. TOURNAMENT MANAGER
  new SlashCommandBuilder()
    .setName('tourney')
    .setDescription('Manage esports tournaments, groups, and CSV exports')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new tournament')
        .addStringOption((o) => o.setName('name').setDescription('Tournament name').setRequired(true))
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addChannelOption((o) =>
          o.setName('confirm_channel').setDescription('Confirmed teams log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addRoleOption((o) => o.setName('role').setDescription('Role given to registered tournament captains').setRequired(true))
        .addIntegerOption((o) => o.setName('total_slots').setDescription('Total tournament slots (e.g. 24, 32, 64, 128)').setMinValue(4).setMaxValue(500).setRequired(true))
        .addIntegerOption((o) => o.setName('mentions').setDescription('Required @mentions per squad').setMinValue(0).setMaxValue(6).setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Open tournament registration')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Tournament registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('pause')
        .setDescription('Pause or close tournament registration')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Tournament registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('groups')
        .setDescription('Auto-divide registered tournament teams into balanced groups (Group A, B, C...)')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Tournament registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addIntegerOption((o) => o.setName('group_size').setDescription('Teams per group (e.g. 12 for Free Fire, 16 or 20 for BGMI)').setMinValue(2).setMaxValue(30).setRequired(true))
        .addBooleanOption((o) => o.setName('shuffle').setDescription('Shuffle teams randomly before grouping'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('export')
        .setDescription('Export all registered tournament squads as a CSV file')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Tournament registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove_slot')
        .setDescription('Remove a specific slot number from a tournament')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Tournament registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addIntegerOption((o) => o.setName('slot_number').setDescription('Slot number to remove').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Delete a tournament configuration')
        .addChannelOption((o) =>
          o.setName('reg_channel').setDescription('Tournament registration channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    ),

  // 4. TAGCHECK & EASYTAG
  new SlashCommandBuilder()
    .setName('tagcheck')
    .setDescription('Configure a Tag Check channel to validate squad registration format')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Channel for Tag Check').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName('mentions').setDescription('Required @mentions to validate (0 to disable)').setMinValue(0).setMaxValue(6).setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('eztag')
    .setDescription('Configure an EasyTag channel to convert raw tags into registration format')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Channel for EasyTag').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .addBooleanOption((o) =>
      o.setName('enabled').setDescription('Enable or disable EasyTag in this channel').setRequired(true)
    ),

  // 5. SCREENSHOT VERIFICATION (SSVERIFY)
  new SlashCommandBuilder()
    .setName('ssverify')
    .setDescription('Configure screenshot verification (YouTube/Instagram sub proof) for role unlock')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Verification channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .addRoleOption((o) =>
      o.setName('verified_role').setDescription('Role granted once screenshots are submitted').setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName('required_screenshots').setDescription('Number of screenshots required (0 to disable)').setMinValue(0).setMaxValue(10).setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('instructions').setDescription('Custom instructions (e.g. Subscribe to Team Elytra YT & follow IG)')
    ),

  // 6. IDP BROADCASTER
  new SlashCommandBuilder()
    .setName('idp')
    .setDescription('Broadcast formatted BGMI / Free Fire Room ID & Password embed')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) => o.setName('room_id').setDescription('Custom Room ID').setRequired(true))
    .addStringOption((o) => o.setName('password').setDescription('Room Password').setRequired(true))
    .addStringOption((o) => o.setName('map').setDescription('Map name (e.g. Erangel, Miramar, Rondo, Bermuda)').setRequired(true))
    .addStringOption((o) => o.setName('start_time').setDescription('Match start time (e.g. 08:15 PM IST)').setRequired(true))
    .addRoleOption((o) => o.setName('ping_role').setDescription('IDP Role to ping'))
    .addIntegerOption((o) =>
      o.setName('autodelete_mins').setDescription('Auto-delete IDP message after N minutes (optional)').setMinValue(1).setMaxValue(120)
    ),
];

// ============================================================================
// 4. DISCORD CLIENT INITIALIZATION & AUTO-SCHEDULER
// ============================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once('ready', async () => {
  console.log(`[ELYTRAx V1] Logged in as ${client.user.tag}`);

  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID || client.user.id;
  if (token && clientId) {
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      await rest.put(Routes.applicationCommands(clientId), {
        body: commands.map((c) => c.toJSON()),
      });
      console.log(`[ELYTRAx V1] Registered ${commands.length} global slash commands.`);
    } catch (err) {
      console.error('[ELYTRAx V1] Slash command registration error:', err.message);
    }
  }

  // 30-second IST scheduler for automated scrim opening
  setInterval(async () => {
    const currentHHMM = getISTTimeHHMM();
    const todayKey = getISTDateKey();

    for (const regChannelId of Object.keys(db.scrims)) {
      const scrim = db.scrims[regChannelId];
      if (!scrim.openTime || scrim.isOpen) continue;
      if (scrim.openTime === currentHHMM && scrim.lastOpenedDate !== todayKey) {
        scrim.lastOpenedDate = todayKey;
        saveDB();
        const guild = await client.guilds.fetch(scrim.guildId).catch(() => null);
        if (guild) {
          console.log(`[Scheduler] Auto-opening scrim "${scrim.name}" at ${currentHHMM} IST`);
          await openScrimRegistration(guild, scrim);
        }
      }
    }
  }, 30 * 1000);
});

// ============================================================================
// 5. SLASH COMMAND & INTERACTION HANDLER
// ============================================================================
client.on('interactionCreate', async (interaction) => {
  try {
    // ------------------------------------------------------------------------
    // A. SLASH COMMANDS
    // ------------------------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // 1. /scrim
      if (commandName === 'scrim') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'create') {
          const name = interaction.options.getString('name', true);
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const slotChannel = interaction.options.getChannel('slot_channel', true);
          const idpRole = interaction.options.getRole('idp_role', true);
          const totalSlots = interaction.options.getInteger('total_slots', true);
          const mentions = interaction.options.getInteger('mentions', true);
          const openTime = interaction.options.getString('open_time') || null;
          const pingRole = interaction.options.getRole('ping_role') || null;
          const autoClean = interaction.options.getBoolean('auto_clean') ?? true;

          db.scrims[regChannel.id] = {
            guildId: interaction.guildId,
            name,
            regChannelId: regChannel.id,
            slotChannelId: slotChannel.id,
            idpRoleId: idpRole.id,
            pingRoleId: pingRole ? pingRole.id : null,
            totalSlots,
            requiredMentions: mentions,
            openTime,
            autoClean,
            isOpen: false,
            lastOpenedDate: null,
            slotlistMessageId: null,
            bannedUsers: [],
            slots: [],
          };
          saveDB();

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(SUCCESS_COLOR)
                .setTitle(`✅ Scrim Created — ${name}`)
                .setDescription(
                  [
                    `**Registration Channel:** <#${regChannel.id}>`,
                    `**Slotlist Channel:** <#${slotChannel.id}>`,
                    `**IDP Role:** <@&${idpRole.id}>`,
                    `**Total Slots:** \`${totalSlots}\` | **Required Mentions:** \`${mentions}\``,
                    `**Daily Auto-Open (IST):** \`${openTime || 'Manual (/scrim start)'}\``,
                    `**Auto-Clean Channel:** \`${autoClean ? 'Yes' : 'No'}\``,
                  ].join('\n')
                ),
            ],
          });
        }

        if (sub === 'start') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const scrim = db.scrims[regChannel.id];
          if (!scrim) {
            return interaction.reply({ content: '❌ No scrim configured for that channel.', ephemeral: true });
          }
          await interaction.deferReply({ ephemeral: true });
          await openScrimRegistration(interaction.guild, scrim);
          return interaction.editReply(`✅ Opened registration for **${scrim.name}** in <#${regChannel.id}>.`);
        }

        if (sub === 'close') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const scrim = db.scrims[regChannel.id];
          if (!scrim) {
            return interaction.reply({ content: '❌ No scrim configured for that channel.', ephemeral: true });
          }
          await interaction.deferReply({ ephemeral: true });
          await closeScrimRegistration(interaction.guild, scrim, 'Closed manually by staff.');
          return interaction.editReply(`✅ Closed **${scrim.name}** and posted slotlist in <#${scrim.slotChannelId}>.`);
        }

        if (sub === 'reserve') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const slotNum = interaction.options.getInteger('slot_number', true);
          const teamName = interaction.options.getString('team_name', true);
          const leader = interaction.options.getUser('leader', true);

          const scrim = db.scrims[regChannel.id];
          if (!scrim) {
            return interaction.reply({ content: '❌ No scrim configured for that channel.', ephemeral: true });
          }
          if (slotNum > scrim.totalSlots) {
            return interaction.reply({ content: `❌ Slot number exceeds total slots (${scrim.totalSlots}).`, ephemeral: true });
          }

          scrim.slots = scrim.slots.filter((s) => s.slot !== slotNum);
          scrim.slots.push({
            slot: slotNum,
            teamName,
            leaderId: leader.id,
            players: [leader.id],
            reserved: true,
          });
          scrim.slots.sort((a, b) => a.slot - b.slot);
          saveDB();

          const member = await interaction.guild.members.fetch(leader.id).catch(() => null);
          if (member) await member.roles.add(scrim.idpRoleId).catch(() => null);

          return interaction.reply({
            content: `✅ Reserved **Slot ${slotNum}** for **${teamName}** (<@${leader.id}>) in **${scrim.name}**.`,
          });
        }

        if (sub === 'ban') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const target = interaction.options.getUser('user', true);
          const scrim = db.scrims[regChannel.id];
          if (!scrim) {
            return interaction.reply({ content: '❌ No scrim configured for that channel.', ephemeral: true });
          }
          const idx = scrim.bannedUsers.indexOf(target.id);
          if (idx === -1) {
            scrim.bannedUsers.push(target.id);
            saveDB();
            return interaction.reply(`🚫 Banned <@${target.id}> from registering in **${scrim.name}**.`);
          } else {
            scrim.bannedUsers.splice(idx, 1);
            saveDB();
            return interaction.reply(`✅ Unbanned <@${target.id}> in **${scrim.name}**.`);
          }
        }

        if (sub === 'list') {
          const guildScrims = Object.values(db.scrims).filter((s) => s.guildId === interaction.guildId);
          if (guildScrims.length === 0) {
            return interaction.reply({ content: 'No scrims configured in this server.', ephemeral: true });
          }
          const lines = guildScrims.map(
            (s) =>
              `• **${s.name}** — Reg: <#${s.regChannelId}> | Slots: \`${s.slots.length}/${s.totalSlots}\` | Open: \`${s.openTime || 'Manual'}\` | Status: ${s.isOpen ? '🟢 Open' : '🔴 Closed'}`
          );
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(BRAND_COLOR)
                .setTitle('Configured Scrims')
                .setDescription(lines.join('\n')),
            ],
          });
        }

        if (sub === 'delete') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          if (!db.scrims[regChannel.id]) {
            return interaction.reply({ content: '❌ No scrim found for that channel.', ephemeral: true });
          }
          const removedName = db.scrims[regChannel.id].name;
          delete db.scrims[regChannel.id];
          saveDB();
          return interaction.reply(`🗑️ Deleted scrim **${removedName}**.`);
        }
      }

      // 2. /slotm (Slot Manager — Cancel / Claim / Transfer)
      if (commandName === 'slotm') {
        const regChannel = interaction.options.getChannel('reg_channel', true);
        const scrim = db.scrims[regChannel.id];
        if (!scrim) {
          return interaction.reply({ content: '❌ No scrim configured for that registration channel.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle(`⚙️ ${scrim.name} — Slot Manager`)
          .setDescription(
            [
              'Use the buttons below to manage your squad slot in real time:',
              '• **Cancel Slot:** Free up your slot if your team cannot play.',
              '• **Claim Slot:** Claim any open/cancelled slot if your squad missed registration.',
              '• **Transfer Slot:** Hand over your slot & IDP role to another captain.',
            ].join('\n')
          )
          .setFooter({ text: `Linked to #${regChannel.name}` });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`slotm_cancel_${scrim.regChannelId}`)
            .setLabel('Cancel My Slot')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`slotm_claim_${scrim.regChannelId}`)
            .setLabel('Claim Open Slot')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`slotm_transfer_${scrim.regChannelId}`)
            .setLabel('Transfer Slot')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: '✅ Slot Manager panel deployed.', ephemeral: true });
      }

      // 3. /tourney
      if (commandName === 'tourney') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'create') {
          const name = interaction.options.getString('name', true);
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const confirmChannel = interaction.options.getChannel('confirm_channel', true);
          const role = interaction.options.getRole('role', true);
          const totalSlots = interaction.options.getInteger('total_slots', true);
          const mentions = interaction.options.getInteger('mentions', true);

          db.tourneys[regChannel.id] = {
            guildId: interaction.guildId,
            name,
            regChannelId: regChannel.id,
            confirmChannelId: confirmChannel.id,
            roleId: role.id,
            totalSlots,
            requiredMentions: mentions,
            isOpen: false,
            teams: [],
          };
          saveDB();

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(SUCCESS_COLOR)
                .setTitle(`🏆 Tournament Created — ${name}`)
                .setDescription(
                  [
                    `**Registration Channel:** <#${regChannel.id}>`,
                    `**Confirm Channel:** <#${confirmChannel.id}>`,
                    `**Captain Role:** <@&${role.id}>`,
                    `**Total Slots:** \`${totalSlots}\` | **Required Mentions:** \`${mentions}\``,
                    'Run `/tourney start` when ready to open registrations.',
                  ].join('\n')
                ),
            ],
          });
        }

        if (sub === 'start') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const tourney = db.tourneys[regChannel.id];
          if (!tourney) {
            return interaction.reply({ content: '❌ No tournament configured for that channel.', ephemeral: true });
          }
          tourney.isOpen = true;
          saveDB();
          await setChannelSendLock(interaction.guild, tourney.regChannelId, true);

          await regChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(SUCCESS_COLOR)
                .setTitle(`🏆 ${tourney.name} — Registration Open`)
                .setDescription(
                  `Slots: \`${tourney.teams.length}/${tourney.totalSlots}\`\nRequired Mentions: \`${tourney.requiredMentions}\` unique players.`
                ),
            ],
          });
          return interaction.reply({ content: `✅ Tournament **${tourney.name}** is now open.`, ephemeral: true });
        }

        if (sub === 'pause') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const tourney = db.tourneys[regChannel.id];
          if (!tourney) {
            return interaction.reply({ content: '❌ No tournament configured for that channel.', ephemeral: true });
          }
          tourney.isOpen = false;
          saveDB();
          await setChannelSendLock(interaction.guild, tourney.regChannelId, false);
          return interaction.reply(`⏸️ Paused/closed registrations for **${tourney.name}**.`);
        }

        if (sub === 'groups') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const groupSize = interaction.options.getInteger('group_size', true);
          const shuffle = interaction.options.getBoolean('shuffle') ?? false;
          const tourney = db.tourneys[regChannel.id];
          if (!tourney || tourney.teams.length === 0) {
            return interaction.reply({ content: '❌ No registered teams found for that tournament.', ephemeral: true });
          }

          await interaction.deferReply();
          const list = [...tourney.teams];
          if (shuffle) {
            for (let i = list.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [list[i], list[j]] = [list[j], list[i]];
            }
          }

          const embeds = [];
          const totalGroups = Math.ceil(list.length / groupSize);
          for (let g = 0; g < totalGroups; g++) {
            const groupLetter = String.fromCharCode(65 + g);
            const slice = list.slice(g * groupSize, (g + 1) * groupSize);
            const lines = slice.map(
              (t, idx) => `\`Slot ${String(idx + 1).padStart(2, '0')}\` **${t.teamName}** (<@${t.leaderId}>)`
            );
            embeds.push(
              new EmbedBuilder()
                .setColor(BRAND_COLOR)
                .setTitle(`${tourney.name} — Group ${groupLetter}`)
                .setDescription(lines.join('\n'))
            );
          }

          for (let i = 0; i < embeds.length; i += 10) {
            await interaction.followUp({ embeds: embeds.slice(i, i + 10) });
          }
          return;
        }

        if (sub === 'export') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const tourney = db.tourneys[regChannel.id];
          if (!tourney || tourney.teams.length === 0) {
            return interaction.reply({ content: '❌ No registered teams found.', ephemeral: true });
          }

          const csvRows = ['Slot,Team Name,Captain ID,Mentioned Player IDs,Registered At'];
          for (const t of tourney.teams) {
            const safeName = `"${(t.teamName || '').replace(/"/g, '""')}"`;
            csvRows.push(`${t.slot},${safeName},${t.leaderId},"${t.players.join(' ')}",${t.timestamp}`);
          }
          const buffer = Buffer.from(csvRows.join('\n'), 'utf8');
          const attachment = new AttachmentBuilder(buffer, {
            name: `${tourney.name.toLowerCase().replace(/\s+/g, '_')}_teams.csv`,
          });

          return interaction.reply({
            content: `📊 Exported **${tourney.teams.length}** teams for **${tourney.name}**.`,
            files: [attachment],
          });
        }

        if (sub === 'remove_slot') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          const slotNum = interaction.options.getInteger('slot_number', true);
          const tourney = db.tourneys[regChannel.id];
          if (!tourney) {
            return interaction.reply({ content: '❌ No tournament found.', ephemeral: true });
          }
          const target = tourney.teams.find((t) => t.slot === slotNum);
          if (!target) {
            return interaction.reply({ content: `❌ Slot ${slotNum} was not found.`, ephemeral: true });
          }
          tourney.teams = tourney.teams.filter((t) => t.slot !== slotNum);
          saveDB();
          return interaction.reply(`🗑️ Removed **Slot ${slotNum}** (**${target.teamName}**) from **${tourney.name}**.`);
        }

        if (sub === 'delete') {
          const regChannel = interaction.options.getChannel('reg_channel', true);
          if (!db.tourneys[regChannel.id]) {
            return interaction.reply({ content: '❌ No tournament found for that channel.', ephemeral: true });
          }
          const removedName = db.tourneys[regChannel.id].name;
          delete db.tourneys[regChannel.id];
          saveDB();
          return interaction.reply(`🗑️ Deleted tournament **${removedName}**.`);
        }
      }

      // 4. /tagcheck
      if (commandName === 'tagcheck') {
        const channel = interaction.options.getChannel('channel', true);
        const mentions = interaction.options.getInteger('mentions', true);
        if (mentions === 0) {
          delete db.tagcheck[channel.id];
          saveDB();
          return interaction.reply(`🗑️ Disabled Tag Check in <#${channel.id}>.`);
        }
        db.tagcheck[channel.id] = { mentions };
        saveDB();
        return interaction.reply(
          `✅ Enabled **Tag Check** in <#${channel.id}> requiring \`${mentions}\` unique player mentions.`
        );
      }

      // 5. /eztag
      if (commandName === 'eztag') {
        const channel = interaction.options.getChannel('channel', true);
        const enabled = interaction.options.getBoolean('enabled', true);
        if (!enabled) {
          delete db.eztag[channel.id];
          saveDB();
          return interaction.reply(`🗑️ Disabled EasyTag in <#${channel.id}>.`);
        }
        db.eztag[channel.id] = { enabled: true };
        saveDB();
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(BRAND_COLOR)
              .setTitle('🏷️ EasyTag Helper')
              .setDescription(
                'Send your Team Name on line 1 and tag your teammates below it. ELYTRAx V1 will generate a clean copy-pasteable registration block for you.'
              ),
          ],
        });
        return interaction.reply({ content: `✅ Enabled **EasyTag** in <#${channel.id}>.`, ephemeral: true });
      }

      // 6. /ssverify
      if (commandName === 'ssverify') {
        const channel = interaction.options.getChannel('channel', true);
        const role = interaction.options.getRole('verified_role', true);
        const count = interaction.options.getInteger('required_screenshots', true);
        const instructions =
          interaction.options.getString('instructions') ||
          'Upload your subscription/follow screenshots below to unlock your Verified Role.';

        if (count === 0) {
          delete db.ssverify[channel.id];
          saveDB();
          return interaction.reply(`🗑️ Disabled SS-Verify in <#${channel.id}>.`);
        }

        db.ssverify[channel.id] = {
          roleId: role.id,
          requiredCount: count,
          submissions: {},
        };
        saveDB();

        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(BRAND_COLOR)
              .setTitle('📸 Screenshot Verification')
              .setDescription(
                [
                  instructions,
                  '',
                  `• **Required Screenshots:** \`${count}\` image(s)`,
                  `• **Role Granted:** <@&${role.id}>`,
                ].join('\n')
              )
              .setFooter({ text: 'ELYTRAx V1 SS-Verify' }),
          ],
        });
        return interaction.reply({ content: `✅ Configured **SS-Verify** in <#${channel.id}>.`, ephemeral: true });
      }

      // 7. /idp
      if (commandName === 'idp') {
        const roomId = interaction.options.getString('room_id', true);
        const password = interaction.options.getString('password', true);
        const map = interaction.options.getString('map', true);
        const startTime = interaction.options.getString('start_time', true);
        const pingRole = interaction.options.getRole('ping_role');
        const autoDeleteMins = interaction.options.getInteger('autodelete_mins');

        const embed = new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle('🔑 Official Match Room Credentials (IDP)')
          .addFields(
            { name: 'Room ID', value: `\`\`\`${roomId}\`\`\``, inline: true },
            { name: 'Password', value: `\`\`\`${password}\`\`\``, inline: true },
            { name: 'Map', value: `\`${map}\``, inline: true },
            { name: 'Start Time', value: `\`${startTime}\``, inline: true }
          )
          .setFooter({
            text: autoDeleteMins
              ? `ELYTRAx V1 • Auto-deletes in ${autoDeleteMins} min(s) • Join your exact assigned slot!`
              : 'ELYTRAx V1 • Join your exact assigned slot!',
          })
          .setTimestamp();

        const sent = await interaction.channel.send({
          content: pingRole ? `<@&${pingRole.id}>` : null,
          embeds: [embed],
        });

        if (autoDeleteMins) {
          setTimeout(() => {
            sent.delete().catch(() => null);
          }, autoDeleteMins * 60 * 1000);
        }

        return interaction.reply({ content: '✅ Room IDP posted.', ephemeral: true });
      }
    }

    // ------------------------------------------------------------------------
    // B. SLOT MANAGER BUTTONS & MODALS
    // ------------------------------------------------------------------------
    if (interaction.isButton()) {
      const { customId } = interaction;

      // Cancel Slot Button
      if (customId.startsWith('slotm_cancel_')) {
        const regChannelId = customId.replace('slotm_cancel_', '');
        const scrim = db.scrims[regChannelId];
        if (!scrim) {
          return interaction.reply({ content: '❌ Scrim no longer exists.', ephemeral: true });
        }

        const entryIdx = scrim.slots.findIndex((s) => s.leaderId === interaction.user.id);
        if (entryIdx === -1) {
          return interaction.reply({ content: '❌ You do not hold an active slot in this scrim.', ephemeral: true });
        }

        const removed = scrim.slots.splice(entryIdx, 1)[0];
        saveDB();

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (member) await member.roles.remove(scrim.idpRoleId).catch(() => null);

        await syncScrimSlotlistMessage(interaction.guild, scrim);
        return interaction.reply({
          content: `⚠️ **Slot ${removed.slot}** (**${removed.teamName}**) has been cancelled and is now open for claiming!`,
        });
      }

      // Claim Open Slot Button -> Opens Modal
      if (customId.startsWith('slotm_claim_')) {
        const regChannelId = customId.replace('slotm_claim_', '');
        const scrim = db.scrims[regChannelId];
        if (!scrim) {
          return interaction.reply({ content: '❌ Scrim no longer exists.', ephemeral: true });
        }
        if (scrim.slots.some((s) => s.leaderId === interaction.user.id)) {
          return interaction.reply({ content: '❌ You already hold a slot in this scrim.', ephemeral: true });
        }
        if (scrim.slots.length >= scrim.totalSlots) {
          return interaction.reply({ content: '❌ All slots are currently full.', ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId(`modal_claim_${regChannelId}`)
          .setTitle(`Claim Slot — ${scrim.name.slice(0, 25)}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('team_name')
                .setLabel('Your Team Name')
                .setPlaceholder('e.g. Team Elytra')
                .setRequired(true)
                .setMaxLength(40)
                .setStyle(TextInputStyle.Short)
            )
          );
        return interaction.showModal(modal);
      }

      // Transfer Slot Button -> Opens Modal
      if (customId.startsWith('slotm_transfer_')) {
        const regChannelId = customId.replace('slotm_transfer_', '');
        const scrim = db.scrims[regChannelId];
        if (!scrim) {
          return interaction.reply({ content: '❌ Scrim no longer exists.', ephemeral: true });
        }
        if (!scrim.slots.some((s) => s.leaderId === interaction.user.id)) {
          return interaction.reply({ content: '❌ You do not hold an active slot to transfer.', ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId(`modal_transfer_${regChannelId}`)
          .setTitle('Transfer Your Scrim Slot')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('new_leader_id')
                .setLabel('New Captain Discord User ID')
                .setPlaceholder('e.g. 987654321012345678')
                .setRequired(true)
                .setStyle(TextInputStyle.Short)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('new_team_name')
                .setLabel('New Team Name')
                .setPlaceholder('e.g. Apex Esports')
                .setRequired(true)
                .setMaxLength(40)
                .setStyle(TextInputStyle.Short)
            )
          );
        return interaction.showModal(modal);
      }
    }

    // Modal Submissions for Claim / Transfer
    if (interaction.isModalSubmit()) {
      const { customId } = interaction;

      if (customId.startsWith('modal_claim_')) {
        const regChannelId = customId.replace('modal_claim_', '');
        const scrim = db.scrims[regChannelId];
        if (!scrim) {
          return interaction.reply({ content: '❌ Scrim not found.', ephemeral: true });
        }
        if (scrim.slots.some((s) => s.leaderId === interaction.user.id)) {
          return interaction.reply({ content: '❌ You already have a slot.', ephemeral: true });
        }

        let freeSlotNumber = null;
        for (let i = 1; i <= scrim.totalSlots; i++) {
          if (!scrim.slots.some((s) => s.slot === i)) {
            freeSlotNumber = i;
            break;
          }
        }
        if (!freeSlotNumber) {
          return interaction.reply({ content: '❌ No open slots remaining.', ephemeral: true });
        }

        const teamName = interaction.fields.getTextInputValue('team_name').trim();
        scrim.slots.push({
          slot: freeSlotNumber,
          teamName,
          leaderId: interaction.user.id,
          players: [interaction.user.id],
          reserved: false,
        });
        scrim.slots.sort((a, b) => a.slot - b.slot);
        saveDB();

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (member) await member.roles.add(scrim.idpRoleId).catch(() => null);

        await syncScrimSlotlistMessage(interaction.guild, scrim);
        return interaction.reply({
          content: `✅ <@${interaction.user.id}> claimed **Slot ${freeSlotNumber}** for **${teamName}**!`,
        });
      }

      if (customId.startsWith('modal_transfer_')) {
        const regChannelId = customId.replace('modal_transfer_', '');
        const scrim = db.scrims[regChannelId];
        if (!scrim) {
          return interaction.reply({ content: '❌ Scrim not found.', ephemeral: true });
        }

        const slotObj = scrim.slots.find((s) => s.leaderId === interaction.user.id);
        if (!slotObj) {
          return interaction.reply({ content: '❌ You no longer hold a slot.', ephemeral: true });
        }

        const newLeaderId = interaction.fields.getTextInputValue('new_leader_id').replace(/\D/g, '');
        const newTeamName = interaction.fields.getTextInputValue('new_team_name').trim();

        const newMember = await interaction.guild.members.fetch(newLeaderId).catch(() => null);
        if (!newMember) {
          return interaction.reply({ content: '❌ Could not find that User ID in this server.', ephemeral: true });
        }

        const oldMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (oldMember) await oldMember.roles.remove(scrim.idpRoleId).catch(() => null);
        await newMember.roles.add(scrim.idpRoleId).catch(() => null);

        slotObj.leaderId = newLeaderId;
        slotObj.teamName = newTeamName;
        saveDB();

        await syncScrimSlotlistMessage(interaction.guild, scrim);
        return interaction.reply({
          content: `🔄 **Slot ${slotObj.slot}** transferred from <@${interaction.user.id}> to <@${newLeaderId}> (**${newTeamName}**).`,
        });
      }
    }
  } catch (err) {
    console.error('[Interaction Error]:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Error: ${err.message}`, ephemeral: true }).catch(() => null);
    }
  }
});

// ============================================================================
// 6. MESSAGE PIPELINE (SCRIMS, TOURNEYS, TAGCHECK, EZTAG, SSVERIFY)
// ============================================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const channelId = message.channel.id;

  // --------------------------------------------------------------------------
  // A. SCRIM REGISTRATION HANDLER
  // --------------------------------------------------------------------------
  const scrim = db.scrims[channelId];
  if (scrim && scrim.isOpen) {
    if (scrim.bannedUsers.includes(message.author.id)) {
      await message.delete().catch(() => null);
      const warn = await message.channel.send(`🚫 <@${message.author.id}>, you are banned from registering in this scrim.`);
      setTimeout(() => warn.delete().catch(() => null), 6000);
      return;
    }

    const mentions = extractUniqueUserMentions(message);
    if (mentions.length < scrim.requiredMentions) {
      await message.delete().catch(() => null);
      const warn = await message.channel.send(
        `❌ <@${message.author.id}>, you must mention at least **${scrim.requiredMentions}** unique players.`
      );
      setTimeout(() => warn.delete().catch(() => null), 6000);
      return;
    }

    // Check duplicate leader or duplicate tagged players
    const allRegisteredPlayers = new Set();
    for (const s of scrim.slots) {
      allRegisteredPlayers.add(s.leaderId);
      for (const p of s.players || []) allRegisteredPlayers.add(p);
    }

    if (allRegisteredPlayers.has(message.author.id) || mentions.some((id) => allRegisteredPlayers.has(id))) {
      await message.delete().catch(() => null);
      const warn = await message.channel.send(
        `❌ <@${message.author.id}>, you or one of your tagged teammates is already registered in **${scrim.name}**.`
      );
      setTimeout(() => warn.delete().catch(() => null), 6000);
      return;
    }

    // Find lowest open slot number
    let assignedSlot = null;
    for (let i = 1; i <= scrim.totalSlots; i++) {
      if (!scrim.slots.some((s) => s.slot === i)) {
        assignedSlot = i;
        break;
      }
    }

    if (!assignedSlot) {
      await closeScrimRegistration(message.guild, scrim, 'All slots have been filled.');
      return;
    }

    const teamName = extractTeamName(message.content);
    scrim.slots.push({
      slot: assignedSlot,
      teamName,
      leaderId: message.author.id,
      players: mentions,
      reserved: false,
    });
    scrim.slots.sort((a, b) => a.slot - b.slot);
    saveDB();

    await message.react('✅').catch(() => null);
    if (message.member) {
      await message.member.roles.add(scrim.idpRoleId).catch(() => null);
    }

    if (scrim.slots.length >= scrim.totalSlots) {
      await closeScrimRegistration(message.guild, scrim, 'All slots filled!');
    }
    return;
  }

  // --------------------------------------------------------------------------
  // B. TOURNAMENT REGISTRATION HANDLER
  // --------------------------------------------------------------------------
  const tourney = db.tourneys[channelId];
  if (tourney && tourney.isOpen) {
    const mentions = extractUniqueUserMentions(message);
    if (mentions.length < tourney.requiredMentions) {
      await message.delete().catch(() => null);
      const warn = await message.channel.send(
        `❌ <@${message.author.id}>, tournament registration requires **${tourney.requiredMentions}** unique @mentions.`
      );
      setTimeout(() => warn.delete().catch(() => null), 6000);
      return;
    }

    const existingPlayers = new Set();
    for (const t of tourney.teams) {
      existingPlayers.add(t.leaderId);
      for (const p of t.players || []) existingPlayers.add(p);
    }

    if (existingPlayers.has(message.author.id) || mentions.some((id) => existingPlayers.has(id))) {
      await message.delete().catch(() => null);
      const warn = await message.channel.send(
        `❌ <@${message.author.id}>, duplicate registration or fake/reused player tags detected.`
      );
      setTimeout(() => warn.delete().catch(() => null), 6000);
      return;
    }

    const slotNumber = tourney.teams.length + 1;
    const teamName = extractTeamName(message.content);

    tourney.teams.push({
      slot: slotNumber,
      teamName,
      leaderId: message.author.id,
      players: mentions,
      timestamp: new Date().toISOString(),
    });
    saveDB();

    await message.react('✅').catch(() => null);
    if (message.member) {
      await message.member.roles.add(tourney.roleId).catch(() => null);
    }

    const confirmChannel = await message.guild.channels.fetch(tourney.confirmChannelId).catch(() => null);
    if (confirmChannel) {
      await confirmChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setTitle(`Slot #${slotNumber} Confirmed — ${teamName}`)
            .setDescription(`**Captain:** <@${message.author.id}>\n**Roster:** ${mentions.map((id) => `<@${id}>`).join(' ')}`)
            .setFooter({ text: `${tourney.name} (${tourney.teams.length}/${tourney.totalSlots})` }),
        ],
      });
    }

    if (tourney.teams.length >= tourney.totalSlots) {
      tourney.isOpen = false;
      saveDB();
      await setChannelSendLock(message.guild, tourney.regChannelId, false);
      await message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(BRAND_COLOR)
            .setTitle(`🔴 ${tourney.name} — Registrations Full (${tourney.totalSlots}/${tourney.totalSlots})`),
        ],
      });
    }
    return;
  }

  // --------------------------------------------------------------------------
  // C. TAG CHECK HANDLER
  // --------------------------------------------------------------------------
  const tagCheckCfg = db.tagcheck[channelId];
  if (tagCheckCfg) {
    const mentions = extractUniqueUserMentions(message);
    const teamName = extractTeamName(message.content);
    const passed = mentions.length >= tagCheckCfg.mentions;

    const embed = new EmbedBuilder()
      .setColor(passed ? SUCCESS_COLOR : WARN_COLOR)
      .setTitle(passed ? '✅ Tag Check Passed' : '❌ Tag Check Failed')
      .addFields(
        { name: 'Detected Team Name', value: `\`${teamName}\``, inline: true },
        {
          name: 'Unique Mentions',
          value: `\`${mentions.length} / ${tagCheckCfg.mentions}\``,
          inline: true,
        }
      )
      .setFooter({ text: 'Auto-deleting in 10 seconds' });

    const reply = await message.reply({ embeds: [embed] }).catch(() => null);
    setTimeout(() => {
      message.delete().catch(() => null);
      if (reply) reply.delete().catch(() => null);
    }, 10000);
    return;
  }

  // --------------------------------------------------------------------------
  // D. EASYTAG HANDLER
  // --------------------------------------------------------------------------
  const ezTagCfg = db.eztag[channelId];
  if (ezTagCfg && ezTagCfg.enabled) {
    const mentions = extractUniqueUserMentions(message);
    const teamName = extractTeamName(message.content);
    const formattedMentions = mentions.length > 0 ? mentions.map((id) => `<@${id}>`).join(' ') : `<@${message.author.id}>`;

    const copyBlock = `Team Name: ${teamName}\nPlayers: ${formattedMentions}`;
    const reply = await message.channel.send({
      content: `<@${message.author.id}> Copy your formatted registration below:`,
      embeds: [
        new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setDescription(`\`\`\`\n${copyBlock}\n\`\`\``)
          .setFooter({ text: 'Auto-deleting in 20 seconds' }),
      ],
    });
    setTimeout(() => {
      message.delete().catch(() => null);
      reply.delete().catch(() => null);
    }, 20000);
    return;
  }

  // --------------------------------------------------------------------------
  // E. SCREENSHOT VERIFICATION (SSVERIFY) HANDLER
  // --------------------------------------------------------------------------
  const ssCfg = db.ssverify[channelId];
  if (ssCfg) {
    const validImages = message.attachments.filter((att) =>
      Boolean(att.contentType && att.contentType.startsWith('image/'))
    );

    if (validImages.size === 0) {
      await message.delete().catch(() => null);
      const warn = await message.channel.send(
        `❌ <@${message.author.id}>, please upload valid screenshot image(s) only.`
      );
      setTimeout(() => warn.delete().catch(() => null), 5000);
      return;
    }

    const prevCount = ssCfg.submissions[message.author.id] || 0;
    const newCount = prevCount + validImages.size;
    ssCfg.submissions[message.author.id] = newCount;
    saveDB();

    if (newCount >= ssCfg.requiredCount) {
      await message.react('✅').catch(() => null);
      if (message.member) {
        await message.member.roles.add(ssCfg.roleId).catch(() => null);
      }
      const doneMsg = await message.reply(
        `✅ Verified! <@${message.author.id}> has uploaded \`${newCount}/${ssCfg.requiredCount}\` screenshots and unlocked <@&${ssCfg.roleId}>.`
      );
      setTimeout(() => doneMsg.delete().catch(() => null), 10000);
    } else {
      await message.react('⏳').catch(() => null);
      const waitMsg = await message.reply(
        `📸 Received \`${newCount}/${ssCfg.requiredCount}\` screenshots. Upload \`${ssCfg.requiredCount - newCount}\` more to unlock <@&${ssCfg.roleId}>.`
      );
      setTimeout(() => waitMsg.delete().catch(() => null), 8000);
    }
  }
});

// ============================================================================
// 7. LOGIN
// ============================================================================
if (!process.env.DISCORD_TOKEN) {
  console.error('[ELYTRAx V1] Missing DISCORD_TOKEN in .env file.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);