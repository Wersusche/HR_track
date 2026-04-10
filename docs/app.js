
const STORAGE_KEY = 'hr-track-installer-config-v1';
const GOOGLE_CLIENT_ID = '1006836828889-n1buk13hje1o559r34urd658slrfe443.apps.googleusercontent.com';
const DEFAULT_HEADERS = [
  'Дата отклика',
  'Компания',
  'Вакансия',
  'Ссылка',
  'Статус',
  'Последнее действие',
  'Дата последнего действия',
  'Следующий шаг',
  'Дата фоллоуапа',
  'Дней с отклика',
  'Дней без ответа',
  'Фоллоуап нужен?',
  'Приоритет',
  'Результат',
  'Дата закрытия',
  'Заметки',
  'Источник',
  'Источник ID',
  'External Vacancy ID',
  'Vacancy Key',
  'Alt Keys JSON',
  'Canonical URL',
  'Raw URL',
  'Company Normalized',
  'Title Normalized',
  'Payload Version',
  'Raw Payload JSON'
];

const els = {
  spreadsheetTitle: document.getElementById('spreadsheet-title'),
  sheetName: document.getElementById('sheet-name'),
  scriptName: document.getElementById('script-name'),
  authorize: document.getElementById('authorize'),
  runSetup: document.getElementById('run-setup'),
  generateScript: document.getElementById('generate-script'),
  openInstall: document.getElementById('open-install'),
  downloadScript: document.getElementById('download-script'),
  log: document.getElementById('log'),
  resultSheet: document.getElementById('result-sheet'),
  resultScript: document.getElementById('result-script'),
  resultWebapp: document.getElementById('result-webapp'),
};

const state = {
  accessToken: '',
  config: loadConfig(),
  setup: null,
  generatedBlobUrl: ''
};

applyConfigToUi();
bindEvents();

function bindEvents() {
  els.authorize.addEventListener('click', authorize);
  els.runSetup.addEventListener('click', runSetup);
  els.generateScript.addEventListener('click', generateScript);
  els.openInstall.addEventListener('click', openInstall);
}

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (error) {
    return {};
  }
}

function applyConfigToUi() {
  if (state.config.spreadsheetTitle) els.spreadsheetTitle.value = state.config.spreadsheetTitle;
  if (state.config.sheetName) els.sheetName.value = state.config.sheetName;
  if (state.config.scriptName) els.scriptName.value = state.config.scriptName;
}

function saveConfigFromUi() {
  state.config = {
    spreadsheetTitle: els.spreadsheetTitle.value.trim(),
    sheetName: els.sheetName.value.trim(),
    scriptName: els.scriptName.value.trim()
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
  log('Конфиг сохранён локально');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function log(message) {
  const now = new Date().toLocaleTimeString('ru-RU');
  els.log.textContent += `[${now}] ${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setResult(el, value, href) {
  if (!value) {
    el.textContent = '—';
    return;
  }
  if (href) {
    el.innerHTML = '';
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = value;
    el.appendChild(a);
  } else {
    el.textContent = value;
  }
}

function enableSetup() {
  els.runSetup.disabled = !state.accessToken;
}

async function authorize() {
  saveConfigFromUi();

  if (!GOOGLE_CLIENT_ID) {
  alert('Не задан GOOGLE_CLIENT_ID');
  return;
}
  
  if (!window.google?.accounts?.oauth2) {
    alert('Google Identity Services ещё не загрузился');
    return;
  }

  const client = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/script.projects',
      'https://www.googleapis.com/auth/script.deployments'
    ].join(' '),
    callback: (response) => {
      if (response.error) {
        log(`OAuth error: ${response.error}`);
        return;
      }
      state.accessToken = response.access_token;
      log('Google access token получен');
      enableSetup();
    }
  });

  client.requestAccessToken({ prompt: 'consent' });
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${state.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {}

  if (!response.ok) {
    const message = data?.error?.message || text || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function createSpreadsheet(title, sheetName) {
  log('Создаю Google Sheet...');
  const data = await apiFetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: sheetName } }]
    })
  });
  return data;
}

async function writeHeaders(spreadsheetId, sheetName) {
  log('Записываю шапку таблицы...');
  await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName + '!1:1')}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({
      range: `${sheetName}!1:1`,
      majorDimension: 'ROWS',
      values: [DEFAULT_HEADERS]
    })
  });

  log('Форматирую первую строку...');
  await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: 0,
              startRowIndex: 0,
              endRowIndex: 1
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true }
              }
            },
            fields: 'userEnteredFormat.textFormat.bold'
          }
        },
        {
          updateSheetProperties: {
            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount'
          }
        }
      ]
    })
  });
}

async function createBoundScript(spreadsheetId, spreadsheetTitle) {
  log('Создаю bound Apps Script project...');
  const data = await apiFetch('https://script.googleapis.com/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: `${spreadsheetTitle} Webhook`,
      parentId: spreadsheetId
    })
  });
  return data;
}

async function updateScriptContent(scriptId, spreadsheetId, sheetName, token) {
  log('Заливаю Apps Script файлы...');
  const [codeTemplate, manifestTemplate] = await Promise.all([
    fetch('./templates/job-tracker-template.gs').then(r => r.text()),
    fetch('./templates/appsscript.template.json').then(r => r.text())
  ]);

  const code = codeTemplate
    .replaceAll('__SPREADSHEET_ID__', spreadsheetId)
    .replaceAll('__SHEET_NAME__', escapeForGsString(sheetName))
    .replaceAll('__TOKEN__', token);

  await apiFetch(`https://script.googleapis.com/v1/projects/${scriptId}/content`, {
    method: 'PUT',
    body: JSON.stringify({
      files: [
        { name: 'Code', type: 'SERVER_JS', source: code },
        { name: 'appsscript', type: 'JSON', source: manifestTemplate }
      ]
    })
  });
}

function escapeForGsString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function createVersion(scriptId) {
  log('Создаю version...');
  return await apiFetch(`https://script.googleapis.com/v1/projects/${scriptId}/versions`, {
    method: 'POST',
    body: JSON.stringify({
      description: 'Initial installer deployment'
    })
  });
}

async function createDeployment(scriptId, versionNumber) {
  log('Создаю deployment web app...');
  const deployment = await apiFetch(`https://script.googleapis.com/v1/projects/${scriptId}/deployments`, {
    method: 'POST',
    body: JSON.stringify({
      versionNumber,
      manifestFileName: 'appsscript',
      description: 'HR Track web app',
      entryPoints: [
        {
          webApp: {
            access: 'ANYONE_ANONYMOUS',
            executeAs: 'USER_DEPLOYING'
          }
        }
      ]
    })
  });

  return deployment;
}

function extractWebAppUrl(deployment) {
  const points = deployment.entryPoints || [];
  for (const point of points) {
    if (point.webApp?.url) return point.webApp.url;
  }
  return '';
}

async function runSetup() {
  if (!state.accessToken) {
    alert('Сначала авторизуйся через Google');
    return;
  }

  els.runSetup.disabled = true;
  els.generateScript.disabled = true;
  els.openInstall.disabled = true;
  els.downloadScript.setAttribute('aria-disabled', 'true');
  els.downloadScript.removeAttribute('href');

  try {
    const spreadsheetTitle = els.spreadsheetTitle.value.trim() || 'Job Tracker';
    const sheetName = els.sheetName.value.trim() || 'Отклики';
    const token = randomToken();

    const spreadsheet = await createSpreadsheet(spreadsheetTitle, sheetName);
    const spreadsheetId = spreadsheet.spreadsheetId;
    const spreadsheetUrl = spreadsheet.spreadsheetUrl;
    setResult(els.resultSheet, spreadsheetTitle, spreadsheetUrl);

    await writeHeaders(spreadsheetId, sheetName);

    const project = await createBoundScript(spreadsheetId, spreadsheetTitle);
    const scriptId = project.scriptId;
    setResult(els.resultScript, scriptId);

    await updateScriptContent(scriptId, spreadsheetId, sheetName, token);

    const version = await createVersion(scriptId);
    const deployment = await createDeployment(scriptId, version.versionNumber);
    const webAppUrl = extractWebAppUrl(deployment);

    if (!webAppUrl) {
      throw new Error('Не удалось получить web app URL из deployment response');
    }

    setResult(els.resultWebapp, webAppUrl, webAppUrl);

    state.setup = {
      spreadsheetTitle,
      sheetName,
      spreadsheetId,
      spreadsheetUrl,
      scriptId,
      deploymentId: deployment.deploymentId,
      webAppUrl,
      token,
      scriptName: els.scriptName.value.trim() || 'Vacancy pages -> Google Sheets Job Tracker'
    };

    localStorage.setItem('hr-track-last-setup', JSON.stringify(state.setup));
    log('Готово. Теперь можно сгенерировать userscript.');
    els.generateScript.disabled = false;
  } catch (error) {
    log(`Ошибка: ${error.message || error}`);
    alert(error.message || String(error));
  } finally {
    els.runSetup.disabled = false;
  }
}

async function generateScript() {
  if (!state.setup?.webAppUrl || !state.setup?.token) {
    alert('Сначала создай инфраструктуру');
    return;
  }

  log('Генерирую персональный userscript...');
  const template = await fetch('./templates/job-tracker-template.user.js').then(r => r.text());
  const content = template
    .replaceAll('__SCRIPT_NAME__', escapeHeaderValue(state.setup.scriptName))
    .replaceAll('__WEB_APP_URL__', state.setup.webAppUrl)
    .replaceAll('__TOKEN__', state.setup.token);

  if (state.generatedBlobUrl) URL.revokeObjectURL(state.generatedBlobUrl);
  const blob = new Blob([content], { type: 'application/javascript' });
  state.generatedBlobUrl = URL.createObjectURL(blob);

  els.downloadScript.href = state.generatedBlobUrl;
  els.downloadScript.download = 'hr-track.user.js';
  els.downloadScript.setAttribute('aria-disabled', 'false');
  els.openInstall.disabled = false;

  log('Userscript готов. Можно открыть установку или скачать файл.');
}

function escapeHeaderValue(value) {
  return String(value || '').replace(/\r?\n/g, ' ').trim();
}

function openInstall() {
  if (!state.generatedBlobUrl) {
    alert('Сначала сгенерируй userscript');
    return;
  }
  window.open(state.generatedBlobUrl, '_blank', 'noopener');
}
