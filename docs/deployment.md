# Личный Idea Bank на Vercel и Backblaze B2

Настройка личного сайта с входом через GitHub и синхронизацией через Backblaze B2. Доступ получает только аккаунт владельца.

## Что подготовить

- Личные аккаунты [GitHub](https://github.com), [Vercel](https://vercel.com) и [Backblaze B2](https://www.backblaze.com/sign-up/cloud-storage).
- Node.js LTS, Git и локальную копию репозитория с установленными зависимостями.

Выберите Vercel Hobby для личного некоммерческого использования. Для работы без списаний не добавляйте карту. Перед регистрацией проверьте бесплатные квоты и условия [Vercel](https://vercel.com/docs/plans/hobby) и [B2](https://www.backblaze.com/cloud-storage/pricing).

## 1. Копия репозитория

На странице [репозитория](https://github.com/IdleSpace76/idea-bank) нажмите **Fork**. Затем откройте **Code** уже в своём форке и скопируйте его HTTPS-адрес.

```sh
git clone https://github.com/YOUR_GITHUB_LOGIN/idea-bank.git
cd idea-bank
npm ci
```

Замените `YOUR_GITHUB_LOGIN` своим логином.

## 2. Закрытое хранилище B2

В Backblaze откройте **B2 Cloud Storage → Buckets → Create a Bucket**.

| Поле | Что выбрать |
| --- | --- |
| Bucket Name | Уникальное имя, например `idea-bank-yourname` (замените `yourname`) |
| Files in Bucket / Bucket Type | **Private** |
| Default Encryption | **Enable** |
| Object Lock | **Disable** |

Сохраните **Bucket Name** и **S3 Endpoint**. Например, для `s3.eu-central-003.backblazeb2.com` регион равен `eu-central-003`, полный endpoint: `https://s3.eu-central-003.backblazeb2.com`.

Оставьте хранение версий включённым. Не настраивайте автоматическое удаление снимков и медиа библиотеки.

### Ключ доступа к хранилищу

Откройте **Application Keys → Add a New Application Key**:

- **Name of Key:** например, `idea-bank-app`.
- **Allow access to Bucket(s):** только созданный bucket.
- **Type of Access:** **Read and Write**.
- **Allow List All Bucket Names:** оставьте выключенным; приложению не нужен список остальных bucket.
- **File name prefix** и **Duration:** оставьте пустыми.

Нажмите **Create New Key**. Сохраните **keyID** и **applicationKey** для `B2_KEY_ID` и `B2_APPLICATION_KEY`. Секрет показывается только при создании; master key не используйте.

Для настройки CORS ключу также нужны `readBuckets` и `writeBuckets`. [Справка о правах ключей](https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys).

## 3. GitHub App для авторизации

Создайте GitHub App для входа в Idea Bank. Подключение Vercel к репозиторию выполняется отдельно в шаге 5.

Откройте **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**. [Прямая ссылка](https://github.com/settings/apps/new).

| Поле | Значение |
| --- | --- |
| GitHub App name | Уникальное имя: `idea-bank-yourname` (замените `yourname`) |
| Homepage URL | `http://127.0.0.1:3000`; после развёртывания замените адресом сайта |
| Callback URL / Redirect URI | `http://127.0.0.1:3000/api/auth/callback/github` |
| Webhook → Active | Выключить |
| Permissions | Оставить обязательные значения GitHub по умолчанию |
| Where can this GitHub App be installed? | **Only on this account** |

Device Flow, Setup URL и дополнительные разрешения не включайте.

Создайте приложение, сохраните **Client ID** и получите **Client secret** через **Generate a new client secret**. App ID и PEM-файл не нужны.

Откройте `https://api.github.com/users/YOUR_GITHUB_LOGIN`. Для `IDEA_BANK_OWNER_ID` возьмите поле **id**, не `node_id` или логин.

[Справка GitHub о регистрации App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

## 4. Локальные настройки

Если `.env.local` ещё нет, создайте его из шаблона в корне репозитория.

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

macOS / Linux:

```sh
cp .env.example .env.local
```

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

Для `AUTH_SECRET` используйте результат команды, для `AUTH_GITHUB_SECRET` секрет GitHub. Храните ключи только в `.env.local` и серверных переменных Vercel, без префикса `NEXT_PUBLIC_`. Не публикуйте их.

Для проверки выполните `npm run dev`, откройте `http://127.0.0.1:3000` и войдите через GitHub. Не заменяйте `127.0.0.1` на `localhost`: адрес должен совпадать с callback.

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

Запустите развёртывание и дождитесь **Ready**. Сообщение «Вход не настроен» на сайте ожидаемо: остальные переменные будут добавлены в шаге 7.

В **Settings → Domains** найдите основной production-домен, например:

```text
https://YOUR-SITE.vercel.app
```

Используйте постоянный домен проекта, не временный адрес отдельной сборки.

[Импорт GitHub-проектов в Vercel](https://vercel.com/docs/git/vercel-for-github).

## 6. Привязка GitHub App к сайту

Вернитесь в настройки своей GitHub App:

1. Измените **Homepage URL** на `https://YOUR-SITE.vercel.app`.
2. Через **Add redirect URI / Add callback URL** добавьте:

   ```text
   https://YOUR-SITE.vercel.app/api/auth/callback/github
   ```

3. Сохраните изменения.

Локальный callback можно оставить для запуска на компьютере.

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

Для секретов выберите тип **Sensitive / Secret**, если он доступен.

Используйте отдельный production `AUTH_SECRET`. Не добавляйте секреты в Preview без настройки его домена, callback и CORS; оставьте только режим `github`.

[Как Vercel применяет переменные окружения](https://vercel.com/docs/environment-variables).

## 8. Настройка CORS для загрузки медиа

CORS разрешает браузеру передавать медиа между вашим сайтом и B2.

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

Скрипт добавит адрес сайта, сохранив остальные правила и закрытый доступ. Команда без `--apply` только проверяет настройки.

Для доступа из локальной копии повторите команду без временной переменной. Другой порт или `localhost` требует отдельного правила.

## 9. Применение настроек и проверка входа

В Vercel откройте **Deployments**, меню последнего production-развёртывания → **Redeploy**. Изменение переменных не обновляет уже запущенную сборку само по себе.

Дождитесь **Ready**, откройте основной адрес и войдите через GitHub. После входа должны открыться библиотека и синхронизация. Язык можно изменить в меню с иконкой планеты.

## 10. Перенос библиотеки и проверка телефона

На устройстве, где уже есть нужные идеи:

1. Откройте свою библиотеку. Сохраните или отмените текущий черновик.
2. Откройте меню синхронизации в верхней панели. Проверка подключения запускается автоматически.
3. При первом подключении выберите **Сохранить локальную в облаке**. Проверьте названия идей перед подтверждением.

На телефоне:

1. Откройте тот же основной HTTPS-адрес. `127.0.0.1` с компьютера сюда не подходит.
2. Войдите тем же GitHub-аккаунтом.
3. Откройте синхронизацию и выберите **Загрузить облачную на устройство**.
4. Проверьте текст и откройте несколько вложений: они загружаются при просмотре. Добавьте небольшую правку и сохраните. Дождитесь статуса **Сохранено в облаке**, вернитесь к приложению на компьютере и убедитесь, что правка пришла без нажатия кнопки синхронизации.

Если ваши идеи пока лежат только в локальной копии без GitHub-входа, есть два пути: настроить в ней вход и B2 либо экспортировать ZIP, импортировать его на опубликованном сайте и затем отправить в облако. Смена адреса сайта сама по себе не переносит данные браузера.

Направление первого переноса выбирает владелец. Дальнейшие изменения синхронизируются автоматически; при конфликте выбираются версии отдельных записей. Если используется старая облачная библиотека, выполните [переход на новый формат](b2-storage.md#сохранность-и-обновление-старой-библиотеки).

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
| На телефоне пусто | Проверьте адрес, аккаунт, выбранный источник при первом подключении и статус отправки на первом устройстве. |
| Изменения ждут отправки | Завершите редактирование или импорт. При сетевой ошибке дождитесь повторной попытки; при истёкшей сессии войдите снова. |
| Есть конфликт | Откройте меню синхронизации, сравните версии записей и примените выбранные варианты. |
| После очистки браузера пропали идеи | Войдите и получите облачную копию или восстановите ZIP. Локальные данные очищаются вместе с данными сайта. |
| `ERR_CONNECTION_CLOSED`, сайт не открывается вовсе | Проверьте другую сеть или мобильный интернет. Если адрес доступен только через прокси, настройте доступ к этому домену на устройстве; не отключайте проверку HTTPS. |

Для сообщения об ошибке достаточно описания, шага и текста ошибки без секретов. Не прикладывайте `.env.local`, ключи, ZIP личной библиотеки или временные подписанные ссылки на вложения.

Справка: [вход через GitHub](github-login.md), [хранение и синхронизация](b2-storage.md).
