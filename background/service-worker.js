const DEFAULT_STATE = {
  status: 'idle',
  step: '',
  error: null,
  session: null,
  lastProfile: null,
  pendingProfile: null,
  duckTabId: null,
  gmailTabId: null,
  regularWindowId: null,
  cpaTabId: null,
  oauthTabId: null,
  oauthCallbackUrl: null,
  cpaAuthState: null,
  oauthSourceUrl: null,
  oauthForceLogin: false,
  aupmailSession: null,
  verifyInboxStatus: {
    email: '',
    state: 'idle',
    message: ''
  },
  latestMail: {
    sender: '',
    subject: '',
    time: '',
    preview: ''
  },
  batchActive: false,
  batchTotal: 1,
  batchCurrentIndex: 0,
  batchFinishedCount: 0,
  batchSuccessCount: 0,
  batchFailedCount: 0,
  batchProfileTemplate: null,
  useIncognito: true,
  consumedMailIds: [],
  finalFlowStarted: false,
  postSignupPending: false,
  paused: false
};

let state = { ...DEFAULT_STATE };
let duckAddressWaiter = null;
let gmailCodeWaiter = null;
let batchAdvanceTimer = null;
let batchAdvancing = false;
const CONFIG_KEY = 'app_config';
const FLOW_STATE_KEY = 'flow_state';
const DEFAULT_CPA_API_BASE = 'https://huangcli.zeabur.app';
const DUCK_FORWARD_AUPMAIL_EMAIL = '';
const DEFAULT_MAILBOX_API_BASE = 'http://74.48.147.156:8787';
const DEFAULT_MAILBOX_API_KEY = 'tm_admin_4eb9dc0f02948ddfbb4595dc511465364bbf37ed26265483';

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function generateProfile(input = {}) {
  const firstNames = ['Alex', 'Sam', 'Chris', 'Taylor', 'Jordan', 'Avery', 'Morgan', 'Jamie'];
  const lastNames = ['Lee', 'Brown', 'Clark', 'Davis', 'Hall', 'Parker', 'Reed', 'Stone'];
  const firstName = (input.firstName || '').trim() || randomItem(firstNames);
  const lastName = (input.lastName || '').trim() || randomItem(lastNames);
  const password = (input.password || '').trim() || `Cgpt!${Math.random().toString(36).slice(2, 10)}9`;

  return {
    email: (input.email || '').trim(),
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    password
  };
}


function normalizeBatchCount(value, fallback = 1) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < 1) {
    const fallbackNumeric = Number.parseInt(fallback, 10);
    return Number.isFinite(fallbackNumeric) && fallbackNumeric > 0 ? fallbackNumeric : 1;
  }
  return Math.min(numeric, 200);
}


function getPublicState() {
  return {
    status: state.status,
    step: state.step,
    error: state.error,
    session: state.session,
    lastProfile: state.lastProfile || state.pendingProfile,
    oauthSourceUrl: state.oauthSourceUrl || '',
    verifyInboxStatus: state.verifyInboxStatus || { email: '', state: 'idle', message: '' },
    latestMail: state.latestMail || { sender: '', subject: '', time: '', preview: '' },
    batchActive: Boolean(state.batchActive),
    batchTotal: normalizeBatchCount(state.batchTotal, 1),
    batchCurrentIndex: Math.max(0, Number.parseInt(state.batchCurrentIndex, 10) || 0),
    batchFinishedCount: Math.max(0, Number.parseInt(state.batchFinishedCount, 10) || 0),
    batchSuccessCount: Math.max(0, Number.parseInt(state.batchSuccessCount, 10) || 0),
    batchFailedCount: Math.max(0, Number.parseInt(state.batchFailedCount, 10) || 0),
    useIncognito: state.useIncognito !== false,
    paused: Boolean(state.paused)
  };
}

function broadcastState() {
  chrome.runtime.sendMessage({
    type: 'STATE_UPDATE',
    state: getPublicState()
  }).catch(() => {});
}

function clearBatchAdvanceTimer() {
  if (batchAdvanceTimer) {
    clearTimeout(batchAdvanceTimer);
    batchAdvanceTimer = null;
  }
}

async function advanceBatchIfNeeded() {
  if (batchAdvancing || !state.batchActive) {
    return;
  }
  if (!['completed', 'error'].includes(state.status)) {
    return;
  }
  if ((state.batchFinishedCount || 0) >= (state.batchCurrentIndex || 0)) {
    return;
  }

  batchAdvancing = true;
  try {
    const total = normalizeBatchCount(state.batchTotal, 1);
    const finished = (state.batchFinishedCount || 0) + 1;
    const success = (state.batchSuccessCount || 0) + (state.status === 'completed' ? 1 : 0);
    const failed = (state.batchFailedCount || 0) + (state.status === 'error' ? 1 : 0);

    if (finished >= total) {
      updateState({
        batchActive: false,
        batchFinishedCount: finished,
        batchSuccessCount: success,
        batchFailedCount: failed,
        status: 'completed',
        error: null,
        step: `Batch finished: ${success}/${total} succeeded${failed ? `, ${failed} failed` : ''}`
      });
      return;
    }

    const nextIndex = finished + 1;
    updateState({
      batchFinishedCount: finished,
      batchSuccessCount: success,
      batchFailedCount: failed,
      batchCurrentIndex: nextIndex,
      status: 'running',
      error: null,
      step: `Starting account ${nextIndex}/${total}`
    });

    await new Promise((resolve) => setTimeout(resolve, 900));
    await startSingleRegistration(state.batchProfileTemplate || {});
  } catch (error) {
    updateState({
      status: 'error',
      error: error.message || String(error)
    });
  } finally {
    batchAdvancing = false;
  }
}

function scheduleBatchAdvance() {
  if (!state.batchActive || !['completed', 'error'].includes(state.status)) {
    return;
  }
  if (batchAdvanceTimer || batchAdvancing) {
    return;
  }

  batchAdvanceTimer = setTimeout(() => {
    batchAdvanceTimer = null;
    advanceBatchIfNeeded().catch(() => {});
  }, 1200);
}

function updateState(updates) {
  const previousStatus = state.status;
  state = { ...state, ...updates };
  chrome.storage.local.set({
    [FLOW_STATE_KEY]: {
      finalFlowStarted: Boolean(state.finalFlowStarted),
      postSignupPending: Boolean(state.postSignupPending),
      step: state.step || '',
      paused: Boolean(state.paused)
    }
  }).catch(() => {});
  broadcastState();
  if (previousStatus !== state.status && ['completed', 'error'].includes(state.status)) {
    scheduleBatchAdvance();
  }
}

async function getPersistedFlowState() {
  const stored = await chrome.storage.local.get(FLOW_STATE_KEY);
  return stored?.[FLOW_STATE_KEY] || {
    finalFlowStarted: false,
    postSignupPending: false,
    step: '',
    paused: false
  };
}

async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const defaults = {
    cpaKey: '',
    cpaUrl: DEFAULT_CPA_API_BASE,
    oauthUrl: '',
    batchCount: 1,
    runInIncognito: true,
    emailProvider: 'mailapi',
    duckForwardEmail: DUCK_FORWARD_AUPMAIL_EMAIL,
    duckForwardPassword: DEFAULT_MAILBOX_API_KEY,
    mailApiUrl: DEFAULT_MAILBOX_API_BASE,
    mailApiKey: DEFAULT_MAILBOX_API_KEY,
    mailDomain: ''
  };
  const saved = stored?.[CONFIG_KEY] || {};
  const next = {
    ...defaults,
    ...saved
  };
  next.emailProvider = next.emailProvider === 'duckduckgo' ? 'duckduckgo' : 'mailapi';
  next.batchCount = normalizeBatchCount(next.batchCount, 1);
  next.runInIncognito = next.runInIncognito !== false;
  next.mailApiUrl = String(next.mailApiUrl || DEFAULT_MAILBOX_API_BASE).trim() || DEFAULT_MAILBOX_API_BASE;
  next.mailApiKey = String(next.mailApiKey || next.duckForwardPassword || DEFAULT_MAILBOX_API_KEY).trim();
  next.duckForwardPassword = next.mailApiKey;
  next.mailDomain = String(next.mailDomain || '').trim();
  return next;
}

async function setConfig(config) {
  const provider = config?.emailProvider === 'duckduckgo' ? 'duckduckgo' : 'mailapi';
  const mailApiKey = (config?.mailApiKey || config?.duckForwardPassword || DEFAULT_MAILBOX_API_KEY).trim();
  const nextConfig = {
    emailProvider: provider,
    batchCount: normalizeBatchCount(config?.batchCount, 1),
    runInIncognito: config?.runInIncognito !== false,
    oauthUrl: (config?.oauthUrl || '').trim(),
    cpaUrl: (config?.cpaUrl || DEFAULT_CPA_API_BASE).trim() || DEFAULT_CPA_API_BASE,
    cpaKey: (config?.cpaKey || '').trim(),
    duckForwardEmail: (config?.duckForwardEmail || DUCK_FORWARD_AUPMAIL_EMAIL).trim() || DUCK_FORWARD_AUPMAIL_EMAIL,
    duckForwardPassword: mailApiKey,
    mailApiUrl: (config?.mailApiUrl || DEFAULT_MAILBOX_API_BASE).trim() || DEFAULT_MAILBOX_API_BASE,
    mailApiKey,
    mailDomain: (config?.mailDomain || '').trim()
  };
  await chrome.storage.local.set({
    [CONFIG_KEY]: nextConfig
  });
  return nextConfig;
}

function randomString(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}


function buildMailboxLocalPart(prefix = '') {
  const normalizedPrefix = String(prefix || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  return `${normalizedPrefix || 'cgpt'}${randomString(8)}`;
}

function splitMailboxAddress(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  const match = normalized.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!match) {
    return { localPart: '', domain: '' };
  }
  return {
    localPart: match[1],
    domain: match[2]
  };
}

function normalizeMailboxApiBaseUrl(baseUrl = '') {
  const fallback = DEFAULT_MAILBOX_API_BASE;
  const candidate = String(baseUrl || '').trim() || fallback;
  return candidate.replace(/\/+$/, '');
}

async function resolveMailboxApiConfig(overrides = {}) {
  const config = await getConfig();
  const apiKey = String(
    overrides.apiKey ||
    config.mailApiKey ||
    config.duckForwardPassword ||
    DEFAULT_MAILBOX_API_KEY ||
    ''
  ).trim();

  return {
    baseUrl: normalizeMailboxApiBaseUrl(overrides.baseUrl || config.mailApiUrl || DEFAULT_MAILBOX_API_BASE),
    apiKey,
    domain: String(overrides.domain || config.mailDomain || '').trim().toLowerCase()
  };
}

async function mailboxApiFetch(path, options = {}) {
  const apiConfig = await resolveMailboxApiConfig(options.apiConfig || {});
  if (!apiConfig.apiKey) {
    throw new Error('Mailbox API key is not configured');
  }

  const requestUrl = new URL(`${apiConfig.baseUrl}${path}`);
  if (options.apiKeyInQuery) {
    requestUrl.searchParams.set('api_key', apiConfig.apiKey);
  }

  const response = await fetch(requestUrl.toString(), {
    method: options.method || 'GET',
    headers: Object.fromEntries(Object.entries({
      Accept: 'application/json, text/plain, */*',
      Authorization: options.apiKeyInQuery ? undefined : `Bearer ${apiConfig.apiKey}`,
      'Content-Type': options.body ? 'application/json' : undefined,
      ...options.headers
    }).filter(([, value]) => value != null)),
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error ||
      payload?.detail ||
      payload?.msg ||
      `Mailbox API request failed: ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function pickArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractListFromPayload(payload) {
  const candidates = [
    payload,
    payload?.data,
    payload?.data?.items,
    payload?.data?.list,
    payload?.data?.records,
    payload?.items,
    payload?.list,
    payload?.records,
    payload?.mailboxes,
    payload?.emails
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function extractMailboxId(item) {
  return String(
    item?.id ||
    item?.mailbox_id ||
    item?.mailboxId ||
    item?.mailboxID ||
    item?._id ||
    item?.data?.id ||
    ''
  ).trim();
}

function extractMailboxAddress(item) {
  const fullAddress = String(
    item?.full_address ||
    item?.fullAddress ||
    item?.mailbox_full_address ||
    item?.mailboxFullAddress ||
    item?.data?.full_address ||
    item?.data?.fullAddress ||
    ''
  ).trim().toLowerCase();
  if (fullAddress.includes('@')) {
    return fullAddress;
  }

  const basicAddress = String(
    item?.address ||
    item?.email ||
    item?.mailbox ||
    item?.mailbox_address ||
    item?.mailboxAddress ||
    item?.data?.address ||
    item?.data?.email ||
    ''
  ).trim().toLowerCase();
  if (basicAddress.includes('@')) {
    return basicAddress;
  }

  const domain = String(
    item?.domain ||
    item?.domain_name ||
    item?.domainName ||
    item?.data?.domain ||
    item?.data?.domain_name ||
    ''
  ).trim().toLowerCase();
  if (basicAddress && domain) {
    return `${basicAddress}@${domain}`;
  }
  return basicAddress;
}

function normalizeMailboxRecord(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const mailboxId = extractMailboxId(item);
  const email = extractMailboxAddress(item);
  if (!mailboxId) {
    return null;
  }

  return {
    raw: item,
    mailboxId,
    email
  };
}

function extractMailboxRecord(payload) {
  const directCandidates = [
    payload?.data?.mailbox,
    payload?.mailbox,
    payload?.data,
    payload
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeMailboxRecord(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const list = extractListFromPayload(payload);
  for (const item of list) {
    const normalized = normalizeMailboxRecord(item);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

async function listMailboxes(apiConfig, page = 1, size = 100) {
  const payload = await mailboxApiFetch(`/api/mailboxes?page=${page}&size=${size}`, {
    method: 'GET',
    apiConfig
  });
  return pickArray(extractListFromPayload(payload));
}

async function findMailboxByAddress(address, apiConfig) {
  const target = String(address || '').trim().toLowerCase();
  if (!target) {
    return null;
  }
  const { localPart: targetLocalPart } = splitMailboxAddress(target);

  const size = 100;
  for (let page = 1; page <= 5; page += 1) {
    const records = await listMailboxes(apiConfig, page, size);
    const hit = records.find((item) => {
      const candidate = extractMailboxAddress(item);
      if (!candidate) {
        return false;
      }
      if (candidate === target) {
        return true;
      }
      const { localPart } = splitMailboxAddress(candidate);
      return Boolean(targetLocalPart && localPart && targetLocalPart === localPart);
    });
    if (hit) {
      return normalizeMailboxRecord(hit);
    }

    if (records.length < size) {
      break;
    }
  }

  return null;
}

async function createMailboxSession(options = {}) {
  const apiConfig = await resolveMailboxApiConfig(options.apiConfig || {});
  if (!apiConfig.apiKey) {
    throw new Error('Mailbox API key is not configured');
  }

  const requestBody = {};
  if (typeof options.permanent === 'boolean') {
    requestBody.permanent = options.permanent;
  }
  if (typeof options.autoSubdomain === 'boolean') {
    requestBody.auto_subdomain = options.autoSubdomain;
  }

  const addressInput = String(options.address || '').trim().toLowerCase();
  const split = splitMailboxAddress(addressInput);
  if (split.localPart) {
    requestBody.address = split.localPart;
  } else if (addressInput && !addressInput.includes('@')) {
    requestBody.address = addressInput.replace(/[^a-z0-9._-]/g, '').slice(0, 64);
  }
  if (split.domain) {
    requestBody.domain = split.domain;
  } else if (apiConfig.domain) {
    requestBody.domain = apiConfig.domain;
    if (apiConfig.domain.startsWith('*.')) {
      requestBody.auto_subdomain = true;
    }
  }

  let payload;
  try {
    payload = await mailboxApiFetch('/api/mailboxes', {
      method: 'POST',
      body: requestBody,
      apiConfig
    });
  } catch (error) {
    if (Object.keys(requestBody).length > 0) {
      payload = await mailboxApiFetch('/api/mailboxes', {
        method: 'POST',
        body: { permanent: Boolean(options.permanent) },
        apiConfig
      });
    } else {
      throw error;
    }
  }

  const mailbox = extractMailboxRecord(payload);
  if (!mailbox?.mailboxId) {
    throw new Error('Mailbox API create mailbox response missing mailbox id');
  }

  if (!mailbox.email) {
    const records = await listMailboxes(apiConfig, 1, 100);
    const hit = records.map((item) => normalizeMailboxRecord(item)).find((item) => item?.mailboxId === mailbox.mailboxId);
    if (hit?.email) {
      mailbox.email = hit.email;
    }
  }

  return {
    email: mailbox.email || '',
    password: '',
    mailboxId: mailbox.mailboxId,
    apiKey: apiConfig.apiKey,
    apiBaseUrl: apiConfig.baseUrl,
    managedMailbox: Boolean(options.managedMailbox)
  };
}

async function registerAupmailAccount(profile) {
  const localPart = buildMailboxLocalPart(profile.firstName || 'cgpt');
  const session = await createMailboxSession({
    address: localPart,
    permanent: false,
    managedMailbox: true
  });

  if (!session.email) {
    throw new Error('Mailbox API did not return created mailbox address');
  }

  return session;
}

async function loginAupmailAccount(email, password) {
  const apiConfig = await resolveMailboxApiConfig({ apiKey: password });
  if (!apiConfig.apiKey) {
    throw new Error('Mailbox API key is missing');
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error('Mailbox address is required');
  }

  let mailbox = await findMailboxByAddress(normalizedEmail, apiConfig);
  if (!mailbox) {
    const created = await createMailboxSession({
      address: normalizedEmail,
      permanent: true,
      apiConfig,
      managedMailbox: false
    });

    mailbox = {
      mailboxId: created.mailboxId,
      email: created.email || normalizedEmail
    };
  }

  return {
    email: mailbox.email || normalizedEmail,
    password: '',
    mailboxId: mailbox.mailboxId,
    apiKey: apiConfig.apiKey,
    apiBaseUrl: apiConfig.baseUrl,
    managedMailbox: false
  };
}

function extractOpenAiCode(text) {
  const normalized = String(text || '');
  if (!/(openai|chatgpt|verification|verify|code|otp|login|signin|signup|register|auth)/i.test(normalized)) {
    return '';
  }
  const patterns = [
    /your\s*(?:chatgpt|openai)?\s*(?:verification\s*)?code\s*(?:is|:)?\s*(\d{5,6})/i,
    /\b(?:verification|verify|security|login|signin|sign in|signup|sign up|register|auth|authentication|otp|code)\b[^0-9]{0,30}(\d{5,6})/i,
    /(?:openai|chatgpt)[^0-9]{0,25}(\d{5,6})/i,
    /(?:verification|code|otp)[^0-9]{0,20}(\d{5,6})/i,
    /\b(\d{5,6})\b/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return '';
}

async function fetchAupmailMessageDetail(id, session) {
  if (!id || !session?.mailboxId) {
    return null;
  }

  return mailboxApiFetch(`/api/mailboxes/${encodeURIComponent(session.mailboxId)}/emails/${encodeURIComponent(id)}`, {
    method: 'GET',
    apiConfig: {
      baseUrl: session.apiBaseUrl,
      apiKey: session.apiKey
    }
  }).catch(() => null);
}

async function deleteAupmailEmail(emailId, session) {
  if (!emailId || !session?.mailboxId) {
    return false;
  }

  await mailboxApiFetch(`/api/mailboxes/${encodeURIComponent(session.mailboxId)}/emails/${encodeURIComponent(emailId)}`, {
    method: 'DELETE',
    apiConfig: {
      baseUrl: session.apiBaseUrl,
      apiKey: session.apiKey
    }
  }).catch(() => null);

  return true;
}

async function deleteAupmailMailbox(session) {
  if (!session?.managedMailbox || !session?.mailboxId) {
    return false;
  }

  await mailboxApiFetch(`/api/mailboxes/${encodeURIComponent(session.mailboxId)}`, {
    method: 'DELETE',
    apiConfig: {
      baseUrl: session.apiBaseUrl,
      apiKey: session.apiKey
    }
  }).catch(() => null);

  return true;
}

async function cleanupManagedMailboxSession(session) {
  if (!session?.managedMailbox) {
    return;
  }
  await deleteAupmailMailbox(session).catch(() => null);
}

async function fetchAupmailEmailList(session) {
  if (!session?.mailboxId) {
    throw new Error('Mailbox session is missing mailbox id');
  }

  const payload = await mailboxApiFetch(`/api/mailboxes/${encodeURIComponent(session.mailboxId)}/emails?page=1&size=50`, {
    method: 'GET',
    apiConfig: {
      baseUrl: session.apiBaseUrl,
      apiKey: session.apiKey
    }
  });

  return pickArray(extractListFromPayload(payload));
}

function collectDeepText(value, seen = new Set()) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'object') {
    return '';
  }
  if (seen.has(value)) {
    return '';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => collectDeepText(entry, seen)).filter(Boolean).join('\n');
  }

  return Object.values(value).map((entry) => collectDeepText(entry, seen)).filter(Boolean).join('\n');
}

function matchesExpectedRecipient(item, expectedRecipient) {
  const normalizedRecipient = String(expectedRecipient || '').trim().toLowerCase();
  if (!normalizedRecipient) {
    return true;
  }

  return collectDeepText(item).toLowerCase().includes(normalizedRecipient);
}

function looksLikeVerificationMail(text) {
  return /(openai|chatgpt|verification|verify|code|otp|signin|sign in|sign up|signup|auth|login|register)/i.test(String(text || ''));
}

function parseEmailTimestamp(value) {
  if (value == null || value === '') {
    return 0;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const normalized = String(value).trim();
  if (/^\d+$/.test(normalized)) {
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getEmailTimestamp(item) {
  return Math.max(
    parseEmailTimestamp(item?.createTime),
    parseEmailTimestamp(item?.createdAt),
    parseEmailTimestamp(item?.created_at),
    parseEmailTimestamp(item?.sendTime),
    parseEmailTimestamp(item?.sentAt),
    parseEmailTimestamp(item?.sent_at),
    parseEmailTimestamp(item?.time),
    parseEmailTimestamp(item?.date),
    parseEmailTimestamp(item?.gmtCreate),
    parseEmailTimestamp(item?.receivedAt),
    parseEmailTimestamp(item?.received_at),
    parseEmailTimestamp(item?.receiveTime),
    parseEmailTimestamp(item?.data?.createTime),
    parseEmailTimestamp(item?.data?.created_at),
    parseEmailTimestamp(item?.data?.sendTime),
    parseEmailTimestamp(item?.data?.sent_at)
  );
}

function getEmailIdentity(item) {
  return String(
    item?.id ||
    item?.emailId ||
    item?.email_id ||
    item?.mailId ||
    item?.messageId ||
    item?.message_id ||
    item?.data?.id ||
    item?.data?.emailId ||
    item?.data?.email_id ||
    ''
  ).trim();
}

function summarizeEmailForStatus(item) {
  if (!item) {
    return '';
  }
  const sender = item?.sendEmail || item?.from || item?.sender || item?.fromAddress || item?.from_address || '-';
  const subject = item?.subject || item?.title || '(no subject)';
  const timestamp = getEmailTimestamp(item);
  const timeText = timestamp ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : 'unknown time';
  return `${sender} | ${subject} | ${timeText}`;
}

function buildLatestMailState(item, detail = null) {
  const sender = item?.sendEmail || item?.from || item?.sender || item?.fromAddress || item?.from_address || detail?.sendEmail || detail?.from || detail?.fromAddress || '-';
  const subject = item?.subject || item?.title || detail?.subject || '(no subject)';
  const timestamp = getEmailTimestamp(item) || getEmailTimestamp(detail);
  const time = timestamp ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
  const previewSource = collectDeepText(detail || item).replace(/\s+/g, ' ').trim();
  return {
    sender,
    subject,
    time,
    preview: previewSource.slice(0, 240) || ''
  };
}

function getConsumedMailIds() {
  return new Set(Array.isArray(state.consumedMailIds) ? state.consumedMailIds : []);
}

function markMailConsumed(emailId) {
  if (!emailId) {
    return;
  }
  const current = Array.isArray(state.consumedMailIds) ? state.consumedMailIds : [];
  if (current.includes(emailId)) {
    return;
  }
  const next = [...current, emailId].slice(-100);
  updateState({
    consumedMailIds: next
  });
}

async function requestAupmailCode(options = {}) {
  const session = options.session || state.aupmailSession;
  if (!session?.apiKey || !session?.mailboxId) {
    throw new Error('Mailbox session is missing');
  }

  const startedAt = Date.now();
  const timeoutMs = 240000;
  const expectedRecipient = String(options.expectedRecipient || state.lastProfile?.email || '').trim().toLowerCase();
  const notBeforeMs = startedAt - 15000;
  const seenEmailIds = new Set();
  const consumedMailIds = getConsumedMailIds();

  const initialEmails = await fetchAupmailEmailList(session);
  for (const item of initialEmails) {
    const emailId = getEmailIdentity(item);
    if (emailId) {
      seenEmailIds.add(emailId);
    }
  }

  while (Date.now() - startedAt < timeoutMs) {
    const rawEmails = await fetchAupmailEmailList(session);
    const allEmails = rawEmails
      .map((item) => ({
        item,
        emailId: getEmailIdentity(item),
        timestamp: getEmailTimestamp(item)
      }))
      .sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0));

    const emails = allEmails
      .map((item) => ({
        item: item.item,
        emailId: item.emailId,
        timestamp: item.timestamp
      }))
      .filter(({ timestamp }) => !timestamp || timestamp >= notBeforeMs)
      .sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0));

    if (allEmails[0]?.item) {
      updateState({
        verifyInboxStatus: {
          email: session.email || '',
          state: 'connected',
          message: rawEmails.length
            ? `Mail count: ${rawEmails.length}. Latest: ${summarizeEmailForStatus(allEmails[0].item)}`
            : `Mail count: 0. mailboxId=${session.mailboxId}`
        },
        latestMail: buildLatestMailState(allEmails[0].item)
      });
    } else {
      updateState({
        verifyInboxStatus: {
          email: session.email || '',
          state: 'connected',
          message: `Mail count: 0. mailboxId=${session.mailboxId}`
        },
        latestMail: {
          sender: '',
          subject: '',
          time: '',
          preview: ''
        }
      });
    }

    const freshEmails = emails.filter(({ emailId }) => emailId && !seenEmailIds.has(emailId) && !consumedMailIds.has(emailId));
    const latestReusableEmails = allEmails.filter(({ emailId }) => emailId && !consumedMailIds.has(emailId)).slice(0, 3);
    const candidateEmails = freshEmails.length ? freshEmails : latestReusableEmails;

    for (const { item, emailId } of candidateEmails) {
      if (emailId) {
        seenEmailIds.add(emailId);
      }

      const itemText = collectDeepText(item);
      const itemCode = extractOpenAiCode(itemText);
      if (itemCode) {
        await deleteAupmailEmail(emailId, session).catch(() => null);
        markMailConsumed(emailId);
        return itemCode;
      }

      const detailId = item?.id || item?.emailId || item?.email_id;
      if (!detailId) {
        continue;
      }

      const detail = await fetchAupmailMessageDetail(detailId, session);
      updateState({
        latestMail: buildLatestMailState(item, detail)
      });
      const detailText = collectDeepText(detail);
      const detailRecipientMatched = matchesExpectedRecipient(detail, expectedRecipient);
      const detailCode = extractOpenAiCode(detailText);
      if (detailRecipientMatched && detailCode) {
        await deleteAupmailEmail(emailId, session).catch(() => null);
        markMailConsumed(emailId);
        return detailCode;
      }

      if (!expectedRecipient && detailCode) {
        await deleteAupmailEmail(emailId, session).catch(() => null);
        markMailConsumed(emailId);
        return detailCode;
      }

      if (detailCode && looksLikeVerificationMail(detailText)) {
        await deleteAupmailEmail(emailId, session).catch(() => null);
        markMailConsumed(emailId);
        return detailCode;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`Timed out while waiting for mailbox verification code for ${session.email || session.mailboxId}`);
}

function extractAuthUrlFromResponse(payload) {

  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const candidates = [
    payload.auth_url,
    payload.authUrl,
    payload.url,
    payload.redirect_url,
    payload.redirectUrl,
    payload.authorize_url,
    payload.authorizeUrl,
    payload?.data?.auth_url,
    payload?.data?.authUrl,
    payload?.data?.url,
    payload?.data?.redirect_url,
    payload?.data?.redirectUrl,
    payload?.data?.authorize_url,
    payload?.data?.authorizeUrl
  ];
  return candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value)) || '';
}

function extractStateFromResponse(payload, fallbackUrl = '') {
  if (payload && typeof payload === 'object') {
    const candidates = [
      payload.state,
      payload?.data?.state
    ];
    const direct = candidates.find((value) => typeof value === 'string' && value.trim());
    if (direct) {
      return direct.trim();
    }
  }
  try {
    const url = new URL(fallbackUrl);
    return url.searchParams.get('state') || '';
  } catch (error) {
    return '';
  }
}

async function cpaApiFetch(path, cpaKey, cpaBaseUrl, options = {}) {
  const response = await fetch(`${cpaBaseUrl}${path}`, {
    method: options.method || 'GET',
    headers: Object.fromEntries(Object.entries({
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${cpaKey}`,
      'content-type': options.body ? 'application/json' : undefined,
      ...options.headers
    }).filter(([, value]) => value != null)),
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    throw new Error(`CPA API request failed: ${response.status}`);
  }

  return response.json().catch(() => ({}));
}

async function requestCodexAuthUrl(cpaKey, cpaBaseUrl) {
  const payload = await cpaApiFetch('/v0/management/codex-auth-url?is_webui=true', cpaKey, cpaBaseUrl);
  const authUrl = extractAuthUrlFromResponse(payload);
  const authState = extractStateFromResponse(payload, authUrl);

  if (!authUrl) {
    throw new Error('CPA auth URL missing in API response');
  }

  return {
    authUrl,
    authState
  };
}

async function submitCodexOauthCallback(cpaKey, cpaBaseUrl, redirectUrl) {
  return cpaApiFetch('/v0/management/oauth-callback', cpaKey, cpaBaseUrl, {
    method: 'POST',
    body: {
      provider: 'codex',
      redirect_url: redirectUrl
    }
  });
}

async function pollCodexAuthStatus(cpaKey, cpaBaseUrl, authState, timeoutMs = 120000) {
  if (!authState) {
    return null;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const payload = await cpaApiFetch(`/v0/management/get-auth-status?state=${encodeURIComponent(authState)}`, cpaKey, cpaBaseUrl);
    const normalized = JSON.stringify(payload || {}).toLowerCase();
    if (
      /success|authorized|completed|done/.test(normalized) &&
      !/pending|waiting|processing/.test(normalized)
    ) {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error('Timed out waiting for CPA auth status');
}

function isLocalhostOauthCallbackUrl(url) {
  return /^http:\/\/localhost:1455\/auth\/callback\?/i.test(String(url || ''));
}

async function completeOauthCallbackFlow(redirectUrl) {
  const normalizedRedirectUrl = String(redirectUrl || '').trim();
  if (!isLocalhostOauthCallbackUrl(normalizedRedirectUrl)) {
    throw new Error('Invalid OAuth callback URL');
  }

  const config = await getConfig();
  if (!config.cpaKey) {
    throw new Error('CPA key is not configured');
  }

  if (state.oauthCallbackUrl === normalizedRedirectUrl && state.status === 'completed') {
    return { success: true, skipped: true };
  }

  updateState({
    oauthCallbackUrl: normalizedRedirectUrl,
    step: 'Submitting OAuth callback to CPA',
    error: null
  });
  await submitCodexOauthCallback(config.cpaKey, config.cpaUrl || DEFAULT_CPA_API_BASE, normalizedRedirectUrl);

  updateState({
    status: 'completed',
    step: '已上传',
    error: null
  });
  return { success: true };
}

async function closeAllIncognitoWindows() {
  const windows = await chrome.windows.getAll();
  const incognitoWindows = windows.filter((windowItem) => windowItem.incognito);

  for (const windowItem of incognitoWindows) {
    try {
      await chrome.windows.remove(windowItem.id);
    } catch (error) {
    }
  }
}

async function focusWindow(windowId) {
  if (windowId == null) {
    return;
  }
  try {
    await chrome.windows.update(windowId, { focused: true });
  } catch (error) {
  }
}

async function getActiveTabInWindow(windowId) {
  if (windowId == null) {
    return null;
  }
  const tabs = await chrome.tabs.query({ windowId, active: true });
  return tabs[0] || null;
}

async function findAnyWindow(incognito) {
  const windows = await chrome.windows.getAll({ populate: true });
  const targetWindow = windows.find((windowItem) => windowItem.incognito === incognito) || null;
  if (!targetWindow) {
    return null;
  }
  const activeTab = targetWindow.tabs?.find((tab) => tab.active) || targetWindow.tabs?.[0] || null;
  return {
    windowId: targetWindow.id,
    tab: activeTab
  };
}

async function isIncognitoAccessAllowed() {
  try {
    return await new Promise((resolve) => {
      if (!chrome.extension?.isAllowedIncognitoAccess) {
        resolve(true);
        return;
      }
      chrome.extension.isAllowedIncognitoAccess((allowed) => resolve(Boolean(allowed)));
    });
  } catch (error) {
    return true;
  }
}

async function reuseOrCreateTab({ url, preferredWindowId = null, incognito = false, createWindowIfNeeded = false }) {
  const incognitoAllowed = incognito ? await isIncognitoAccessAllowed() : true;
  if (incognito && !incognitoAllowed) {
    throw new Error('Incognito access is disabled. Please enable \"Allow in Incognito\" for this extension.');
  }
  const targetIncognito = incognito;

  if (preferredWindowId != null) {
    try {
      const activeTab = await getActiveTabInWindow(preferredWindowId);
      if (activeTab?.id && Boolean(activeTab.incognito) === Boolean(targetIncognito)) {
        const updatedTab = await chrome.tabs.update(activeTab.id, { url, active: true });
        await focusWindow(updatedTab.windowId);
        return updatedTab;
      }
    } catch (error) {
    }
  }

  const existingWindow = await findAnyWindow(targetIncognito);
  if (existingWindow?.tab?.id) {
    const updatedTab = await chrome.tabs.update(existingWindow.tab.id, { url, active: true });
    await focusWindow(updatedTab.windowId);
    return updatedTab;
  }

  try {
    if (createWindowIfNeeded) {
      const windowsBefore = await chrome.windows.getAll({ populate: true }).catch(() => []);
      const knownWindowIds = new Set((windowsBefore || []).map((windowItem) => windowItem.id));

      const createdWindow = await chrome.windows.create({
        url,
        incognito: targetIncognito,
        focused: true,
        width: 520,
        height: 860
      });
      const createdTab =
        createdWindow?.tabs?.[0] ||
        (createdWindow && createdWindow.id != null
          ? (await chrome.tabs.query({ windowId: createdWindow.id, active: true }))[0]
          : null);

      if (createdTab?.id) {
        return createdTab;
      }

      if (createdWindow && createdWindow.id != null) {
        const fallbackTab = await chrome.tabs.create({
          windowId: createdWindow.id,
          url,
          active: true
        });
        return fallbackTab || null;
      }

      const windowsAfter = await chrome.windows.getAll({ populate: true }).catch(() => []);
      const newlyCreated = (windowsAfter || []).find((windowItem) => !knownWindowIds.has(windowItem.id));
      if (newlyCreated) {
        const newTab = newlyCreated.tabs?.find((tab) => tab.active) || newlyCreated.tabs?.[0] || null;
        if (newTab?.id) {
          return await chrome.tabs.update(newTab.id, { url, active: true });
        }
      }

      const fallbackWindow = await findAnyWindow(targetIncognito);
      if (fallbackWindow?.tab?.id) {
        return await chrome.tabs.update(fallbackWindow.tab.id, { url, active: true });
      }

      throw new Error(
        targetIncognito
          ? 'Failed to create incognito window. Please enable "Allow in Incognito" for this extension.'
          : 'Failed to create browser window (no window id returned)'
      );
    }

    const createdTab = await chrome.tabs.create({
      url,
      active: true
    });
    await focusWindow(createdTab.windowId);
    return createdTab;
  } catch (error) {
    const fallbackWindow = await findAnyWindow(targetIncognito);
    if (fallbackWindow?.tab?.id) {
      const updatedTab = await chrome.tabs.update(fallbackWindow.tab.id, { url, active: true });
      await focusWindow(updatedTab.windowId);
      return updatedTab;
    }
    throw error;
  }
}

async function openTabInRegularWindow(url, preferredWindowId = null) {
  if (preferredWindowId != null) {
    try {
      const tab = await chrome.tabs.create({
        windowId: preferredWindowId,
        url,
        active: true
      });
      await focusWindow(tab.windowId);
      return tab;
    } catch (error) {
    }
  }

  const existingWindow = await findAnyWindow(false);
  if (existingWindow?.windowId) {
    const tab = await chrome.tabs.create({
      windowId: existingWindow.windowId,
      url,
      active: true
    });
    await focusWindow(tab.windowId);
    return tab;
  }

  const createdTab = await chrome.tabs.create({
    url,
    active: true
  });
  await focusWindow(createdTab.windowId);
  return createdTab;
}

async function openRegistrationWindow(profile) {
  const tab = await reuseOrCreateTab({
    url: 'https://chatgpt.com/',
    preferredWindowId: state.session?.windowId || null,
    incognito: true,
    createWindowIfNeeded: true
  });
  const tabId = tab?.id || null;

  updateState({
    status: 'running',
    step: 'Opened ChatGPT signup page',
    error: null,
    session: {
      windowId: tab?.windowId || null,
      tabId
    },
    lastProfile: profile,
    pendingProfile: null,
    finalFlowStarted: false,
    postSignupPending: false
  });
}

async function openCpaWindow(cpaUrl) {
  await closeCpaTab();
  const tab = await reuseOrCreateTab({
    url: cpaUrl,
    preferredWindowId: state.regularWindowId || null,
    incognito: false,
    createWindowIfNeeded: false
  });
  updateState({
    cpaTabId: tab?.id || null,
    regularWindowId: tab?.windowId || null,
    oauthCallbackUrl: null,
    step: 'Opening CPA OAuth page'
  });
}

async function openOauthWindow(url, useIncognito = true) {
  await closeOauthTab();
  const tab = await reuseOrCreateTab({
    url,
    preferredWindowId: state.session?.windowId || null,
    incognito: useIncognito,
    createWindowIfNeeded: true
  });
  const tabId = tab?.id || null;

  updateState({
    oauthTabId: tabId,
    session: {
      windowId: tab?.windowId || null,
      tabId
    },
    step: 'Opening Codex OAuth in incognito'
  });
}

async function openOauthRetryTab(url) {
  await closeOauthTab();
  const useIncognito = state.useIncognito !== false;

  try {
    if (useIncognito && state.session?.windowId) {
      const tab = await chrome.tabs.create({
        windowId: state.session.windowId,
        url,
        active: true
      });
      updateState({
        oauthTabId: tab.id,
        session: {
          windowId: tab.windowId,
          tabId: tab.id
        },
        step: 'Opening OAuth retry tab in incognito'
      });
      return;
    }
  } catch (error) {
  }

  await openOauthWindow(url, useIncognito);
}

async function startCpaOAuthFlow() {
  const config = await getConfig();
  const useIncognito = state.useIncognito !== false;
  if (!config.cpaKey) {
    updateState({
      status: 'completed',
      step: 'Signup completed; CPA key not configured',
      error: null
    });
    return;
  }

  updateState({
    status: 'running',
    step: 'Starting CPA OAuth flow',
    error: null,
    useIncognito,
    oauthCallbackUrl: null,
    finalFlowStarted: true,
    postSignupPending: false
  });
  const preferredOauthUrl = (config.oauthUrl || '').trim();
  const { authUrl, authState } = preferredOauthUrl
    ? { authUrl: preferredOauthUrl, authState: extractStateFromResponse(null, preferredOauthUrl) }
    : await requestCodexAuthUrl(config.cpaKey, config.cpaUrl || DEFAULT_CPA_API_BASE);
  updateState({
    cpaTabId: null,
    regularWindowId: null,
    cpaAuthState: authState || '',
    oauthSourceUrl: authUrl,
    oauthForceLogin: false
  });
  await openOauthWindow(authUrl, useIncognito);
}

async function closeTabById(tabId) {
  if (tabId == null) {
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
  }
}

async function closeDuckTab() {
  await closeTabById(state.duckTabId);
  state.duckTabId = null;
}

async function closeGmailTab() {
  await closeTabById(state.gmailTabId);
  state.gmailTabId = null;
}

async function closeCpaTab() {
  await closeTabById(state.cpaTabId);
  state.cpaTabId = null;
}

async function closeOauthTab() {
  await closeTabById(state.oauthTabId);
  state.oauthTabId = null;
}

async function requestDuckAddress(profile) {
  await closeDuckTab();

  updateState({
    status: 'running',
    step: 'Opening DuckDuckGo Email Protection page',
    error: null,
    pendingProfile: profile,
    lastProfile: null,
    session: null
  });

  const tab = await reuseOrCreateTab({
    url: 'https://duckduckgo.com/email/settings/autofill',
    preferredWindowId: state.regularWindowId || null,
    incognito: false,
    createWindowIfNeeded: false
  });

  updateState({
    duckTabId: tab?.id || null,
    regularWindowId: tab?.windowId || null,
    step: 'Waiting for DuckDuckGo private address'
  });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      duckAddressWaiter = null;
      reject(new Error('Timed out while waiting for DuckDuckGo private address'));
    }, 120000);

    duckAddressWaiter = {
      resolve: async (email) => {
        clearTimeout(timeoutId);
        duckAddressWaiter = null;
        await closeDuckTab();
        resolve(email);
      },
      reject: async (error) => {
        clearTimeout(timeoutId);
        duckAddressWaiter = null;
        await closeDuckTab();
        reject(error);
      }
    };
  });
}

async function requestGmailCode() {
  if (gmailCodeWaiter) {
    return new Promise((resolve, reject) => {
      const previous = gmailCodeWaiter;
      gmailCodeWaiter = {
        resolve: async (code) => {
          await previous.resolve(code);
          resolve(code);
        },
        reject: async (error) => {
          await previous.reject(error);
          reject(error);
        }
      };
    });
  }

  updateState({
    status: 'running',
    step: 'Opening Gmail inbox for latest OpenAI code',
    error: null
  });

  const tab = await openTabInRegularWindow('https://mail.google.com/mail/u/0/#inbox', state.regularWindowId || null);

  updateState({
    gmailTabId: tab?.id || null,
    regularWindowId: tab?.windowId || null,
    step: 'Waiting for latest OpenAI email in Gmail'
  });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      gmailCodeWaiter = null;
      reject(new Error('Timed out while waiting for Gmail verification code'));
    }, 120000);

    gmailCodeWaiter = {
      resolve: async (code) => {
        clearTimeout(timeoutId);
        gmailCodeWaiter = null;
        resolve(code);
      },
      reject: async (error) => {
        clearTimeout(timeoutId);
        gmailCodeWaiter = null;
        reject(error);
      }
    };
  });
}

async function requestVerificationCode() {
  const config = await getConfig();
  if (config.emailProvider === 'mailapi') {
    updateState({
      status: 'running',
      step: 'Waiting for latest OpenAI email in Mailbox API',
      error: null
    });
    return requestAupmailCode();
  }

  const duckForwardEmail = String(config.duckForwardEmail || '').trim() || DUCK_FORWARD_AUPMAIL_EMAIL;
  const mailApiKey = String(config.mailApiKey || config.duckForwardPassword || '').trim();
  if (!mailApiKey) {
    throw new Error('Mailbox API key is not configured');
  }

  updateState({
    status: 'running',
    step: `Connecting mailbox ${duckForwardEmail}`,
    error: null
  });
  const adminSession = await loginAupmailAccount(duckForwardEmail, mailApiKey);
  state.aupmailSession = adminSession;
  updateState({
    status: 'running',
    step: `Waiting for latest OpenAI email in ${duckForwardEmail}`,
    error: null,
    aupmailSession: adminSession
  });
  return requestAupmailCode({
    session: adminSession,
    expectedRecipient: ''
  });
}

async function startSingleRegistration(profileInput) {
  const profile = generateProfile(profileInput);
  const config = await getConfig();
  const useIncognito = config.runInIncognito !== false;

  updateState({
    status: 'running',
    step: useIncognito ? 'Closing existing incognito windows' : 'Preparing browser window',
    error: null,
    useIncognito
  });

  if (useIncognito) {
    await closeAllIncognitoWindows();
  }
  await cleanupManagedMailboxSession(state.aupmailSession);
  state.aupmailSession = null;

  if (!profile.email) {
    if (config.emailProvider === 'mailapi') {
      updateState({
        status: 'running',
        step: 'Generating mailbox address',
        error: null
      });
      const aupmailAccount = await registerAupmailAccount(profile);
      profile.email = aupmailAccount.email;
      state.aupmailSession = aupmailAccount;
    } else {
      profile.email = await requestDuckAddress(profile);
      state.aupmailSession = null;
    }
  }

  if (!config.cpaKey) {
    throw new Error('CPA key is not configured');
  }

  updateState({
    status: 'running',
    step: 'Requesting CPA auth URL',
    error: null,
    lastProfile: profile,
    pendingProfile: null,
    aupmailSession: state.aupmailSession,
    session: null,
    finalFlowStarted: false,
    postSignupPending: false
  });
  const preferredOauthUrl = (config.oauthUrl || '').trim();
  const { authUrl, authState } = preferredOauthUrl
    ? { authUrl: preferredOauthUrl, authState: extractStateFromResponse(null, preferredOauthUrl) }
    : await requestCodexAuthUrl(config.cpaKey, config.cpaUrl || DEFAULT_CPA_API_BASE);
  updateState({
    cpaTabId: null,
    regularWindowId: null,
    cpaAuthState: authState || '',
    oauthSourceUrl: authUrl,
    oauthForceLogin: false,
    step: useIncognito ? 'Opening Codex OAuth in incognito' : 'Opening Codex OAuth in regular window'
  });
  await openOauthWindow(authUrl, useIncognito);
  return { success: true, state: getPublicState() };
}

async function startRegistration(profileInput, options = {}) {
  if (state.status === 'running') {
    throw new Error('Registration is already running');
  }

  const config = await getConfig();
  const total = normalizeBatchCount(options.batchCount, config.batchCount || 1);
  clearBatchAdvanceTimer();
  batchAdvancing = false;

  const template = { ...(profileInput || {}) };
  updateState({
    batchActive: total > 1,
    batchTotal: total,
    batchCurrentIndex: 1,
    batchFinishedCount: 0,
    batchSuccessCount: 0,
    batchFailedCount: 0,
    batchProfileTemplate: template
  });

  return startSingleRegistration(template);
}

async function resetState() {
  const windowId = state.session?.windowId;
  if (windowId) {
    try {
      await chrome.windows.remove(windowId);
    } catch (error) {
    }
  }

  await closeDuckTab();
  await closeGmailTab();
  await closeCpaTab();
  await closeOauthTab();
  await cleanupManagedMailboxSession(state.aupmailSession);
  clearBatchAdvanceTimer();
  batchAdvancing = false;
  duckAddressWaiter = null;
  gmailCodeWaiter = null;
  await chrome.storage.local.remove(FLOW_STATE_KEY);
  state = { ...DEFAULT_STATE };
  broadcastState();
}

function findSessionByWindowId(windowId) {
  return state.session && state.session.windowId === windowId ? state.session : null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderWindowId = sender.tab?.windowId;
  const session = senderWindowId ? findSessionByWindowId(senderWindowId) : null;

  switch (message.type) {
    case 'GET_STATE':
      sendResponse({ state: getPublicState() });
      break;

    case 'PAUSE':
      updateState({
        paused: true,
        step: 'Paused'
      });
      sendResponse({ success: true });
      break;

    case 'RESUME':
      updateState({
        paused: false,
        step: ''
      });
      sendResponse({ success: true });
      break;

    case 'GET_CONFIG':
      getConfig().then((config) => sendResponse({ config }));
      return true;

    case 'SET_CONFIG':
      setConfig(message.config || {}).then((config) => sendResponse({ success: true, config }));
      return true;

    case 'START_REGISTRATION':
      startRegistration(message.profile || {}, { batchCount: message.batchCount }).then(sendResponse).catch((error) => {
        updateState({
          status: 'error',
          step: '',
          error: error.message || String(error),
          pendingProfile: null
        });
        sendResponse({ success: false, error: error.message || String(error) });
      });
      return true;

    case 'RESET':
      resetState().then(() => sendResponse({ success: true }));
      return true;

    case 'GET_ACCOUNT_INFO':
      sendResponse({
        profile: state.lastProfile || state.pendingProfile || null
      });
      break;

    case 'GET_DUCK_CONTEXT':
      sendResponse({
        enabled: Boolean(state.pendingProfile && sender.tab?.id === state.duckTabId),
        pendingProfile: state.pendingProfile
      });
      break;

    case 'REQUEST_GMAIL_CODE':
      requestVerificationCode().then((code) => {
        sendResponse({ success: true, code });
      }).catch((error) => {
        updateState({
          status: 'error',
          error: error.message || String(error)
        });
        sendResponse({ success: false, error: error.message || String(error) });
      });
      return true;

    case 'GET_GMAIL_CONTEXT':
      sendResponse({
        enabled: Boolean(sender.tab?.id === state.gmailTabId)
      });
      break;

    case 'GET_FLOW_CONTEXT':
      getPersistedFlowState().then((flowState) => {
        state = {
          ...state,
          finalFlowStarted: Boolean(flowState.finalFlowStarted),
          postSignupPending: Boolean(flowState.postSignupPending),
          paused: Boolean(flowState.paused),
          step: state.step || flowState.step || ''
        };
        sendResponse({
          finalFlowStarted: Boolean(state.finalFlowStarted),
          postSignupPending: Boolean(state.postSignupPending),
          paused: Boolean(state.paused)
        });
      });
      return true;

    case 'PROFILE_SUBMITTED':
      updateState({
        postSignupPending: true,
        step: message.step || 'Profile submitted, waiting for redirect'
      });
      sendResponse({ success: true });
      break;

    case 'GET_CPA_CONTEXT':
      sendResponse({
        enabled: Boolean(sender.tab?.id === state.cpaTabId),
        callbackUrl: state.oauthCallbackUrl || ''
      });
      break;

    case 'GET_OAUTH_CONTEXT':
      sendResponse({
        enabled: Boolean(sender.tab?.id === state.oauthTabId),
      profile: state.lastProfile || null
      ,
      authUrl: state.oauthSourceUrl || '',
      forceLogin: Boolean(state.oauthForceLogin)
      });
      break;

    case 'CPA_AUTH_LINK_READY':
      if (!message.url) {
        sendResponse({ success: false, error: 'Missing OAuth URL' });
        break;
      }
      updateState({
        oauthSourceUrl: message.url,
        oauthForceLogin: false
      });
      openOauthWindow(message.url, state.useIncognito !== false).then(() => sendResponse({ success: true })).catch((error) => {
        updateState({ status: 'error', error: error.message || String(error) });
        sendResponse({ success: false, error: error.message || String(error) });
      });
      return true;

    case 'REOPEN_OAUTH_FOR_LOGIN':
      if (!state.oauthSourceUrl) {
        sendResponse({ success: false, error: 'Missing stored OAuth URL' });
        break;
      }
      updateState({
        oauthForceLogin: true,
        step: 'Reopening OAuth in login mode'
      });
      openOauthRetryTab(state.oauthSourceUrl).then(() => sendResponse({ success: true })).catch((error) => {
        updateState({ status: 'error', error: error.message || String(error) });
        sendResponse({ success: false, error: error.message || String(error) });
      });
      return true;

    case 'OAUTH_CALLBACK_READY':
      (async () => {
        try {
          const result = await completeOauthCallbackFlow(message.url || '');
          sendResponse(result);
        } catch (error) {
          updateState({
            status: 'error',
            error: error.message || String(error)
          });
          sendResponse({ success: false, error: error.message || String(error) });
        }
      })();
      return true;

    case 'CPA_SUBMIT_DONE':
      updateState({
        status: 'completed',
        step: '已上传',
        error: null
      });
      sendResponse({ success: true });
      break;

    case 'GMAIL_CODE_READY':
      if (gmailCodeWaiter && message.code) {
        state.gmailTabId = null;
        gmailCodeWaiter.resolve(message.code);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active Gmail code request' });
      }
      break;

    case 'GMAIL_CODE_ERROR':
      if (gmailCodeWaiter) {
        gmailCodeWaiter.reject(new Error(message.error || 'Failed to read Gmail code'));
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active Gmail code request' });
      }
      break;

    case 'DUCK_ADDRESS_READY':
      if (duckAddressWaiter && message.email) {
        duckAddressWaiter.resolve(message.email);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active DuckDuckGo address request' });
      }
      break;

    case 'DUCK_ADDRESS_ERROR':
      if (duckAddressWaiter) {
        duckAddressWaiter.reject(new Error(message.error || 'DuckDuckGo address generation failed'));
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active DuckDuckGo address request' });
      }
      break;

    case 'UPDATE_STEP':
      if (
        gmailCodeWaiter &&
        sender.tab?.id !== state.gmailTabId &&
        String(message.step || '') === 'Waiting for post-signup redirect'
      ) {
        sendResponse({ success: true, ignored: true });
        break;
      }
      updateState({ step: message.step || state.step });
      sendResponse({ success: true });
      break;

    case 'REPORT_ERROR':
      updateState({
        status: 'error',
        error: message.error || 'Unknown error'
      });
      sendResponse({ success: true });
      break;

    case 'AUTH_COMPLETED':
      if (state.finalFlowStarted) {
        sendResponse({ success: true, skipped: true });
        break;
      }
      startCpaOAuthFlow().then(() => sendResponse({ success: true })).catch((error) => {
        updateState({
          status: 'error',
          error: error.message || String(error)
        });
        sendResponse({ success: false, error: error.message || String(error) });
      });
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (state.session?.windowId === windowId && state.status === 'running') {
    updateState({
      status: 'idle',
      step: '',
      session: null
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const candidateUrl = changeInfo.url || tab?.url || '';
  if (tabId !== state.oauthTabId || !isLocalhostOauthCallbackUrl(candidateUrl)) {
    return;
  }

  completeOauthCallbackFlow(candidateUrl).catch((error) => {
    updateState({
      status: 'error',
      error: error.message || String(error)
    });
  });
});
