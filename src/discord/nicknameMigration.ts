import type { Guild, GuildMember } from 'discord.js';
import type { AppContext } from '../types.js';
import { dbAudit, dbDeleteJobState, dbGetJobState, dbSetJobState } from '../db.js';
import { listGuildMembersPage } from './guildMembers.js';

function normalizeName(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function extractCandidateStrings(displayName: string): string[] {
  const raw = String(displayName ?? '').trim();
  if (!raw) return [];

  // Common patterns:
  // - "Name | something"
  // - "Name - something"
  // - "Name (something)"
  const withoutParens = raw.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');

  const parts = withoutParens
    .split(/\||•|·|:|\/|\\|-|–|—/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const candidates = new Set<string>();
  candidates.add(raw);
  if (parts[0]) candidates.add(parts[0]);
  if (withoutParens.trim()) candidates.add(withoutParens.trim());

  return [...candidates];
}

function normalizedCandidates(...strings: string[]): string[] {
  const merged: string[] = [];
  for (const s of strings) merged.push(...extractCandidateStrings(s));
  const out = new Set<string>();
  for (const s of merged) {
    const n = normalizeName(s);
    if (n) out.add(n);
    // Also try stripping trailing digits (e.g. "RockTofu123").
    const stripped = n.replace(/\d+$/g, '');
    if (stripped) out.add(stripped);
  }
  return [...out];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  const d = levenshtein(a, b);
  return 1 - d / maxLen;
}

function pickDisplayName(member: GuildMember): string {
  return String(member.displayName ?? member.user.username ?? '').trim();
}

function pickUsername(member: GuildMember): string {
  return String(member.user?.username ?? '').trim();
}

type MigrationStats = {
  scanned: number;
  skippedAlreadyLinked: number;
  skippedNoNickname: number;
  skippedNoMatch: number;
  skippedAmbiguous: number;
  skippedTagAlreadyLinked: number;
  linked: number;
};

export async function maybeRunNicknameToTagMigration(ctx: AppContext, guild: Guild) {
  if (!ctx.cfg.MIGRATE_NICKNAME_TO_TAG) return;

  const doneKey = 'migrate:nickname_to_tag:done';
  const done = dbGetJobState(ctx.db, doneKey);
  const version = 'v2';
  if (done === version && !ctx.cfg.MIGRATE_NICKNAME_TO_TAG_FORCE) return;

  dbAudit(
    ctx.db,
    'nickname_migration_start',
    `starting version=${version} force=${ctx.cfg.MIGRATE_NICKNAME_TO_TAG_FORCE} priorDone=${JSON.stringify(
      done ?? null,
    )}`,
  );

  try {
    const clanMembers = await ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG);

    // Build a normalized name -> list of candidates (to detect duplicates).
    const byNorm = new Map<string, Array<{ tag: string; name: string; norm: string }>>();
    const normList: Array<{ tag: string; name: string; norm: string }> = [];
    for (const cm of clanMembers) {
      const norm = normalizeName(cm.name);
      if (!norm) continue;
      const row = { tag: cm.tag, name: cm.name, norm };
      normList.push(row);
      const arr = byNorm.get(norm) ?? [];
      arr.push(row);
      byNorm.set(norm, arr);
    }

    const linkedRows = ctx.db
      .prepare('SELECT discord_user_id, player_tag FROM user_links')
      .all() as Array<{ discord_user_id: string; player_tag: string }>;
    const linkedIds = new Set(linkedRows.map((r) => r.discord_user_id));
    const linkedTags = new Set(linkedRows.map((r) => r.player_tag.toUpperCase()));

    const stats: MigrationStats = {
      scanned: 0,
      skippedAlreadyLinked: 0,
      skippedNoNickname: 0,
      skippedNoMatch: 0,
      skippedAmbiguous: 0,
      skippedTagAlreadyLinked: 0,
      linked: 0,
    };

    let debugLogged = 0;
    const debugLogLimit = 200;

    // Resume-able pagination cursor so rate limits don't waste work.
    const cursorKey = 'migrate:nickname_to_tag:after';
    let after = (dbGetJobState(ctx.db, cursorKey) || '').trim() || undefined;

    while (true) {
      const page = await listGuildMembersPage(guild, { after, limit: 1000 });
      if (!page.length) break;

      for (const member of page) {
        if (member.user.bot) continue;
        stats.scanned++;

        if (linkedIds.has(member.id)) {
          stats.skippedAlreadyLinked++;
          continue;
        }

        const display = pickDisplayName(member);
        const username = pickUsername(member);
        const normDisplays = normalizedCandidates(display, username);
        if (!normDisplays.length) {
          stats.skippedNoNickname++;
          continue;
        }

        // Strategy:
        // 1) Exact normalized match (must be unique).
        // 2) Otherwise fuzzy match using Levenshtein similarity; require high score and clear winner.
        let picked: { tag: string; name: string; norm: string } | undefined;
        let bestScore = 0;
        let secondScore = 0;

        for (const normDisplay of normDisplays) {
          const exact = byNorm.get(normDisplay) ?? [];
          if (exact.length === 1) {
            picked = exact[0];
            bestScore = 1;
            secondScore = 0;
            break;
          }
        }

        // Unique substring match (helps when nicknames include extra prefix/suffix like "HOL(HandingOutLs)").
        if (!picked) {
          const found: Array<{ tag: string; name: string; norm: string }> = [];
          for (const normDisplay of normDisplays) {
            if (normDisplay.length < 6) continue;
            for (const cm of normList) {
              if (cm.norm.length < 6) continue;
              if (normDisplay.includes(cm.norm) || cm.norm.includes(normDisplay)) found.push(cm);
            }
          }

          const uniq = new Map<string, { tag: string; name: string; norm: string }>();
          for (const c of found) uniq.set(c.tag.toUpperCase(), c);
          const candidates = [...uniq.values()];
          if (candidates.length === 1) {
            picked = candidates[0];
            bestScore = 0.99;
            secondScore = 0;
          }
        }

        if (!picked) {
          for (const normDisplay of normDisplays) {
            // Skip ultra-short names; too collision-prone.
            if (normDisplay.length < 3) continue;

            let localBest: { tag: string; name: string; norm: string } | undefined;
            let localBestScore = 0;
            let localSecond = 0;

            for (const cm of normList) {
              const score = similarity(normDisplay, cm.norm);
              if (score > localBestScore) {
                localSecond = localBestScore;
                localBestScore = score;
                localBest = cm;
              } else if (score > localSecond) {
                localSecond = score;
              }
            }

            if (localBest && localBestScore > bestScore) {
              picked = localBest;
              bestScore = localBestScore;
              secondScore = localSecond;
            }
          }

          // Require a strong match and a clear gap from the runner-up.
          // Tuned to catch common one-off typos while avoiding obvious collisions.
          const minScore = 0.9;
          const minGap = 0.02;
          if (!picked || bestScore < minScore || bestScore - secondScore < minGap) {
            // If it was close-ish, log a breadcrumb for debugging.
            if (debugLogged < debugLogLimit && picked && bestScore >= 0.85) {
              debugLogged++;
              dbAudit(
                ctx.db,
                'nickname_migration_skip',
                `user=${member.id} display=${JSON.stringify(
                  display,
                )} username=${JSON.stringify(username)} best=${picked.name}(${picked.tag}) score=${bestScore.toFixed(
                  3,
                )} second=${secondScore.toFixed(3)}`,
              );
            }
            stats.skippedNoMatch++;
            continue;
          }
        }

        // If multiple clan members normalize to the same value, treat as ambiguous.
        const dupes = byNorm.get(picked.norm) ?? [];
        if (dupes.length !== 1) {
          stats.skippedAmbiguous++;
          if (debugLogged < debugLogLimit) {
            debugLogged++;
            dbAudit(
              ctx.db,
              'nickname_migration_ambiguous',
              `user=${member.id} display=${JSON.stringify(
                display,
              )} norm=${picked.norm} candidates=${dupes
                .map((d) => `${d.name}(${d.tag})`)
                .join(',')}`,
            );
          }
          continue;
        }

        const tagKey = picked.tag.toUpperCase();
        if (linkedTags.has(tagKey)) {
          stats.skippedTagAlreadyLinked++;
          continue;
        }

        try {
          ctx.db
            .prepare(
              'INSERT INTO user_links(discord_user_id, player_tag, player_name) VALUES(?, ?, ?)',
            )
            .run(member.id, picked.tag, picked.name);
          linkedIds.add(member.id);
          linkedTags.add(tagKey);
          stats.linked++;
        } catch {
          // Could be a uniqueness conflict (tag already linked) or any DB constraint.
          stats.skippedTagAlreadyLinked++;
        }
      }

      after = page[page.length - 1]?.id;
      if (after) dbSetJobState(ctx.db, cursorKey, after);
    }

    dbSetJobState(ctx.db, doneKey, version);
    dbDeleteJobState(ctx.db, cursorKey);

    dbAudit(
      ctx.db,
      'nickname_migration',
      `done version=${version} scanned=${stats.scanned} linked=${stats.linked} alreadyLinked=${stats.skippedAlreadyLinked} ` +
        `noNick=${stats.skippedNoNickname} noMatch=${stats.skippedNoMatch} ambiguous=${stats.skippedAmbiguous} tagTaken=${stats.skippedTagAlreadyLinked} debugLogged=${debugLogged}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dbAudit(ctx.db, 'nickname_migration_error', msg);
    throw err;
  }
}
