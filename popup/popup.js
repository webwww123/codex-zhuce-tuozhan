const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const stepText = document.getElementById('step-text');
const errorBox = document.getElementById('error-box');
const inboxStatusText = document.getElementById('inbox-status');
const generatedOauthUrlInput = document.getElementById('generated-oauth-url');

const emailProviderInput = document.getElementById('email-provider');
const runIncognitoInput = document.getElementById('run-incognito');
const batchCountInput = document.getElementById('batch-count');
const batchDelaySecondsInput = document.getElementById('batch-delay-seconds');
const codeTimeoutSecondsInput = document.getElementById('code-timeout-seconds');
const cpaUrlInput = document.getElementById('cpa-url');
const cpaKeyInput = document.getElementById('cpa-key');
const mailApiUrlInput = document.getElementById('mail-api-url');
const mailDomainInput = document.getElementById('mail-domain');
const duckForwardEmailInput = document.getElementById('duck-forward-email');
const duckForwardPasswordInput = document.getElementById('duck-forward-password');

const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const resetBtn = document.getElementById('reset-btn');
const saveConfigBtn = document.getElementById('save-config-btn');

const profilePanel = document.getElementById('profile-panel');
const profileEmail = document.getElementById('profile-email');
const profileName = document.getElementById('profile-name');
const profilePassword = document.getElementById('profile-password');

function updateUI(state) {
  statusDot.className = 'dot';
  statusDot.classList.add(state.status || 'idle');

  const textMap = {
    idle: '就绪',
    running: '运行中',
    completed: '已完成',
    error: '错误'
  };

  statusText.textContent = textMap[state.status] || '就绪';
  const batchText = Number(state.batchTotal || 1) > 1
    ? ` [${state.batchCurrentIndex || 0}/${state.batchTotal}] 成功:${state.batchSuccessCount || 0} 失败:${state.batchFailedCount || 0}`
    : '';
  stepText.textContent = state.paused ? '已暂停' : `${state.step || ''}${batchText}`;
  pauseBtn.textContent = state.paused ? '继续' : '暂停';
  generatedOauthUrlInput.value = state.oauthSourceUrl || '';
  const inboxEmail = state.verifyInboxStatus?.email || '';
  const inboxMessage = state.verifyInboxStatus?.message || '';
  inboxStatusText.textContent = inboxEmail || inboxMessage
    ? `邮箱: ${inboxEmail || '-'} | ${inboxMessage || ''}`
    : '';

  if (state.error) {
    errorBox.style.display = 'block';
    errorBox.textContent = state.error;
  } else {
    errorBox.style.display = 'none';
    errorBox.textContent = '';
  }

  if (state.lastProfile?.email) {
    profilePanel.style.display = 'block';
    profileEmail.textContent = state.lastProfile.email || '-';
    profileName.textContent = state.lastProfile.fullName || '-';
    profilePassword.textContent = state.lastProfile.password || '-';
  } else {
    profilePanel.style.display = 'none';
  }
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  updateUI(response?.state || { status: 'idle' });
}

async function loadConfig() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  const config = response?.config || {};

  emailProviderInput.value = config.emailProvider || 'mailapi';
  runIncognitoInput.value = config.runInIncognito === false ? 'false' : 'true';
  batchCountInput.value = String(config.batchCount || 1);
  batchDelaySecondsInput.value = String(config.batchDelaySeconds ?? 25);
  codeTimeoutSecondsInput.value = String(config.codeWaitTimeoutSeconds ?? 150);
  cpaUrlInput.value = config.cpaUrl || 'https://codex.supxh.xin';
  cpaKeyInput.value = config.cpaKey || 'webwww123';

  mailApiUrlInput.value = config.mailApiUrl || 'http://74.48.147.156:8787';
  mailDomainInput.value = config.mailDomain || '';
  duckForwardEmailInput.value = config.duckForwardEmail || '';
  duckForwardPasswordInput.value = config.mailApiKey || config.duckForwardPassword || '';
}

async function saveConfig() {
  const mailApiKey = duckForwardPasswordInput.value.trim();

  await chrome.runtime.sendMessage({
    type: 'SET_CONFIG',
    config: {
      emailProvider: emailProviderInput.value,
      runInIncognito: runIncognitoInput.value !== 'false',
      batchCount: Math.max(1, Math.min(200, Number(batchCountInput.value) || 1)),
      batchDelaySeconds: Math.max(0, Math.min(300, Number(batchDelaySecondsInput.value) || 0)),
      codeWaitTimeoutSeconds: Math.max(30, Math.min(600, Number(codeTimeoutSecondsInput.value) || 150)),
      cpaUrl: cpaUrlInput.value.trim(),
      cpaKey: cpaKeyInput.value.trim(),

      mailApiUrl: mailApiUrlInput.value.trim(),
      mailApiKey,
      mailDomain: mailDomainInput.value.trim(),

      duckForwardEmail: duckForwardEmailInput.value.trim(),
      duckForwardPassword: mailApiKey
    }
  });
  await refreshState();
}

async function startRegistration() {
  const batchCount = Math.max(1, Math.min(200, Number(batchCountInput.value) || 1));
  const batchDelaySeconds = Math.max(0, Math.min(300, Number(batchDelaySecondsInput.value) || 0));
  const response = await chrome.runtime.sendMessage({
    type: 'START_REGISTRATION',
    profile: {},
    batchCount,
    batchDelaySeconds
  });

  if (response?.state) {
    updateUI(response.state);
  } else if (response?.error) {
    updateUI({ status: 'error', error: response.error });
  }
}

async function resetState() {
  await chrome.runtime.sendMessage({ type: 'RESET' });
  await refreshState();
}

async function togglePause() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const paused = Boolean(response?.state?.paused);
  await chrome.runtime.sendMessage({ type: paused ? 'RESUME' : 'PAUSE' });
  await refreshState();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STATE_UPDATE') {
    updateUI(message.state || { status: 'idle' });
  }
});

document.addEventListener('DOMContentLoaded', () => {
  refreshState();
  loadConfig();
  startBtn.addEventListener('click', startRegistration);
  pauseBtn.addEventListener('click', togglePause);
  resetBtn.addEventListener('click', resetState);
  saveConfigBtn.addEventListener('click', saveConfig);
});
