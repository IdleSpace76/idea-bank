# Личный Idea Bank на Vercel и Backblaze B2

После этой настройки у тебя будет свой HTTPS-адрес Idea Bank. Войти сможет только твой GitHub-аккаунт. С компьютера и телефона можно будет получать одну библиотеку: текст, обложки и вложения.

Инструкция рассчитана на личную копию, а не на общий сервис с регистрацией пользователей. Настройка выполняется через сайты сервисов и несколько команд на компьютере. Плагины для чата, Vercel CLI и закрытый репозиторий с идеями не нужны.

## Что подготовить

- Личные аккаунты [GitHub](https://github.com), [Vercel](https://vercel.com) и [Backblaze B2](https://www.backblaze.com/sign-up/cloud-storage).
- Node.js LTS, Git и локальную копию репозитория с установленными зависимостями.
- Место для хранения секретов: локальный `.env.local` и серверные переменные Vercel. В публичный код они не попадут.

В Vercel выбирай **Hobby**, не Pro или пробный Pro. Hobby предназначен для личного некоммерческого использования. У B2 есть бесплатная квота хранения; операции и скачивания имеют свои условия. Если нужен вариант без списаний, не добавляй платёжный метод и следи за расходом в кабинете B2. Проверь текущие условия [Vercel](https://vercel.com/docs/plans/hobby) и [B2](https://www.backblaze.com/cloud-storage/pricing) перед регистрацией.

## 1. Сделать свою копию кода

На странице [репозитория](https://github.com/IdleSpace76/idea-bank) нажми **Fork**. Затем открой **Code** уже в своём форке и скопируй его HTTPS-адрес.

```sh
git clone https://github.com/YOUR_GITHUB_LOGIN/idea-bank.git
cd idea-bank
npm ci
```

Замени `YOUR_GITHUB_LOGIN` своим логином. Для Vercel нужен именно твой форк: так ты сможешь обновлять и менять свою копию.

## 2. Создать закрытое хранилище B2

В Backblaze открой **B2 Cloud Storage → Buckets → Create a Bucket**.

| Поле | Что выбрать |
| --- | --- |
| Bucket Name | Уникальное имя, например `idea-bank-yourname` (замени `yourname`) |
| Files in Bucket / Bucket Type | **Private** |
| Default Encryption | **Enable** |
| Object Lock | **Disable** |

После создания сохрани **Bucket Name** и **S3 Endpoint**. Если показано `s3.eu-central-003.backblazeb2.com`, регион — `eu-central-003`, а адрес для настройки приложения — `https://s3.eu-central-003.backblazeb2.com`. Используй регион своего bucket, не копируй пример вслепую.

Оставь хранение версий файлов включённым. Не настраивай удаление объектов из папки `idea-bank/v1/revisions/`: снимки библиотеки ссылаются на предыдущие версии.

### Выдать ключ приложению

Открой **Application Keys → Add a New Application Key**:

- **Name of Key:** например, `idea-bank-app`.
- **Allow access to Bucket(s):** только созданный bucket.
- **Type of Access:** **Read and Write**.
- **Allow List All Bucket Names:** оставь выключенным; приложению не нужен список остальных bucket.
- **File name prefix** и **Duration:** оставь пустыми.

Нажми **Create New Key**. Сохрани **keyID** и **applicationKey**: секрет показывается при создании. Это значения `B2_KEY_ID` и `B2_APPLICATION_KEY`. Приложению выдаётся отдельный ключ bucket, а не master key аккаунта.

Такой ключ должен позволять чтение и запись объектов. Для автоматической настройки CORS также нужны `readBuckets` и `writeBuckets` для выбранного bucket. Если скрипт позже сообщит, что не может настроить CORS, проверь права этого ключа. [Справка Backblaze по ключам](https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys).

## 3. Создать GitHub App для входа

Не путай два приложения GitHub: **твоя GitHub App** отвечает за вход в Idea Bank, а **интеграция Vercel** получит доступ к коду при импорте форка.

Открой **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**. [Прямая ссылка](https://github.com/settings/apps/new).

| Поле | Значение |
| --- | --- |
| GitHub App name | Уникальное имя: `idea-bank-yourname` (замени `yourname`) |
| Homepage URL | `http://127.0.0.1:3000` — позже заменим адресом сайта |
| Callback URL / Redirect URI | `http://127.0.0.1:3000/api/auth/callback/github` |
| Webhook → Active | Выключить |
| Permissions | Оставить обязательные значения GitHub по умолчанию |
| Where can this GitHub App be installed? | **Only on this account** |

Остальные необязательные возможности, включая Device Flow и Setup URL, не включай. Доступ к коду репозиториев, организациям и почте для входа Idea Bank не требуется.

Создай приложение. На его странице найди **Client ID**, затем создай **Client secret** через **Generate a new client secret**. Сохрани оба значения. Для этой интеграции не нужны **App ID**, private key или PEM-файл: используются Client ID и Client secret.

Найди свой числовой ID: открой `https://api.github.com/users/YOUR_GITHUB_LOGIN` и посмотри поле **id**. Именно число пойдёт в `IDEA_BANK_OWNER_ID`; поле `node_id` и логин не подойдут.

[Справка GitHub о регистрации App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

## 4. Сохранить локальные настройки

В корне репозитория создай `.env.local` из шаблона.

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

macOS / Linux:

```sh
cp .env.example .env.local
```

Если `.env.local` уже есть, открой его: повторно копировать шаблон поверх рабочих настроек не нужно.

Создай случайный секрет сессий:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Заполни `.env.local`, заменив значения-заглушки:

```dotenv
IDEA_BANK_AUTH_MODE=github
AUTH_URL=http://127.0.0.1:3000
AUTH_SECRET=RANDOM_SESSION_SECRET
AUTH_GITHUB_ID=GITHUB_APP_CLIENT_ID
AUTH_GITHUB_SECRET=GITHUB_APP_CLIENT_SECRET
IDEA_BANK_OWNER_ID=YOUR_NUMERIC_GITHUB_ID
B2_S3_ENDPOINT=https://s3.YOUR_REGION.backblazeb2.com
B2_REGION=YOUR_REGION
B2_BUCKET_NAME=YOUR_PRIVATE_BUCKET_NAME
B2_KEY_ID=YOUR_B2_KEY_ID
B2_APPLICATION_KEY=YOUR_B2_APPLICATION_KEY
```

`AUTH_SECRET` — результат команды, а `AUTH_GITHUB_SECRET` — секрет из GitHub. Это разные значения. Имена переменных не меняй; префикс `NEXT_PUBLIC_` им не нужен.

`.env.local` исключён из Git. Не переноси рабочие ключи в `.env.example`, README или комментарии к коду.

Можно проверить вход локально: выполни `npm run dev`, открой `http://127.0.0.1:3000` и нажми **Sign in with GitHub**. Используй именно `127.0.0.1`, как в callback. Подробности — в [github-login.md](github-login.md).

## 5. Импортировать форк в Vercel

В Vercel выбери **Create New → Project** или **Import Project** и подключи GitHub. Если появится **Install Vercel**, выбери **Only select repositories** и укажи только свой форк `idea-bank`.

В форме импорта проверь:

| Настройка | Значение |
| --- | --- |
| Team / Plan | Личное пространство, **Hobby** |
| Repository | Твой форк |
| Production Branch | `main`, если ты не менял имя ветки |
| Root Directory | `./` |
| Framework / Application Preset | **Next.js** |
| Build / Install / Output | Стандартные настройки Next.js |

Перед **Create Project / Deploy** открой **Environment Variables** и добавь:

```dotenv
IDEA_BANK_AUTH_MODE=github
```

Задай её для Production и Preview. Остальные значения добавим, когда появится постоянный домен. Не публикуй личную копию в режиме `local`: в нём нет проверки владельца.

Запусти развёртывание. Первая сборка должна получить статус **Ready**, а сам сайт пока покажет **Sign-in is not configured / Вход не настроен**. На этом этапе это ожидаемо: доступ к библиотеке закрыт, пока не заполнены настройки.

В **Settings → Domains** найди основной production-домен, например:

```text
https://YOUR-SITE.vercel.app
```

Дальше используй этот адрес везде. Не подставляй адрес отдельной сборки с временным суффиксом. Свой платный домен покупать не требуется.

[Импорт GitHub-проектов в Vercel](https://vercel.com/docs/git/vercel-for-github).

## 6. Привязать GitHub App к сайту

Вернись в настройки своей GitHub App:

1. Измени **Homepage URL** на `https://YOUR-SITE.vercel.app`.
2. Через **Add redirect URI / Add callback URL** добавь:

   ```text
   https://YOUR-SITE.vercel.app/api/auth/callback/github
   ```

3. Сохрани изменения.

Локальный callback можно оставить, если хочешь запускать ту же копию на компьютере. Адрес сайта и callback должны совпадать посимвольно: `https`, имя домена и путь `/api/auth/callback/github`.

## 7. Заполнить серверные переменные Vercel

Открой проект в Vercel → **Settings → Environment Variables**. Добавь следующие переменные для **Production**:

| Переменная | Что указать |
| --- | --- |
| `IDEA_BANK_AUTH_MODE` | Уже задано: `github` |
| `AUTH_URL` | `https://YOUR-SITE.vercel.app`, без пути и завершающего `/` |
| `AUTH_SECRET` | Новый случайный секрет, созданный той же командой Node.js |
| `AUTH_GITHUB_ID` | Client ID твоей GitHub App |
| `AUTH_GITHUB_SECRET` | Client secret этой App |
| `IDEA_BANK_OWNER_ID` | Числовой ID твоего GitHub-аккаунта |
| `B2_S3_ENDPOINT` | S3 Endpoint с `https://` |
| `B2_REGION` | Регион из этого endpoint |
| `B2_BUCKET_NAME` | Имя закрытого bucket |
| `B2_KEY_ID` | keyID ключа этого bucket |
| `B2_APPLICATION_KEY` | applicationKey |

Для секретов используй тип **Sensitive / Secret**, если он предлагается интерфейсом. Не включай их в клиентские переменные. Vercel получает настройки отдельно от Git — загружать `.env.local` в репозиторий не нужно.

Для production удобно иметь отдельный `AUTH_SECRET`: смена секрета завершает прежние сессии. Секреты не нужно добавлять в Preview без отдельной настройки preview-домена, callback и CORS. Незавершённая конфигурация Preview останется закрытой режимом `github`.

[Как Vercel применяет переменные окружения](https://vercel.com/docs/environment-variables).

## 8. Разрешить загрузку файлов с адреса сайта

Браузер отправляет и получает медиа напрямую из B2. Для этого bucket должен разрешать origin твоего сайта в **CORS**. Одного server-side ключа недостаточно.

В терминале открой локальную папку приложения. Скрипт возьмёт B2-ключи из `.env.local`; production-адрес передай только на время команды.

PowerShell:

```powershell
$env:AUTH_URL = "https://YOUR-SITE.vercel.app"
npm run storage:cors -- --apply
Remove-Item Env:AUTH_URL
```

macOS / Linux:

```sh
AUTH_URL=https://YOUR-SITE.vercel.app npm run storage:cors -- --apply
```

При успехе скрипт сообщит, что CORS настроен или уже существует. Он добавляет origin в своё правило, сохраняет другие правила и оставляет bucket закрытым. Команда без `--apply` только проверяет настройки.

В `.env.local` локальный `AUTH_URL` останется прежним. Если нужен и локальный облачный режим, выполни `npm run storage:cors -- --apply` ещё раз без временной переменной: тогда добавится `http://127.0.0.1:3000`. Другой порт или `localhost` считается отдельным origin.

## 9. Применить настройки и войти

В Vercel открой **Deployments**, меню последнего production-развёртывания → **Redeploy**. Изменение переменных не обновляет уже запущенную сборку само по себе.

Дождись **Ready**, открой основной адрес и нажми **Sign in with GitHub**. Если удобнее русский интерфейс, выбери **RU · Русский** в меню с планетой — оно доступно и на странице входа.

Проверь, что после входа открывается библиотека, а вверху есть **Выйти / Sign out** и **Синхронизация / Sync**. Приложение сверяет ID при входе и при чтении сессии; чужой аккаунт не должен получить доступ.

## 10. Перенести библиотеку и проверить телефон

На устройстве, где уже есть нужные идеи:

1. Открой свою библиотеку. Сохрани или отмени текущий черновик.
2. Нажми **Синхронизация → Синхронизировать**.
3. При первом подключении выбери **Сохранить локальную в облаке**. Проверь названия идей перед подтверждением.

На телефоне:

1. Открой тот же основной HTTPS-адрес. `127.0.0.1` с компьютера сюда не подходит.
2. Войди тем же GitHub-аккаунтом.
3. Открой синхронизацию и выбери **Загрузить облачную на устройство**.
4. Проверь текст и несколько вложений. Добавь небольшую правку, сохрани, синхронизируй; на компьютере тоже нажми синхронизацию и убедись, что правка пришла.

Если твои идеи пока лежат только в локальной копии без GitHub-входа, есть два пути: настроить в ней вход и B2 либо экспортировать ZIP, импортировать его на опубликованном сайте и затем отправить в облако. Смена адреса сайта сама по себе не переносит данные браузера.

Первая синхронизация и конфликты требуют выбора направления. Следующие нажатия передают изменения автоматически, если менялась только одна сторона. При разных изменениях на обоих устройствах приложение предлагает выбрать библиотеку целиком. Старые облачные версии остаются в истории.

## Если что-то не сработало

| Симптом | Что проверить |
| --- | --- |
| `Missing script: dev` | Терминал должен быть открыт в папке с `package.json`. |
| Сборка Vercel завершилась Error | Открой Build Logs. Проверь Root Directory `./`, Next.js preset и версию Node.js, совместимую с `package.json`. |
| «Вход не настроен» после заполнения переменных | Значения добавлены в **Production** нужного проекта? После них выполнен **Redeploy**? |
| GitHub отклоняет callback | Точный production-домен и путь, правильные Client ID и Client secret. Нужна GitHub App, не случайная OAuth App. |
| `AccessDenied` | В `IDEA_BANK_OWNER_ID` должно быть поле `id` владельца, а не логин или `node_id`. |
| Текст доступен, но медиа не загружается | Production-origin в CORS, права ключа и поля B2. Повтори настройку CORS для точного адреса. |
| Скрипт CORS завершился ошибкой | Ключ относится к нужному bucket, имеет `readBuckets`/`writeBuckets`, `.env.local` заполнен, адрес B2 доступен. |
| На телефоне пусто | Это тот же сайт и аккаунт? Библиотека отправлена с первого устройства, а затем получена на телефоне? |
| После очистки браузера пропали идеи | Войди и получи облачную копию или восстанови ZIP. Локальные данные очищаются вместе с данными сайта. |
| `ERR_CONNECTION_CLOSED`, сайт не открывается вовсе | Проверь другую сеть или мобильный интернет. Если адрес доступен только через прокси, настрой доступ к этому домену на устройстве; не отключай проверку HTTPS. |

Для сообщения об ошибке достаточно описания, шага и текста ошибки без секретов. Не прикладывай `.env.local`, ключи, ZIP личной библиотеки или временные подписанные ссылки на вложения.

Детали API, истории версий и лимитов — в [b2-storage.md](b2-storage.md). Правила публикации исходников — в [publishing.md](publishing.md).
