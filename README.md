# Expense Tracker Webhook Server

A Node.js webhook server for recording expenses through Telegram and WhatsApp-style webhooks. It stores expenses in Google Sheets, supports Gemini-powered expense parsing, and records split expenses in an `Owed` sheet.

## Requirements

- Windows CMD or another terminal
- Node.js 20 or newer
- A Google Cloud project with Google Sheets API enabled
- A Gemini API key
- A Telegram bot token, if using Telegram
- A public HTTPS URL for Telegram webhooks in production

## Quick Start in Windows CMD

Clone your fork and enter the project directory:

```cmd
git clone https://github.com/YOUR_GITHUB_USERNAME/Expense-Tracker.git
cd Expense-Tracker
```

Create the local environment file and install dependencies:

```cmd
copy .env.example .env
npm install
```

Open `.env` and replace every placeholder:

```cmd
notepad .env
```

Start the server:

```cmd
npm start
```

Check that it is running from another CMD window:

```cmd
curl http://localhost:3000/health
```

Expected response:

```json
{"status":"ok","timestamp":"..."}
```

## Google Sheets Setup

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable **Google Sheets API**.
4. Create a service account under **IAM & Admin > Service Accounts**.
5. Create and download a JSON key for the service account.
6. Save the downloaded file as `credentials.json` in the project root.
7. Create a Google Sheet.
8. Share the sheet with the service account's `client_email` as **Editor**.
9. Copy the spreadsheet ID from the URL:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

For local development, leave `GOOGLE_CREDENTIALS` empty and use `credentials.json`.

For a hosted/serverless deployment, do not upload `credentials.json`. Put the complete JSON key in the host's `GOOGLE_CREDENTIALS` environment variable instead.

## Environment Variables

Set these in `.env`:

```env
GEMINI_API_KEY=your_gemini_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_WEBHOOK_SECRET=your_random_webhook_secret
WEBHOOK_ADMIN_TOKEN=another_long_random_admin_token
PUBLIC_BASE_URL=https://your-public-domain.example
```

For each Telegram user, add a spreadsheet mapping. The variable name must match the user's Telegram username:

```env
vaibhav_SPREADSHEET_ID=your_google_sheet_id
```

The username is entered without `@`. The app matches the variable name case-insensitively.

For the WhatsApp-style `/webhook` endpoint, set the spreadsheet variable expected by your integration, for example:

```env
Hardiksingla07_SPREADSHEET_ID=your_google_sheet_id
```

Never commit `.env`, `credentials.json`, or API keys. They are excluded by `.gitignore`.

## Gemini Model Selection

Each Gemini request randomly selects a model supported by the standard `generateContent` API using these weights:

- `gemini-3.8-flash`: 90% (most likely)
- `gemini-3.6-flash`: 10% (least likely)

`gemini-3.8-live` is not included because it requires the real-time bidirectional streaming API rather than `generateContent`. If a request hits a rate limit or a temporary service-availability error, the server retries with a different model and a newly selected API key when available. Text messages and receipt images use a schema-constrained JSON response so Gemini identifies the request type and supplies transaction details, including any owed split amounts.

## Telegram Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) using `/newbot`.
2. Copy the bot token into `TELEGRAM_BOT_TOKEN`.
3. Set `TELEGRAM_WEBHOOK_SECRET` to a random value.
4. Set `WEBHOOK_ADMIN_TOKEN` to a different random value.
5. Deploy the server or expose local port 3000 through an HTTPS tunnel.

For local testing with ngrok:

```cmd
ngrok http 3000
```

Copy the HTTPS forwarding URL into `PUBLIC_BASE_URL`, restart the server, and register the webhook:

```cmd
curl "https://your-public-domain.example/telegram/set-webhook?adminToken=YOUR_WEBHOOK_ADMIN_TOKEN"
```

The endpoint registers:

```text
https://your-public-domain.example/telegram/webhook
```

To use a different public URL, pass it explicitly. In CMD, keep the complete URL inside quotes because it contains `&`:

```cmd
curl "https://your-public-domain.example/telegram/set-webhook?adminToken=YOUR_WEBHOOK_ADMIN_TOKEN&url=https%3A%2F%2Fyour-public-domain.example%2Ftelegram%2Fwebhook"
```

Check the current Telegram webhook:

```cmd
curl "https://your-public-domain.example/telegram/webhook-info?adminToken=YOUR_WEBHOOK_ADMIN_TOKEN"
```

When changing `TELEGRAM_WEBHOOK_SECRET`, edit `.env`, restart the server, and call `/telegram/set-webhook` again. The server uses the same secret to validate Telegram's `X-Telegram-Bot-Api-Secret-Token` header.

## Expense Examples

A normal message can be sent to the Telegram bot:

```text
150 auto rickshaw
```

A split expense is written as:

```text
349 - 67 Vaibhav, 51 Yash
```

This records `231` as the expense and adds separate rows for Vaibhav and Yash in the `Owed` sheet. The owed rows include the date, person's name, amount, original expense amount, timestamp, running total, and the original message as `Reason / Note`.

The assistant also understands equal splits and reasons:

```text
306 split equally between me and Yash
740 (Aata purchase) - 450 Yash
```

The first records your share as `₹153` and adds `₹153` owed by Yash. The second records your share as `₹290`, adds `₹450` owed by Yash, and saves `Aata purchase` as the reason.

Repayments can be recorded with:

```text
/paid Yash 500
/paid Yash 500 dinner repayment
```

Repayments reduce the person's outstanding balance while preserving the original owed history. Telegram receipt photos are also supported; send a clear receipt image, optionally with a caption such as `office lunch`, and the assistant will extract the expense details.

## Telegram Commands

```text
/today       Today's total
/month       Current month's total
/budget 30000 Set or update the current monthly budget
/budget      Review budget, spending, remaining amount, and pace
/limit Category Amount Set a monthly category limit
/limits      Review category spending limits
/report      Monthly report with budget and owed summary
/owed        Review amounts owed to you by person and reason
/owed Name   Review one person's outstanding balance
/paid Name Amount Record a repayment
/avg         Average daily spending this month
/overview    Category breakdown
/last        Most recent expense
/undo        Remove the most recent expense
```

## API Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `POST` | `/telegram/webhook` | Receives Telegram updates |
| `POST` | `/webhook` | Receives WhatsApp-style webhook payloads |
| `GET` | `/telegram/webhook-info?adminToken=...` | Reads Telegram webhook status |
| `GET` | `/telegram/set-webhook?adminToken=...` | Registers or updates Telegram's webhook |

The application uses these sheets:

- `Budget` for monthly budgets.
- `Limits` for category limits.
- `Owed` for owed entries, repayments, reasons, and transaction IDs.
- Monthly sheets for expenses and transaction IDs used by `/undo`.

## Forking and Personal Setup

1. Fork this repository on GitHub.
2. Clone your fork using the commands above.
3. Create `.env` from `.env.example`.
4. Create your own Gemini key, Telegram bot, Google Cloud service account, and Google Sheet.
5. Share your sheet with your own service account email.
6. Add your own Telegram username-to-sheet environment variable.
7. Run `npm install` and `npm start`.
8. Deploy to a host that supports Node.js and HTTPS, or use an HTTPS tunnel for testing.
9. Register the Telegram webhook using the protected GET endpoint.

Each person should use their own API keys and spreadsheet. Do not reuse the repository owner's credentials.

## Troubleshooting

- **Google Sheets not writing:** confirm the sheet is shared with the service account email and that the spreadsheet ID is correct.
- **Telegram returns 401:** check `WEBHOOK_ADMIN_TOKEN` in `.env` and the `adminToken` query parameter.
- **Telegram webhook is rejected:** use a public HTTPS URL and ensure `TELEGRAM_WEBHOOK_SECRET` matches the restarted server.
- **Telegram user is ignored:** add `<telegram_username>_SPREADSHEET_ID` to `.env`, then restart the server.
- **Gemini errors:** confirm `GEMINI_API_KEY` is valid and the server has been restarted after editing `.env`.
