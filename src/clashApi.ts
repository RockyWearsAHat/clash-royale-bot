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

export class ClashApi {
  constructor(private readonly token: string) {}

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`https://api.clashroyale.com/v1${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
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
  async getCurrentRiverRace(clanTag: string): Promise<any> {
    const tag = encodeTag(clanTag);
    return await this.request<any>(`/clans/${tag}/currentriverrace`);
  }

  async getRiverRaceLog(clanTag: string): Promise<any> {
    const tag = encodeTag(clanTag);
    return await this.request<any>(`/clans/${tag}/riverracelog`);
  }
}
