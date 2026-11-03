# Личный вход через GitHub

Каждый владелец разворачивает собственную копию и регистрирует собственную GitHub App. Общего сервера пользователей нет. Для входа используется Auth.js (`next-auth` 5.0.0-beta.32, закреплённая beta-версия интеграции с App Router). GitHub-плагин для чата не нужен.

Вход защищает страницу приложения. Сам вход не включает перенос данных: для ручной синхронизации текстов и медиа настрой B2 по [инструкции](b2-storage.md). Локальная копия остаётся в браузере; вход не шифрует уже сохранённые локальные файлы. На общем компьютере другой человек с доступом к профилю браузера может прочитать локальное хранилище.

## Локальный запуск

Без `.env.local` приложение работает как раньше, без аккаунта. Не публикуй личный экземпляр в таком режиме. Для публичного развёртывания личной копии явно включи `IDEA_BANK_AUTH_MODE=github`.

## Настройка для проверки на компьютере

1. Открой [GitHub → Settings → Developer settings → GitHub Apps](https://github.com/settings/apps) и нажми **New GitHub App**.
2. Укажи уникальное имя, например `idea-bank-твой-логин`, и Homepage URL `http://127.0.0.1:3000`.
3. В Callback URL укажи **`http://127.0.0.1:3000/api/auth/callback/github`**. Не используй `localhost` вперемешку с `127.0.0.1`.
4. Выключи **Webhook → Active**. На этом шаге не запрашивай доступ к содержимому репозиториев, почте и организациям. Оставь обязательные разрешения GitHub по умолчанию. Device flow, Setup URL и private key для входа не нужны.
5. В **Where can this GitHub App be installed?** выбери **Only on this account** и создай приложение.
6. На странице приложения скопируй **Client ID**. Нажми **Generate a new client secret**. Секрет сохрани только в `.env.local`, не в чате и не в репозитории.
7. Создай локальный файл настроек:

   ```powershell
   Copy-Item .env.example .env.local
   ```

8. Открой свой профиль API по адресу `https://api.github.com/users/YOUR_GITHUB_LOGIN` (замени `YOUR_GITHUB_LOGIN` своим логином). Число в поле `id` — значение `IDEA_BANK_OWNER_ID`. Не используй `node_id` или имя пользователя.
9. Создай случайный секрет сессий:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

10. В `.env.local` выставь `IDEA_BANK_AUTH_MODE=github`, `AUTH_URL=http://127.0.0.1:3000`, заполни остальные переменные по комментариям. `AUTH_SECRET` — результат команды выше, `AUTH_GITHUB_SECRET` — секрет из GitHub. Это разные значения.
11. Перезапусти локальный сервер, открой адрес и нажми **Войти через GitHub**. Проверь вход своим аккаунтом и кнопку **Выйти**.

GitHub App использует разрешения самой App, поэтому вход не просит OAuth-scopes `repo` или `user:email`. Приложение запрашивает профиль `/user`, сверяет постоянный числовой ID и хранит зашифрованную HttpOnly-сессию до 7 дней. Проверка владельца повторяется при открытии страницы; токены GitHub не передаются браузеру и не сохраняются в сессии. При выходе локальная библиотека не удаляется. Смена `AUTH_SECRET` завершает все старые сессии.

Если включён режим `github`, но настройки неполные, библиотека не открывается. При `AccessDenied` проверь ID владельца; при другой ошибке — Client ID, Client secret и точное совпадение Callback URL.

## Личный экземпляр на Vercel

Полная последовательность настройки — в [deployment.md](deployment.md). При развёртывании добавь production Callback URL `https://твой-домен/api/auth/callback/github` в GitHub App и эти же переменные в Vercel → Environment Variables. `AUTH_URL` должен быть точным HTTPS-адресом production-сайта без пути. После изменения переменных нужен новый deployment. Не включай GitHub-вход на произвольных preview-доменах без отдельной настройки адреса и callback.

Для локальной и опубликованной копии удобнее отдельные GitHub Apps и секреты. `.env.local` исключён из Git; `.env.example` содержит только пустые поля. Закрытый GitHub-репозиторий для данных не нужен: тексты и медиа хранятся вместе в B2. Серверное подключение описано в [b2-storage.md](b2-storage.md), синхронизация запускается по кнопке в интерфейсе.

Справка: [GitHub App web flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [Auth.js в Next.js](https://authjs.dev/reference/nextjs).
