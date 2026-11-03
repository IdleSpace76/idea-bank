# Личный Idea Bank на Vercel и Backblaze B2

Руководство описывает развёртывание личного экземпляра Idea Bank с HTTPS-адресом, авторизацией через GitHub и синхронизацией через Backblaze B2. Доступ к библиотеке получает только GitHub-аккаунт владельца.

Инструкция рассчитана на личную копию, а не на общий сервис с регистрацией пользователей. Настройка выполняется через сайты сервисов и несколько команд на компьютере. Плагины для чата, Vercel CLI и закрытый репозиторий с идеями не нужны.

## Что подготовить

- Личные аккаунты [GitHub](https://github.com), [Vercel](https://vercel.com) и [Backblaze B2](https://www.backblaze.com/sign-up/cloud-storage).
- Node.js LTS, Git и локальную копию репозитория с установленными зависимостями.
- Место для хранения секретов: локальный `.env.local` и серверные переменные Vercel. В публичный код они не попадут.

В Vercel выбирайте **Hobby**, не Pro или пробный Pro. Hobby предназначен для личного некоммерческого использования. У B2 есть бесплатная квота хранения; операции и скачивания имеют свои условия. Для работы без списаний не добавляйте платёжный метод и следите за расходом в кабинете B2. Проверьте текущие условия [Vercel](https://vercel.com/docs/plans/hobby) и [B2](https://www.backblaze.com/cloud-storage/pricing) перед регистрацией.

## 1. Копия репозитория

На странице [репозитория](https://github.com/IdleSpace76/idea-bank) нажмите **Fork**. Затем откройте **Code** уже в своём форке и скопируйте его HTTPS-адрес.

```sh
git clone https://github.com/YOUR_GITHUB_LOGIN/idea-bank.git
cd idea-bank
npm ci
```

Замените `YOUR_GITHUB_LOGIN` своим логином. Для Vercel нужен именно ваш форк: так вы сможете обновлять и менять свою копию.

## 2. Закрытое хранилище B2

В Backblaze откройте **B2 Cloud Storage → Buckets → Create a Bucket**.

| Поле | Что выбрать |
| --- | --- |
| Bucket Name | Уникальное имя, например `idea-bank-yourname` (замените `yourname`) |
| Files in Bucket / Bucket Type | **Private** |
| Default Encryption | **Enable** |
| Object Lock | **Disable** |

После создания сохраните **Bucket Name** и **S3 Endpoint**. Если показано `s3.eu-central-003.backblazeb2.com`, регион указывается как `eu-central-003`, адрес приложения как `https://s3.eu-central-003.backblazeb2.com`. Укажите регион созданного bucket; приведённое значение служит примером.

Оставьте хранение версий файлов включённым. Не настраивайте удаление объектов из папки `idea-bank/v1/revisions/`: снимки библиотеки ссылаются на предыдущие версии.

### Ключ доступа к хранилищу

Откройте **Application Keys → Add a New Application Key**:

- **Name of Key:** например, `idea-bank-app`.
- **Allow access to Bucket(s):** только созданный bucket.
- **Type of Access:** **Read and Write**.
- **Allow List All Bucket Names:** оставьте выключенным; приложению не нужен список остальных bucket.
- **File name prefix** и **Duration:** оставьте пустыми.

Нажмите **Create New Key**. Сохраните **keyID** и **applicationKey**: секрет показывается при создании. Это значения `B2_KEY_ID` и `B2_APPLICATION_KEY`. Приложению выдаётся отдельный ключ bucket, а не master key аккаунта.

Такой ключ должен позволять чтение и запись объектов. Для автоматической настройки CORS также нужны `readBuckets` и `writeBuckets` для выбранного bucket. Если скрипт позже сообщит, что не может настроить CORS, проверьте права этого ключа. [Справка Backblaze по ключам](https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys).

## 3. GitHub App для авторизации

При настройке используются два отдельных подключения GitHub. Собственная GitHub App отвечает за авторизацию в Idea Bank. Интеграция Vercel получает доступ к исходному коду при импорте форка.

Откройте **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**. [Прямая ссылка](https://github.com/settings/apps/new).

| Поле | Значение |
| --- | --- |
| GitHub App name | Уникальное имя: `idea-bank-yourname` (замените `yourname`) |
| Homepage URL | `http://127.0.0.1:3000`; после развёртывания замените адресом сайта |
| Callback URL / Redirect URI | `http://127.0.0.1:3000/api/auth/callback/github` |
| Webhook → Active | Выключить |
| Permissions | Оставить обязательные значения GitHub по умолчанию |
| Where can this GitHub App be installed? | **Only on this account** |

Остальные необязательные возможности, включая Device Flow и Setup URL, не включайте. Доступ к коду репозиториев, организациям и почте для входа Idea Bank не требуется.

Создайте приложение. На его странице найдите **Client ID**, затем создайте **Client secret** через **Generate a new client secret**. Сохраните оба значения. Для этой интеграции не нужны **App ID**, private key или PEM-файл: используются Client ID и Client secret.

Найдите свой числовой ID: откройте `https://api.github.com/users/YOUR_GITHUB_LOGIN` и посмотрите поле **id**. Значение поля `id` используется для `IDEA_BANK_OWNER_ID`; поле `node_id` и логин не подойдут.

[Справка GitHub о регистрации App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

## 4. Локальные настройки

В корне репозитория создайте `.env.local` из шаблона.

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

macOS / Linux:

```sh
cp .env.example .env.local
```

Если `.env.local` уже есть, откройте его: повторно копировать шаблон поверх рабочих настроек не нужно.

Создайте случайный секрет сессий:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Заполните `.env.local`, заменив значения-заглушки:

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

Для `AUTH_SECRET` используется результат команды, для `AUTH_GITHUB_SECRET` секрет из GitHub. Это разные значения. Имена переменных не изменяйте; префикс `NEXT_PUBLIC_` им не нужен.

`.env.local` исключён из Git. Не переносите рабочие ключи в `.env.example`, README или комментарии к коду.

Можно проверить вход локально: выполните `npm run dev`, откройте `http://127.0.0.1:3000` и нажмите **Sign in with GitHub**. Используйте именно `127.0.0.1`, как в callback. Подробности приведены в [github-login.md](github-login.md).

## 5. Импорт форка в Vercel

В Vercel выберите **Create New → Project** или **Import Project** и подключите GitHub. Если появится **Install Vercel**, выберите **Only select repositories** и укажите только свой форк `idea-bank`.

В форме импорта проверьте:

| Настройка | Значение |
| --- | --- |
| Team / Plan | Личное пространство, **Hobby** |
| Repository | Ваш форк |
| Production Branch | `main`, если вы не меняли имя ветки |
| Root Directory | `./` |
| Framework / Application Preset | **Next.js** |
| Build / Install / Output | Стандартные настройки Next.js |

Перед **Create Project / Deploy** откройте **Environment Variables** и добавьте:

```dotenv
IDEA_BANK_AUTH_MODE=github
```

Задайте переменную для Production и Preview. Остальные значения добавьте после получения постоянного домена. Не публикуйте личную копию в режиме `local`: в нём нет проверки владельца.

Запустите развёртывание. Первая сборка должна получить статус **Ready**, на странице приложения отобразится **Sign-in is not configured / Вход не настроен**. Сообщение означает, что настройки авторизации ещё не заполнены. До их заполнения доступ к библиотеке закрыт.

В **Settings → Domains** найдите основной production-домен, например:

```text
https://YOUR-SITE.vercel.app
```

Используйте этот адрес при дальнейшей настройке. Не подставляйте адрес отдельной сборки с временным суффиксом. Свой платный домен покупать не требуется.

[Импорт GitHub-проектов в Vercel](https://vercel.com/docs/git/vercel-for-github).

## 6. Привязка GitHub App к сайту

Вернитесь в настройки своей GitHub App:

1. Измените **Homepage URL** на `https://YOUR-SITE.vercel.app`.
2. Через **Add redirect URI / Add callback URL** добавьте:

   ```text
   https://YOUR-SITE.vercel.app/api/auth/callback/github
   ```

3. Сохраните изменения.

Локальный callback можно оставить, если хотите запускать ту же копию на компьютере. Адрес сайта и callback должны совпадать посимвольно: `https`, имя домена и путь `/api/auth/callback/github`.

## 7. Серверные переменные Vercel

Откройте проект в Vercel → **Settings → Environment Variables**. Добавьте следующие переменные для **Production**:

| Переменная | Что указать |
| --- | --- |
| `IDEA_BANK_AUTH_MODE` | Уже задано: `github` |
| `AUTH_URL` | `https://YOUR-SITE.vercel.app`, без пути и завершающего `/` |
| `AUTH_SECRET` | Новый случайный секрет, созданный той же командой Node.js |
| `AUTH_GITHUB_ID` | Client ID вашей GitHub App |
| `AUTH_GITHUB_SECRET` | Client secret этой App |
| `IDEA_BANK_OWNER_ID` | Числовой ID вашего GitHub-аккаунта |
| `B2_S3_ENDPOINT` | S3 Endpoint с `https://` |
| `B2_REGION` | Регион из этого endpoint |
| `B2_BUCKET_NAME` | Имя закрытого bucket |
| `B2_KEY_ID` | keyID ключа этого bucket |
| `B2_APPLICATION_KEY` | applicationKey |

Для секретов используйте тип **Sensitive / Secret**, если он предлагается интерфейсом. Не включайте их в клиентские переменные. Vercel получает настройки отдельно от Git. Файл `.env.local` не требуется загружать в репозиторий.

Для production удобно иметь отдельный `AUTH_SECRET`: смена секрета завершает прежние сессии. Секреты не нужно добавлять в Preview без отдельной настройки preview-домена, callback и CORS. Незавершённая конфигурация Preview останется закрытой режимом `github`.

[Как Vercel применяет переменные окружения](https://vercel.com/docs/environment-variables).

## 8. Настройка CORS для загрузки медиа

Браузер отправляет и получает медиа напрямую из B2. Для этого bucket должен разрешать origin вашего сайта в **CORS**. Одного server-side ключа недостаточно.

В терминале откройте локальную папку приложения. Скрипт возьмёт B2-ключи из `.env.local`; production-адрес передайте только на время команды.

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

В `.env.local` локальный `AUTH_URL` останется прежним. Если нужен и локальный облачный режим, выполните `npm run storage:cors -- --apply` ещё раз без временной переменной: тогда добавится `http://127.0.0.1:3000`. Другой порт или `localhost` считается отдельным origin.

## 9. Применение настроек и проверка входа

В Vercel откройте **Deployments**, меню последнего production-развёртывания → **Redeploy**. Изменение переменных не обновляет уже запущенную сборку само по себе.

Дождитесь **Ready**, откройте основной адрес и нажмите **Sign in with GitHub**. Если удобнее русский интерфейс, выберите **RU · Русский** в меню с иконкой планеты. Оно также доступно на странице входа.

Проверьте, что после входа открывается библиотека, а вверху есть **Выйти / Sign out** и **Синхронизация / Sync**. Приложение сверяет ID при входе и при чтении сессии; чужой аккаунт не должен получить доступ.

## 10. Перенос библиотеки и проверка телефона

На устройстве, где уже есть нужные идеи:

1. Откройте свою библиотеку. Сохраните или отмените текущий черновик.
2. Нажмите **Синхронизация → Синхронизировать**.
3. При первом подключении выберите **Сохранить локальную в облаке**. Проверьте названия идей перед подтверждением.

На телефоне:

1. Откройте тот же основной HTTPS-адрес. `127.0.0.1` с компьютера сюда не подходит.
2. Войдите тем же GitHub-аккаунтом.
3. Откройте синхронизацию и выберите **Загрузить облачную на устройство**.
4. Проверьте текст и несколько вложений. Добавьте небольшую правку, сохраните, синхронизируйте; на компьютере тоже нажмите синхронизацию и убедитесь, что правка пришла.

Если ваши идеи пока лежат только в локальной копии без GitHub-входа, есть два пути: настроить в ней вход и B2 либо экспортировать ZIP, импортировать его на опубликованном сайте и затем отправить в облако. Смена адреса сайта сама по себе не переносит данные браузера.

Первая синхронизация и конфликты требуют выбора направления. Следующие нажатия передают изменения автоматически, если менялась только одна сторона. При разных изменениях на обоих устройствах приложение предлагает выбрать библиотеку целиком. Старые облачные версии остаются в истории.

## Возможные ошибки

| Симптом | Что проверить |
| --- | --- |
| `Missing script: dev` | Терминал должен быть открыт в папке с `package.json`. |
| Сборка Vercel завершилась Error | Откройте Build Logs. Проверьте Root Directory `./`, Next.js preset и версию Node.js, совместимую с `package.json`. |
| «Вход не настроен» после заполнения переменных | Значения добавлены в **Production** нужного проекта? После них выполнен **Redeploy**? |
| GitHub отклоняет callback | Точный production-домен и путь, правильные Client ID и Client secret. Client ID и Client secret должны относиться к созданной GitHub App. |
| `AccessDenied` | В `IDEA_BANK_OWNER_ID` должно быть поле `id` владельца, а не логин или `node_id`. |
| Текст доступен, но медиа не загружается | Production-origin в CORS, права ключа и поля B2. Повторите настройку CORS для точного адреса. |
| Скрипт CORS завершился ошибкой | Ключ относится к нужному bucket, имеет `readBuckets`/`writeBuckets`, `.env.local` заполнен, адрес B2 доступен. |
| На телефоне пусто | Это тот же сайт и аккаунт? Библиотека отправлена с первого устройства, а затем получена на телефоне? |
| После очистки браузера пропали идеи | Войдите и получите облачную копию или восстановите ZIP. Локальные данные очищаются вместе с данными сайта. |
| `ERR_CONNECTION_CLOSED`, сайт не открывается вовсе | Проверьте другую сеть или мобильный интернет. Если адрес доступен только через прокси, настройте доступ к этому домену на устройстве; не отключайте проверку HTTPS. |

Для сообщения об ошибке достаточно описания, шага и текста ошибки без секретов. Не прикладывайте `.env.local`, ключи, ZIP личной библиотеки или временные подписанные ссылки на вложения.

Сведения об API, истории версий и лимитах приведены в [b2-storage.md](b2-storage.md). Правила публикации исходников приведены в [publishing.md](publishing.md).
