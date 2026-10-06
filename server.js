require('dotenv').config();
const express = require('express');
const { processExpenseMessage, processReceiptImage, getTodayTotal, getMonthTotal, setMonthlyBudget, getBudgetStatus, setCategoryLimit, getCategoryLimitStatuses, getCategoryLimitAlert, getMonthlyReport, getOwedSummary, recordSettlement, getAveragePerDayThisMonth, getCategoryOverviewThisMonth, undoLastExpense, getLastExpense } = require('./expenseService');
const { telegramAuthMiddleware, verifyTelegramWebhook } = require('./telegramMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_ADMIN_TOKEN = process.env.WEBHOOK_ADMIN_TOKEN;

app.use(express.json());

// Idempotency cache: store recently processed update IDs
const processedUpdates = new Set();
// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function sendTelegramReply(chatId, text) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error("Missing TELEGRAM_BOT_TOKEN to send replies");
        return;
    }
    const cleanText = String(text ?? '')
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n /g, '\n')
        .trim();
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: cleanText })
        });
    } catch (e) {
        console.error("Failed to send telegram message:", e);
    }
}

function authorizeWebhookAdmin(req, res, next) {
    if (!WEBHOOK_ADMIN_TOKEN || req.query.adminToken !== WEBHOOK_ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

async function callTelegramApi(method, body = {}) {
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error('TELEGRAM_BOT_TOKEN is missing');
    }

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
        throw new Error(result.description || `Telegram API request failed with status ${response.status}`);
    }
    return result.result;
}

async function downloadTelegramPhoto(photo) {
    const file = await callTelegramApi('getFile', { file_id: photo.file_id });
    const response = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram image download failed with status ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

async function sendRecordedExpenses(chatId, result, spreadsheetId, heading = 'Recorded') {
    const entries = result.entries || (result.data ? [{ ...result.data, owed: result.owed || [] }] : []);
    if (!entries.length) {
        await sendTelegramReply(chatId, 'I could not find any transaction entries to record.');
        return;
    }

    const lines = [];
    const alerts = new Set();
    for (const entry of entries) {
        const owed = entry.owed?.length
            ? `; owed: ${entry.owed.map(item => `${item.name} ₹${item.amount}`).join(', ')}`
            : '';
        lines.push(`₹${entry.amount} for ${entry.category} (${entry.need_want})${owed}`);
        const alert = await getCategoryLimitAlert(entry.category, spreadsheetId);
        if (alert) alerts.add(alert);
    }

    const count = entries.length;
    const alertText = alerts.size ? `\n${Array.from(alerts).join('\n')}` : '';
    await sendTelegramReply(chatId, `${heading} ${count} entr${count === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}${alertText}`);
}

app.get('/telegram/webhook-info', authorizeWebhookAdmin, async (req, res) => {
    try {
        const info = await callTelegramApi('getWebhookInfo');
        res.json({
            url: info.url,
            hasCustomCertificate: info.has_custom_certificate,
            pendingUpdateCount: info.pending_update_count,
            lastErrorDate: info.last_error_date,
            lastErrorMessage: info.last_error_message
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/telegram/set-webhook', authorizeWebhookAdmin, async (req, res) => {
    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const webhookUrl = req.query.url || `${publicBaseUrl}/telegram/webhook`;

    if (!webhookUrl.startsWith('https://')) {
        return res.status(400).json({ error: 'A public HTTPS webhook URL is required.' });
    }

    try {
        const result = await callTelegramApi('setWebhook', {
            url: webhookUrl,
            ...(process.env.TELEGRAM_WEBHOOK_SECRET
                ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET }
                : {})
        });
        res.json({ ok: result, webhookUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// WhatsApp Webhook endpoint
app.post('/webhook', async (req, res) => {
    const payload = req.body;

    try {
        const message = payload?.data?.body;
        const msgType = payload?.data?.type;

        if (message && msgType === 'text') {
            const spreadsheetId = process.env.Hardiksingla07_SPREADSHEET_ID;
            await processExpenseMessage(message, spreadsheetId);
        }
        // ONLY send 200 AFTER processing is complete to keep Vercel alive
        res.status(200).send('Webhook processed');
    } catch (error) {
        console.error("❌ Error processing WA webhook logic:", error);
        res.status(500).send('Internal Error');
    }
});

// Telegram Webhook endpoint
app.post('/telegram/webhook', verifyTelegramWebhook, telegramAuthMiddleware, async (req, res) => {
    const payload = req.body;
    console.log(payload);

    // return res.status(200).send('Webhook processed');

    try {
        const updateId = payload?.update_id;
        if (updateId) {
            if (processedUpdates.has(updateId)) {
                console.log(`[Idempotency] Ignoring already processed update_id: ${updateId}`);
                return res.status(200).send('Ignored: Already processed');
            }
            processedUpdates.add(updateId);
            // Keep cache size bounded
            if (processedUpdates.size > 200) {
                const first = processedUpdates.values().next().value;
                processedUpdates.delete(first);
            }
        }

        const { username, spreadsheetId } = req;

        // Safe access Telegram message payload
        const msgObj = payload?.message;
        const text = msgObj.text;
        const chatId = msgObj.chat?.id;

        if (msgObj.photo?.length) {
            try {
                const photo = msgObj.photo[msgObj.photo.length - 1];
                const imageBuffer = await downloadTelegramPhoto(photo);
                const result = await processReceiptImage(imageBuffer, 'image/jpeg', msgObj.caption, spreadsheetId);
                if (result.error) {
                    await sendTelegramReply(chatId, result.error);
                } else if (result.type === 'clarification') {
                    await sendTelegramReply(chatId, result.text);
                } else {
                    await sendRecordedExpenses(chatId, result, spreadsheetId, 'Receipt recorded');
                }
            } catch (error) {
                console.error('Receipt webhook failed:', error.message);
                await sendTelegramReply(chatId, 'I could not process that receipt image. Please try a clearer image.');
            }
            return res.status(200).send('Telegram webhook processed');
        }

        if (!text) {
            return res.status(200).send('Ignored: No text');
        }

        console.log(`Processing Telegram Command: "${text}" from ${username}`);

        if (text === '/today') {
            const total = await getTodayTotal(spreadsheetId);
            await sendTelegramReply(chatId, `Today's Total Expenses: ₹${total.toFixed(2)}`);
        }
        else if (text === '/month') {
            const total = await getMonthTotal(spreadsheetId);
            await sendTelegramReply(chatId, `This Month's Total Expenses: ₹${total.toFixed(2)}`);
        }
        else if (text.startsWith('/limit ')) {
            const parts = text.slice('/limit'.length).trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
            if (!parts) {
                await sendTelegramReply(chatId, 'Use /limit Category Amount, for example /limit Food & Dining 8000.');
            } else {
                const result = await setCategoryLimit(parts[1], parts[2], spreadsheetId);
                await sendTelegramReply(chatId, result.error || `Monthly limit set for ${result.category}: ₹${result.limit.toFixed(2)}.`);
            }
        }
        else if (text === '/limits') {
            const statuses = await getCategoryLimitStatuses(spreadsheetId);
            if (statuses.error) {
                await sendTelegramReply(chatId, statuses.error);
            } else if (!statuses.length) {
                await sendTelegramReply(chatId, 'No category limits are set.');
            } else {
                await sendTelegramReply(chatId, statuses.map(status => `${status.category}: ₹${status.spent.toFixed(2)} of ₹${status.limit.toFixed(2)} (₹${status.remaining.toFixed(2)} remaining)`).join('\n'));
            }
        }
        else if (text === '/report') {
            const report = await getMonthlyReport(spreadsheetId);
            if (report.error) {
                await sendTelegramReply(chatId, report.error);
            } else {
                const categoryText = report.categories.length
                    ? report.categories.slice(0, 3).map(item => `${item.category}: ₹${item.amount.toFixed(2)}`).join('\n')
                    : 'No spending recorded.';
                const budgetText = report.budget?.budget !== null && report.budget
                    ? `\nBudget: ₹${report.budget.budget.toFixed(2)}\nRemaining: ₹${report.budget.remaining.toFixed(2)}`
                    : '\nBudget: not set';
                await sendTelegramReply(chatId, `Monthly report for ${report.month}\n\nSpent: ₹${report.total.toFixed(2)} across ${report.count} transactions.${budgetText}\nOutstanding owed: ₹${report.owed.toFixed(2)}\n\nTop categories:\n${categoryText}`);
            }
        }
        else if (text === '/budget' || text.startsWith('/budget ')) {
            const budgetInput = text.slice('/budget'.length).trim();
            if (budgetInput) {
                const result = await setMonthlyBudget(budgetInput, spreadsheetId);
                await sendTelegramReply(chatId, result.error
                    ? result.error
                    : `Monthly budget set to ₹${result.budget.toFixed(2)} for ${result.month}.`);
            } else {
                const status = await getBudgetStatus(spreadsheetId);
                if (status.error) {
                    await sendTelegramReply(chatId, status.error);
                } else if (status.budget === null) {
                    await sendTelegramReply(chatId, `No budget is set for ${status.month}. Use /budget amount, for example /budget 30000.`);
                } else {
                    const pace = status.spent > status.expectedSpend
                        ? 'You are spending faster than the calendar pace.'
                        : 'Your spending is within the calendar pace.';
                    await sendTelegramReply(chatId, `Budget for ${status.month}: ₹${status.budget.toFixed(2)}\nSpent: ₹${status.spent.toFixed(2)}\nRemaining: ₹${status.remaining.toFixed(2)}\n${pace}`);
                }
            }
        }
        else if (text === '/owed') {
            const summary = await getOwedSummary(spreadsheetId);
            if (summary.error) {
                await sendTelegramReply(chatId, summary.error);
            } else if (summary.people.length === 0) {
                await sendTelegramReply(chatId, 'There are no recorded outstanding amounts yet.');
            } else {
                const lines = summary.people.map(person => {
                    const recentReasons = person.transactions
                        .slice(-3)
                        .map(transaction => `${transaction.date}: ₹${transaction.amount.toFixed(2)} for ${transaction.reason}`)
                        .join('\n  ');
                    return `${person.name}: ₹${person.total.toFixed(2)}\n  ${recentReasons}`;
                });
                await sendTelegramReply(chatId, `Outstanding amounts: ₹${summary.total.toFixed(2)}\n\n${lines.join('\n\n')}`);
            }
        }
        else if (text.startsWith('/owed ')) {
            const person = text.slice('/owed'.length).trim();
            const summary = await getOwedSummary(spreadsheetId, person);
            if (summary.error) {
                await sendTelegramReply(chatId, summary.error);
            } else if (summary.people.length === 0) {
                await sendTelegramReply(chatId, `No outstanding amount found for ${person}.`);
            } else {
                const personData = summary.people[0];
                const details = personData.transactions.slice(-10)
                    .map(transaction => `${transaction.date}: ₹${transaction.amount.toFixed(2)} for ${transaction.reason}`)
                    .join('\n');
                await sendTelegramReply(chatId, `${personData.name} owes ₹${personData.total.toFixed(2)}.\n\n${details}`);
            }
        }
        else if (text.startsWith('/paid ')) {
            const parts = text.slice('/paid'.length).trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)(?:\s+(.+))?$/);
            if (!parts) {
                await sendTelegramReply(chatId, 'Use /paid Name Amount, for example /paid Yash 500.');
            } else {
                const settlement = await recordSettlement(parts[1], parts[2], parts[3], spreadsheetId);
                await sendTelegramReply(chatId, settlement.error || `Recorded ₹${settlement.amount.toFixed(2)} repayment from ${settlement.name}.`);
            }
        }
        else if (text === '/avg') {
            const stats = await getAveragePerDayThisMonth(spreadsheetId);
            if (!stats) {
                await sendTelegramReply(chatId, "Could not fetch the average. Please ensure Google Sheets is configured.");
            } else {
                const projected = stats.average * 30;
                const msg = `Here is your monthly summary, ${username}.\n\nSpent: ₹${stats.total.toFixed(2)} across ${stats.transactionCount} transactions.\nDaily average: ₹${stats.average.toFixed(2)} over ${stats.daysPast} days.\nProjected month-end total: ₹${projected.toFixed(2)}.`;
                await sendTelegramReply(chatId, msg);
            }
        }
        else if (text.startsWith('/overview')) {
            const args = text.split(' ');
            const targetMonth = args.length > 1 ? args.slice(1).join(' ') : null;
            const overviewStr = await getCategoryOverviewThisMonth(spreadsheetId, targetMonth);
            if (overviewStr) {
                if (overviewStr.error) {
                    await sendTelegramReply(chatId, overviewStr.error);
                } else {
                    await sendTelegramReply(chatId, overviewStr);
                }
            } else {
                await sendTelegramReply(chatId, "I could not fetch the overview. Please ensure Google Sheets is configured.");
            }
        }
        else if (text === '/undo') {
            const deletedAmount = await undoLastExpense(spreadsheetId);
            if (deletedAmount !== null) {
                await sendTelegramReply(chatId, `The last recorded expense of ₹${deletedAmount} has been removed.`);
            } else {
                await sendTelegramReply(chatId, `I could not find a recent expense to remove.`);
            }
        }
        else if (text === '/last') {
            const lastExp = await getLastExpense(spreadsheetId);
            if (lastExp) {
                await sendTelegramReply(chatId, `Most recent expense:\n₹${lastExp.amount} for ${lastExp.category}\nDate: ${lastExp.date}\nDescription: ${lastExp.description}\nAdded at: ${lastExp.addedAt}`);
            } else {
                await sendTelegramReply(chatId, `I could not find a recent expense.`);
            }
        }
        else if (text === '/start') {
            await sendTelegramReply(chatId, `Good to see you, ${username}. I am ready to keep your finances in order.\n\nTry: "150 auto rickshaw" or send a receipt photo.\n\nCommands:\n/today - today's total\n/month - this month's total\n/budget 30000 - set a monthly budget\n/budget - review budget status\n/limit Food & Dining 8000 - set a category limit\n/limits - review category limits\n/report - monthly financial report\n/owed - amounts owed to you\n/owed Yash - one person's balance\n/paid Yash 500 - record a repayment\n/avg - daily average and projection\n/overview - category breakdown\n/last - most recent transaction\n/undo - remove the last expense`);
        }
        else {
            const aiResult = await processExpenseMessage(text, spreadsheetId);
            if (aiResult.error) {
                await sendTelegramReply(chatId, `I could not complete that request: ${aiResult.error}`);
            } else if (aiResult.type === 'log') {
                await sendRecordedExpenses(chatId, aiResult, spreadsheetId);
            } else if (aiResult.type === 'query' || aiResult.type === 'chat') {
                await sendTelegramReply(chatId, aiResult.text);
            }
        }

        // ONLY send 200 AFTER everything, including fetch(), is fully complete so Vercel does not terminate the process.
        res.status(200).send('Telegram webhook processed');
    } catch (error) {
        console.error("Error processing telegram webhook:", error);
        res.status(500).send('Internal Error');
    }
});

app.listen(PORT, () => {
    if (!process.env.Hardiksingla07_SPREADSHEET_ID) console.warn("⚠️ Hardiksingla07_SPREADSHEET_ID is missing from .env");
    if (!process.env.TELEGRAM_BOT_TOKEN) console.warn("⚠️ TELEGRAM_BOT_TOKEN is missing from .env");
    console.log(`🚀 Webhook server is running on port ${PORT}`);
});
