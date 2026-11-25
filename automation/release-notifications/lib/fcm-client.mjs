const PROJECT_ID_REGEX = /^[a-z0-9-]{4,30}$/;
// Only 429 and 503 guarantee FCM did not process/enqueue the request; 500/502/504/network drops are ambiguous.
const RETRYABLE_DEFINITE_STATUSES = new Set([429, 503]);
const AMBIGUOUS_STATUSES = new Set([500, 502, 504]);

export function isValidProjectId(projectId) {
  return typeof projectId === 'string' && PROJECT_ID_REGEX.test(projectId);
}

export function isRetryableStatus(status) {
  return RETRYABLE_DEFINITE_STATUSES.has(status);
}

export function isAmbiguousStatus(status) {
  return AMBIGUOUS_STATUSES.has(status);
}

export function parseRetryAfterMs(headerVal, maxMs = 15_000) {
  if (!headerVal) return null;
  const trimmed = String(headerVal).trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number.parseInt(trimmed, 10) * 1000;
    return Math.min(maxMs, Math.max(0, ms));
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.min(maxMs, Math.max(0, timestamp - Date.now()));
}

/**
 * Redacts OAuth access tokens, JWTs, API keys, and GitHub tokens from diagnostic strings.
 */
export function redactSensitive(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED_OAUTH_TOKEN]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/gh[opsu]_[0-9A-Za-z]{20,}/g, '[REDACTED_GH_TOKEN]');
}

function extractFcmErrorSummary(status, bodyText, secrets) {
  let errorCode = null;
  let message = '';
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed?.error ?? {};
    errorCode =
      err?.details?.find?.((d) => d?.errorCode)?.errorCode ??
      err?.status ??
      null;
    message = typeof err?.message === 'string' ? err.message : '';
  } catch {
    message = bodyText.slice(0, 140);
  }
  const summary = errorCode ? `HTTP ${status} (${errorCode})` : `HTTP ${status}${message ? `: ${message.slice(0, 100)}` : ''}`;
  return {
    errorCode: errorCode ? String(errorCode) : null,
    errorSummary: redactSensitive(summary, secrets),
  };
}

/**
 * Dispatches one message (or dry-run validate_only check) via the FCM HTTP v1 API
 * with bounded exponential backoff + jitter on transient 429/5xx/network errors.
 */
export async function sendFcmMessage({
  projectId,
  accessToken,
  payload,
  validateOnly = false,
  endpointBase = 'https://fcm.googleapis.com',
  maxAttempts = 3,
  baseDelayMs = 1000,
  maxDelayMs = 15_000,
  timeoutMs = 15_000,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid Firebase projectId "${String(projectId)}".`);
  }
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('FCM_ACCESS_TOKEN is missing or empty.');
  }

  const endpointUrl = new URL(`/v1/projects/${projectId}/messages:send`, endpointBase).toString();
  const requestBody = JSON.stringify(
    validateOnly ? { ...payload, validate_only: true } : payload,
  );
  const secrets = [accessToken];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const safeErr = redactSensitive(err?.message ?? String(err), secrets);
      if (validateOnly && attempt < maxAttempts) {
        const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleepImpl(delayMs);
        continue;
      }
      return {
        ok: false,
        deliveryState: validateOnly ? 'failed' : 'ambiguous',
        ambiguous: !validateOnly,
        status: null,
        messageName: null,
        errorCode: 'NETWORK_ERROR',
        errorSummary: safeErr,
        attempts: attempt,
        validateOnly,
      };
    }

    const bodyText = await response.text();
    if (response.ok) {
      let messageName = null;
      try {
        const parsed = JSON.parse(bodyText);
        messageName = typeof parsed?.name === 'string' ? redactSensitive(parsed.name, secrets) : null;
      } catch {
        messageName = null;
      }
      return {
        ok: true,
        deliveryState: 'sent',
        ambiguous: false,
        status: response.status,
        messageName,
        errorCode: null,
        errorSummary: null,
        attempts: attempt,
        validateOnly,
      };
    }

    const { errorCode, errorSummary } = extractFcmErrorSummary(response.status, bodyText, secrets);
    const definiteRetry = isRetryableStatus(response.status);
    const ambiguousStatus = isAmbiguousStatus(response.status);

    if ((definiteRetry || (validateOnly && ambiguousStatus)) && attempt < maxAttempts) {
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'), maxDelayMs);
      const jitter = Math.floor(Math.random() * Math.max(1, Math.min(250, baseDelayMs)));
      const computedDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1) + jitter);
      await sleepImpl(retryAfter ?? computedDelay);
      continue;
    }

    const ambiguous = !validateOnly && ambiguousStatus;
    return {
      ok: false,
      deliveryState: ambiguous ? 'ambiguous' : 'failed',
      ambiguous,
      status: response.status,
      messageName: null,
      errorCode,
      errorSummary,
      attempts: attempt,
      validateOnly,
    };
  }

  return {
    ok: false,
    deliveryState: 'failed',
    ambiguous: false,
    status: null,
    messageName: null,
    errorCode: 'EXHAUSTED_RETRIES',
    errorSummary: 'Exhausted FCM delivery attempts.',
    attempts: maxAttempts,
    validateOnly,
  };
}
