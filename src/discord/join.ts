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
  WebhookClient,
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
  // Legacy (kept for older stored messages that might still exist).
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:settings`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Settings'),
  );
}

function makeMainProfileButtons(userId: string, currentNickname: string) {
  const nick = truncateButtonLabel(String(currentNickname ?? '').trim() || 'Unknown');
  const changeLabel = truncateButtonLabel(`Change Nickname (Currently: ${nick})`);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:nickname`)
      .setStyle(ButtonStyle.Primary)
      .setLabel(changeLabel),
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:settings`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Settings'),
  );
}

function isLegacyOpenMenuMessage(userId: string, msg: any): boolean {
  try {
    const rows = Array.isArray(msg?.components) ? msg.components : [];
    for (const row of rows) {
      const comps = Array.isArray(row?.components) ? row.components : [];
      for (const c of comps) {
        const customId = String(c?.customId ?? '');
        const label = String(c?.label ?? '');
        if (customId === `menu:${userId}:open`) return true;
        if (label.toLowerCase().includes('open menu')) return true;
      }
    }

    const embeds = Array.isArray(msg?.embeds) ? msg.embeds : [];
    for (const e of embeds) {
      const desc = String((e as any)?.description ?? '');
      if (desc.toLowerCase().includes('open menu')) return true;
    }
  } catch {
    // ignore
  }
  return false;
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

function makeCloseButton(userId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:close`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Close'),
  );
}

function makeSettingsButtons(userId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:change_tag`)
      .setStyle(ButtonStyle.Primary)
      .setLabel('Change Linked Tag'),
    new ButtonBuilder()
      .setCustomId(`menu:${userId}:unlink`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Unlink'),
  );
}

async function buildNicknameMenu(ctx: AppContext, guild: any, userId: string) {
  const row = getLinkRow(ctx, userId);
  if (!row) {
    const embed = new EmbedBuilder()
      .setTitle('Profile')
      .setDescription('Not linked. Paste your player tag in your thread.');
    return { embeds: [embed], components: [] as any[] };
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  const discordBaseName = member ? getPreferredBaseName(member) : 'Discord';
  const currentDisplayName = member ? getCurrentGuildDisplayName(member) : discordBaseName;

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

  const effective = determineEffectiveDisplayPreference({
    currentDisplayName,
    discordBaseName,
    clashName: liveName,
    savedCustomName: row.custom_display_name,
  });

  const preferenceRow = makePreferenceButtons(userId, effective.pref, {
    discord: discordBaseName,
    discordWithClash: `${discordBaseName} (${liveName})`,
    clash: liveName,
    // If the user's current name isn't a default, show it like it was typed via "Other".
    custom: effective.pref === 'custom' ? effective.customLabel : undefined,
  });

  return {
    embeds: [embed],
    components: [preferenceRow, makeCloseButton(userId)],
  };
}

async function buildSettingsMenu(ctx: AppContext, guild: any, userId: string) {
  const row = getLinkRow(ctx, userId);
  const embed = new EmbedBuilder().setTitle('Settings');

  if (!row) {
    embed.setDescription('Not linked. Paste your player tag in your thread.');
    return { embeds: [embed], components: [makeCloseButton(userId)] as any[] };
  }

  // Best-effort live lookup for display.
  const player = await ctx.clash.getPlayer(row.player_tag).catch(() => null);
  const liveName = player?.name ?? row.player_name ?? 'Unknown';
  const liveTag = player?.tag ?? row.player_tag;

  embed.setDescription(`Currently linked to **${liveName} (${liveTag})**.`);

  return {
    embeds: [embed],
    components: [makeSettingsButtons(userId), makeCloseButton(userId)],
  };
}

async function buildMainMenuEphemeral(ctx: AppContext, guild: any, userId: string) {
  const row = getLinkRow(ctx, userId);
  const embed = new EmbedBuilder().setTitle('Profile');

  if (!row) {
    embed.setDescription('Not linked. Paste your player tag in your thread.');
    return { embeds: [embed], components: [makeCloseButton(userId)] as any[] };
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  const currentNick = getCurrentGuildDisplayName(member);
  embed.setDescription(`Linked to **${row.player_tag}**. Choose an option.`);

  return {
    embeds: [embed],
    components: [makeMainProfileButtons(userId, currentNick), makeCloseButton(userId)],
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

    // Duplicates can happen due to old versions or manual actions.
    // Do NOT delete by default (it can feel like threads "randomly disappear").
    // Instead, archive+lock so history remains and the canonical thread stays stable.
    await t.setLocked(true, 'Closing duplicate verification/profile thread').catch(() => undefined);
    await t
      .setArchived(true, 'Closing duplicate verification/profile thread')
      .catch(() => undefined);
  }

  // Also clear any stale state pointing at something else.
  dbSetJobState(ctx.db, `verify:thread:${userId}`, keepThreadId);
}

async function ensureThreadMember(
  ctx: AppContext,
  thread: ThreadChannel,
  userId: string,
): Promise<boolean> {
  const isMember = async () =>
    await thread.members
      .fetch(userId)
      .then(() => true)
      .catch(() => false);

  if (await isMember()) return true;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await thread.members.add(userId);
    } catch (e) {
      lastErr = e;
    }

    await new Promise((r) => setTimeout(r, 250 * attempt));
    if (await isMember()) return true;
  }

  const msg =
    lastErr instanceof Error ? lastErr.message : lastErr ? String(lastErr) : 'Unknown error';
  ctx.db
    .prepare('INSERT INTO audit_log(type, message) VALUES(?, ?)')
    .run('verify_thread_add_member_error', `user=${userId} thread=${thread.id} err=${msg}`);
  return false;
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
    embed.setDescription(`Linked to ${row.player_tag}. Choose an option below.`);
  }

  let components: any[] = [];
  if (row) {
    const member = await thread.guild.members.fetch(userId).catch(() => null);
    const currentNick = getCurrentGuildDisplayName(member);
    components = [makeMainProfileButtons(userId, currentNick)];
  }

  // Only create if missing; avoid updating this message so it never shows “edited”.
  if (uiId) {
    const exists = await thread.messages.fetch(uiId).catch(() => null);
    if (exists) {
      // Upgrade legacy Open Menu messages in-place once.
      if (row && isLegacyOpenMenuMessage(userId, exists)) {
        await exists
          .edit({ content: '', embeds: [embed], components } as any)
          .catch(() => undefined);
      }
      return;
    }
  }

  // Delete any stale pointer and create a fresh UI message.
  if (uiId) {
    await deleteMessageIfExists(thread, uiId);
    dbDeleteJobState(ctx.db, uiKey);
  }

  const sent = await thread.send({ content: '', embeds: [embed], components }).catch(() => null);
  if (sent) dbSetJobState(ctx.db, uiKey, sent.id);
}

export async function refreshProfileThreadMainMenuMessage(
  ctx: AppContext,
  guild: any,
  userId: string,
) {
  const row = getLinkRow(ctx, userId);
  if (!row) return;

  const parent = await guild.channels.fetch(ctx.cfg.CHANNEL_VERIFICATION_ID).catch(() => null);
  if (!parent || parent.type !== ChannelType.GuildText) return;
  const textChannel = parent as TextChannel;

  const threadId = dbGetJobState(ctx.db, `verify:thread:${userId}`);
  if (!threadId) return;
  const thread = await textChannel.threads.fetch(threadId).catch(() => null);
  if (!thread) return;

  const uiId = dbGetJobState(ctx.db, `profile:uiMessage:${userId}`);
  if (!uiId) return;
  const msg = await thread.messages.fetch(uiId).catch(() => null);
  if (!msg) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  const currentNick = getCurrentGuildDisplayName(member);

  const embed = new EmbedBuilder().setTitle('Profile');
  embed.setDescription(`Linked to ${row.player_tag}. Choose an option below.`);

  await msg
    .edit({
      content: '',
      embeds: [embed],
      components: [makeMainProfileButtons(userId, currentNick)],
    } as any)
    .catch(() => undefined);
}

function getPreferredBaseName(member: any): string {
  // Prefer global display name if available; otherwise fallback to username.
  return String(member?.user?.globalName ?? member?.user?.username ?? 'Discord');
}

function getCurrentGuildDisplayName(member: any): string {
  // In discord.js, displayName matches what the guild shows (nickname if set; else globalName/username).
  return String(
    member?.displayName ??
      member?.nickname ??
      member?.user?.globalName ??
      member?.user?.username ??
      'Discord',
  );
}

function determineEffectiveDisplayPreference(args: {
  currentDisplayName: string;
  discordBaseName: string;
  clashName: string;
  savedCustomName?: string | null;
}): { pref: DisplayPreference; customLabel?: string } {
  const cur = String(args.currentDisplayName ?? '').trim();
  const discord = String(args.discordBaseName ?? '').trim();
  const clash = String(args.clashName ?? '').trim();
  const discordWithClash = `${discord} (${clash})`;
  const savedCustom = String(args.savedCustomName ?? '').trim();

  if (cur && cur === discord) return { pref: 'discord' };
  if (cur && cur === clash) return { pref: 'clash' };
  if (cur && cur === discordWithClash) return { pref: 'discord_with_clash' };
  if (cur && savedCustom && cur === savedCustom)
    return { pref: 'custom', customLabel: savedCustom };

  // Not a default: show as if the user chose Other and typed it.
  if (cur) return { pref: 'custom', customLabel: cur };

  // Fallback.
  if (savedCustom) return { pref: 'custom', customLabel: savedCustom };
  return { pref: 'discord' };
}

type OpenNicknameMenuState = {
  appId: string;
  token: string;
  messageId: string;
  openedAt: number;
};

function nicknameMenuStateKey(userId: string) {
  return `profile:nickMenu:${userId}`;
}

export async function refreshOpenNicknameMenuIfAny(ctx: AppContext, guild: any, userId: string) {
  const raw = dbGetJobState(ctx.db, nicknameMenuStateKey(userId));
  if (!raw) return;

  let state: OpenNicknameMenuState | null = null;
  try {
    state = JSON.parse(raw) as OpenNicknameMenuState;
  } catch {
    dbDeleteJobState(ctx.db, nicknameMenuStateKey(userId));
    return;
  }

  const openedAt = Number(state?.openedAt ?? 0);
  // Interaction tokens are short-lived; be conservative.
  if (!Number.isFinite(openedAt) || Date.now() - openedAt > 14 * 60_000) {
    dbDeleteJobState(ctx.db, nicknameMenuStateKey(userId));
    return;
  }

  const appId = String(state?.appId ?? '').trim();
  const token = String(state?.token ?? '').trim();
  const messageId = String(state?.messageId ?? '').trim();
  if (!appId || !token || !messageId) {
    dbDeleteJobState(ctx.db, nicknameMenuStateKey(userId));
    return;
  }

  const menu = await buildNicknameMenu(ctx, guild, userId);

  try {
    const webhook = new WebhookClient({ id: appId, token });
    await webhook.editMessage(messageId, menu as any).catch(() => undefined);
  } catch {
    // If the ephemeral message no longer exists or token expired, clear state.
    dbDeleteJobState(ctx.db, nicknameMenuStateKey(userId));
  }
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
  const setupThreadName = `Verification — ${username}`.slice(0, 90);
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
      // IMPORTANT: only lock/archive other threads after we confirm this canonical thread is usable.
      const ok = await ensureThreadMember(ctx, existing, userId);
      if (ok) {
        await closeOtherThreadsForUser(ctx, client, textChannel, userId, username, existing.id);
      }

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

  // IMPORTANT: ensure the user is actually a member before we lock/archive other candidate threads.
  const ok = await ensureThreadMember(ctx, thread, userId);
  if (ok) {
    await closeOtherThreadsForUser(ctx, client, textChannel, userId, username, thread.id);
  }

  await renderOrUpdateProfileMessage(ctx, thread, userId);
  const uiId = dbGetJobState(ctx.db, `profile:uiMessage:${userId}`) ?? '';
  await cleanupThreadMessagesKeep(thread, [uiId]);
  return thread;
}

export async function repairVerificationThreadsOnce(ctx: AppContext, client: any): Promise<void> {
  // Goal: cleanup/repair ONLY. No recreations.
  // - Fix archived/locked state
  // - Ensure user is a member of their canonical private thread
  // - Archive/lock duplicate bot-managed threads
  // - Delete orphan bot-only threads
  // - Clear stale DB pointers
  const channel = await client.channels.fetch(ctx.cfg.CHANNEL_VERIFICATION_ID).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const textChannel = channel as TextChannel;

  const linked = ctx.db
    .prepare('SELECT discord_user_id, player_name FROM user_links')
    .all() as Array<{ discord_user_id: string; player_name?: string | null }>;

  const isBotManagedThreadName = (name: string | null | undefined) => {
    const n = String(name ?? '').toLowerCase();
    return n.startsWith('link-') || n.startsWith('setup necessary') || n.startsWith('profile -');
  };

  const botId = String(client.user?.id ?? '');
  const listAllThreads = async (): Promise<ThreadChannel[]> => {
    const byId = new Map<string, ThreadChannel>();

    const active = await textChannel.threads.fetchActive().catch(() => null);
    if (active?.threads?.values) {
      for (const t of active.threads.values()) byId.set(t.id, t);
    }

    const fetchArchivedPaged = async (type: 'private' | 'public') => {
      let before: string | undefined = undefined;
      let pages = 0;
      while (pages < 10) {
        const res: any = await textChannel.threads
          .fetchArchived({ type, limit: 100, before })
          .catch(() => null);
        if (!res) break;

        const threads: any[] = Array.from(res.threads.values());
        for (const t of threads) byId.set(t.id, t);

        pages++;
        if (!threads.length) break;
        // Paginate by the oldest thread id we received.
        before = String(threads[threads.length - 1]?.id ?? '');
        const hasMore = Boolean((res as any)?.hasMore);
        if (!hasMore) break;
      }
    };

    await fetchArchivedPaged('private');
    await fetchArchivedPaged('public');

    return Array.from(byId.values());
  };

  // First pass: delete bot-only orphan threads (these are invisible to users and just clutter).
  // Delete ANY thread under the verification channel whose ONLY member is the bot.
  if (botId) {
    const candidates = await listAllThreads();

    for (const t of candidates) {
      // Try to determine if this thread is bot-only.
      // For some private threads, member fetch can fail or be incomplete; fall back to memberCount.
      let isBotOnly = false;
      const members = await t.members.fetch().catch(() => null);
      if (members) {
        // Some APIs occasionally return an empty collection; treat that as bot-only-ish for bot-managed names.
        if (members.size === 0) {
          isBotOnly = isBotManagedThreadName(t.name);
        } else {
          isBotOnly = members.size === 1 && members.has(botId);
        }
      } else {
        const mc = Number((t as any)?.memberCount ?? NaN);
        // If we can't fetch members but Discord says only 1 member, and it looks bot-managed,
        // treat it as an orphan candidate.
        isBotOnly = Number.isFinite(mc) && mc === 1 && isBotManagedThreadName(t.name);
      }

      if (!isBotOnly) continue;

      // Best-effort deletion; fall back to archive+lock if guild disallows deletes.
      try {
        await t.delete('Repair pass: deleting bot-only orphan thread');
      } catch (e) {
        await t
          .setLocked(true, 'Repair pass: locking bot-only orphan thread (delete failed)')
          .catch(() => undefined);
        await t
          .setArchived(true, 'Repair pass: archiving bot-only orphan thread (delete failed)')
          .catch(() => undefined);
        const msg = e instanceof Error ? e.message : String(e);
        ctx.db
          .prepare('INSERT INTO audit_log(type, message) VALUES(?, ?)')
          .run('verify_thread_orphan_delete_failed', `thread=${t.id} err=${msg}`);
      }

      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Second pass: validate every stored verify:thread pointer (covers linked + unlinked users).
  // If the pointer thread exists but the user isn't in it (and cannot be re-added), delete it and clear the pointer.
  const pointers = ctx.db
    .prepare("SELECT key, value FROM job_state WHERE key LIKE 'verify:thread:%'")
    .all() as Array<{ key: string; value: string }>;
  for (const p of pointers) {
    const userId = p.key.split(':').slice(2).join(':');
    const threadId = String(p.value ?? '');
    if (!userId || !threadId) continue;

    const t = await textChannel.threads.fetch(threadId).catch(() => null);
    if (!t) {
      dbDeleteJobState(ctx.db, p.key);
      continue;
    }

    // If the user is already a member, leave it alone.
    const isMember = await t.members
      .fetch(userId)
      .then(() => true)
      .catch(() => false);
    if (isMember) continue;

    // Attempt to re-add them.
    const ok = await ensureThreadMember(ctx, t, userId);
    if (ok) continue;

    // Still not accessible: delete/lock/archive and clear pointer to prevent persistent bot-only threads.
    try {
      await t.delete('Repair pass: deleting unusable thread (cannot add user)');
    } catch {
      await t
        .setLocked(true, 'Repair pass: locking unusable thread (delete failed)')
        .catch(() => undefined);
      await t
        .setArchived(true, 'Repair pass: archiving unusable thread (delete failed)')
        .catch(() => undefined);
    }
    dbDeleteJobState(ctx.db, p.key);

    await new Promise((r) => setTimeout(r, 150));
  }

  for (const row of linked) {
    const userId = row.discord_user_id;
    const user = await client.users.fetch(userId).catch(() => null);
    const username = user?.username ?? 'Discord Username';

    const stateKey = `verify:thread:${userId}`;
    const existingId = dbGetJobState(ctx.db, stateKey);

    const fetchThreadById = async (id: string): Promise<ThreadChannel | null> => {
      if (!id) return null;
      return await textChannel.threads.fetch(id).catch(() => null);
    };

    let thread: ThreadChannel | null = existingId ? await fetchThreadById(existingId) : null;

    // If pointer is missing or stale, attempt to select an existing bot-managed thread.
    if (!thread) {
      if (existingId) {
        ctx.db
          .prepare('INSERT INTO audit_log(type, message) VALUES(?, ?)')
          .run('verify_thread_pointer_stale', `user=${userId} thread=${existingId}`);
        dbDeleteJobState(ctx.db, stateKey);
      }

      const candidates = await listAllThreads();

      const uname = username.toLowerCase();
      const legacyNameMatchesUser = (name: string) => {
        const n = name.toLowerCase();
        return n.startsWith('link-') && n.includes(uname);
      };

      const scored = [] as Array<{ t: ThreadChannel; score: number; ts: number }>;
      for (const t of candidates) {
        if (!isBotManagedThreadName(t.name)) continue;

        const isMember = await t.members
          .fetch(userId)
          .then(() => true)
          .catch(() => false);
        const legacy = !isMember && legacyNameMatchesUser(t.name ?? '');
        if (!isMember && !legacy) continue;

        const base = isMember ? 2 : 1;
        const bonus = t.archived ? 0 : 1;
        scored.push({ t, score: base + bonus, ts: (t as any).createdTimestamp ?? 0 });
      }

      scored.sort((a, b) => b.score - a.score || b.ts - a.ts);
      thread = scored[0]?.t ?? null;

      if (thread) {
        dbSetJobState(ctx.db, stateKey, thread.id);
      } else {
        // Nothing to repair for this user.
        await new Promise((r) => setTimeout(r, 75));
        continue;
      }
    }

    // Repair the canonical thread in-place.
    if (thread.archived) {
      await thread
        .setArchived(false, 'Repairing verification/profile thread')
        .catch(() => undefined);
    }
    if (thread.locked) {
      await thread.setLocked(false, 'Repairing verification/profile thread').catch(() => undefined);
    }

    const desiredName = `Profile - ${row.player_name ?? username}`.slice(0, 90);
    if (thread.name !== desiredName) {
      await thread.setName(desiredName).catch(() => undefined);
    }

    const ok = await ensureThreadMember(ctx, thread, userId);
    if (ok) {
      await closeOtherThreadsForUser(ctx, client, textChannel, userId, username, thread.id);
    } else {
      // If we couldn't add the user back, this thread is effectively unusable for them.
      // Delete it if possible so we don't accumulate bot-only threads tied to users.
      try {
        await thread.delete('Repair pass: deleting unusable bot-only thread (could not add user)');
      } catch {
        await thread
          .setLocked(true, 'Repair pass: locking unusable thread (delete failed)')
          .catch(() => undefined);
        await thread
          .setArchived(true, 'Repair pass: archiving unusable thread (delete failed)')
          .catch(() => undefined);
      }

      dbDeleteJobState(ctx.db, stateKey);
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }

    // Best-effort: ensure UI is present and keep the thread clean.
    await renderOrUpdateProfileMessage(ctx, thread, userId);
    const uiId = dbGetJobState(ctx.db, `profile:uiMessage:${userId}`) ?? '';
    await cleanupThreadMessagesKeep(thread, [uiId]);

    await new Promise((r) => setTimeout(r, 150));
  }
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
      // Only touch the thread if it's actually not usable.
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

      // Only rename if it's wrong (renames show as "edited").
      const desiredName = `Profile - ${linked.player_name ?? 'Profile'}`.slice(0, 90);
      if (existing.name !== desiredName) {
        await existing.setName(desiredName).catch(() => undefined);
      }

      // Ensure the user can access the thread again if they were removed.
      // Use the same canonical create-or-repair logic so errors get audited.
      const isMember = await existing.members
        .fetch(userId)
        .then(() => true)
        .catch(() => false);
      if (!isMember) {
        await getOrCreateVerificationThread(ctx, client, userId);
        return;
      }
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

export async function recreateProfileThreadForUser(
  ctx: AppContext,
  client: any,
  userId: string,
): Promise<void> {
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
      try {
        await existing.delete('DEV_RECREATE_PROFILE_THREADS: recreating profile thread');
      } catch {
        // If delete is disallowed (common in some guild setups), archive/lock it so the new one is clean.
        await existing
          .setLocked(true, 'DEV_RECREATE_PROFILE_THREADS: locking old profile thread')
          .catch(() => undefined);
        await existing
          .setArchived(true, 'DEV_RECREATE_PROFILE_THREADS: archiving old profile thread')
          .catch(() => undefined);

        // Best-effort: remove the static UI message pointer so the new thread gets a fresh UI.
        const uiKey = `profile:uiMessage:${userId}`;
        const uiId = dbGetJobState(ctx.db, uiKey);
        if (uiId) {
          await deleteMessageIfExists(existing, uiId);
          dbDeleteJobState(ctx.db, uiKey);
        }
      }
    }
  }

  // Always clear pointers so a fresh thread is created.
  dbDeleteJobState(ctx.db, stateKey);
  dbDeleteJobState(ctx.db, `profile:uiMessage:${userId}`);
  dbDeleteJobState(ctx.db, `profile:infoMessage:${userId}`);
  dbDeleteJobState(ctx.db, `profile:controlsMessage:${userId}`);
  dbDeleteJobState(ctx.db, `profile:infoHash:${userId}`);
  dbDeleteJobState(ctx.db, `profile:controlsHash:${userId}`);

  await getOrCreateVerificationThread(ctx, client, userId);
}

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
  // Throttle hint messages per-user so the verification channel doesn't get noisy.
  const hintKey = `verify:hint:last:${msg.author.id}`;
  const lastRaw = dbGetJobState(ctx.db, hintKey);
  const last = lastRaw ? Number(lastRaw) : 0;
  if (Number.isFinite(last) && Date.now() - last < 60_000) return;
  dbSetJobState(ctx.db, hintKey, String(Date.now()));

  const hint = await msg.channel
    .send({
      content: `<@${msg.author.id}> your verification thread is here: <#${thread.id}> (paste your tag like \`#ABC123\`).`,
    })
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

  // Optional: lock the parent "who-are-you" channel for the user.
  // We keep it viewable so their private profile thread doesn't become inaccessible.
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

    const member = await interaction.guild?.members.fetch(userId).catch(() => null);
    const suggested = getCurrentGuildDisplayName(member);

    const input = new TextInputBuilder()
      .setCustomId('custom_display_name')
      .setLabel('Custom server nickname')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(32)
      .setValue(String(existing?.custom_display_name ?? suggested ?? '').slice(0, 32));

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

      const member = await interaction.guild?.members.fetch(userId).catch(() => null);
      const suggested = getCurrentGuildDisplayName(member);

      const input = new TextInputBuilder()
        .setCustomId('custom_display_name')
        .setLabel('Custom server nickname')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32)
        .setValue(String(suggested ?? '').slice(0, 32));

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
    const menu = await buildNicknameMenu(ctx, guild, userId);
    await interaction.update(menu as any).catch(async () => {
      // If we can't update (e.g., legacy buttons in thread), fall back to an ephemeral reply.
      await interaction.reply({ ephemeral: true, ...(menu as any) }).catch(() => undefined);
    });

    // Update the main profile thread buttons once the nickname update succeeds.
    void nicknamePromise
      .then((err) => {
        if (err) return;
        return refreshProfileThreadMainMenuMessage(ctx, guild, userId);
      })
      .catch(() => undefined);
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

  const nicknameErr = await tryApplyNicknamePreference(ctx, interaction, userId, 'custom', {
    customDisplayName: custom,
  });

  try {
    const guild = await interaction.client.guilds.fetch(ctx.cfg.GUILD_ID);
    const menu = await buildNicknameMenu(ctx, guild, userId);
    await interaction.editReply(menu as any).catch(() => undefined);

    await refreshProfileThreadMainMenuMessage(ctx, guild, userId);
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

  // Legacy support: old thread buttons might still have customId menu:<id>:open
  if (action === 'open') {
    const menu = await buildMainMenuEphemeral(ctx, guild, userId);
    await interaction.reply({ ephemeral: true, ...(menu as any) }).catch(() => undefined);
    return;
  }

  if (action === 'nickname') {
    const menu = await buildNicknameMenu(ctx, guild, userId);
    await interaction.reply({ ephemeral: true, ...(menu as any) }).catch(() => undefined);

    // Remember this ephemeral menu so we can refresh its selected state if the user's
    // display name changes while the menu is open.
    try {
      const appId = String((interaction as any).applicationId ?? '');
      const token = String((interaction as any).token ?? '');
      const reply = await interaction.fetchReply().catch(() => null);
      const messageId = String((reply as any)?.id ?? '').trim();
      if (appId && token && messageId) {
        const state = {
          appId,
          token,
          messageId,
          openedAt: Date.now(),
        };
        dbSetJobState(ctx.db, nicknameMenuStateKey(userId), JSON.stringify(state));
      }
    } catch {
      // ignore
    }
    return;
  }

  if (action === 'settings') {
    const menu = await buildSettingsMenu(ctx, guild, userId);
    await interaction.reply({ ephemeral: true, ...(menu as any) }).catch(() => undefined);
    return;
  }

  if (action === 'close') {
    await interaction.deferUpdate().catch(() => undefined);
    // For ephemeral interaction responses, deleteReply removes the menu for the user.
    await interaction.deleteReply().catch(() => undefined);

    // Best-effort: clear any stored menu state.
    dbDeleteJobState(ctx.db, nicknameMenuStateKey(userId));
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
    const menu = await buildSettingsMenu(ctx, guild, userId);
    await interaction.update(menu as any).catch(() => undefined);
    return;
  }

  if (action === 'change_tag') {
    const existing = ctx.db
      .prepare('SELECT player_tag FROM user_links WHERE discord_user_id = ?')
      .get(userId) as { player_tag?: string } | undefined;

    const modal = new ModalBuilder()
      .setCustomId(`changetagmodal:${userId}`)
      .setTitle('Change linked tag');

    const input = new TextInputBuilder()
      .setCustomId('player_tag')
      .setLabel('New Clash Royale player tag')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(16)
      .setValue(String(existing?.player_tag ?? '').slice(0, 16));

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

    await interaction.showModal(modal).catch(() => undefined);
    return;
  }

  if (action === 'unlink_confirm') {
    await interaction.deferUpdate().catch(() => undefined);

    ctx.db.prepare('DELETE FROM user_links WHERE discord_user_id = ?').run(userId);
    dbDeleteJobState(ctx.db, `profile:uiMessage:${userId}`);
    dbDeleteJobState(ctx.db, nicknameMenuStateKey(userId));

    // Best-effort: remove bot-managed roles and restore verification channel access.
    try {
      const member = await guild.members.fetch(userId);

      const clanRoleIds = [
        ctx.cfg.ROLE_MEMBER_ID,
        ctx.cfg.ROLE_ELDER_ID,
        ctx.cfg.ROLE_COLEADER_ID,
        ctx.cfg.ROLE_LEADER_ID,
      ];
      const toRemove = clanRoleIds.filter((rid) => member.roles.cache.has(rid));
      if (toRemove.length) await member.roles.remove(toRemove).catch(() => undefined);

      // Unlinked users should always be vanquished.
      if (!member.roles.cache.has(ctx.cfg.ROLE_NON_MEMBER_ID)) {
        await member.roles.add(ctx.cfg.ROLE_NON_MEMBER_ID).catch(() => undefined);
      }

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

export async function handleChangeTagModalSubmit(
  ctx: AppContext,
  interaction: ModalSubmitInteraction,
) {
  if (!interaction.inGuild()) return;
  if (!interaction.customId.startsWith('changetagmodal:')) return;

  const [, userId] = interaction.customId.split(':');
  if (!userId) return;
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
    return;
  }

  const raw = interaction.fields.getTextInputValue('player_tag');
  let tag: string;
  try {
    tag = normalizeTag(String(raw ?? ''));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid tag.';
    await interaction.reply({ content: msg, ephemeral: true }).catch(() => undefined);
    return;
  }

  await interaction.deferReply({ ephemeral: true }).catch(() => undefined);

  const player = await ctx.clash.getPlayer(tag).catch(() => null);
  if (!player?.tag) {
    await interaction
      .editReply({ content: 'Could not validate that tag. Please try again.' })
      .catch(() => undefined);
    return;
  }

  try {
    ctx.db
      .prepare('UPDATE user_links SET player_tag = ?, player_name = ? WHERE discord_user_id = ?')
      .run(player.tag, player.name, userId);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? 'Failed to update link.');
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('constraint')) {
      await interaction.editReply({
        content:
          'That player tag is already linked to another Discord user. If that is you, unlink it first.',
      });
      return;
    }
    await interaction
      .editReply({ content: 'Failed to update your linked tag. Please try again.' })
      .catch(() => undefined);
    return;
  }

  // Update the thread name + static UI message (best-effort).
  try {
    const channel = await interaction.client.channels
      .fetch(ctx.cfg.CHANNEL_VERIFICATION_ID)
      .catch(() => null);
    if (channel && channel.type === ChannelType.GuildText) {
      const threadId = dbGetJobState(ctx.db, `verify:thread:${userId}`);
      if (threadId) {
        const thread = await (channel as TextChannel).threads.fetch(threadId).catch(() => null);
        if (thread) {
          await thread.setName(`Profile - ${player.name}`.slice(0, 90)).catch(() => undefined);

          const priorUiId = dbGetJobState(ctx.db, `profile:uiMessage:${userId}`);
          if (priorUiId) {
            await deleteMessageIfExists(thread, priorUiId);
            dbDeleteJobState(ctx.db, `profile:uiMessage:${userId}`);
          }
          await renderOrUpdateProfileMessage(ctx, thread, userId);
        }
      }
    }
  } catch {
    // ignore
  }

  await interaction
    .editReply({ content: `Updated your linked tag to **${player.tag}**.` })
    .catch(() => undefined);
}
