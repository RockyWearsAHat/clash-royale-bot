import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { dbDeleteJobState, dbGetJobState, dbSetJobState } from '../db.js';

const TAG_RE = /#?[0289PYLQGRJCUV]{5,}/i;
type DisplayPreference = 'discord' | 'discord_with_clash' | 'clash' | 'custom';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const marker = Symbol('timeout');
  const result = await Promise.race([promise as Promise<any>, sleep(ms).then(() => marker)]);
  if (result === marker) return { ok: false };
  return { ok: true, value: result as T };
}

function uiHash(payload: unknown): string {
  // Deterministic enough for our UI: JSON stringify of embed/components JSON.
  // The goal is just “did the UI change?” not cryptographic security.
  return JSON.stringify(payload);
}

async function deleteMessageIfExists(thread: ThreadChannel, messageId?: string | null) {
  const id = String(messageId ?? '').trim();
  if (!id) return;
  // Delete directly (faster than fetch+delete) and ignore failures.
  await thread.messages.delete(id).catch(() => undefined);
}

function normalizeTag(raw: string): string {
  const m = raw.toUpperCase().match(TAG_RE);
  if (!m) throw new Error('Please provide a valid Clash Royale player tag (looks like #ABC123).');
  const tag = m[0].startsWith('#') ? m[0] : `#${m[0]}`;
  return tag;
}

function truncateNickname(nick: string): string {
  return nick.length <= 32 ? nick : nick.slice(0, 32);
}

type LinkRow = {
  player_tag: string;
  player_name?: string;
  custom_display_name?: string;
  display_preference: DisplayPreference;
};

function getLinkRow(ctx: AppContext, userId: string): LinkRow | undefined {
  return ctx.db
    .prepare(
      'SELECT player_tag, player_name, custom_display_name, display_preference FROM user_links WHERE discord_user_id = ?',
    )
    .get(userId) as LinkRow | undefined;
}

function prefButtonStyle(selected: DisplayPreference, current: DisplayPreference) {
  return selected === current ? ButtonStyle.Primary : ButtonStyle.Secondary;
}

function truncateButtonLabel(label: string): string {
  const s = String(label ?? '').trim();
  if (s.length <= 80) return s;
  return `${s.slice(0, 79)}…`;
}

function makePreferenceButtons(
  userId: string,
  selected: DisplayPreference,
  labels: { discord: string; discordWithClash: string; clash: string; custom?: string },
) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`linkpref:${userId}:discord`)
      .setStyle(prefButtonStyle(selected, 'discord'))
      .setLabel(truncateButtonLabel(labels.discord)),
    new ButtonBuilder()
      .setCustomId(`linkpref:${userId}:discord_with_clash`)
      .setStyle(prefButtonStyle(selected, 'discord_with_clash'))
      .setLabel(truncateButtonLabel(labels.discordWithClash)),
    new ButtonBuilder()
      .setCustomId(`linkpref:${userId}:clash`)
      .setStyle(prefButtonStyle(selected, 'clash'))
      .setLabel(truncateButtonLabel(labels.clash)),
  );

  // Only show the custom-name option while it is selected.
  // If the user clicks away, it collapses back to a single "Other" button.
  if (selected === 'custom' && labels.custom) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`linkpref:${userId}:custom`)
        .setStyle(prefButtonStyle(selected, 'custom'))
        .setLabel(truncateButtonLabel(labels.custom)),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`linkpref:${userId}:other`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Other'),
  );

  return row;
}

function makeProfileButtons(userId: string) {
  // Thread should be static; open the dynamic UI in an ephemeral menu.
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:open`)
      .setStyle(ButtonStyle.Primary)
      .setLabel('Open Menu'),
  );
}

function makeDangerZoneButton(userId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:unlink`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Unlink Clash account'),
  );
}

function makeUnlinkConfirmButtons(userId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:unlink_confirm`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Yes, unlink'),
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:unlink_cancel`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('No'),
  );
}

function makeMenuFooterButtons(userId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:refresh`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Refresh'),
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:close`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Close'),
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:unlink`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Unlink'),
  );
}

async function buildEphemeralMenu(ctx: AppContext, guild: any, userId: string) {
  const row = getLinkRow(ctx, userId);
  if (!row) {
    const embed = new EmbedBuilder()
      .setTitle('Profile')
      .setDescription('Not linked. Paste your player tag in your thread.');
    return { embeds: [embed], components: [] as any[] };
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  const discordName = member ? getPreferredBaseName(member) : 'Discord';

  // Live data from Clash API (name, clan membership, role).
  const player = await ctx.clash.getPlayer(row.player_tag).catch(() => null);
  const liveName = player?.name ?? row.player_name ?? 'Unknown';
  const liveTag = player?.tag ?? row.player_tag;
  const inClan =
    (player?.clan?.tag ? String(player.clan.tag).toUpperCase() : '') ===
    ctx.cfg.CLASH_CLAN_TAG.toUpperCase();

  const embed = new EmbedBuilder().setTitle('Profile');
  embed.addFields({ name: 'Player', value: `${liveName} (${liveTag})`, inline: false });
  embed.addFields({
    name: 'Clan',
    value: inClan
      ? `${player?.clan?.name ?? 'In clan'}${player?.clan?.role ? ` (${player.clan.role})` : ''}`
      : 'Not in clan',
    inline: false,
  });

  const preferenceRow = makePreferenceButtons(userId, row.display_preference, {
    discord: discordName,
    discordWithClash: `${discordName} (${liveName})`,
    clash: liveName,
    custom: row.custom_display_name || undefined,
  });

  return {
    embeds: [embed],
    components: [preferenceRow, makeMenuFooterButtons(userId)],
  };
}

async function cleanupThreadMessages(thread: ThreadChannel, keepMessageId?: string) {
  // Best-effort: keep the thread clean like a form/state machine.
  // Discord APIs limit fetch sizes; we only clean the most recent 100 messages.
  const msgs = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!msgs) return;

  // Delete newest first to reduce chance we delete the control message if not found.
  const deletions: Promise<any>[] = [];
  for (const m of msgs.values()) {
    if (keepMessageId && m.id === keepMessageId) continue;
    deletions.push(m.delete().catch(() => undefined));
    if (deletions.length >= 25) break; // avoid rate limit spikes
  }
  await Promise.all(deletions);
}

async function cleanupThreadMessagesKeep(thread: ThreadChannel, keepMessageIds: string[]) {
  const keep = new Set(keepMessageIds.filter(Boolean));
  const msgs = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!msgs) return;

  const deletions: Promise<any>[] = [];
  for (const m of msgs.values()) {
    if (keep.has(m.id)) continue;
    deletions.push(m.delete().catch(() => undefined));
    if (deletions.length >= 25) break;
  }
  await Promise.all(deletions);
}

async function closeOtherThreadsForUser(
  ctx: AppContext,
  client: any,
  textChannel: TextChannel,
  userId: string,
  username: string,
  keepThreadId: string,
) {
  const active = await textChannel.threads.fetchActive().catch(() => null);
  const activeThreads = active?.threads?.values ? Array.from(active.threads.values()) : [];

  // Also try archived threads (best-effort); older duplicates might be archived but still visible.
  const archivedThreads: ThreadChannel[] = [];
  try {
    const archPriv = await textChannel.threads.fetchArchived({ type: 'private', limit: 100 });
    archivedThreads.push(...Array.from(archPriv.threads.values()));
  } catch {
    // ignore
  }
  try {
    const archPub = await textChannel.threads.fetchArchived({ type: 'public', limit: 100 });
    archivedThreads.push(...Array.from(archPub.threads.values()));
  } catch {
    // ignore
  }

  const threads = [...activeThreads, ...archivedThreads];

  const uname = username.toLowerCase();
  const legacyNameMatchesUser = (name: string) => {
    const n = name.toLowerCase();
    // Common old formats we used earlier:
    // - link-<discord username>
    // - link-<something derived from username>
    return n.startsWith('link-') && n.includes(uname);
  };

  const isBotManagedThreadName = (name: string | null | undefined) => {
    const n = String(name ?? '').toLowerCase();
    return n.startsWith('link-') || n.startsWith('setup necessary') || n.startsWith('profile -');
  };

  for (const t of threads) {
    if (t.id === keepThreadId) continue;
    if (!isBotManagedThreadName(t.name)) continue;

    const isMember = await t.members
      .fetch(userId)
      .then(() => true)
      .catch(() => false);

    // For legacy public threads, the user might not show up in members.
    // Fall back to name matching for old formats.
    if (!isMember && !legacyNameMatchesUser(t.name ?? '')) continue;

    // Prefer deleting duplicates entirely. If Discord refuses, fall back to archive/lock.
    try {
      await t.delete('Deleting duplicate verification/profile thread');
    } catch {
      await t
        .setLocked(true, 'Closing duplicate verification/profile thread')
        .catch(() => undefined);
      await t
        .setArchived(true, 'Closing duplicate verification/profile thread')
        .catch(() => undefined);
    }
  }

  // Also clear any stale state pointing at something else.
  dbSetJobState(ctx.db, `verify:thread:${userId}`, keepThreadId);
}

async function renderOrUpdateProfileMessage(
  ctx: AppContext,
  thread: ThreadChannel,
  userId: string,
) {
  const row = getLinkRow(ctx, userId);

  // One static “page” message in the thread. All dynamic UI (buttons, selected state, live data)
  // is shown in an ephemeral menu (opened via the button below).
  const uiKey = `profile:uiMessage:${userId}`;
  const uiId = dbGetJobState(ctx.db, uiKey);

  // Clean up legacy UI messages from older versions.
  const legacyInfoKey = `profile:infoMessage:${userId}`;
  const legacyControlsKey = `profile:controlsMessage:${userId}`;
  const legacyInfoId = dbGetJobState(ctx.db, legacyInfoKey);
  const legacyControlsId = dbGetJobState(ctx.db, legacyControlsKey);
  if (legacyInfoId) {
    await deleteMessageIfExists(thread, legacyInfoId);
    dbDeleteJobState(ctx.db, legacyInfoKey);
    dbDeleteJobState(ctx.db, `profile:infoHash:${userId}`);
  }
  if (legacyControlsId) {
    await deleteMessageIfExists(thread, legacyControlsId);
    dbDeleteJobState(ctx.db, legacyControlsKey);
    dbDeleteJobState(ctx.db, `profile:controlsHash:${userId}`);
  }

  const embed = new EmbedBuilder().setTitle('Profile');
  if (!row) {
    embed.setDescription(
      'Step 1: Paste your Clash Royale player tag in this thread (example: `#ABC123`).',
    );
  } else {
    embed.setDescription(
      `Linked to ${row.player_tag}. Use **Open Menu** to view live status and change your display name.`,
    );
  }

  const components = row ? [makeProfileButtons(userId)] : [];

  // Only create if missing; avoid updating this message so it never shows “edited”.
  if (uiId) {
    const exists = await thread.messages.fetch(uiId).catch(() => null);
    if (exists) return;
  }

  // Delete any stale pointer and create a fresh UI message.
  if (uiId) {
    await deleteMessageIfExists(thread, uiId);
    dbDeleteJobState(ctx.db, uiKey);
  }

  const sent = await thread.send({ content: '', embeds: [embed], components }).catch(() => null);
  if (sent) dbSetJobState(ctx.db, uiKey, sent.id);
}

function getPreferredBaseName(member: any): string {
  // Prefer global display name if available; otherwise fallback to username.
  return String(member?.user?.globalName ?? member?.user?.username ?? 'Discord');
}

function computeNicknameForPreference(
  pref: DisplayPreference,
  member: any,
  clashName?: string,
  custom?: string,
) {
  const base = getPreferredBaseName(member);
  const cn = clashName ?? 'Clash';

  if (pref === 'discord') return null; // reset nickname to default
  if (pref === 'clash') return truncateNickname(cn);
  if (pref === 'discord_with_clash') return truncateNickname(`${base} (${cn})`);
  if (pref === 'custom') return truncateNickname(String(custom ?? '').trim());
  return null;
}

async function tryApplyNicknamePreference(
  ctx: AppContext,
  interaction: ButtonInteraction | ModalSubmitInteraction,
  userId: string,
  pref: DisplayPreference,
  opts?: { customDisplayName?: string },
): Promise<string | null> {
  try {
    const guild = await interaction.client.guilds.fetch(ctx.cfg.GUILD_ID);
    const me = await guild.members.fetchMe().catch(() => null);
    const member = await guild.members.fetch(userId);

    if (guild.ownerId === userId) {
      return 'Discord does not allow bots to change the server owner’s nickname.';
    }

    // Permission/hierarchy sanity checks (best-effort; still try in case caches are weird).
    if (!me?.permissions?.has?.('ManageNicknames')) {
      return 'Bot is missing `Manage Nicknames` permission.';
    }

    // This is the most common real-world cause of 50013 (Missing Permissions).
    // It means role hierarchy prevents the bot from managing this member.
    if (member.manageable === false) {
      const botRole = me?.roles?.highest?.name ? ` (${me.roles.highest.name})` : '';
      const userRole = member?.roles?.highest?.name ? ` (${member.roles.highest.name})` : '';
      return (
        'Bot cannot manage your member object due to role hierarchy. ' +
        `Move the bot’s role${botRole} above your highest role${userRole} in Server Settings → Roles.`
      );
    }

    if (me.roles?.highest && member.roles?.highest) {
      const cmp = me.roles.highest.comparePositionTo(member.roles.highest);
      if (cmp <= 0) {
        return 'Bot role must be above your highest role to change your nickname.';
      }
    }

    const row = ctx.db
      .prepare('SELECT player_name, custom_display_name FROM user_links WHERE discord_user_id = ?')
      .get(userId) as { player_name?: string; custom_display_name?: string } | undefined;

    const desiredNickname = computeNicknameForPreference(
      pref,
      member,
      row?.player_name,
      opts?.customDisplayName ?? row?.custom_display_name,
    );

    await member.setNickname(desiredNickname);
    await denyVerificationChannel(ctx, guild, userId);
    return null;
  } catch (e) {
    const anyErr = e as any;
    const msg = e instanceof Error ? e.message : String(e);
    const code = anyErr?.code ?? anyErr?.rawError?.code;
    const status = anyErr?.status;
    // Common Discord error for insufficient perms is 50013.
    const suffix = code || status ? ` (code: ${code ?? 'n/a'}, status: ${status ?? 'n/a'})` : '';
    return `Nickname update failed (${msg})${suffix}. This is usually role hierarchy or missing permissions.`;
  }
}

async function denyVerificationChannel(ctx: AppContext, guild: any, userId: string) {
  if (!ctx.cfg.HIDE_VERIFICATION_CHANNEL_AFTER_LINK) return;
  const chan = await guild.channels.fetch(ctx.cfg.CHANNEL_VERIFICATION_ID).catch(() => null);
  if (!chan || chan.type !== ChannelType.GuildText) return;
  await chan.permissionOverwrites
    .edit(userId, { ViewChannel: false, SendMessages: false })
    .catch(() => undefined);
}

async function getOrCreateVerificationThread(
  ctx: AppContext,
  client: any,
  userId: string,
): Promise<ThreadChannel> {
  const channel = await client.channels.fetch(ctx.cfg.CHANNEL_VERIFICATION_ID);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('Verification channel is missing or not a text channel.');
  }
  const textChannel = channel as TextChannel;

  const user = await client.users.fetch(userId).catch(() => null);
  const username = user?.username ?? 'Discord Username';
  const setupThreadName = `Setup Necessary - ${username}`.slice(0, 90);
  const existingLink = getLinkRow(ctx, userId);
  const desiredName = existingLink
    ? `Profile - ${existingLink.player_name ?? username}`.slice(0, 90)
    : setupThreadName;

  const stateKey = `verify:thread:${userId}`;
  const existingId = dbGetJobState(ctx.db, stateKey);
  if (existingId) {
    const existing = await textChannel.threads.fetch(existingId).catch(() => null);
    if (existing) {
      if (existing.archived) {
        await existing
          .setArchived(false, 'Re-opening verification/profile thread')
          .catch(() => undefined);
      }
      if (existing.locked) {
        await existing
          .setLocked(false, 'Re-opening verification/profile thread')
          .catch(() => undefined);
      }
      await closeOtherThreadsForUser(ctx, client, textChannel, userId, username, existing.id);

      // Keep the setup thread name consistent (even if it was created earlier with a different name).
      await existing.setName(desiredName).catch(() => undefined);

      // If the user left/was removed from the thread, re-add them so they can see it again.
      await existing.members.add(userId).catch(() => undefined);

      // Ensure control message exists and thread is clean (best-effort).
      await renderOrUpdateProfileMessage(ctx, existing, userId);
      const uiId = dbGetJobState(ctx.db, `profile:uiMessage:${userId}`) ?? '';
      await cleanupThreadMessagesKeep(existing, [uiId]);
      return existing;
    }
  }

  const thread = await textChannel.threads.create({
    name: desiredName,
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 10080,
    reason: 'Player link onboarding',
  });
  dbSetJobState(ctx.db, stateKey, thread.id);

  await closeOtherThreadsForUser(ctx, client, textChannel, userId, username, thread.id);

  await thread.members.add(userId).catch(() => undefined);
  await renderOrUpdateProfileMessage(ctx, thread, userId);
  const uiId = dbGetJobState(ctx.db, `profile:uiMessage:${userId}`) ?? '';
  await cleanupThreadMessagesKeep(thread, [uiId]);
  return thread;
}

export async function reconcileVerificationThreadForUser(
  ctx: AppContext,
  client: any,
  userId: string,
): Promise<void> {
  // Goal: if the user is linked and their profile thread was deleted/archived/left,
  // recreate/unarchive/re-add them. Avoid re-rendering/cleaning on every run.
  const linked = getLinkRow(ctx, userId);
  if (!linked) return;

  const channel = await client.channels.fetch(ctx.cfg.CHANNEL_VERIFICATION_ID).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const textChannel = channel as TextChannel;

  const stateKey = `verify:thread:${userId}`;
  const existingId = dbGetJobState(ctx.db, stateKey);
  if (existingId) {
    const existing = await textChannel.threads.fetch(existingId).catch(() => null);
    if (existing) {
      if (existing.archived) {
        await existing
          .setArchived(false, 'Re-opening verification/profile thread')
          .catch(() => undefined);
      }
      if (existing.locked) {
        await existing
          .setLocked(false, 'Re-opening verification/profile thread')
          .catch(() => undefined);
      }
      await existing
        .setName(`Profile - ${linked.player_name ?? 'Profile'}`.slice(0, 90))
        .catch(() => undefined);
      await existing.members.add(userId).catch(() => undefined);
      return;
    }
  }

  // Missing thread or missing pointer: create a new one and render the correct current DB state.
  await getOrCreateVerificationThread(ctx, client, userId);
}

export async function ensureVerificationThreadForUser(
  ctx: AppContext,
  client: any,
  userId: string,
): Promise<ThreadChannel> {
  return await getOrCreateVerificationThread(ctx, client, userId);
}

async function ensureThread(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<ThreadChannel> {
  return await getOrCreateVerificationThread(ctx, interaction.client, interaction.user.id);
}

export const JoinCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Start linking your Discord to your Clash Royale player tag via a thread.'),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    const thread = await ensureThread(ctx, interaction);
    await interaction.reply({
      content: `Created your verification thread: <#${thread.id}>`,
      ephemeral: true,
    });
  },
};

// If an unlinked user speaks in the verification channel, create their thread automatically.
export async function handleVerificationEntryMessage(ctx: AppContext, msg: any) {
  if (!msg.guild) return;
  if (!msg.channel || msg.channel.type !== ChannelType.GuildText) return;
  if (msg.channel.id !== ctx.cfg.CHANNEL_VERIFICATION_ID) return;
  if (msg.author?.bot) return;

  const linked = ctx.db
    .prepare('SELECT 1 FROM user_links WHERE discord_user_id = ?')
    .get(msg.author.id) as { 1: number } | undefined;
  if (linked) return;

  const thread = await getOrCreateVerificationThread(ctx, msg.client, msg.author.id);

  await msg.delete().catch(() => undefined);
  const hint = await msg.channel
    .send({ content: `<@${msg.author.id}> please use your thread: <#${thread.id}>` })
    .catch(() => null);
  if (hint) {
    setTimeout(() => {
      hint.delete().catch(() => undefined);
    }, 15_000);
  }
}

// Handle tag submission inside the created thread.
export async function handleVerificationThreadMessage(ctx: AppContext, msg: any) {
  if (!msg.guild) return;
  if (!msg.channel) return;
  if (![ChannelType.PublicThread, ChannelType.PrivateThread].includes(msg.channel.type)) return;
  const thread = msg.channel as ThreadChannel;
  if (thread.parentId !== ctx.cfg.CHANNEL_VERIFICATION_ID) return;
  if (msg.author?.bot) return;

  // If already linked, keep the thread clean; ignore additional chat.
  const alreadyLinked = getLinkRow(ctx, msg.author.id);
  if (alreadyLinked) {
    await msg.delete().catch(() => undefined);
    await renderOrUpdateProfileMessage(ctx, thread, msg.author.id);
    const uiId = dbGetJobState(ctx.db, `profile:uiMessage:${msg.author.id}`) ?? '';
    await cleanupThreadMessagesKeep(thread, [uiId]);
    return;
  }

  let tag: string;
  try {
    tag = normalizeTag(String(msg.content ?? ''));
  } catch {
    await msg.delete().catch(() => undefined);
    await renderOrUpdateProfileMessage(ctx, thread, msg.author.id);
    const uiId = dbGetJobState(ctx.db, `profile:uiMessage:${msg.author.id}`) ?? '';
    await cleanupThreadMessagesKeep(thread, [uiId]);
    return;
  }

  // Validate tag via Clash API
  const player = await ctx.clash.getPlayer(tag);

  // Save mapping
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO user_links(discord_user_id, player_tag, player_name, display_preference)
         VALUES(?, ?, ?, 'discord')
         ON CONFLICT(discord_user_id) DO UPDATE
           SET player_tag = excluded.player_tag,
               player_name = excluded.player_name`,
      )
      .run(msg.author.id, player.tag, player.name);
  })();

  const inClan = player.clan?.tag?.toUpperCase() === ctx.cfg.CLASH_CLAN_TAG.toUpperCase();

  // Keep the thread clean: delete the user's tag message once processed.
  await msg.delete().catch(() => undefined);

  // Turn this into a simple profile thread.
  await thread.setName(`Profile - ${player.name}`.slice(0, 90)).catch(() => undefined);

  // Force rebuild of the static UI message so it flips from “Step 1” to “Linked”.
  const priorUiId = dbGetJobState(ctx.db, `profile:uiMessage:${msg.author.id}`);
  if (priorUiId) {
    await deleteMessageIfExists(thread, priorUiId);
    dbDeleteJobState(ctx.db, `profile:uiMessage:${msg.author.id}`);
  }
  await renderOrUpdateProfileMessage(ctx, thread, msg.author.id);

  // Clean up any prior messages so the thread reads like a form.
  const uiId = dbGetJobState(ctx.db, `profile:uiMessage:${msg.author.id}`) ?? '';
  await cleanupThreadMessagesKeep(thread, [uiId]);

  // Optional: hide the parent "who-are-you" channel from the user.
  try {
    const guild = await msg.client.guilds.fetch(ctx.cfg.GUILD_ID);
    await denyVerificationChannel(ctx, guild, msg.author.id);
  } catch {
    // ignore
  }
}

export async function handleLinkPreferenceInteraction(
  ctx: AppContext,
  interaction: ButtonInteraction,
) {
  if (!interaction.inGuild()) return;
  if (!interaction.customId.startsWith('linkpref:')) return;

  const [, userId, prefRaw] = interaction.customId.split(':');
  const pref = prefRaw as DisplayPreference;
  if (!userId || !pref) return;

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'This choice is not for you.', ephemeral: true });
    return;
  }

  // "Other" is a UI action: open modal to set/replace the single custom name.
  if (prefRaw === 'other') {
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: 'This choice is not for you.', ephemeral: true });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`linkprefmodal:${userId}`)
      .setTitle('Set custom name');

    const existing = ctx.db
      .prepare('SELECT custom_display_name FROM user_links WHERE discord_user_id = ?')
      .get(userId) as { custom_display_name?: string } | undefined;

    const input = new TextInputBuilder()
      .setCustomId('custom_display_name')
      .setLabel('Custom server nickname')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(32)
      .setValue((existing?.custom_display_name ?? '').slice(0, 32));

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (!['discord', 'discord_with_clash', 'clash', 'custom'].includes(pref)) {
    await interaction.reply({ content: 'Invalid preference.', ephemeral: true });
    return;
  }

  ctx.db
    .prepare('UPDATE user_links SET display_preference = ? WHERE discord_user_id = ?')
    .run(pref, userId);

  // If the user clicks the custom-name option but no custom name is set yet,
  // fall back to the modal (should be rare because we only render the custom button if set).
  if (pref === 'custom') {
    const existing = ctx.db
      .prepare('SELECT custom_display_name FROM user_links WHERE discord_user_id = ?')
      .get(userId) as { custom_display_name?: string } | undefined;
    if (!existing?.custom_display_name) {
      const modal = new ModalBuilder()
        .setCustomId(`linkprefmodal:${userId}`)
        .setTitle('Set custom name');

      const input = new TextInputBuilder()
        .setCustomId('custom_display_name')
        .setLabel('Custom server nickname')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32);

      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }
  }

  // Try to keep the button spinner visible until the nickname attempt finishes.
  // Discord requires a response within ~3s, so we wait up to ~2.4s.
  const nicknamePromise = tryApplyNicknamePreference(ctx, interaction, userId, pref);
  const attempt = await withTimeout(nicknamePromise, 2400);

  // Update the ephemeral menu in-place (no thread edits, no “edited” tag).
  try {
    const guild = await interaction.client.guilds.fetch(ctx.cfg.GUILD_ID);
    const menu = await buildEphemeralMenu(ctx, guild, userId);
    await interaction.update(menu as any).catch(async () => {
      // If we can't update (e.g., legacy buttons in thread), fall back to an ephemeral reply.
      await interaction.reply({ ephemeral: true, ...(menu as any) }).catch(() => undefined);
    });
  } catch {
    await interaction.deferUpdate().catch(() => undefined);
  }

  if (!attempt.ok) void nicknamePromise.catch(() => undefined);
}

export async function handleLinkPreferenceModalSubmit(
  ctx: AppContext,
  interaction: ModalSubmitInteraction,
) {
  if (!interaction.inGuild()) return;
  if (!interaction.customId.startsWith('linkprefmodal:')) return;

  const [, userId] = interaction.customId.split(':');
  if (!userId) return;
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
    return;
  }

  const raw = interaction.fields.getTextInputValue('custom_display_name');
  const custom = String(raw ?? '').trim();
  if (!custom) {
    await interaction.reply({ content: 'Custom name cannot be empty.', ephemeral: true });
    return;
  }

  // Ack the modal ephemerally and refresh the menu UI.
  await interaction.deferReply({ ephemeral: true }).catch(() => undefined);

  ctx.db
    .prepare(
      'UPDATE user_links SET display_preference = ?, custom_display_name = ? WHERE discord_user_id = ?',
    )
    .run('custom', custom, userId);

  await tryApplyNicknamePreference(ctx, interaction, userId, 'custom', {
    customDisplayName: custom,
  });

  try {
    const guild = await interaction.client.guilds.fetch(ctx.cfg.GUILD_ID);
    const menu = await buildEphemeralMenu(ctx, guild, userId);
    await interaction.editReply(menu as any).catch(() => undefined);
  } catch {
    await interaction.deleteReply().catch(() => undefined);
  }
}

export async function handleProfileInteraction(ctx: AppContext, interaction: ButtonInteraction) {
  if (!interaction.inGuild()) return;
  if (!interaction.customId.startsWith('menu:')) return;

  const [, userId, action] = interaction.customId.split(':');
  if (!userId || !action) return;

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'This button is not for you.', ephemeral: true });
    return;
  }

  const guild = await interaction.client.guilds.fetch(ctx.cfg.GUILD_ID);

  if (action === 'open') {
    const menu = await buildEphemeralMenu(ctx, guild, userId);
    await interaction.reply({ ephemeral: true, ...(menu as any) }).catch(() => undefined);
    return;
  }

  if (action === 'refresh') {
    const menu = await buildEphemeralMenu(ctx, guild, userId);
    await interaction.update(menu as any).catch(() => undefined);
    return;
  }

  if (action === 'close') {
    await interaction.deferUpdate().catch(() => undefined);
    // For ephemeral interaction responses, deleteReply removes the menu for the user.
    await interaction.deleteReply().catch(() => undefined);
    return;
  }

  if (action === 'unlink') {
    const embed = new EmbedBuilder()
      .setTitle('Unlink')
      .setDescription('Are you sure you want to unlink your Clash account?');

    await interaction.update({
      embeds: [embed],
      components: [makeUnlinkConfirmButtons(userId)],
    } as any);
    return;
  }

  if (action === 'unlink_cancel') {
    const menu = await buildEphemeralMenu(ctx, guild, userId);
    await interaction.update(menu as any).catch(() => undefined);
    return;
  }

  if (action === 'unlink_confirm') {
    await interaction.deferUpdate().catch(() => undefined);

    ctx.db.prepare('DELETE FROM user_links WHERE discord_user_id = ?').run(userId);
    dbDeleteJobState(ctx.db, `profile:uiMessage:${userId}`);

    // Best-effort: remove bot-managed roles and restore verification channel access.
    try {
      const member = await guild.members.fetch(userId);

      const roleIds = [
        ctx.cfg.ROLE_VANQUISHED_ID,
        ctx.cfg.ROLE_MEMBER_ID,
        ctx.cfg.ROLE_ELDER_ID,
        ctx.cfg.ROLE_COLEADER_ID,
        ctx.cfg.ROLE_LEADER_ID,
      ];
      const toRemove = roleIds.filter((rid) => member.roles.cache.has(rid));
      if (toRemove.length) await member.roles.remove(toRemove).catch(() => undefined);

      const chan = await guild.channels.fetch(ctx.cfg.CHANNEL_VERIFICATION_ID).catch(() => null);
      if (chan && chan.type === ChannelType.GuildText) {
        await chan.permissionOverwrites.delete(userId).catch(() => undefined);
      }
    } catch {
      // ignore
    }

    // Rename thread back to setup flow and refresh.
    if (interaction.channel && interaction.channel.isThread?.()) {
      const setupName = `Setup Necessary - ${interaction.user.username}`.slice(0, 90);
      await (interaction.channel as ThreadChannel).setName(setupName).catch(() => undefined);

      // Force rebuild of the static thread message so it flips back to “Step 1”.
      const priorUiId = dbGetJobState(ctx.db, `profile:uiMessage:${userId}`);
      if (priorUiId) {
        await deleteMessageIfExists(interaction.channel as ThreadChannel, priorUiId);
        dbDeleteJobState(ctx.db, `profile:uiMessage:${userId}`);
      }
      await renderOrUpdateProfileMessage(ctx, interaction.channel as ThreadChannel, userId);
      const uiId = dbGetJobState(ctx.db, `profile:uiMessage:${userId}`) ?? '';
      await cleanupThreadMessagesKeep(interaction.channel as ThreadChannel, [uiId]);
    }

    await interaction.editReply({ content: '', embeds: [], components: [] }).catch(() => undefined);
  }
}
