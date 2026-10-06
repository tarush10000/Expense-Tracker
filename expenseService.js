const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');
const fs = require('fs');
const crypto = require('crypto');

// Initialize Gemini keys list
const GEMINI_API_KEYS = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.split(',').map(k => k.trim()).filter(Boolean) : [];

function getRandomGeminiKey() {
    if (GEMINI_API_KEYS.length === 0) return null;
    return GEMINI_API_KEYS[Math.floor(Math.random() * GEMINI_API_KEYS.length)];
}
// Setup Google Sheets auth
let sheets = null;
try {
    let auth;
    if (process.env.GOOGLE_CREDENTIALS) {
        // For Vercel/serverless environments
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    } else if (fs.existsSync('credentials.json')) {
        // For local development
        auth = new google.auth.GoogleAuth({
            keyFile: 'credentials.json',
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    if (auth) {
        sheets = google.sheets({ version: 'v4', auth });
        console.log("✅ Google Sheets auth configured successfully");
    } else {
        console.warn("⚠️ No GOOGLE_CREDENTIALS env var or credentials.json found. Proceeding without Google Sheets DB writing.");
    }
} catch (error) {
    console.error("❌ Error setting up Google Sheets auth:", error.message);
}

const CATEGORIES = [
    "Food & Dining",
    "Transportation",
    "Shopping",
    "Entertainment",
    "Bills & Utilities",
    "Healthcare",
    "Housing",
    "Personal Care",
    "Education",
    "Miscellaneous"
];

const geminiTools = [{
    functionDeclarations: [
        {
            name: "draftExpenses",
            description: "Creates a draft JSON for one or more transactions. Never logs or saves transactions. Negative amounts represent income.",
            parameters: {
                type: "OBJECT",
                properties: {
                    needs_clarification: { type: "BOOLEAN" },
                    clarification_question: { type: "STRING" },
                    entries: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                amount: { type: "NUMBER" },
                                category: { type: "STRING", description: "Optional best-effort category; do not block a draft because categorization is uncertain." },
                                subcategory: { type: "STRING" },
                                description: { type: "STRING" },
                                merchant: { type: "STRING" },
                                payment_method: { type: "STRING" },
                                need_want: { type: "STRING" },
                                date: { type: "STRING", description: "YYYY-MM-DD format" },
                                split: {
                                    type: "OBJECT",
                                    properties: {
                                        original_amount: { type: "NUMBER" },
                                        reason: { type: "STRING" },
                                        owed_entries: {
                                            type: "ARRAY",
                                            items: {
                                                type: "OBJECT",
                                                properties: {
                                                    name: { type: "STRING" },
                                                    amount: { type: "NUMBER" }
                                                },
                                                required: ["name", "amount"]
                                            }
                                        }
                                    },
                                    required: ["original_amount", "reason", "owed_entries"]
                                }
                            },
                            required: ["amount", "date"]
                        }
                    }
                },
                required: ["needs_clarification", "clarification_question", "entries"],
            }
        },
        {
            name: "queryExpenses",
            description: "Queries past expenses for a specific timeframe. Use this when the user asks questions like 'how much did I spend on food this week?'.",
            parameters: {
                type: "OBJECT",
                properties: {
                    startDate: { type: "STRING", description: "YYYY-MM-DD" },
                    endDate: { type: "STRING", description: "YYYY-MM-DD" },
                    category: { type: "STRING", description: "Optional category to filter by", enum: CATEGORIES }
                },
                required: ["startDate", "endDate"]
            }
        }
    ]
}];

function getMonthSheetName(dateInput = new Date()) {
    const dateObj = new Date(dateInput);
    const monthName = dateObj.toLocaleString('default', { month: 'long' });
    const year = dateObj.getFullYear();
    return `${monthName} ${year}`;
}

async function ensureMonthlySheetExists(sheetName, spreadsheetId) {
    if (!sheets || !spreadsheetId) return;

    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId });
        const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName);

        if (!sheetExists) {
            console.log(`Creating new sheet for month: ${sheetName}...`);
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: { properties: { title: sheetName } }
                    }]
                }
            });

            // Order of headers: Date, Amount, Category, Subcategory, Merchant, Description, Payment Method, Need/Want, AddedAt, Cumulative Total
            const headers = [["Date", "Amount", "Category", "Subcategory", "Merchant", "Description", "Payment Method", "Need/Want", "AddedAt", "Cumulative Total", "Transaction ID"]];

            await sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: `${sheetName}!A1:K1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: headers }
            });
            console.log(`✅ Successfully initialized sheet: ${sheetName}`);
        } else {
            const headerResponse = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetName}!A1:K1`
            });
            if ((headerResponse.data.values?.[0] || [])[10] !== 'Transaction ID') {
                await sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${sheetName}!K1`,
                    valueInputOption: 'RAW',
                    requestBody: { values: [['Transaction ID']] }
                });
            }
        }
    } catch (error) {
        console.error(`❌ Error checking/creating monthly sheet:`, error.message);
    }
}

async function ensureOwedSheetExists(spreadsheetId) {
    if (!sheets || !spreadsheetId) return;

    const sheetName = 'Owed';
    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName);

        if (!sheetExists) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{ addSheet: { properties: { title: sheetName } } }]
                }
            });

            const headers = [[
                'Date', 'Name', 'Amount Owed', 'Expense Amount', 'Description', 'AddedAt', 'Total Owed By Person', 'Reason / Note', 'Transaction ID'
            ]];
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A1:I1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: headers }
            });
        } else {
            const headerResponse = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetName}!A1:I1`
            });
            const headers = headerResponse.data.values?.[0] || [];
            if (headers[7] !== 'Reason / Note') {
                await sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${sheetName}!H1`,
                    valueInputOption: 'RAW',
                    requestBody: { values: [['Reason / Note']] }
                });
            }
            if (headers[8] !== 'Transaction ID') {
                await sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${sheetName}!I1`,
                    valueInputOption: 'RAW',
                    requestBody: { values: [['Transaction ID']] }
                });
            }
        }
    } catch (error) {
        console.error('❌ Error checking/creating Owed sheet:', error.message);
    }
}

async function ensureBudgetSheetExists(spreadsheetId) {
    if (!sheets || !spreadsheetId) return false;

    const sheetName = 'Budget';
    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName);
        if (!sheetExists) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{ addSheet: { properties: { title: sheetName } } }]
                }
            });
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A1:C1`,
                valueInputOption: 'RAW',
                requestBody: { values: [['Month', 'Budget', 'UpdatedAt']] }
            });
        }
        return true;
    } catch (error) {
        console.error('Error checking/creating Budget sheet:', error.message);
        return false;
    }
}

async function ensureLimitsSheetExists(spreadsheetId) {
    if (!sheets || !spreadsheetId) return false;
    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
        if (!spreadsheetInfo.data.sheets.some(sheet => sheet.properties.title === 'Limits')) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title: 'Limits' } } }] }
            });
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: 'Limits!A1:C1',
                valueInputOption: 'RAW',
                requestBody: { values: [['Category', 'Monthly Limit', 'UpdatedAt']] }
            });
        }
        return true;
    } catch (error) {
        console.error('Error checking/creating Limits sheet:', error.message);
        return false;
    }
}

function parseSplitExpenseMessage(message) {
    const text = message.trim();
    const amountMatch = text.match(/^(\d+(?:\.\d+)?)(.*)$/);
    if (!amountMatch) return null;

    const originalAmount = Number(amountMatch[1]);
    const body = amountMatch[2].trim();
    const reasonMatch = body.match(/^\(([^)]+)\)/);
    const reason = reasonMatch?.[1]?.trim() || 'Split expense';
    const splitInstruction = body.replace(/^\([^)]*\)\s*/, '').replace(/^[-:]\s*/, '').trim();

    const groupedSplitMatch = splitInstruction.match(/^(\d+(?:\.\d+)?)\s*\(([^)]+)\)\s*,\s*rest\s*\(([^)]+)\)$/i);
    if (groupedSplitMatch) {
        const fixedAmount = Number(groupedSplitMatch[1]);
        const fixedPeople = groupedSplitMatch[2]
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);
        const remainderPeople = groupedSplitMatch[3]
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);

        if (fixedPeople.length === 0 || remainderPeople.length === 0 || fixedAmount > originalAmount) {
            return null;
        }

        const fixedShare = Number((fixedAmount / fixedPeople.length).toFixed(2));
        const fixedTotal = Number((fixedShare * fixedPeople.length).toFixed(2));
        const remainder = Number((originalAmount - fixedAmount).toFixed(2));
        const remainderShare = Number((remainder / remainderPeople.length).toFixed(2));
        const owedEntries = [];

        for (const name of fixedPeople) {
            if (!/^(me|myself|i)$/i.test(name)) {
                owedEntries.push({ amount: fixedShare, name });
            }
        }
        for (let index = 0; index < remainderPeople.length; index++) {
            const name = remainderPeople[index];
            if (!/^(me|myself|i)$/i.test(name)) {
                const amount = index === remainderPeople.length - 1
                    ? Number((remainder - remainderShare * (remainderPeople.length - 1)).toFixed(2))
                    : remainderShare;
                owedEntries.push({ amount, name });
            }
        }

        const personalShare = Number((originalAmount - owedEntries.reduce((sum, entry) => sum + entry.amount, 0)).toFixed(2));
        return {
            amount: personalShare,
            originalAmount,
            owedEntries,
            reason
        };
    }

    if (/\brest\s+(?:is\s+)?(?:divide|divided)\s+by\s+\d+/i.test(splitInstruction)) {
        const remainderMatch = splitInstruction.match(/^(\d+(?:\.\d+)?)\s+(?:me|myself|i)\s*,\s*rest\s+(?:is\s+)?(?:divide|divided)\s+by\s+(\d+)/i);
        return {
            error: 'Please reply with the names of the people included in the remaining split, separated by commas.',
            pending: remainderMatch ? {
                originalAmount,
                personalAmount: Number(remainderMatch[1]),
                peopleCount: Number(remainderMatch[2]),
                reason
            } : null
        };
    }

    const equalMatch = splitInstruction.match(/^(?:split\s+equally|split|divide|share)\s+between\s+(.+)$/i);
    if (equalMatch) {
        const people = equalMatch[1]
            .replace(/\s+and\s+/gi, ',')
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);
        const owedPeople = people.filter(name => !/^(me|myself|i)$/i.test(name));
        if (people.length < 2 || owedPeople.length === 0) return null;

        const share = Number((originalAmount / people.length).toFixed(2));
        return {
            amount: Number((originalAmount - share * owedPeople.length).toFixed(2)),
            originalAmount,
            owedEntries: owedPeople.map(name => ({ amount: share, name })),
            reason: reasonMatch?.[1]?.trim() || 'Split equally'
        };
    }

    if (!splitInstruction) return null;

    const owedEntries = splitInstruction.split(',').map(entry => {
        const entryMatch = entry.match(/^\s*(\d+(?:\.\d+)?)\s+(.+?)\s*$/);
        if (!entryMatch) return null;
        return { amount: Number(entryMatch[1]), name: entryMatch[2].trim() };
    });

    if (owedEntries.some(entry => !entry) || owedEntries.length === 0) return null;

    const totalOwed = owedEntries.reduce((total, entry) => total + entry.amount, 0);
    const remainingAmount = Number((originalAmount - totalOwed).toFixed(2));
    if (remainingAmount < 0) return null;

    return {
        amount: remainingAmount,
        originalAmount,
        owedEntries,
        reason: reasonMatch?.[1]?.trim() || 'Split expense'
    };
}

function completePendingSplit(pending, namesMessage) {
    const names = namesMessage
        .replace(/^names?\s*(?:are|:)?\s*/i, '')
        .replace(/\s+and\s+/gi, ',')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);

    if (names.length !== pending.peopleCount) {
        return { error: `Please provide exactly ${pending.peopleCount} names, separated by commas.` };
    }
    if (names.some(name => /^(me|myself|i)$/i.test(name))) {
        return { error: 'Please provide the names of the other people. Your personal share is already recorded.' };
    }

    const remainder = Number((pending.originalAmount - pending.personalAmount).toFixed(2));
    if (remainder < 0 || pending.personalAmount < 0) {
        return { error: 'The personal share cannot be greater than the total transaction amount.' };
    }

    const baseShare = Number((remainder / pending.peopleCount).toFixed(2));
    const owedEntries = names.map((name, index) => ({
        name,
        amount: index === names.length - 1
            ? Number((remainder - baseShare * (names.length - 1)).toFixed(2))
            : baseShare
    }));
    return {
        amount: pending.personalAmount,
        originalAmount: pending.originalAmount,
        owedEntries,
        reason: pending.reason
    };
}

async function appendOwedEntries(splitData, date, addedAtTime, transactionId, spreadsheetId) {
    if (!sheets || !spreadsheetId) return;

    await ensureOwedSheetExists(spreadsheetId);
    const existingRowsResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Owed!A:A'
    });
    const firstDataRow = (existingRowsResponse.data.values || []).length + 1;
    const values = splitData.owedEntries.map((entry, index) => [
        date,
        entry.name,
        entry.amount,
        splitData.originalAmount,
        `Split expense of ₹${splitData.originalAmount}`,
        addedAtTime,
        `=SUMIF($B$2:$B,B${firstDataRow + index},$C$2:$C)`,
        splitData.reason,
        transactionId
    ]);

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Owed!A:I',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values }
    });
}

async function recordExpenseData(expenseData, spreadsheetId) {
    if (expenseData.is_error) return { error: expenseData.error_message };

    const normalizedAmount = Number(expenseData.amount);
    if (!Number.isFinite(normalizedAmount)) {
        return { error: 'I need a clear numeric amount before I can record that expense.' };
    }
    expenseData.amount = Number(normalizedAmount.toFixed(2));
    expenseData.category = String(expenseData.category || 'Miscellaneous').trim() || 'Miscellaneous';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseData.date) || Number.isNaN(Date.parse(expenseData.date))) {
        expenseData.date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    }
    expenseData.description = String(expenseData.description || expenseData.merchant || 'Expense').trim();
    expenseData.subcategory = String(expenseData.subcategory || 'General').trim();
    expenseData.merchant = String(expenseData.merchant || 'Unknown').trim();
    expenseData.payment_method = String(expenseData.payment_method || 'UPI').trim();
    expenseData.need_want = expenseData.need_want === 'Want' ? 'Want' : 'Need';

    const transactionId = crypto.randomUUID();
    expenseData.transactionId = transactionId;
    const d = new Date();
    const datePart = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const timePart = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });
    const addedAtTime = `${datePart} ${timePart}`;

    if (sheets && spreadsheetId) {
        const sheetName = getMonthSheetName(expenseData.date);
        await ensureMonthlySheetExists(sheetName, spreadsheetId);
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:K`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[
                expenseData.date,
                expenseData.amount,
                expenseData.category,
                expenseData.subcategory,
                expenseData.merchant,
                expenseData.description,
                expenseData.payment_method,
                expenseData.need_want,
                addedAtTime,
                '=SUM($B$2:INDIRECT("B"&ROW()))',
                transactionId
            ]] }
        });
    }
    return { type: 'log', data: expenseData };
}

async function recordSplitExpense(splitData, spreadsheetId) {
    const transactionId = crypto.randomUUID();
    const datePart = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const timePart = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });
    const expenseData = {
        is_error: false,
        amount: splitData.amount,
        category: 'Miscellaneous',
        subcategory: 'Split expense',
        description: `Paid ₹${splitData.originalAmount}; ${splitData.owedEntries.map(entry => `${entry.name} owes ₹${entry.amount}`).join(', ')}`,
        merchant: 'Split expense',
        payment_method: 'UPI',
        need_want: 'Need',
        date: datePart,
        transactionId
    };
    const addedAtTime = `${datePart} ${timePart}`;

    if (sheets && spreadsheetId) {
        const sheetName = getMonthSheetName(expenseData.date);
        await ensureMonthlySheetExists(sheetName, spreadsheetId);
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:K`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[
                expenseData.date,
                expenseData.amount,
                expenseData.category,
                expenseData.subcategory,
                expenseData.merchant,
                expenseData.description,
                expenseData.payment_method,
                expenseData.need_want,
                addedAtTime,
                '=SUM($B$2:INDIRECT("B"&ROW()))',
                transactionId
            ]] }
        });
        await appendOwedEntries(splitData, datePart, addedAtTime, transactionId, spreadsheetId);
    }
    return { type: 'log', data: expenseData, owed: splitData.owedEntries };
}

async function recordExpenseDraft(draft, spreadsheetId) {
    if (!Array.isArray(draft?.entries) || draft.entries.length === 0) {
        return { error: 'This draft has no entries to record.' };
    }

    for (const entry of draft.entries) {
        if (!entry || typeof entry !== 'object' || entry.amount === null || entry.amount === '' || !Number.isFinite(Number(entry.amount))) {
            return { error: 'A draft entry is missing a valid amount. Please send the transaction again.' };
        }
        if (entry.split) {
            const split = entry.split;
            const owedEntries = split.owed_entries;
            const originalAmount = Number(split.original_amount);
            if (!Number.isFinite(originalAmount) || !Array.isArray(owedEntries) || owedEntries.length === 0 ||
                owedEntries.some(owed => !owed || !String(owed.name || '').trim() || !Number.isFinite(Number(owed.amount)) || Number(owed.amount) < 0)) {
                return { error: 'The split details are incomplete. Please send the transaction again.' };
            }
            const splitTotal = Number(entry.amount) + owedEntries.reduce((total, owed) => total + Number(owed.amount), 0);
            if (Math.abs(splitTotal - originalAmount) > 0.01) {
                return { error: 'The split shares do not add up to the original amount. Please send the transaction details again.' };
            }
        }
    }

    const recordedEntries = [];
    for (const entry of draft.entries) {
        const { split, ...expenseData } = entry;
        const result = await recordExpenseData(expenseData, spreadsheetId);
        if (result.error) return result;

        const owed = split?.owed_entries || [];
        if (owed.length) {
            const time = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });
            const addedAt = `${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })} ${time}`;
            await appendOwedEntries({
                originalAmount: Number(split.original_amount),
                reason: split.reason || 'Split expense',
                owedEntries: owed.map(item => ({ name: String(item.name).trim(), amount: Number(item.amount) }))
            }, result.data.date, addedAt, result.data.transactionId, spreadsheetId);
        }
        recordedEntries.push({ ...result.data, owed });
    }

    return { type: 'log', entries: recordedEntries };
}

async function processExpenseMessage(message, spreadsheetId) {

    const todayIST = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true });
    const prompt = `You are a personal finance assistant. Evaluate this message: "${message}". Decide whether the user wants to record transactions, query spending, or chat. For transaction messages, call draftExpenses and include every distinct transaction in entries. Do not log or save anything. Do not require a category to understand or draft a transaction; category is optional and must not cause clarification by itself. Never invent an amount. If the amount is missing or ambiguous, set needs_clarification to true, provide one concise clarification_question, and leave entries empty. Preserve negative amounts as income. For a split, include the original total, the user's personal share as entry amount, and each other person's owed amount in split. Use today's date in India if none is given: ${todayIST}. Use "UPI" as payment_method only as a fallback. For queries, call queryExpenses. Keep chat and query replies concise and plain text.`;

    console.log(`[DEBUG] Calling Gemini API...`);

    let resultPayload = null;
    let success = false;
    let attempts = 0;
    const maxAttempts = GEMINI_API_KEYS.length > 0 ? Math.min(GEMINI_API_KEYS.length + 1, 3) : 1;
    let lastError = null;

    while (!success && attempts < maxAttempts) {
        attempts++;
        const apiKey = GEMINI_API_KEYS.length > 0 ? getRandomGeminiKey() : process.env.GEMINI_API_KEY;

        if (!apiKey) {
            console.error(`[DEBUG] ❌ No Gemini API Key found in environment variables.`);
            return { error: `Server Configuration Error: Missing API Key.` };
        }

        const ai = new GoogleGenAI({ apiKey: apiKey });

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                config: {
                    tools: geminiTools
                }
            });

            const functionCall = response.functionCalls?.[0];

            if (functionCall) {
                if (functionCall.name === "draftExpenses") {
                    const draft = functionCall.args;
                    if (draft.needs_clarification || !draft.entries?.length) {
                        resultPayload = {
                            type: 'clarification',
                            text: draft.clarification_question || 'What was the amount?'
                        };
                    } else {
                        resultPayload = { type: 'draft', draft };
                    }
                    success = true;
                } else if (functionCall.name === "queryExpenses") {
                    // Execute Query
                    const queryArgs = functionCall.args;
                    const queryResult = await queryExpenses(queryArgs.startDate, queryArgs.endDate, queryArgs.category, spreadsheetId);

                    // Call Gemini again to construct final message
                    const followupResponse = await ai.models.generateContent({
                        model: 'gemini-3.6-flash',
                        contents: [
                            { role: "user", parts: [{ text: prompt }] },
                            response.candidates[0].content,
                            { role: "user", parts: [{ functionResponse: { name: functionCall.name, response: queryResult } }] }
                        ]
                    });

                    resultPayload = { type: 'query', text: followupResponse.text };
                    success = true;
                }
            } else {
                // If the model didn't call a tool, it likely means invalid request or casual chat
                resultPayload = { type: 'chat', text: response.text };
                success = true;
            }
        } catch (apiError) {
            lastError = apiError;
            console.error(`[DEBUG] ❌ Gemini API threw an error on attempt ${attempts}:`, apiError.message);

            const isRateLimit = apiError.status === 429 ||
                (apiError.message && (apiError.message.includes('429') || apiError.message.includes('Too Many Requests') || apiError.message.includes('quota')));

            if (isRateLimit && attempts < maxAttempts) {
                console.log(`⚠️ 429 error encountered limit hit. Retrying with another key...`);
            } else {
                break;
            }
        }
    }

    if (!success) {
        return { error: `API Connection Failed: ${lastError?.message}. Check if your model name is valid.` };
    }

    if (resultPayload.type === 'draft') {
        return recordExpenseDraft(resultPayload.draft, spreadsheetId);
    }

    return resultPayload;
}

async function processReceiptImage(imageBuffer, mimeType, caption, spreadsheetId) {
    const apiKey = getRandomGeminiKey();
    if (!apiKey) return { error: 'Server Configuration Error: Missing Gemini API Key.' };

    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Read this receipt and create a transaction draft by calling draftExpenses. Extract the FULL final payable amount printed on it, before applying any split. ${caption ? `The user's note is: "${caption}". Treat this note only as an instruction for how to divide the full receipt total after extraction; never halve or otherwise change the amount because of the note.` : ''} Extract only information visible in the receipt. If the full payable amount is unclear, set needs_clarification to true and ask one concise question. Use today's date in India if no date is visible. Do not log or save anything.`;
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [{
                role: 'user',
                parts: [
                    { text: prompt },
                    { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBuffer.toString('base64') } }
                ]
            }],
            config: { tools: geminiTools }
        });
        const functionCall = response.functionCalls?.[0];
        if (!functionCall || functionCall.name !== 'draftExpenses') {
            return { error: 'I could not read a clear expense from that receipt.' };
        }
        const expenseData = functionCall.args;
        if (expenseData.needs_clarification || !expenseData.entries?.length) {
            return { type: 'clarification', text: expenseData.clarification_question || 'I could not read a clear amount from that receipt.' };
        }
        if (caption) {
            const firstEntry = expenseData.entries[0];
            const captionSplit = parseSplitExpenseMessage(caption) ||
                parseSplitExpenseMessage(`${firstEntry.amount} ${caption}`);
            if (captionSplit?.error) {
                return { error: captionSplit.error };
            }
            if (captionSplit?.owedEntries?.length) {
                if (!captionSplit.reason || captionSplit.reason === 'Split expense') {
                    captionSplit.reason = firstEntry.merchant || 'Receipt split';
                }
                firstEntry.amount = captionSplit.amount;
                firstEntry.split = {
                    original_amount: captionSplit.originalAmount,
                    reason: captionSplit.reason,
                    owed_entries: captionSplit.owedEntries
                };
            }
        }
        return recordExpenseDraft(expenseData, spreadsheetId);
    } catch (error) {
        console.error('Receipt parsing failed:', error.message);
        return { error: 'I could not read that receipt. Please send a clearer image or enter the amount manually.' };
    }
}

async function getTodayTotal(spreadsheetId) {
    if (!sheets) return 0;
    const sheetName = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
    if (!response || !response.data.values) return 0;

    const localToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    let total = 0;
    const rows = response.data.values;
    for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === localToday) {
            total += parseFloat(rows[i][1]) || 0;
        }
    }
    return total;
}

async function getMonthTotal(spreadsheetId) {
    if (!sheets) return 0;
    const sheetName = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
    if (!response || !response.data.values) return 0;

    let total = 0;
    const rows = response.data.values;
    for (let i = 1; i < rows.length; i++) {
        total += parseFloat(rows[i][1]) || 0;
    }
    return total;
}

async function setMonthlyBudget(amount, spreadsheetId) {
    const budget = Number(amount);
    if (!Number.isFinite(budget) || budget <= 0) {
        return { error: 'Please provide a monthly budget greater than zero.' };
    }
    if (!await ensureBudgetSheetExists(spreadsheetId)) {
        return { error: 'Google Sheets is not configured.' };
    }

    const month = getMonthSheetName();
    const updatedAt = new Date().toISOString();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Budget!A:C' });
    const rows = response.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === month);
    const values = [[month, budget, updatedAt]];

    if (rowIndex >= 1) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Budget!A${rowIndex + 1}:C${rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Budget!A:C',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });
    }
    return { month, budget };
}

async function getBudgetStatus(spreadsheetId) {
    if (!await ensureBudgetSheetExists(spreadsheetId)) {
        return { error: 'Google Sheets is not configured.' };
    }

    const month = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Budget!A:C' });
    const row = (response.data.values || []).find(values => values[0] === month);
    if (!row || !Number.isFinite(Number(row[1]))) {
        return { month, budget: null, spent: await getMonthTotal(spreadsheetId) };
    }

    const budget = Number(row[1]);
    const spent = await getMonthTotal(spreadsheetId);
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dayOfMonth = today.getDate();
    const expectedSpend = (budget / daysInMonth) * dayOfMonth;
    return {
        month,
        budget,
        spent,
        remaining: budget - spent,
        expectedSpend
    };
}

async function setCategoryLimit(category, amount, spreadsheetId) {
    const matchedCategory = CATEGORIES.find(item => item.toLowerCase() === String(category).trim().toLowerCase());
    const limit = Number(amount);
    if (!matchedCategory || !Number.isFinite(limit) || limit <= 0) {
        return { error: `Use /limit Category Amount. Category must be one of: ${CATEGORIES.join(', ')}.` };
    }
    if (!await ensureLimitsSheetExists(spreadsheetId)) return { error: 'Google Sheets is not configured.' };

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Limits!A:C' });
    const rows = response.data.values || [];
    const rowIndex = rows.findIndex(row => String(row[0]).toLowerCase() === matchedCategory.toLowerCase());
    const values = [[matchedCategory, Number(limit.toFixed(2)), new Date().toISOString()]];
    if (rowIndex >= 1) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Limits!A${rowIndex + 1}:C${rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });
    } else {
        await sheets.spreadsheets.values.append({ spreadsheetId, range: 'Limits!A:C', valueInputOption: 'USER_ENTERED', requestBody: { values } });
    }
    return { category: matchedCategory, limit };
}

async function getCategoryLimitStatuses(spreadsheetId) {
    if (!await ensureLimitsSheetExists(spreadsheetId)) return { error: 'Google Sheets is not configured.' };
    const limitResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Limits!A:C' });
    const expenseResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${getMonthSheetName()}!A:K` }).catch(() => null);
    const totals = {};
    for (const row of (expenseResponse?.data?.values || []).slice(1)) {
        const category = row[2];
        const amount = Number(row[1]);
        if (category && Number.isFinite(amount)) totals[category] = (totals[category] || 0) + amount;
    }
    return (limitResponse.data.values || []).slice(1).filter(row => row[0] && Number.isFinite(Number(row[1]))).map(row => ({
        category: row[0],
        limit: Number(row[1]),
        spent: Number((totals[row[0]] || 0).toFixed(2)),
        remaining: Number((Number(row[1]) - (totals[row[0]] || 0)).toFixed(2))
    }));
}

async function getCategoryLimitAlert(category, spreadsheetId) {
    const statuses = await getCategoryLimitStatuses(spreadsheetId);
    if (statuses.error) return null;
    const status = statuses.find(item => item.category === category);
    if (!status) return null;
    const percentage = status.spent / status.limit;
    if (percentage < 0.8) return null;
    return percentage >= 1
        ? `${status.category} is over its monthly limit by ₹${Math.abs(status.remaining).toFixed(2)}.`
        : `${status.category} has used ${Math.round(percentage * 100)}% of its monthly limit.`;
}

async function getMonthlyReport(spreadsheetId) {
    if (!sheets || !spreadsheetId) return { error: 'Google Sheets is not configured.' };
    const month = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${month}!A:K` }).catch(() => null);
    const rows = response?.data?.values || [];
    if (rows.length <= 1) return { month, total: 0, count: 0, categories: [], budget: null, owed: 0 };

    const categories = {};
    let total = 0;
    for (const row of rows.slice(1)) {
        const amount = Number(row[1]);
        if (!Number.isFinite(amount)) continue;
        total += amount;
        const category = row[2] || 'Uncategorized';
        categories[category] = (categories[category] || 0) + amount;
    }
    const budget = await getBudgetStatus(spreadsheetId);
    const owed = await getOwedSummary(spreadsheetId);
    return {
        month,
        total: Number(total.toFixed(2)),
        count: rows.length - 1,
        categories: Object.entries(categories)
            .map(([category, amount]) => ({ category, amount: Number(amount.toFixed(2)) }))
            .sort((first, second) => second.amount - first.amount),
        budget: budget.error ? null : budget,
        owed: owed.error ? 0 : owed.total
    };
}

async function recordSettlement(name, amount, reason, spreadsheetId) {
    if (!sheets || !spreadsheetId) return { error: 'Google Sheets is not configured.' };
    const personName = String(name || '').trim();
    const settledAmount = Number(amount);
    if (!personName || !Number.isFinite(settledAmount) || settledAmount <= 0) {
        return { error: 'Use /paid Name Amount, for example /paid Yash 500.' };
    }
    await ensureOwedSheetExists(spreadsheetId);
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const addedAt = new Date().toISOString();
    const transactionId = crypto.randomUUID();
    const existingRowsResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Owed!A:A' });
    const firstDataRow = (existingRowsResponse.data.values || []).length + 1;
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Owed!A:I',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[
                date,
                personName,
                -Number(settledAmount.toFixed(2)),
                0,
                'Settlement',
                addedAt,
                `=SUMIF($B$2:$B,B${firstDataRow},$C$2:$C)`,
                reason || 'Repayment received',
                transactionId
            ]]
        }
    });
    return { name: personName, amount: settledAmount };
}

async function getOwedSummary(spreadsheetId, personFilter = null) {
    if (!sheets || !spreadsheetId) {
        return { error: 'Google Sheets is not configured.' };
    }

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Owed!A:H'
    }).catch(() => null);
    const rows = response?.data?.values || [];
    if (rows.length <= 1) {
        return { total: 0, people: [] };
    }

    const peopleByKey = new Map();
    for (const row of rows.slice(1)) {
        const name = String(row[1] || '').trim();
        const amount = Number(row[2]);
        if (!name || !Number.isFinite(amount) || (personFilter && name.toLowerCase() !== personFilter.toLowerCase())) continue;

        const key = name.toLowerCase();
        let person = peopleByKey.get(key);
        if (!person) {
            person = { name, total: 0, transactions: [] };
            peopleByKey.set(key, person);
        }
        person.total = Number((person.total + amount).toFixed(2));
        if (amount > 0) {
            person.transactions.push({
                date: row[0] || 'Unknown date',
                amount,
                reason: row[7] || row[4] || 'No reason recorded'
            });
        }
    }

    const people = [...peopleByKey.values()]
        .filter(person => person.total > 0)
        .sort((first, second) => second.total - first.total);
    return {
        total: Number(people.reduce((sum, person) => sum + person.total, 0).toFixed(2)),
        people
    };
}

async function getAveragePerDayThisMonth(spreadsheetId) {
    if (!sheets) return null;
    const sheetName = getMonthSheetName();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
    if (!response || !response.data.values) return null;

    let total = 0;
    const rows = response.data.values;
    const transactionCount = rows.length > 1 ? rows.length - 1 : 0;
    for (let i = 1; i < rows.length; i++) {
        total += parseFloat(rows[i][1]) || 0;
    }

    const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const daysPast = todayIST.getDate();
    const average = daysPast > 0 ? total / daysPast : 0;
    const monthName = todayIST.toLocaleString('default', { month: 'long' });
    const year = todayIST.getFullYear();

    return {
        total,
        transactionCount,
        daysPast,
        average,
        monthName,
        year
    };
}

async function getCategoryOverviewThisMonth(spreadsheetId, targetMonthStr = null) {
    if (!sheets) return null;

    let sheetName = getMonthSheetName();
    const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    let daysPast = todayIST.getDate();
    let displayTitle = "this Month";

    if (targetMonthStr) {
        const currentYear = todayIST.getFullYear();
        const parseStr = /\d/.test(targetMonthStr) ? targetMonthStr : `${targetMonthStr} 1, ${currentYear}`;
        const ts = Date.parse(parseStr);
        if (!isNaN(ts)) {
            const targetDate = new Date(ts);
            sheetName = getMonthSheetName(targetDate);
            displayTitle = `for ${sheetName}`;
            if (sheetName !== getMonthSheetName(todayIST)) {
                // If it's a past/future month, use total days in that month
                daysPast = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0).getDate();
            }
        }
    }

    const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
    if (!response || !response.data.values) return { error: `Could not find data for ${sheetName}.` };

    const rows = response.data.values;
    const categoryTotals = {};
    let totalSpend = 0;

    for (let i = 1; i < rows.length; i++) {
        const amount = parseFloat(rows[i][1]) || 0;
        const category = rows[i][2] || "Uncategorized";
        if (!categoryTotals[category]) categoryTotals[category] = 0;
        categoryTotals[category] += amount;
        totalSpend += amount;
    }

    let overviewString = `📊 Category Overview ${displayTitle}:\n`;
    for (const [cat, total] of Object.entries(categoryTotals)) {
        const avg = daysPast > 0 ? total / daysPast : 0;
        overviewString += `\n${cat}: ₹${total.toFixed(2)} (Avg: ₹${avg.toFixed(2)}/day)`;
    }

    const totalAvg = daysPast > 0 ? totalSpend / daysPast : 0;
    overviewString += `\n\n💰 **Total Spend: ₹${totalSpend.toFixed(2)}** (Avg: ₹${totalAvg.toFixed(2)}/day)`;

    return overviewString;
}

async function queryExpenses(startDate, endDate, category, spreadsheetId) {
    if (!sheets) return { error: "Google Sheets not configured." };

    // Convert strings to date objects for comparison
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start) || isNaN(end)) return { error: "Invalid date format." };

    let current = new Date(start);
    const monthsToFetch = new Set();
    while (current <= end) {
        monthsToFetch.add(getMonthSheetName(current));
        current.setMonth(current.getMonth() + 1);
    }
    // Also add the end date's month just in case
    monthsToFetch.add(getMonthSheetName(end));

    // To prevent checking 600+ months if AI hallucinates 1970 start date, let's fetch available sheets first.
    const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId }).catch(() => null);
    if (!spreadsheetInfo) return { error: "Could not fetch spreadsheet data." };

    const availableSheets = new Set(spreadsheetInfo.data.sheets.map(s => s.properties.title));
    const sheetsToQuery = Array.from(monthsToFetch).filter(s => availableSheets.has(s));

    let totalAmount = 0;
    let transactions = [];

    // Try fetching every relevant month sheet
    for (const sheetName of sheetsToQuery) {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName }).catch(() => null);
        if (!response || !response.data.values) continue;

        const rows = response.data.values;
        for (let i = 1; i < rows.length; i++) { // Skip headers
            const dateStr = rows[i][0];
            const amount = parseFloat(rows[i][1]) || 0;
            const rCategory = rows[i][2];

            const rDate = new Date(dateStr);
            if (rDate >= start && rDate <= end) {
                if (!category || rCategory === category) {
                    totalAmount += amount;
                    transactions.push({
                        date: dateStr,
                        amount: amount,
                        category: rCategory,
                        subcategory: rows[i][3],
                        merchant: rows[i][4],
                        description: rows[i][5],
                    });
                }
            }
        }
    }

    return {
        totalAmount,
        transactionCount: transactions.length,
        timeframe: `${startDate} to ${endDate}`
    };
}

async function getLastExpense(spreadsheetId) {
    if (!sheets || !spreadsheetId) return null;
    const sheetName = getMonthSheetName();
    try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName }).catch(() => null);
        if (!response || !response.data.values) return null;

        const rows = response.data.values;
        if (rows.length <= 1) return null;

        let maxRowIndex = -1;
        let maxDate = 0;
        let lastRow = null;

        for (let i = 1; i < rows.length; i++) {
            const addedAtStr = rows[i][8];
            if (addedAtStr) {
                let ms = new Date(addedAtStr).getTime();
                if (isNaN(ms)) ms = new Date(addedAtStr.replace(' ', 'T')).getTime();

                if (ms > maxDate) {
                    maxDate = ms;
                    maxRowIndex = i;
                    lastRow = rows[i];
                }
            }
        }

        if (lastRow) {
            // [Date, Amount, Category, Subcategory, Merchant, Description, Payment Method, Need/Want, AddedAt]
            return {
                date: lastRow[0],
                amount: lastRow[1],
                category: lastRow[2],
                description: lastRow[5],
                addedAt: lastRow[8]
            };
        }
        return null;
    } catch (e) {
        console.error(e);
        return null;
    }
}

async function undoLastExpense(spreadsheetId) {
    if (!sheets || !spreadsheetId) return null;
    const sheetName = getMonthSheetName();
    try {
        const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId });
        const sheet = spreadsheetInfo.data.sheets.find(s => s.properties.title === sheetName);
        if (!sheet) return null;
        const sheetId = sheet.properties.sheetId;

        const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId, range: sheetName });
        const rows = response.data.values || [];
        if (rows.length <= 1) return null; // No data rows

        let maxRowIndex = -1;
        let maxDate = 0;
        let deletedAmount = 0;

        for (let i = 1; i < rows.length; i++) {
            const addedAtStr = rows[i][8];
            if (addedAtStr) {
                let ms = new Date(addedAtStr).getTime();
                if (isNaN(ms)) ms = new Date(addedAtStr.replace(' ', 'T')).getTime();

                if (ms > maxDate) {
                    maxDate = ms;
                    maxRowIndex = i;
                    deletedAmount = rows[i][1];
                }
            }
        }

        if (maxRowIndex === -1) {
            maxRowIndex = rows.length - 1;
            deletedAmount = rows[maxRowIndex][1];
        }

        const transactionId = rows[maxRowIndex][10];
        const requests = [{
            deleteDimension: {
                range: {
                    sheetId: sheetId,
                    dimension: "ROWS",
                    startIndex: maxRowIndex,
                    endIndex: maxRowIndex + 1
                }
            }
        }];

        if (transactionId) {
            const owedSheet = spreadsheetInfo.data.sheets.find(item => item.properties.title === 'Owed');
            if (owedSheet) {
                const owedResponse = await sheets.spreadsheets.values.get({
                    spreadsheetId: spreadsheetId,
                    range: 'Owed!A:I'
                });
                const owedRows = owedResponse.data.values || [];
                for (let index = owedRows.length - 1; index >= 1; index--) {
                    if (owedRows[index][8] === transactionId) {
                        requests.push({
                            deleteDimension: {
                                range: {
                                    sheetId: owedSheet.properties.sheetId,
                                    dimension: 'ROWS',
                                    startIndex: index,
                                    endIndex: index + 1
                                }
                            }
                        });
                    }
                }
            }
        }

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: spreadsheetId,
            requestBody: { requests }
        });
        return deletedAmount;
    } catch (e) {
        console.error(e);
        return null;
    }
}

module.exports = {
    processExpenseMessage,
    processReceiptImage,
    recordExpenseDraft,
    parseSplitExpenseMessage,
    completePendingSplit,
    getTodayTotal,
    getMonthTotal,
    setMonthlyBudget,
    getBudgetStatus,
    setCategoryLimit,
    getCategoryLimitStatuses,
    getCategoryLimitAlert,
    getMonthlyReport,
    getOwedSummary,
    recordSettlement,
    getAveragePerDayThisMonth,
    getCategoryOverviewThisMonth,
    undoLastExpense,
    getLastExpense
};
