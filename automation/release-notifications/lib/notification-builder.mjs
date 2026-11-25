export const CHANNEL_ID = 'duit_developer_broadcasts';
export const TOPIC_BETA = 'duit_beta_broadcasts';
export const TOPIC_STABLE = 'duit_announcements';
export const MAX_TITLE_LENGTH = 100;
export const MAX_BODY_LENGTH = 220;
export const DEFAULT_ROUTE = 'home';
export const DEFAULT_TTL = '259200s';

const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const BROADCAST_ID_REGEX = /^[a-z0-9._-]{4,64}$/;
const STOP_SECTIONS_REGEX = /^##\s+(Asset Verification|Before You Install|Known Limitations|Verification)\b/i;

/**
 * Strips control characters, collapses whitespace, and truncates safely at a word boundary.
 */
export function sanitizeNotificationText(raw, maxLen) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(CONTROL_CHARS_REGEX, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;

  const slice = cleaned.slice(0, Math.max(1, maxLen - 1)).trimEnd();
  const lastSpace = slice.lastIndexOf(' ');
  const clipped = lastSpace >= Math.floor(maxLen * 0.6) ? slice.slice(0, lastSpace).trimEnd() : slice;
  return `${clipped}…`;
}

function stripMarkdownFormatting(line) {
  return line
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();
}

function summarizeBullet(bulletText) {
  const clean = stripMarkdownFormatting(bulletText)
    .replace(/\s+[–—-]\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';

  const colonIdx = clean.indexOf(':');
  if (colonIdx > 2 && colonIdx <= 44) {
    const label = clean.slice(0, colonIdx).trim();
    const rest = clean.slice(colonIdx + 1).trim();
    if (rest.length <= 42) {
      return `${label}: ${rest.replace(/\.$/, '')}`;
    }
    return label;
  }

  return sanitizeNotificationText(clean.replace(/\.$/, ''), 68);
}

/**
 * Extracts concise highlights from release notes while ignoring verification footers.
 */
export function extractReleaseHighlights(markdownBody) {
  if (typeof markdownBody !== 'string' || !markdownBody.trim()) {
    return [];
  }

  const lines = markdownBody.replace(/\r\n/g, '\n').split('\n');
  const highlights = [];
  const paragraphs = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (STOP_SECTIONS_REGEX.test(trimmed)) break;
    if (/^SHA-256(\s+APK)?:/i.test(trimmed)) continue;
    if (trimmed.startsWith('#')) continue;

    if (/^[-*+]\s+/.test(trimmed)) {
      const summary = summarizeBullet(trimmed.replace(/^[-*+]\s+/, ''));
      if (summary && !highlights.includes(summary)) {
        highlights.push(summary);
      }
      if (highlights.length >= 3) break;
      continue;
    }

    const cleanPara = stripMarkdownFormatting(trimmed);
    if (cleanPara && !cleanPara.toLowerCase().includes('versioncode')) {
      paragraphs.push(cleanPara);
    }
  }

  if (highlights.length > 0) {
    return highlights.slice(0, 3);
  }

  if (paragraphs.length > 0) {
    const firstSentence = paragraphs[0].split(/(?<=[.!?])\s+/)[0] || paragraphs[0];
    const summarized = sanitizeNotificationText(firstSentence, 120);
    return summarized ? [summarized.replace(/\.$/, '')] : [];
  }

  return [];
}

/**
 * Computes deterministic broadcast_id, notification copy, target topics, and FCM HTTP v1 payloads.
 */
export function buildNotificationPlan(releaseInfo) {
  const broadcastId = `duit-release-${releaseInfo.version.toLowerCase()}`;
  if (!BROADCAST_ID_REGEX.test(broadcastId)) {
    throw new Error(`Generated broadcastId "${broadcastId}" failed safety validation.`);
  }

  const rawTitle = releaseInfo.prerelease
    ? `duit. ${releaseInfo.version} Beta is ready`
    : `duit. v${releaseInfo.version} is now available`;
  const title = sanitizeNotificationText(rawTitle, MAX_TITLE_LENGTH);

  const highlights = extractReleaseHighlights(releaseInfo.body);
  const rawBody =
    highlights.length > 0
      ? `${highlights.join(' · ')}. Open duit. to update in-app.`
      : releaseInfo.prerelease
        ? 'A new Beta update for duit. is available. Open duit. to update in-app.'
        : 'A new Stable update for duit. is available. Open duit. to update safely in-app.';
  const body = sanitizeNotificationText(rawBody, MAX_BODY_LENGTH);

  const targets = releaseInfo.prerelease ? [TOPIC_BETA] : [TOPIC_STABLE, TOPIC_BETA];
  const data = {
    title,
    body,
    route: DEFAULT_ROUTE,
    broadcast_id: broadcastId,
    release_tag: releaseInfo.tag,
    release_channel: releaseInfo.channel,
    version_code: String(releaseInfo.versionCode),
  };

  for (const [k, v] of Object.entries(data)) {
    if (!k || k.trim() !== k || typeof v !== 'string') {
      throw new Error(`Invalid FCM data entry key "${k}".`);
    }
  }

  const messages = targets.map((topic) => ({
    topic,
    payload: {
      message: {
        topic,
        notification: {
          title,
          body,
        },
        data: { ...data },
        android: {
          ttl: DEFAULT_TTL,
          collapse_key: broadcastId,
          notification: {
            channel_id: CHANNEL_ID,
            tag: broadcastId,
            visibility: 'PRIVATE',
          },
        },
      },
    },
  }));

  return {
    broadcastId,
    channelId: CHANNEL_ID,
    title,
    body,
    highlights,
    targets,
    messages,
  };
}
