const CONFIG = {
  SPREADSHEET_ID: '__SPREADSHEET_ID__',
  SHEET_NAME: '__SHEET_NAME__',
  SECRET_TOKEN: '__TOKEN__',
  TEMPLATE_ROW: 2
};

const COLS = {
  DATE_APPLIED: 'Дата отклика',
  COMPANY: 'Компания',
  TITLE: 'Вакансия',
  LINK: 'Ссылка',
  STATUS: 'Статус',
  LAST_ACTION: 'Последнее действие',
  LAST_ACTION_DATE: 'Дата последнего действия',
  NEXT_STEP: 'Следующий шаг',
  FOLLOWUP_DATE: 'Дата фоллоуапа',
  DAYS_SINCE_APPLIED: 'Дней с отклика',
  DAYS_NO_RESPONSE: 'Дней без ответа',
  FOLLOWUP_NEEDED: 'Фоллоуап нужен?',
  PRIORITY: 'Приоритет',
  RESULT: 'Результат',
  CLOSED_DATE: 'Дата закрытия',
  NOTES: 'Заметки',
  SOURCE: 'Источник',
  SOURCE_ID: 'Источник ID',
  EXTERNAL_ID: 'External Vacancy ID',
  VACANCY_KEY: 'Vacancy Key',
  ALT_KEYS_JSON: 'Alt Keys JSON',
  CANONICAL_URL: 'Canonical URL',
  RAW_URL: 'Raw URL',
  COMPANY_NORMALIZED: 'Company Normalized',
  TITLE_NORMALIZED: 'Title Normalized',
  PAYLOAD_VERSION: 'Payload Version',
  RAW_PAYLOAD_JSON: 'Raw Payload JSON'
};

function doGet() {
  return jsonOutput({ ok: true, message: 'job tracker webhook ready' });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const payload = JSON.parse(raw);

    if (payload.token !== CONFIG.SECRET_TOKEN) {
      return jsonOutput({ ok: false, error: 'Unauthorized' });
    }

    const action = String(payload.action || 'add').trim();
    if (action === 'check') return handleCheck(payload);
    if (action === 'add') return handleAdd(payload);

    return jsonOutput({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return jsonOutput({ ok: false, error: error && error.message ? error.message : String(error) });
  }
}

function handleCheck(payload) {
  const { ss, sheet, headers } = getSheetContext();
  const vacancy = normalizeIncoming(payload);
  const found = findExisting(sheet, headers, vacancy);

  if (!found) return jsonOutput({ ok: true, applied: false });

  return jsonOutput({
    ok: true,
    applied: true,
    row: found.row,
    data: {
      row: found.row,
      sourceLabel: found.sourceLabel,
      vacancyKey: found.vacancyKey,
      url: found.canonicalUrl || found.url,
      company: found.company,
      title: found.title,
      status: found.status,
      dateApplied: found.dateApplied,
      lastAction: found.lastAction
    }
  });
}

function handleAdd(payload) {
  const { ss, sheet, headers } = getSheetContext();
  const vacancy = normalizeIncoming(payload);

  if (!vacancy.title || !vacancy.company) {
    throw new Error('Не хватает обязательных полей: title/company');
  }
  if (!vacancy.vacancyKey && !vacancy.canonicalUrl && !vacancy.rawUrl) {
    throw new Error('Не хватает identity-полей: vacancyKey/canonicalUrl/rawUrl');
  }

  const duplicate = findExisting(sheet, headers, vacancy);
  if (duplicate) {
    return jsonOutput({
      ok: true,
      status: 'duplicate',
      message: 'Такая вакансия уже есть в таблице',
      row: duplicate.row,
      data: {
        row: duplicate.row,
        sourceLabel: duplicate.sourceLabel,
        vacancyKey: duplicate.vacancyKey,
        url: duplicate.canonicalUrl || duplicate.url,
        company: duplicate.company,
        title: duplicate.title,
        status: duplicate.status,
        dateApplied: duplicate.dateApplied
      }
    });
  }

  const targetRow = Math.max(sheet.getLastRow() + 1, 2);
  writeVacancyToRow(sheet, targetRow, headers, vacancy);

  return jsonOutput({
    ok: true,
    status: 'added',
    row: targetRow,
    message: 'Вакансия добавлена',
    data: {
      row: targetRow,
      sourceLabel: vacancy.sourceLabel,
      vacancyKey: vacancy.vacancyKey,
      url: vacancy.canonicalUrl || vacancy.rawUrl,
      company: vacancy.company,
      title: vacancy.title,
      status: vacancy.status,
      dateApplied: formatDateForResponse(new Date(), ss)
    }
  });
}

function getSheetContext() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`Лист "${CONFIG.SHEET_NAME}" не найден`);
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error('На листе нет заголовков');
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(v => String(v || '').trim());
  return { ss, sheet, headers };
}

function normalizeIncoming(payload) {
  const altKeys = Array.isArray(payload.altKeys) ? payload.altKeys : [];
  return {
    version: Number(payload.version || 2),
    sourceId: clean(payload.sourceId),
    sourceLabel: clean(payload.sourceLabel),
    externalId: clean(payload.externalId),
    vacancyKey: clean(payload.vacancyKey),
    altKeys: altKeys.map(v => clean(v)).filter(Boolean),
    canonicalUrl: clean(payload.canonicalUrl),
    rawUrl: clean(payload.rawUrl),
    title: clean(payload.title),
    company: clean(payload.company),
    titleNormalized: clean(payload.titleNormalized) || normalizeText(payload.title),
    companyNormalized: clean(payload.companyNormalized) || normalizeText(payload.company),
    status: clean(payload.status) || 'Новый отклик',
    lastAction: clean(payload.lastAction) || 'Добавлено через userscript',
    notes: clean(payload.notes),
    priority: clean(payload.priority) || 'Средний',
    nextStep: clean(payload.nextStep),
    raw: payload.raw && typeof payload.raw === 'object' ? payload.raw : {}
  };
}

function findExisting(sheet, headers, vacancy) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const data = sheet.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues();

  const col = name => findColumnIndex(headers, name);
  const idx = {
    sourceLabel: col(COLS.SOURCE),
    sourceId: col(COLS.SOURCE_ID),
    externalId: col(COLS.EXTERNAL_ID),
    vacancyKey: col(COLS.VACANCY_KEY),
    altKeysJson: col(COLS.ALT_KEYS_JSON),
    canonicalUrl: col(COLS.CANONICAL_URL),
    rawUrl: col(COLS.RAW_URL),
    company: col(COLS.COMPANY),
    title: col(COLS.TITLE),
    status: col(COLS.STATUS),
    dateApplied: col(COLS.DATE_APPLIED),
    lastAction: col(COLS.LAST_ACTION),
    link: col(COLS.LINK)
  };

  const incomingAltKeys = toSet(vacancy.altKeys);
  const incomingCanonical = clean(vacancy.canonicalUrl);
  const incomingRaw = clean(vacancy.rawUrl);

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowData = {
      row: i + 2,
      sourceLabel: getAt(row, idx.sourceLabel),
      sourceId: getAt(row, idx.sourceId),
      externalId: getAt(row, idx.externalId),
      vacancyKey: getAt(row, idx.vacancyKey),
      canonicalUrl: getAt(row, idx.canonicalUrl),
      rawUrl: getAt(row, idx.rawUrl),
      url: getAt(row, idx.link),
      company: getAt(row, idx.company),
      title: getAt(row, idx.title),
      status: getAt(row, idx.status),
      dateApplied: getAt(row, idx.dateApplied),
      lastAction: getAt(row, idx.lastAction),
      altKeys: parseAltKeys(getAt(row, idx.altKeysJson))
    };

    if (vacancy.vacancyKey && rowData.vacancyKey && vacancy.vacancyKey === rowData.vacancyKey) return rowData;
    if (vacancy.sourceId && vacancy.externalId && rowData.sourceId === vacancy.sourceId && rowData.externalId === vacancy.externalId) return rowData;
    if (incomingCanonical && rowData.canonicalUrl && incomingCanonical === rowData.canonicalUrl) return rowData;
    if (incomingRaw && rowData.rawUrl && incomingRaw === rowData.rawUrl) return rowData;
    if (incomingCanonical && rowData.url && incomingCanonical === clean(rowData.url)) return rowData;
    if (incomingAltKeys.size > 0 && intersects(incomingAltKeys, toSet(rowData.altKeys))) return rowData;
  }

  return null;
}

function writeVacancyToRow(sheet, row, headers, vacancy) {
  const now = new Date();

  setByHeader(sheet, row, headers, COLS.DATE_APPLIED, now);
  setByHeader(sheet, row, headers, COLS.COMPANY, vacancy.company);
  setByHeader(sheet, row, headers, COLS.TITLE, vacancy.title);
  setLinkByHeader(sheet, row, headers, COLS.LINK, vacancy.canonicalUrl || vacancy.rawUrl);
  setByHeader(sheet, row, headers, COLS.STATUS, vacancy.status);
  setByHeader(sheet, row, headers, COLS.LAST_ACTION, vacancy.lastAction);
  setByHeader(sheet, row, headers, COLS.LAST_ACTION_DATE, now);
  setByHeader(sheet, row, headers, COLS.NEXT_STEP, vacancy.nextStep || '');
  setByHeader(sheet, row, headers, COLS.PRIORITY, vacancy.priority || '');
  setByHeader(sheet, row, headers, COLS.NOTES, vacancy.notes || '');

  setByHeader(sheet, row, headers, COLS.SOURCE, vacancy.sourceLabel);
  setByHeader(sheet, row, headers, COLS.SOURCE_ID, vacancy.sourceId);
  setByHeader(sheet, row, headers, COLS.EXTERNAL_ID, vacancy.externalId);
  setByHeader(sheet, row, headers, COLS.VACANCY_KEY, vacancy.vacancyKey);
  setByHeader(sheet, row, headers, COLS.ALT_KEYS_JSON, JSON.stringify(vacancy.altKeys || []));
  setByHeader(sheet, row, headers, COLS.CANONICAL_URL, vacancy.canonicalUrl);
  setByHeader(sheet, row, headers, COLS.RAW_URL, vacancy.rawUrl);
  setByHeader(sheet, row, headers, COLS.COMPANY_NORMALIZED, vacancy.companyNormalized);
  setByHeader(sheet, row, headers, COLS.TITLE_NORMALIZED, vacancy.titleNormalized);
  setByHeader(sheet, row, headers, COLS.PAYLOAD_VERSION, vacancy.version);
  setByHeader(sheet, row, headers, COLS.RAW_PAYLOAD_JSON, JSON.stringify(vacancy.raw || {}));
}

function getAt(row, colIndex) {
  return colIndex ? String(row[colIndex - 1] || '').trim() : '';
}

function parseAltKeys(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(v => clean(v)).filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function toSet(values) {
  return new Set((values || []).map(v => clean(v)).filter(Boolean));
}

function intersects(setA, setB) {
  for (const value of setA) {
    if (setB.has(value)) return true;
  }
  return false;
}

function setByHeader(sheet, row, headers, headerName, value) {
  const col = findColumnIndex(headers, headerName);
  if (!col) return;
  sheet.getRange(row, col).setValue(value);
}

function setLinkByHeader(sheet, row, headers, headerName, url) {
  const col = findColumnIndex(headers, headerName);
  if (!col || !url) return;
  const cell = sheet.getRange(row, col);
  cell.setValue(url);
  cell.setShowHyperlink(true);
}

function findColumnIndex(headers, name) {
  const idx = headers.indexOf(name);
  return idx === -1 ? 0 : idx + 1;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/["'`´’‘]/g, '')
    .replace(/[«»]/g, '')
    .replace(/[^\w\u0400-\u04FF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDateForResponse(date, ss) {
  return Utilities.formatDate(date, ss.getSpreadsheetTimeZone(), 'dd.MM.yyyy');
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
