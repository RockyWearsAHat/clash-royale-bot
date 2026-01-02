export type TimeOfDaySpec = {
  hour: number;
  minute: number;
  timeZone: string;
  original: string;
};

const TZ_ALIASES: Record<string, string> = {
  UTC: 'UTC',
  GMT: 'UTC',

  // Fixed-offset abbreviations (no DST)
  MST: 'Etc/GMT+7',
  MDT: 'Etc/GMT+6',
  CST: 'Etc/GMT+6',
  CDT: 'Etc/GMT+5',
  EST: 'Etc/GMT+5',
  EDT: 'Etc/GMT+4',
  PST: 'Etc/GMT+8',
  PDT: 'Etc/GMT+7',

  // Friendly region names (DST-aware)
  PACIFIC: 'America/Los_Angeles',
  MOUNTAIN: 'America/Denver',
  CENTRAL: 'America/Chicago',
  EASTERN: 'America/New_York',
};

function normalizeTzToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // Treat tokens with '/' as IANA tz names and keep case.
  if (trimmed.includes('/')) return trimmed;

  // Normalize common aliases.
  const up = trimmed.toUpperCase();
  return TZ_ALIASES[up] ?? trimmed;
}

function assertValidTimeZone(timeZone: string): void {
  // Intl will throw RangeError if the timeZone is invalid.
  // We do a tiny formatting attempt to validate.
  new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
}

export function parseTimeOfDayWithTimeZone(
  raw: string,
): { ok: true; value: TimeOfDaySpec } | { ok: false; error: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'Empty time string.' };

  // Accept examples like:
  // - "8am MST"
  // - "9 pm Pacific"
  // - "08:30 America/Denver"
  // - "20:15 UTC"
  const m = s.match(/^\s*(\d{1,2})(?:\s*:\s*(\d{2}))?\s*(am|pm)?\s+(.+?)\s*$/i);
  if (!m) {
    return {
      ok: false,
      error: 'Invalid format. Examples: "8am MST", "9pm Pacific", "08:30 America/Denver".',
    };
  }

  const hourRaw = Number(m[1]);
  const minuteRaw = m[2] ? Number(m[2]) : 0;
  const ampm = (m[3] ?? '').toLowerCase() as '' | 'am' | 'pm';
  const tzRaw = String(m[4] ?? '').trim();

  if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) {
    return { ok: false, error: 'Hour must be between 0 and 23 (or 1-12 with am/pm).' };
  }
  if (!Number.isFinite(minuteRaw) || minuteRaw < 0 || minuteRaw > 59) {
    return { ok: false, error: 'Minute must be between 00 and 59.' };
  }

  let hour = hourRaw;
  if (ampm) {
    if (hourRaw < 1 || hourRaw > 12) {
      return { ok: false, error: 'With am/pm, hour must be between 1 and 12.' };
    }
    hour = hourRaw % 12;
    if (ampm === 'pm') hour += 12;
  }

  const timeZone = normalizeTzToken(tzRaw);
  try {
    assertValidTimeZone(timeZone);
  } catch {
    return {
      ok: false,
      error: `Invalid timezone: "${tzRaw}". Try "Pacific", "MST", or an IANA zone like "America/Denver".`,
    };
  }

  return {
    ok: true,
    value: {
      hour,
      minute: minuteRaw,
      timeZone,
      original: s,
    },
  };
}

export function getZonedYmdHm(
  now: Date,
  timeZone: string,
): {
  ymd: string;
  hour: number;
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = fmt.formatToParts(now);
  const byType = new Map(parts.map((p) => [p.type, p.value] as const));
  const year = byType.get('year') ?? '0000';
  const month = byType.get('month') ?? '00';
  const day = byType.get('day') ?? '00';
  const hour = Number(byType.get('hour') ?? 'NaN');
  const minute = Number(byType.get('minute') ?? 'NaN');

  return {
    ymd: `${year}-${month}-${day}`,
    hour: Number.isFinite(hour) ? hour : -1,
    minute: Number.isFinite(minute) ? minute : -1,
  };
}
