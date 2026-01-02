export type ClashClanMemberRole = 'member' | 'elder' | 'coLeader' | 'leader';

export type ClashClanMember = {
  tag: string;
  name: string;
  role: ClashClanMemberRole;
};

export type ClashPlayer = {
  tag: string;
  name: string;
  trophies?: number;
  bestTrophies?: number;
  expLevel?: number;
  wins?: number;
  losses?: number;
  battleCount?: number;
  threeCrownWins?: number;
  donations?: number;
  donationsReceived?: number;
  clan?: {
    tag: string;
    name: string;
    role: ClashClanMemberRole;
  };
};

function encodeTag(tag: string): string {
  const t = tag.startsWith('#') ? tag : `#${tag}`;
  // Clash API expects # encoded as %23
  return encodeURIComponent(t);
}

function appendCacheBust(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}_ts=${Date.now()}`;
}

export class ClashApi {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, opts?: { cacheBust?: boolean }): Promise<T> {
    const finalPath = opts?.cacheBust ? appendCacheBust(path) : path;
    const res = await fetch(`https://api.clashroyale.com/v1${finalPath}`, {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(opts?.cacheBust
          ? {
              'Cache-Control': 'no-cache, no-store, max-age=0',
              Pragma: 'no-cache',
            }
          : null),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Clash API error ${res.status} ${res.statusText}: ${text}`);
    }

    return (await res.json()) as T;
  }

  async getClanMembers(clanTag: string): Promise<ClashClanMember[]> {
    const tag = encodeTag(clanTag);
    const data = await this.request<{
      items: Array<{ tag: string; name: string; role: ClashClanMemberRole }>;
    }>(`/clans/${tag}/members`);
    return data.items.map((m) => ({ tag: m.tag, name: m.name, role: m.role }));
  }

  async getPlayer(playerTag: string): Promise<ClashPlayer> {
    const tag = encodeTag(playerTag);
    return await this.request<ClashPlayer>(`/players/${tag}`);
  }

  // Placeholder for war endpoints; will be used in later steps.
  async getCurrentRiverRace(clanTag: string, opts?: { cacheBust?: boolean }): Promise<any> {
    const tag = encodeTag(clanTag);
    return await this.request<any>(`/clans/${tag}/currentriverrace`, opts);
  }

  async getRiverRaceLog(clanTag: string, opts?: { cacheBust?: boolean }): Promise<any> {
    const tag = encodeTag(clanTag);
    return await this.request<any>(`/clans/${tag}/riverracelog`, opts);
  }
}
