# HR Track GitHub Pages installer

## Куда класть
Этот scaffold рассчитан на репозиторий `Wersusche/HR_track`.

Самый простой вариант:
- положить `docs/` в репозиторий
- включить GitHub Pages из ветки `main`, папка `/docs`

Тогда installer будет жить по адресу:
`https://wersusche.github.io/HR_track/`

## Что настроить в Google Cloud
1. Создать OAuth Client ID типа **Web application**
2. Включить:
   - Google Sheets API
   - Google Apps Script API
3. Добавить origin:
   - `https://wersusche.github.io`

Для project site Pages origin — именно `https://wersusche.github.io`, а путь `/HR_track/` указывается уже в URL страницы.

## Что делает installer
- получает OAuth access token через Google Identity Services
- создаёт Google Sheet
- записывает шапку таблицы
- создаёт bound Apps Script project через `parentId`
- заливает `Code.gs` и `appsscript.json`
- создаёт version
- создаёт deployment web app
- генерирует персональный `.user.js` в браузере

## Ограничение без backend
Здесь нет сервера, поэтому персональный userscript создаётся на клиенте. В зависимости от браузера и версии Tampermonkey установка из blob/local file может отличаться. Поэтому оставлены сразу две кнопки:
- открыть установку
- скачать `.user.js`

## Рекомендуемая структура репо
- `docs/` — GitHub Pages installer
- `templates/` — шаблоны userscript и Apps Script


Шаблоны для браузера лежат в `docs/templates/`, потому что GitHub Pages публикует только содержимое `docs/`.
