// ==UserScript==
// @name         __SCRIPT_NAME__
// @namespace    https://tampermonkey.net/
// @version      2.1.0
// @description  Добавляет вакансии в Google Sheets и показывает, что уже откликался.
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    WEB_APP_URL: '__WEB_APP_URL__',
    TOKEN: '__TOKEN__',
    BUTTON_ID: 'jt-add-vacancy-button',
    TOAST_ID: 'jt-toast',
    BADGE_ID: 'jt-applied-badge',
    CHECK_DEBOUNCE_MS: 700,
    NAVIGATION_POLL_MS: 500,
    BUTTON_LABEL_IDLE: '+ в отклики',
    BUTTON_LABEL_LOADING: 'Отправляю...',
    DEFAULT_STATUS: 'Новый отклик',
    DEFAULT_PRIORITY: 'Средний'
  };

  const STATE = {
    lastHref: location.href,
    checkTimer: null,
    lastCheckFingerprint: '',
    lastRenderedBadgeKey: ''
  };

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeText(value) {
    return clean(value)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/["'`´’‘]/g, '')
      .replace(/[«»]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeUrlGeneric(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';

    try {
      const u = new URL(raw, location.origin);
      u.hash = '';
      u.search = '';
      const protocol = u.protocol.toLowerCase();
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      const pathname = u.pathname.replace(/\/+$/, '') || '/';
      return `${protocol}//${host}${pathname}`;
    } catch (error) {
      return raw.replace(/[#?].*$/, '').replace(/\/+$/, '');
    }
  }

  function hashString(input) {
    let hash = 5381;
    const text = String(input || '');
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function uniq(items) {
    return Array.from(new Set((items || []).filter(Boolean).map(item => String(item).trim()).filter(Boolean)));
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (error) { return null; }
  }

  function getContext() {
    return {
      url: location.href,
      location,
      document,
      hostname: location.hostname.toLowerCase(),
      pathname: location.pathname,
      search: location.search,
      hash: location.hash
    };
  }

  function qs(selector, root) { return (root || document).querySelector(selector); }
  function qsa(selector, root) { return Array.from((root || document).querySelectorAll(selector)); }

  function textFromSelectors(selectors, root) {
    for (const selector of selectors) {
      const element = qs(selector, root);
      const text = clean(element && element.textContent);
      if (text) return text;
    }
    return '';
  }

  function canonicalizeHhUrl(url) {
    const normalized = normalizeUrlGeneric(url);
    if (!normalized) return '';
    try {
      const u = new URL(normalized);
      const match = u.pathname.match(/^\/vacancy\/(\d+)/);
      if (match) return `https://${u.hostname.replace(/^www\./, '')}/vacancy/${match[1]}`;
      return normalized;
    } catch (error) {
      return normalized;
    }
  }

  function canonicalizeVkUrl(url) {
    const normalized = normalizeUrlGeneric(url);
    if (!normalized) return '';
    try {
      const u = new URL(normalized);
      const match = u.pathname.match(/^\/vacancy\/([^/]+)/);
      if (match) return `https://${u.hostname.replace(/^www\./, '')}/vacancy/${match[1]}`;
      return normalized;
    } catch (error) {
      return normalized;
    }
  }

  function buildIdentity(sourceId, sourceLabel, data) {
    const titleNormalized = normalizeText(data.title);
    const companyNormalized = normalizeText(data.company);
    const canonicalUrl = clean(data.canonicalUrl || data.url);
    const externalId = clean(data.externalId);
    let vacancyKey = '';
    const altKeys = [];

    if (sourceId && externalId) {
      vacancyKey = `${sourceId}:${externalId}`;
      altKeys.push(`src-ext:${sourceId}:${externalId}`);
    }
    if (canonicalUrl) altKeys.push(`url:${canonicalUrl}`);
    if (!vacancyKey && canonicalUrl) vacancyKey = `${sourceId}:url:${canonicalUrl}`;
    if (!vacancyKey && (titleNormalized || companyNormalized)) {
      vacancyKey = `${sourceId}:fp:${hashString(`${sourceId}|${companyNormalized}|${titleNormalized}`)}`;
      altKeys.push(`fp:${sourceId}:${companyNormalized}:${titleNormalized}`);
    }

    return {
      sourceId, sourceLabel, externalId, canonicalUrl,
      titleNormalized, companyNormalized, vacancyKey,
      altKeys: uniq(altKeys.concat(data.altKeys || []))
    };
  }

  function makePayload(adapter, extracted) {
    const defaults = typeof adapter.buildDefaults === 'function' ? adapter.buildDefaults(extracted) : {};
    const identity = buildIdentity(adapter.id, adapter.label, extracted);
    return {
      version: 2,
      sourceId: adapter.id,
      sourceLabel: adapter.label,
      externalId: identity.externalId,
      vacancyKey: identity.vacancyKey,
      altKeys: identity.altKeys,
      canonicalUrl: identity.canonicalUrl,
      rawUrl: clean(location.href),
      title: clean(extracted.title),
      company: clean(extracted.company),
      titleNormalized: identity.titleNormalized,
      companyNormalized: identity.companyNormalized,
      status: clean(extracted.status || defaults.status || CONFIG.DEFAULT_STATUS),
      lastAction: clean(extracted.lastAction || defaults.lastAction || `Добавлено с ${adapter.label}`),
      notes: clean(extracted.notes || defaults.notes || ''),
      priority: clean(extracted.priority || defaults.priority || CONFIG.DEFAULT_PRIORITY),
      nextStep: clean(extracted.nextStep || defaults.nextStep || ''),
      raw: Object.assign({ pageUrl: location.href }, extracted.raw || {})
    };
  }

  const SITE_ADAPTERS = [
    {
      id: 'hh',
      label: 'hh.ru',
      matches(ctx) { return /(^|\.)hh\.ru$/.test(ctx.hostname) && /^\/vacancy\//.test(ctx.pathname); },
      isReady() { return Boolean(qs('h1[data-qa="vacancy-title"]')); },
      extract() {
        const title = textFromSelectors(['h1[data-qa="vacancy-title"] span','h1[data-qa="vacancy-title"]']);
        const company = textFromSelectors(['[data-qa="vacancy-company-name"]','.vacancy-company-name a[data-qa="vacancy-company-name"]','.vacancy-company-name']);
        const canonicalUrl = canonicalizeHhUrl(location.href);
        const idMatch = canonicalUrl.match(/\/vacancy\/(\d+)$/);
        return { title, company, canonicalUrl, externalId: idMatch ? idMatch[1] : '', raw: { site: 'hh', pageTitle: document.title } };
      },
      buildDefaults() { return { status: 'Новый отклик', lastAction: 'Добавлено с hh.ru' }; }
    },
    {
      id: 'vk',
      label: 'team.vk.company',
      matches(ctx) { return ctx.hostname === 'team.vk.company' && /^\/vacancy\//.test(ctx.pathname); },
      isReady() { return Boolean(qs('div[itemprop="title"]')) && Boolean(qs('h2.title-block')); },
      extract() {
        const title = textFromSelectors(['div[itemprop="title"].title.desktop-only','div[itemprop="title"].title','div[itemprop="title"]']);
        const company = textFromSelectors(['h2.title-block']);
        const canonicalUrl = canonicalizeVkUrl(location.href);
        const idMatch = canonicalUrl.match(/\/vacancy\/([^/]+)$/);
        return { title, company, canonicalUrl, externalId: idMatch ? idMatch[1] : '', raw: { site: 'vk', pageTitle: document.title } };
      },
      buildDefaults() { return { status: 'Новый отклик', lastAction: 'Добавлено с team.vk.company' }; }
    },
    {
      id: 'avito',
      label: 'career.avito.com',
      matches(ctx) {
        return ctx.hostname === 'career.avito.com' && /^\/vacancies\/[^/]+\/\d+\/?$/.test(ctx.pathname);
      },
      isReady() { return Boolean(qs('.page-info.page-info--detail h1')); },
      extract() {
        const root = qs('.page-info.page-info--detail');
        const title = textFromSelectors(['.page-info.page-info--detail h1','h1'], root || document);
        const company = 'Авито';
        const canonicalUrl = (() => {
          const normalized = normalizeUrlGeneric(location.href);
          try {
            const u = new URL(normalized);
            const match = u.pathname.match(/^\/vacancies\/([^/]+)\/(\d+)\/?$/);
            if (match) return `https://${u.hostname.replace(/^www\./, '')}/vacancies/${match[1]}/${match[2]}`;
            return normalized;
          } catch (error) { return normalized; }
        })();
        const externalId =
          clean(root?.getAttribute('data-detail-vacancy-id-hf')) ||
          (canonicalUrl.match(/\/vacancies\/[^/]+\/(\d+)$/)?.[1] || '');
        const team = clean(root?.getAttribute('data-detail-vacancy-team'));
        const section = clean(root?.getAttribute('data-detail-vacancy-section'));
        const geo = clean(root?.getAttribute('data-detail-vacancy-geo'));
        const remote = clean(root?.getAttribute('data-detail-vacancy-remote'));
        const intern = clean(root?.getAttribute('data-detail-vacancy-intern'));
        return {
          title, company, canonicalUrl, externalId,
          raw: { site: 'avito', pageTitle: document.title, team, section, geo, remote, intern }
        };
      },
      buildDefaults() { return { status: 'Новый отклик', lastAction: 'Добавлено с career.avito.com' }; }
    }
  ];

  function getActiveAdapter() {
    const ctx = getContext();
    return SITE_ADAPTERS.find(adapter => adapter.matches(ctx)) || null;
  }

  function extractCurrentVacancy() {
    const adapter = getActiveAdapter();
    if (!adapter) return null;
    if (typeof adapter.isReady === 'function' && !adapter.isReady(getContext())) return null;
    const extracted = adapter.extract(getContext());
    if (!extracted) return null;
    const payload = makePayload(adapter, extracted);
    if (!payload.title || !payload.company || !payload.canonicalUrl || !payload.vacancyKey) return null;
    return payload;
  }

  function apiRequest(action, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.WEB_APP_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(Object.assign({ token: CONFIG.TOKEN, action }, payload || {})),
        onload(response) {
          const parsed = safeJsonParse(response.responseText);
          if (!parsed) return reject(new Error('Сервер вернул непонятный ответ'));
          if (!parsed.ok) return reject(new Error(parsed.error || 'Ошибка запроса'));
          resolve(parsed);
        },
        onerror() { reject(new Error('Не удалось отправить запрос')); }
      });
    });
  }

  function showToast(text, isError) {
    let toast = document.getElementById(CONFIG.TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = CONFIG.TOAST_ID;
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.className = isError ? 'jt-toast jt-toast-error' : 'jt-toast';
    toast.style.opacity = '1';
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  }

  function setButtonState(loading) {
    const button = document.getElementById(CONFIG.BUTTON_ID);
    if (!button) return;
    button.disabled = loading;
    button.textContent = loading ? CONFIG.BUTTON_LABEL_LOADING : CONFIG.BUTTON_LABEL_IDLE;
  }

  function createButton() {
    if (document.getElementById(CONFIG.BUTTON_ID)) return;
    const button = document.createElement('button');
    button.id = CONFIG.BUTTON_ID;
    button.type = 'button';
    button.textContent = CONFIG.BUTTON_LABEL_IDLE;
    button.addEventListener('click', onAddButtonClick);
    document.body.appendChild(button);
  }

  function removeButton() {
    const button = document.getElementById(CONFIG.BUTTON_ID);
    if (button) button.remove();
  }

  function renderAppliedBadge(info) {
    let badge = document.getElementById(CONFIG.BADGE_ID);
    if (!badge) {
      badge = document.createElement('div');
      badge.id = CONFIG.BADGE_ID;
      document.body.appendChild(badge);
    }
    const parts = ['Уже откликался'];
    if (info?.dateApplied) parts.push(info.dateApplied);
    if (info?.status) parts.push(info.status);
    if (info?.sourceLabel) parts.push(info.sourceLabel);
    badge.textContent = parts.join(' · ');
    badge.style.display = 'block';
    STATE.lastRenderedBadgeKey = info?.vacancyKey || '';
  }

  function removeAppliedBadge() {
    const badge = document.getElementById(CONFIG.BADGE_ID);
    if (badge) badge.style.display = 'none';
    STATE.lastRenderedBadgeKey = '';
  }

  async function onAddButtonClick() {
    const payload = extractCurrentVacancy();
    if (!payload) {
      showToast('Не удалось собрать данные вакансии', true);
      return;
    }
    setButtonState(true);
    try {
      const result = await apiRequest('add', payload);
      setButtonState(false);
      showToast(result.status === 'duplicate' ? 'Уже есть в таблице' : 'Добавлено в Google Sheets', false);
      renderAppliedBadge(result.data || {
        dateApplied: new Date().toLocaleDateString('ru-RU'),
        status: payload.status,
        sourceLabel: payload.sourceLabel,
        vacancyKey: payload.vacancyKey
      });
    } catch (error) {
      setButtonState(false);
      showToast(error.message || 'Ошибка записи', true);
    }
  }

  async function checkCurrentVacancy() {
    const payload = extractCurrentVacancy();
    if (!payload) {
      removeAppliedBadge();
      return;
    }
    const fingerprint = [payload.vacancyKey, payload.canonicalUrl, payload.rawUrl].join('|');
    if (STATE.lastCheckFingerprint === fingerprint && STATE.lastRenderedBadgeKey === payload.vacancyKey) return;
    STATE.lastCheckFingerprint = fingerprint;
    try {
      const result = await apiRequest('check', {
        sourceId: payload.sourceId,
        sourceLabel: payload.sourceLabel,
        externalId: payload.externalId,
        vacancyKey: payload.vacancyKey,
        altKeys: payload.altKeys,
        canonicalUrl: payload.canonicalUrl,
        rawUrl: payload.rawUrl,
        title: payload.title,
        company: payload.company
      });
      if (result.applied) renderAppliedBadge(result.data || payload);
      else removeAppliedBadge();
    } catch (error) {}
  }

  function syncUi() {
    const adapter = getActiveAdapter();
    if (!adapter) {
      removeButton();
      removeAppliedBadge();
      STATE.lastCheckFingerprint = '';
      return;
    }
    createButton();
    clearTimeout(STATE.checkTimer);
    STATE.checkTimer = setTimeout(() => { checkCurrentVacancy(); }, CONFIG.CHECK_DEBOUNCE_MS);
  }

  GM_addStyle(`
    #${CONFIG.BUTTON_ID} {
      position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
      border: none; border-radius: 999px; padding: 12px 16px;
      font-size: 14px; font-weight: 700; cursor: pointer; color: #fff;
      background: #1976d2; box-shadow: 0 8px 24px rgba(0,0,0,.18);
    }
    #${CONFIG.BUTTON_ID}:disabled { opacity: .75; cursor: wait; }
    #${CONFIG.TOAST_ID} {
      position: fixed; right: 24px; bottom: 78px; z-index: 2147483647;
      max-width: 340px; padding: 10px 14px; border-radius: 12px; color: #fff;
      background: #1f2937; font-size: 13px; line-height: 1.35;
      box-shadow: 0 8px 24px rgba(0,0,0,.18); opacity: 0;
      transition: opacity .2s ease; pointer-events: none;
    }
    #${CONFIG.TOAST_ID}.jt-toast-error { background: #b42318; }
    #${CONFIG.BADGE_ID} {
      position: fixed; top: 24px; right: 24px; z-index: 2147483647; max-width: 460px;
      padding: 12px 16px; border-radius: 14px; color: #5f4700; background: #ffe08a;
      border: 1px solid #f2c94c; font-size: 14px; font-weight: 700; line-height: 1.35;
      box-shadow: 0 8px 24px rgba(0,0,0,.12); display: none;
    }
  `);

  syncUi();
  setInterval(() => {
    if (location.href !== STATE.lastHref) {
      STATE.lastHref = location.href;
      STATE.lastCheckFingerprint = '';
      STATE.lastRenderedBadgeKey = '';
      setTimeout(syncUi, 350);
    }
  }, CONFIG.NAVIGATION_POLL_MS);

  const observer = new MutationObserver(() => {
    const adapter = getActiveAdapter();
    if (adapter) {
      if (!document.getElementById(CONFIG.BUTTON_ID)) createButton();
    } else {
      removeButton();
      removeAppliedBadge();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
