(function() {
  'use strict';

  let isProcessing = false;
  let processedPageIds = new Set();
  let finalFlowStarted = false;
  let profileSubmitted = false;
  let authShellHandledOnce = false;
  let oauthSignupClickedOnce = false;
  let oauthLoginClickedOnce = false;
  let oauthPhoneRetryRequested = false;
  let lastGmailRefreshAt = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function $(selectors) {
    const list = selectors.split(',').map((item) => item.trim());
    for (const selector of list) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }
    return null;
  }

  function fillInput(element, value) {
    if (!element || value == null) {
      return false;
    }

    element.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function clearInputWithBackspace(element, count = null) {
    if (!element) {
      return false;
    }

    element.focus();
    const existingValue = String(element.value || element.getAttribute('value') || '');
    const backspaceCount = count == null ? Math.max(existingValue.length, 10) : count;

    for (let index = 0; index < backspaceCount; index += 1) {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', bubbles: true }));
    }

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(element, '');
    } else {
      element.value = '';
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function typeDigitSequence(element, value) {
    if (!element || value == null) {
      return false;
    }

    const digits = String(value).replace(/\D/g, '');
    if (!digits) {
      return false;
    }

    element.focus();
    for (const digit of digits) {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: digit, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keypress', { key: digit, bubbles: true }));
      document.execCommand('insertText', false, digit);
      element.dispatchEvent(new KeyboardEvent('keyup', { key: digit, bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(30);
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function setInputValue(element, value) {
    if (!element) {
      return false;
    }

    element.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(element, String(value));
    } else {
      element.value = String(value);
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function replaceEditableSegmentValue(element, value) {
    if (!element || value == null) {
      return false;
    }

    const text = String(value);
    element.focus();
    const applyValue = () => {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        element.textContent = text;
      }

      element.setAttribute('aria-valuetext', text);
      if (/^\d+$/.test(text)) {
        element.setAttribute('aria-valuenow', String(Number(text)));
      }
      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        inputType: 'insertText',
        data: text
      }));
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text
      }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };

    applyValue();
    if ((element.textContent || '').trim() !== text) {
      applyValue();
    }

    element.dispatchEvent(new Event('blur', { bubbles: true }));
    return (element.textContent || '').trim() === text;
  }

  function setSelectValue(element, value) {
    if (!element || value == null) {
      return false;
    }

    const normalized = String(value).trim().toLowerCase();
    const options = Array.from(element.options || []);
    const option = options.find((item) => {
      const candidateValue = String(item.value || '').trim().toLowerCase();
      const candidateText = String(item.textContent || '').trim().toLowerCase();
      return candidateValue === normalized || candidateText === normalized;
    });

    if (!option) {
      return false;
    }

    element.value = option.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function clickButton(button) {
    if (!button || button.disabled) {
      return false;
    }
    button.click();
    return true;
  }

  async function getProfile() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_INFO' }).catch(() => null);
    return response?.profile || null;
  }

  async function getDuckContext() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_DUCK_CONTEXT' }).catch(() => null);
    return response || { enabled: false };
  }

  async function getGmailContext() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_GMAIL_CONTEXT' }).catch(() => null);
    return response || { enabled: false };
  }

  async function getCpaContext() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_CPA_CONTEXT' }).catch(() => null);
    return response || { enabled: false, callbackUrl: '' };
  }

  async function getOauthContext() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_OAUTH_CONTEXT' }).catch(() => null);
    return response || { enabled: false, profile: null };
  }

  async function getFlowContext() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_FLOW_CONTEXT' }).catch(() => null);
    return response || { finalFlowStarted: false, postSignupPending: false, paused: false };
  }

  async function requestGmailCode() {
    const response = await chrome.runtime.sendMessage({ type: 'REQUEST_GMAIL_CODE' }).catch(() => null);
    if (response?.success && response.code) {
      return response.code;
    }
    throw new Error(response?.error || 'Failed to fetch verification code from inbox');
  }

  function pageId() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function getSearchDocuments() {
    const docs = [];
    const visited = new Set();

    const visit = (doc) => {
      if (!doc || visited.has(doc)) {
        return;
      }
      visited.add(doc);
      docs.push(doc);

      const frames = Array.from(doc.querySelectorAll('iframe, frame'));
      for (const frame of frames) {
        try {
          const childDoc = frame.contentDocument;
          if (childDoc?.body) {
            visit(childDoc);
          }
        } catch (error) {
        }
      }
    };

    visit(document);
    return docs;
  }

  function queryAllAcrossDocuments(selectors) {
    const elements = [];
    for (const doc of getSearchDocuments()) {
      elements.push(...Array.from(doc.querySelectorAll(selectors)));
    }
    return elements;
  }

  function getCombinedBodyText() {
    return getSearchDocuments()
      .map((doc) => doc.body?.innerText || '')
      .filter(Boolean)
      .join('\n');
  }

  function findButtonByText(pattern) {
    const elements = Array.from(document.querySelectorAll('button, [role="button"]'));
    return elements.find((element) => {
      const text = (element.textContent || '').trim();
      return pattern.test(text);
    }) || null;
  }

  function findClickableByText(patterns) {
    const elements = Array.from(document.querySelectorAll('button, [role="button"], a'));
    return elements.find((element) => {
      const text = (element.textContent || '').trim();
      return patterns.some((pattern) => pattern.test(text));
    }) || null;
  }

  function findCodexOauthLoginButton() {
    const cards = Array.from(document.querySelectorAll('.card'));
    for (const card of cards) {
      const title = card.querySelector('.OAuthPage-module__cardTitle___yFaP0, .title');
      const titleText = (title?.textContent || card.textContent || '').trim();
      if (!/codex oauth/i.test(titleText)) {
        continue;
      }

      const button = Array.from(card.querySelectorAll('button, [role="button"], a')).find((element) => {
        const text = (element.textContent || '').trim();
        return /^登录$/.test(text) || /^login$/i.test(text);
      });

      if (button) {
        return button;
      }
    }

    return null;
  }

  function findChatComposer() {
    return document.querySelector('textarea, div[contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"][role="textbox"]');
  }

  function findSignupButton() {
    return findClickableByText([
      /^\u514d\u8d39\u6ce8\u518c$/,
      /^\u514d\u8d39\u8bd5\u7528$/,
      /^\u6ce8\u518c$/,
      /^\u521b\u5efa\u8d26\u6237$/,
      /^sign up for free$/i,
      /^start now$/i,
      /^sign up$/i,
      /^create account$/i,
      /^create an account$/i
    ]);
  }

  function findLoginButton() {
    return findClickableByText([
      /^\u767b\u5f55$/,
      /^log in$/i,
      /^login$/i,
      /^sign in$/i,
      /^continue with existing account$/i
    ]);
  }

  function pageShowsPhoneRequired() {
    const text = document.body?.innerText || '';
    return (
      /auth\.openai\.com\/add-phone/i.test(location.href) ||
      text.includes('\u7535\u8bdd\u53f7\u7801\u662f\u5fc5\u586b\u9879') ||
      text.includes('\u624b\u673a\u53f7\u7801\u662f\u5fc5\u586b\u9879') ||
      /phone number is required/i.test(text) ||
      /phone number required/i.test(text)
    );
  }

  function pageShowsSessionEnded() {
    const text = document.body?.innerText || '';
    return (
      text.includes('\u4f60\u7684\u4f1a\u8bdd\u5df2\u7ed3\u675f') ||
      /your session has ended/i.test(text) ||
      /session expired/i.test(text)
    );
  }

  function isRegistrationHost() {
    return [
      'chatgpt.com',
      'auth.openai.com',
      'auth0.openai.com',
      'duckduckgo.com',
      'mail.google.com'
    ].includes(location.hostname);
  }

  function findLinkLikeUrl(pattern) {
    const link = Array.from(document.querySelectorAll('a[href]')).find((element) => pattern.test(element.href));
    if (link) {
      return link.href;
    }

    const text = document.body?.innerText || '';
    const match = text.match(pattern);
    return match ? match[0] : '';
  }

  function findGmailRefreshButton() {
    return document.querySelector('.asa .asf.T-I-J3.J-J5-Ji') ||
      findElementByAriaLabel([
      /^refresh$/i,
      /refresh inbox/i,
      /^\u5237\u65b0$/,
      /\u5237\u65b0/
    ]) || findClickableByText([
      /^refresh$/i,
      /^\u5237\u65b0$/
    ]);
  }

  function isVisibleElement(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findVerificationCodeInput() {
    const candidates = Array.from(document.querySelectorAll(
      'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[maxlength="6"]'
    ));

    return candidates.find((element) => {
      const type = (element.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden') {
        return false;
      }

      const combined = [
        element.getAttribute('name') || '',
        element.getAttribute('id') || '',
        element.getAttribute('placeholder') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('autocomplete') || ''
      ].join(' ').toLowerCase();

      if (/birth|birthday|dob|bday|year|month|day/.test(combined)) {
        return false;
      }

      return isVisibleElement(element);
    }) || null;
  }

  function findElementByAriaLabel(patterns, selectors = 'button, [role="button"], div[role="button"]') {
    const list = Array.from(document.querySelectorAll(selectors));
    return list.find((element) => {
      const ariaLabel = [
        element.getAttribute('aria-label') || '',
        element.getAttribute('data-tooltip') || '',
        element.getAttribute('title') || ''
      ].join(' ');
      return patterns.some((pattern) => pattern.test(ariaLabel));
    }) || null;
  }

  function randomAdultBirthDate() {
    const year = 1990 + Math.floor(Math.random() * 10);
    const month = 1 + Math.floor(Math.random() * 12);
    const daysInMonth = new Date(year, month, 0).getDate();
    const day = 1 + Math.floor(Math.random() * daysInMonth);
    const paddedMonth = String(month).padStart(2, '0');
    const paddedDay = String(day).padStart(2, '0');

    return {
      year: String(year),
      month: paddedMonth,
      day: paddedDay,
      iso: `${year}-${paddedMonth}-${paddedDay}`
    };
  }

  function randomAdultAge() {
    return String(20 + Math.floor(Math.random() * 21));
  }

  function isLikelyBirthdayField(element) {
    if (!element) {
      return false;
    }

    const name = element.getAttribute('name') || '';
    const id = element.getAttribute('id') || '';
    const placeholder = element.getAttribute('placeholder') || '';
    const autocomplete = element.getAttribute('autocomplete') || '';
    const ariaLabel = element.getAttribute('aria-label') || '';
    const type = element.getAttribute('type') || '';
    const combined = `${name} ${id} ${placeholder} ${autocomplete} ${ariaLabel}`.toLowerCase();

    if (type.toLowerCase() === 'date') {
      return true;
    }

    if (/(^|\s)(name|full.?name|first.?name|last.?name|username)(\s|$)/i.test(combined)) {
      return false;
    }

    return /(birth|birthday|date.?of.?birth|dob|bday)/i.test(combined);
  }

  function isLikelyAgeField(element) {
    if (!element) {
      return false;
    }

    const name = element.getAttribute('name') || '';
    const id = element.getAttribute('id') || '';
    const placeholder = element.getAttribute('placeholder') || '';
    const autocomplete = element.getAttribute('autocomplete') || '';
    const ariaLabel = element.getAttribute('aria-label') || '';
    const inputMode = element.getAttribute('inputmode') || '';
    const type = element.getAttribute('type') || '';
    const combined = `${name} ${id} ${placeholder} ${autocomplete} ${ariaLabel} ${inputMode}`.toLowerCase();

    if (type.toLowerCase() === 'hidden') {
      return false;
    }

    if (/(birth|birthday|date.?of.?birth|dob|bday|year|month|day)/i.test(combined)) {
      return false;
    }

    return /(^|\b)(age|years?\s*old)(\b|$)/i.test(combined);
  }

  async function fillAgeField(age) {
    const ageInput = Array.from(document.querySelectorAll('input')).find((element) => {
      if (!isVisibleElement(element)) {
        return false;
      }
      return isLikelyAgeField(element);
    }) || null;
    const ageSelect = Array.from(document.querySelectorAll('select')).find((element) => {
      if (!isVisibleElement(element)) {
        return false;
      }
      return isLikelyAgeField(element);
    }) || null;

    if (ageInput) {
      const inputType = (ageInput.getAttribute('type') || '').toLowerCase();
      if (inputType === 'number' || ageInput.getAttribute('inputmode') === 'numeric') {
        return setInputValue(ageInput, age);
      }
      await clearInputWithBackspace(ageInput, 3);
      return typeDigitSequence(ageInput, age);
    }

    if (ageSelect) {
      return setSelectValue(ageSelect, age);
    }

    return false;
  }

  async function fillBirthdayFields(birthDate) {
    const hiddenBirthdayInput = document.querySelector('input[type="hidden"][name="birthday"]');
    const birthdayGroup = hiddenBirthdayInput?.closest('div')?.querySelector('[role="group"]') ||
      document.querySelector('[id*="birthday"][role="group"]');
    const yearSegment = birthdayGroup?.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSegment = birthdayGroup?.querySelector('[role="spinbutton"][data-type="month"]');
    const daySegment = birthdayGroup?.querySelector('[role="spinbutton"][data-type="day"]');

    if (yearSegment && monthSegment && daySegment) {
      replaceEditableSegmentValue(yearSegment, birthDate.year);
      await sleep(50);
      replaceEditableSegmentValue(monthSegment, birthDate.month);
      await sleep(50);
      replaceEditableSegmentValue(daySegment, birthDate.day);

      if (hiddenBirthdayInput) {
        setInputValue(hiddenBirthdayInput, birthDate.iso);
      }
      return true;
    }

    const dateInput = Array.from(document.querySelectorAll('input')).find((element) => {
      if (element.type === 'hidden') {
        return false;
      }
      return isLikelyBirthdayField(element);
    }) || null;
    if (dateInput) {
      await clearInputWithBackspace(dateInput, 8);
      return typeDigitSequence(dateInput, `${birthDate.year}${birthDate.month}${birthDate.day}`);
    }

    const yearInput = $('input[name*="year" i], input[placeholder*="year" i], input[autocomplete="bday-year"]');
    const monthInput = $('input[name*="month" i], input[placeholder*="month" i], input[autocomplete="bday-month"]');
    const dayInput = $('input[name*="day" i], input[placeholder*="day" i], input[autocomplete="bday-day"]');
    const yearSelect = $('select[name*="year" i], select[autocomplete="bday-year"]');
    const monthSelect = $('select[name*="month" i], select[autocomplete="bday-month"]');
    const daySelect = $('select[name*="day" i], select[autocomplete="bday-day"]');

    let filled = false;
    if (yearInput) {
      filled = fillInput(yearInput, birthDate.year) || filled;
    }
    if (monthInput) {
      filled = fillInput(monthInput, String(Number(birthDate.month))) || filled;
    }
    if (dayInput) {
      filled = fillInput(dayInput, String(Number(birthDate.day))) || filled;
    }
    if (yearSelect) {
      filled = setSelectValue(yearSelect, birthDate.year) || filled;
    }
    if (monthSelect) {
      filled = setSelectValue(monthSelect, String(Number(birthDate.month))) ||
        setSelectValue(monthSelect, birthDate.month) || filled;
    }
    if (daySelect) {
      filled = setSelectValue(daySelect, String(Number(birthDate.day))) ||
        setSelectValue(daySelect, birthDate.day) || filled;
    }

    return filled;
  }

  async function waitForDocumentReady(timeout = 15000) {
    if (document.readyState === 'complete') {
      return;
    }

    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        window.removeEventListener('load', onLoad);
        reject(new Error('Timed out waiting for page load'));
      }, timeout);

      function onLoad() {
        clearTimeout(timeoutId);
        resolve();
      }

      window.addEventListener('load', onLoad, { once: true });
    });
  }

  async function waitForButtonByText(pattern, timeout = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const button = findButtonByText(pattern);
      if (button) {
        return button;
      }
      await sleep(250);
    }
    throw new Error(`Button not found: ${pattern}`);
  }

  function findDuckAddressInPage() {
    const matcher = /[a-z0-9._%+-]+@duck\.com\b/i;

    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    for (const element of inputs) {
      const value = (element.value || element.getAttribute('value') || '').trim();
      if (matcher.test(value)) {
        return value.match(matcher)?.[0] || '';
      }
    }

    const text = document.body?.innerText || '';
    return text.match(matcher)?.[0] || '';
  }

  async function waitForDuckAddressChange(previousEmail, timeout = 15000) {
    const startedAt = Date.now();
    const normalizedPrevious = String(previousEmail || '').trim().toLowerCase();

    while (Date.now() - startedAt < timeout) {
      const currentEmail = findDuckAddressInPage();
      if (currentEmail && String(currentEmail).trim().toLowerCase() !== normalizedPrevious) {
        return currentEmail;
      }
      await sleep(300);
    }

    throw new Error('Timed out waiting for DuckDuckGo to generate a new private address');
  }

  function extractOpenAiCodeFromText(text) {
    const normalized = String(text || '');
    const openAiLike = /openai|chatgpt/i.test(normalized);
    const codeMatch = normalized.match(/\b(\d{6})\b/);
    return openAiLike && codeMatch ? codeMatch[1] : '';
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function bodyContainsRecipient(email) {
    if (!email) {
      return false;
    }
    const text = getCombinedBodyText();
    return new RegExp(escapeRegExp(email), 'i').test(text);
  }

  function textLooksLikeOpenAiVerification(text) {
    const raw = String(text || '');
    const normalized = raw.toLowerCase();
    return /chatgpt|openai/.test(normalized) && (
      /code|verification|verify|login|sign in|sign-in|signup|register/.test(normalized) ||
      /验证码|验证|登录|注册/.test(raw)
    );
  }

  function rowLooksRelevantForCode(row) {
    return textLooksLikeOpenAiVerification(row?.innerText || '');
  }

  function pageLooksRelevantForCode(email) {
    return bodyContainsRecipient(email) || textLooksLikeOpenAiVerification(getCombinedBodyText());
  }

  function extractAnyOpenAiCodeFromBody(text) {
    const normalized = String(text || '');
    const patterns = [
      /你的\s*chatgpt\s*(?:验证码|代码)(?:是|为)?\s*(\d{6})/i,
      /你的\s*openai\s*(?:验证码|代码)(?:是|为)?\s*(\d{6})/i,
      /your\s*(?:verification\s*)?code\s*is\s*(\d{6})/i,
      /use\s+code\s+(\d{6})/i,
      /code[^0-9]{0,20}(\d{6})/i,
      /\b(\d{6})\b/
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return '';
  }

  function rowLooksUnread(row) {
    const classText = row.className || '';
    const ariaLabel = row.getAttribute('aria-label') || '';
    return /zE|unread/i.test(classText) || /unread|未读/i.test(ariaLabel);
  }

  function extractChatGptCodeFromBody(text) {
    const normalized = String(text || '');
    const patterns = [
      /你的\s*ChatGPT\s*代码为\s*(\d{6})/i,
      /your\s*chatgpt\s*code\s*is\s*(\d{6})/i,
      /chatgpt[^0-9]{0,20}(\d{6})/i
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return '';
  }

  function gmailRowKey(row) {
    const dataId = row.getAttribute('data-legacy-thread-id') || row.getAttribute('data-thread-id') || '';
    const ariaLabel = row.getAttribute('aria-label') || '';
    const text = (row.innerText || '').trim();
    return `${dataId}|${ariaLabel}|${text}`;
  }

  async function markCurrentGmailMessageAsRead() {
    const markReadButton = findElementByAriaLabel([
      /mark as read/i,
      /marked as read/i,
      /标记为已读/i
    ]);

    if (markReadButton) {
      clickButton(markReadButton);
      await sleep(500);
      return true;
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', shiftKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'I', shiftKey: true, bubbles: true }));
    await sleep(500);
    return true;
  }

  function detectStep() {
    const url = location.href;
    const text = document.body?.innerText || '';

    if (location.hostname === 'duckduckgo.com' && location.pathname.includes('/email/settings/autofill')) {
      return 'duck_address';
    }

    if (location.hostname === 'mail.google.com') {
      return 'gmail_inbox';
    }

    if (location.hostname.includes('chatgpt.com') && findSignupButton()) {
      return 'landing_signup';
    }

    if ($('input[type="email"], input[autocomplete="email"]')) {
      return 'email';
    }

    if ($('input[type="password"], input[autocomplete="new-password"]')) {
      return 'password';
    }

    if ($('input[name="name"], input[autocomplete="name"], input[placeholder*="name" i]')) {
      return 'name';
    }

    if (findVerificationCodeInput()) {
      return 'verification_code';
    }

    if (location.hostname === 'auth.openai.com' || url.includes('/auth/login') || url.includes('mode=signup')) {
      return 'auth_shell';
    }

    if (findClickableByText([/^\u5b66\u6821$/, /^\u5de5\u4f5c$/, /^\u4e2a\u4eba\u4efb\u52a1$/, /^\u4e50\u8da3\u548c\u5a31\u4e50$/, /^\u5176\u4ed6$/])) {
      return 'onboarding_goal';
    }

    if (findClickableByText([/^\u4e2a\u4eba\u4f7f\u7528$/, /^personal$/i, /^for personal use$/i])) {
      return 'onboarding_personal';
    }

    if (findClickableByText([/^\u4e0b\u4e00\u6b65$/, /^\u7ee7\u7eed$/, /^continue$/i, /^next$/i, /^\u8df3\u8fc7\u5bfc\u89c8$/, /^skip/i, /^\u597d\u7684\u5f00\u59cb\u5427$/, /^let'?s go$/i, /^get started$/i])) {
      return 'onboarding_continue';
    }

    if (location.hostname.includes('chatgpt.com') && findChatComposer()) {
      return 'chat_ready';
    }

    if (text.includes('Check your email') || text.includes('Verify your email')) {
      return 'verify_email';
    }

    return 'unknown';
  }

  function updateStep(step) {
    chrome.runtime.sendMessage({ type: 'UPDATE_STEP', step }).catch(() => {});
  }

  function reportError(error) {
    chrome.runtime.sendMessage({ type: 'REPORT_ERROR', error }).catch(() => {});
  }

  async function handleEmailStep(profile) {
    const emailInput = $('input[type="email"], input[autocomplete="email"]');
    const nextButton = $('button[type="submit"], button[data-testid], form button');

    if (!emailInput || !profile?.email) {
      return false;
    }

    updateStep('Filling email');
    fillInput(emailInput, profile.email);
    await sleep(150);
    clickButton(nextButton);
    return true;
  }

  async function handleLandingSignupStep() {
    await waitForDocumentReady(15000);
    await sleep(800);

    const signupButton = findSignupButton();
    if (!signupButton) {
      return false;
    }

    updateStep('Opening ChatGPT free signup');
    clickButton(signupButton);
    await sleep(1200);
    return true;
  }

  async function handlePasswordStep(profile) {
    const passwordInput = $('input[type="password"], input[autocomplete="new-password"]');
    const submitButton = $('button[type="submit"], form button');

    if (!passwordInput || !profile?.password) {
      return false;
    }

    updateStep('Filling password');
    fillInput(passwordInput, profile.password);
    await sleep(150);
    clickButton(submitButton);
    return true;
  }

  async function handleNameStep(profile) {
    const fullNameInput = $('input[name="name"], input[autocomplete="name"], input[placeholder*="name" i]');
    const firstNameInput = $('input[name="firstName"], input[autocomplete="given-name"]');
    const lastNameInput = $('input[name="lastName"], input[autocomplete="family-name"]');
    const submitButton = $('button[type="submit"], form button');
    const age = randomAdultAge();
    const birthDate = randomAdultBirthDate();

    updateStep('Filling name');

    if (fullNameInput) {
      fillInput(fullNameInput, profile.fullName);
    } else {
      if (firstNameInput) {
        fillInput(firstNameInput, profile.firstName);
      }
      if (lastNameInput) {
        fillInput(lastNameInput, profile.lastName);
      }
    }

    const ageFilled = await fillAgeField(age);
    if (ageFilled) {
      updateStep(`Setting age ${age}`);
    } else {
      updateStep(`Setting birth date ${birthDate.iso}`);
      await fillBirthdayFields(birthDate);
    }
    await sleep(200);

    if (submitButton) {
      updateStep('Submitting profile details');
      await chrome.runtime.sendMessage({
        type: 'PROFILE_SUBMITTED',
        step: 'Profile submitted, waiting for redirect'
      }).catch(() => null);
      clickButton(submitButton);
      await sleep(1200);
      return true;
    }

    updateStep('Profile fields filled');
    return true;
  }

  async function handleDuckAddressStep() {
    const context = await getDuckContext();
    if (!context.enabled) {
      return false;
    }

    updateStep('Waiting for DuckDuckGo page load');
    await waitForDocumentReady();
    await sleep(1000);

    updateStep('Generating DuckDuckGo private address');
    const previousEmail = findDuckAddressInPage();

    const generateButton = await waitForButtonByText(/^generate private duck address$/i);

    clickButton(generateButton);
    const email = await waitForDuckAddressChange(previousEmail, 20000);

    const copyButton = await waitForButtonByText(/^copy$/i, 10000).catch(() => null);
    if (copyButton) {
      clickButton(copyButton);
      await sleep(300);
    }
    if (!email) {
      throw new Error('Generated DuckDuckGo address not found on page');
    }

    await chrome.runtime.sendMessage({ type: 'DUCK_ADDRESS_READY', email }).catch(() => null);
    return true;
  }

  async function handleGmailInboxStep() {
    const context = await getGmailContext();
    if (!context.enabled) {
      return false;
    }

    const profile = await getProfile();
    if (!profile?.email) {
      throw new Error('Current signup email is missing');
    }

    updateStep('Waiting for Gmail inbox to load');
    await waitForDocumentReady(20000);
    await sleep(1500);

    updateStep('Waiting for latest unread OpenAI email in Gmail');

    const startedAt = Date.now();
    const timeout = 90000;
    const attemptedRows = new Set();
    let noUnreadSince = 0;

    while (Date.now() - startedAt < timeout) {
      const rows = Array.from(document.querySelectorAll('tr[role="row"]'));
      const unreadCandidateRows = rows.filter((row) => {
        const key = gmailRowKey(row);
        return rowLooksUnread(row) && rowLooksRelevantForCode(row) && !attemptedRows.has(key);
      });
      const candidateRows = unreadCandidateRows;

      if (!candidateRows.length) {
        if (!noUnreadSince) {
          noUnreadSince = Date.now();
        }

        const waitMs = Date.now() - noUnreadSince;
        updateStep('Waiting for unread Gmail message');

        if (waitMs >= 8000 && Date.now() - lastGmailRefreshAt >= 15000) {
          const refreshButton = findGmailRefreshButton();
          lastGmailRefreshAt = Date.now();

          if (refreshButton) {
            updateStep('Refreshing Gmail inbox');
            clickButton(refreshButton);
            await sleep(4000);
          } else {
            updateStep('Reloading Gmail page while waiting for new email');
            location.reload();
            await sleep(5000);
          }
        } else {
          await sleep(2000);
        }
        continue;
      }

      noUnreadSince = 0;

      for (const row of candidateRows) {
        const key = gmailRowKey(row);
        attemptedRows.add(key);

        updateStep('Opening latest OpenAI email from Gmail');
        clickButton(row);
        await sleep(2500);

        const bodyText = document.body?.innerText || '';
        const code = extractChatGptCodeFromBody(bodyText) ||
          extractAnyOpenAiCodeFromBody(bodyText) ||
          extractOpenAiCodeFromText(bodyText);
        if (code) {
          updateStep('Marking Gmail message as read');
          await markCurrentGmailMessageAsRead();
          await sleep(500);
          updateStep('Returning to Gmail inbox');
          history.back();
          await sleep(1500);
          await chrome.runtime.sendMessage({ type: 'GMAIL_CODE_READY', code }).catch(() => null);
          return true;
        }

        if (!pageLooksRelevantForCode(profile.email)) {
          history.back();
          await sleep(1500);
          continue;
        }

        history.back();
        await sleep(1500);
      }

      await sleep(3000);
    }

    throw new Error(`Timed out waiting for unread ChatGPT code email for ${profile.email}`);
  }

  async function handleVerificationCodeStep() {
    const codeInput = findVerificationCodeInput();
    const submitButton = $('button[type="submit"], form button');
    if (!codeInput) {
      return false;
    }

    const findResendCodeButton = () => findClickableByText([
      /^resend$/i,
      /^resend code$/i,
      /^send again$/i,
      /^try again$/i,
      /^重新发送$/,
      /^重新发送验证码$/,
      /^重发验证码$/
    ]);

    const requestCodeWithResend = async () => {
      const codePromise = requestGmailCode();
      let settled = false;
      codePromise.finally(() => {
        settled = true;
      });

      let attempt = 0;
      while (!settled) {
        await sleep(30000);
        if (settled) {
          break;
        }
        const resendButton = findResendCodeButton();
        if (resendButton) {
          attempt += 1;
          updateStep(`No code yet, trying resend #${attempt}`);
          clickButton(resendButton);
        }
      }

      return codePromise;
    };

    updateStep('Opening verification inbox to fetch latest OpenAI code');
    const code = await requestCodeWithResend();
    if (!code) {
      throw new Error('Unable to fetch verification code from configured inbox');
    }

    updateStep(`Filling verification code ${code}`);
    fillInput(codeInput, code);
    await sleep(150);
    clickButton(submitButton);
    return true;
  }

  async function handleAuthShellStep() {
    if (authShellHandledOnce) {
      updateStep('Auth page already handled once; waiting');
      return false;
    }

    await waitForDocumentReady(15000);
    await sleep(800);

    updateStep(pageShowsSessionEnded()
      ? 'Session ended page detected; waiting without action'
      : 'Auth page detected; waiting without action');
    authShellHandledOnce = true;
    return false;
  }

  async function handleOnboardingGoalStep() {
    updateStep('Selecting ChatGPT onboarding goal');
    const anyGoal = findClickableByText([/^\u5b66\u6821$/, /^\u5de5\u4f5c$/, /^\u4e2a\u4eba\u4efb\u52a1$/, /^\u4e50\u8da3\u548c\u5a31\u4e50$/, /^\u5176\u4ed6$/]);
    if (!anyGoal) {
      return false;
    }
    clickButton(anyGoal);
    await sleep(300);
    const nextButton = findClickableByText([/^下一步$/, /^继续$/, /^continue$/i, /^next$/i]);
    if (nextButton) {
      clickButton(nextButton);
      await sleep(600);
    }
    return true;
  }

  async function handleOnboardingPersonalStep() {
    updateStep('Selecting personal use');
    const personalButton = findClickableByText([/^\u4e2a\u4eba\u4f7f\u7528$/, /^personal$/i, /^for personal use$/i]);
    if (!personalButton) {
      return false;
    }
    clickButton(personalButton);
    await sleep(300);
    const continueButton = findClickableByText([/^继续$/, /^continue$/i, /^下一步$/, /^next$/i]);
    if (continueButton) {
      clickButton(continueButton);
      await sleep(600);
    }
    return true;
  }

  async function handleOnboardingContinueStep() {
    updateStep('Advancing ChatGPT onboarding');
    const button = findClickableByText([
      /^跳过导览$/,
      /^\u8df3\u8fc7\u5bfc\u89c8$/,
      /^\u7ee7\u7eed$/,
      /^continue$/i,
      /^\u4e0b\u4e00\u6b65$/,
      /^next$/i,
      /^\u597d\u7684\u5f00\u59cb\u5427$/,
      /^let'?s go$/i,
      /^get started$/i
    ]);
    if (!button) {
      return false;
    }
    clickButton(button);
    await sleep(700);
    return true;
  }

  async function handleChatReadyStep() {
    if (finalFlowStarted) {
      return false;
    }

    const composer = findChatComposer();
    if (!composer) {
      return false;
    }

    finalFlowStarted = true;
    updateStep('Sending first ChatGPT message');
    composer.focus();

    if (composer.tagName === 'TEXTAREA') {
      fillInput(composer, '\u4f60\u597d');
    } else {
      composer.textContent = '\u4f60\u597d';
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: '\u4f60\u597d'
      }));
    }

    await sleep(200);
    const sendButton = findElementByAriaLabel([/send/i, /发送/i]) ||
      findClickableByText([/^发送$/, /^send$/i]);
    if (sendButton) {
      clickButton(sendButton);
    } else {
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    }

    await chrome.runtime.sendMessage({ type: 'AUTH_COMPLETED' }).catch(() => null);
    return true;
  }

  async function handleCpaStep() {
    const context = await getCpaContext();
    if (!context.enabled) {
      return false;
    }

    await waitForDocumentReady(20000);
    await sleep(1000);

    if (context.callbackUrl) {
      updateStep('Submitting OAuth callback URL to CPA page');
      const input = Array.from(document.querySelectorAll('input, textarea')).find((element) => {
        const type = (element.getAttribute('type') || '').toLowerCase();
        return type !== 'hidden' && isVisibleElement(element);
      });

      if (input) {
        fillInput(input, context.callbackUrl);
        await sleep(200);
      }

      const submitButton = findClickableByText([
        /^submit$/i,
        /^\u63d0\u4ea4$/,
        /^continue$/i,
        /^\u7ee7\u7eed$/
      ]);

      if (submitButton) {
        clickButton(submitButton);
        await sleep(500);
      }

      await chrome.runtime.sendMessage({ type: 'CPA_SUBMIT_DONE' }).catch(() => null);
      return true;
    }

    updateStep('Opening Codex OAuth on CPA page');
    const loginButton = findCodexOauthLoginButton();

    if (loginButton) {
      clickButton(loginButton);
      await sleep(1500);
    }

    const authUrl = findLinkLikeUrl(/https:\/\/auth\.openai\.com\/[^\s"'<>]+/i) ||
      findLinkLikeUrl(/https:\/\/auth0\.openai\.com\/[^\s"'<>]+/i);
    if (!authUrl) {
      return false;
    }

    await chrome.runtime.sendMessage({ type: 'CPA_AUTH_LINK_READY', url: authUrl }).catch(() => null);
    return true;
  }

  async function handleOauthStep() {
    const context = await getOauthContext();
    if (!context.enabled) {
      return false;
    }

    if (/^http:\/\/localhost/i.test(location.href)) {
      updateStep('Captured localhost OAuth callback URL');
      await chrome.runtime.sendMessage({ type: 'OAUTH_CALLBACK_READY', url: location.href }).catch(() => null);
      return true;
    }

    if (pageShowsPhoneRequired() && !oauthPhoneRetryRequested) {
      oauthPhoneRetryRequested = true;
      oauthSignupClickedOnce = true;
      updateStep('Phone required page detected; reopening OAuth in login mode');
      await chrome.runtime.sendMessage({ type: 'REOPEN_OAUTH_FOR_LOGIN' }).catch(() => null);
      return true;
    }

    if (context.forceLogin) {
      const loginButton = findLoginButton();
      if (loginButton && !oauthLoginClickedOnce) {
        oauthLoginClickedOnce = true;
        updateStep('Opening login from Codex OAuth page');
        clickButton(loginButton);
        await sleep(1200);
        return true;
      }
    }

    const signupButton = findSignupButton();
    if (!context.forceLogin && signupButton && !oauthSignupClickedOnce) {
      oauthSignupClickedOnce = true;
      updateStep('Opening signup from Codex OAuth page');
      clickButton(signupButton);
      await sleep(1200);
      return true;
    }

    const profile = context.profile;
    if ($('input[type="email"], input[autocomplete="email"]') && profile?.email) {
      return handleEmailStep(profile);
    }

    if ($('input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]') && profile?.password) {
      const passwordInput = $('input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]');
      const submitButton = $('button[type="submit"], form button');
      updateStep('Completing OAuth login password');
      fillInput(passwordInput, profile.password);
      await sleep(150);
      clickButton(submitButton);
      return true;
    }

    if (findVerificationCodeInput()) {
      return handleVerificationCodeStep();
    }

    if ($('input[name="name"], input[autocomplete="name"], input[placeholder*="name" i]')) {
      return handleNameStep(profile);
    }

    const continueButton = findClickableByText([
      /^continue$/i,
      /^\u7ee7\u7eed$/,
      /^next$/i,
      /^\u4e0b\u4e00\u6b65$/,
      /^allow$/i,
      /^\u5141\u8bb8$/,
      /^authorize$/i,
      /^\u6388\u6743$/
    ]);

    if (continueButton) {
      updateStep('Continuing Codex OAuth approval');
      clickButton(continueButton);
      await sleep(1000);
      return true;
    }

    return false;
  }

  async function processPage() {
    if (isProcessing) {
      return;
    }

    const cpaContext = await getCpaContext();
    if (cpaContext.enabled) {
      isProcessing = true;
      try {
        const id = pageId();
        const uniqueId = `cpa:${id}:${cpaContext.callbackUrl || 'pending'}`;
        if (!processedPageIds.has(uniqueId)) {
          const handled = await handleCpaStep();
          if (handled) {
            processedPageIds.add(uniqueId);
          }
        }
      } catch (error) {
        reportError(error.message || String(error));
      } finally {
        isProcessing = false;
      }
      return;
    }

    const oauthContext = await getOauthContext();
    if (oauthContext.enabled) {
      isProcessing = true;
      try {
        const id = pageId();
        const uniqueId = `oauth:${id}`;
        if (!processedPageIds.has(uniqueId)) {
          const handled = await handleOauthStep();
          if (handled) {
            processedPageIds.add(uniqueId);
          }
        }
      } catch (error) {
        reportError(error.message || String(error));
      } finally {
        isProcessing = false;
      }
      return;
    }

    if (!isRegistrationHost() && !/^http:\/\/localhost/i.test(location.href)) {
      return;
    }

    const flowContext = await getFlowContext();
    finalFlowStarted = finalFlowStarted || flowContext.finalFlowStarted;
    profileSubmitted = profileSubmitted || flowContext.postSignupPending;

    if (flowContext.paused) {
      updateStep('Paused');
      return;
    }

    if (finalFlowStarted && !/^http:\/\/localhost/i.test(location.href)) {
      updateStep('Final flow already started');
      return;
    }

    const step = detectStep();
    const allowedPostSubmitSteps = [
      'onboarding_goal',
      'onboarding_personal',
      'onboarding_continue',
      'chat_ready',
      'gmail_inbox',
      'verification_code',
      'verify_email',
      'auth_shell'
    ];

    if (
      profileSubmitted &&
      !allowedPostSubmitSteps.includes(step) &&
      !/^http:\/\/localhost/i.test(location.href)
    ) {
      updateStep('Waiting for post-signup redirect');
      return;
    }
    if (step === 'duck_address') {
      isProcessing = true;
      try {
        const id = pageId();
        const uniqueId = `${step}:${id}`;
        if (!processedPageIds.has(uniqueId)) {
          const handled = await handleDuckAddressStep();
          if (handled) {
            processedPageIds.add(uniqueId);
          }
        }
      } catch (error) {
        reportError(error.message || String(error));
        await chrome.runtime.sendMessage({
          type: 'DUCK_ADDRESS_ERROR',
          error: error.message || String(error)
        }).catch(() => null);
      } finally {
        isProcessing = false;
      }
      return;
    }

    if (step === 'gmail_inbox') {
      isProcessing = true;
      try {
        await handleGmailInboxStep();
      } catch (error) {
        reportError(error.message || String(error));
        await chrome.runtime.sendMessage({
          type: 'GMAIL_CODE_ERROR',
          error: error.message || String(error)
        }).catch(() => null);
      } finally {
        isProcessing = false;
      }
      return;
    }

    const profile = await getProfile();
    if (!profile?.email) {
      return;
    }

    const id = pageId();
    const uniqueId = `${step}:${id}`;

    if (processedPageIds.has(uniqueId)) {
      return;
    }

    isProcessing = true;

    try {
      let handled = false;

      if (step === 'email') {
        handled = await handleEmailStep(profile);
      } else if (step === 'landing_signup') {
        handled = await handleLandingSignupStep();
      } else if (step === 'password') {
        handled = await handlePasswordStep(profile);
      } else if (step === 'verification_code') {
        handled = await handleVerificationCodeStep();
      } else if (step === 'auth_shell') {
        handled = await handleAuthShellStep();
      } else if (step === 'name') {
        handled = await handleNameStep(profile);
      } else if (step === 'onboarding_goal') {
        handled = await handleOnboardingGoalStep();
      } else if (step === 'onboarding_personal') {
        handled = await handleOnboardingPersonalStep();
      } else if (step === 'onboarding_continue') {
        handled = await handleOnboardingContinueStep();
      } else if (step === 'chat_ready') {
        handled = await handleChatReadyStep();
      } else if (step === 'verify_email') {
        updateStep('Check inbox step reached');
      }

      if (handled) {
        processedPageIds.add(uniqueId);
      }
    } catch (error) {
      reportError(error.message || String(error));
    } finally {
      isProcessing = false;
    }
  }

  async function init() {
    await sleep(300);
    processPage();
    setInterval(processPage, 800);
  }

  init();
})();
