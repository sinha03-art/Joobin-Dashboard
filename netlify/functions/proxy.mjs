/**
 * JOOBIN Renovation Hub Proxy v10.0.7 - Netlify Compatible
 * FIXED: Removed optional chaining, PRESERVED em-dashes
 */

// --- Environment Variables ---
const {
    GEMINI_API_KEY,
    NOTION_API_KEY,
    NOTION_BUDGET_DB_ID,
    NOTION_ACTUALS_DB_ID,
    MILESTONES_DB_ID,
    DELIVERABLES_DB_ID,
    VENDOR_REGISTRY_DB_ID,
    NOTION_WORK_PACKAGES_DB_ID,
    PAYMENTS_DB_ID,
    UPDATE_PASSWORD,
} = process.env;

// --- Constants ---
const NOTION_VERSION = '2022-06-28';
const GEMINI_MODEL = 'gemini-1.5-flash';
const CONSTRUCTION_START_DATE = '2025-11-22';

const REQUIRED_BY_GATE = {
    "G0 Pre Construction": ["G0 — Move out to temporary residence"],
    "G1 Concept": [
        "G1 — Moodboard",
        "G1 — Proposed renovation floor plan",
        "G1 — 3D render"
    ],
    "G2 Schematic": [
        "G2 — 3D render",
        "G2 — Floor plans 1:100",
        "G2 — Building elevations",
        "G2 — Area schedules"
    ],
    "G3 Design Development": [
        "G3 — Doors and windows",
        "G3 — Construction drawings",
        "G3 — MEP drawings",
        "G3 — Interior design plans",
        "G3 — Schedules",
        "G3 — Finishes"
    ],
    "G4 Authority Submission": [
        "G4 — Renovation permit",
        "G4 — Structural drawings",
        "G4 — BQ complete",
        "G4 — Quotation package ready",
        "G4 — Authority submission set",
        "G4 — MEP single-line diagrams",
        "G4 — Structural calculations"
    ],
    "G5 Construction Documentation": [
        "G5 — Contractor awarded",
        "G5 — Tender package issued",
        "G5 — Site mobilization complete",
        "G5 — Demolition complete certificate",
        "G5 — Structural works complete",
        "G5 — Carpentry complete",
        "G5 — Finishes complete",
        "G5 — IFC construction drawings",
        "G5 — Method statements",
        "G5 — Work plans"
    ],
    "G6 Design Close-out": [
        "G6 — Final inspection complete",
        "G6 — Handover certificate",
        "G6 — As-built drawings"
    ]
};

// --- API & Utility Helpers ---
const notionHeaders = () => ({
    'Authorization': `Bearer ${NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
});

const norm = (s) => String(s || '').trim().toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function queryNotionDB(dbId, filter = {}) {
    if (!dbId) {
        console.warn(`queryNotionDB called with no dbId. Skipping.`);
        return { results: [] };
    }
    const url = `https://api.notion.com/v1/databases/${dbId}/query`;
    try {
        const res = await fetch(url, { method: 'POST', headers: notionHeaders(), body: JSON.stringify(filter) });
        if (!res.ok) {
            const errText = await res.text();
            console.error(`Notion API error for DB ${dbId}: ${res.status}`, errText);
            throw new Error(`Notion API error for DB ${dbId}: ${res.status}: ${errText}`);
        }
        return await res.json();
    } catch (error) {
        console.error('queryNotionDB error:', error);
        throw error;
    }
}

async function callGemini(prompt) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured.');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    let delay = 1000;
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
            if (res.ok) {
                const json = await res.json();
                return (json.candidates && json.candidates[0] && json.candidates[0].content &&
                    json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
                    json.candidates[0].content.parts[0].text) || '';
            }
            if (res.status === 503) {
                console.warn(`Gemini API overloaded. Retrying in ${delay / 1000}s...`);
                await sleep(delay);
                delay *= 2;
                continue;
            }
            throw new Error(`Gemini API error: ${res.status}: ${await res.text()}`);
        } catch (error) {
            if (i === 2) throw error;
            console.warn(`Network error calling Gemini. Retrying...`, error.message);
            await sleep(delay);
            delay *= 2;
        }
    }
    throw new Error('Gemini API is unavailable after multiple retries.');
}

function getProp(page, name, fallback) {
    if (!page.properties) return undefined;
    return page.properties[name] || page.properties[fallback];
}

function extractText(prop) {
    if (!prop) return '';
    const propType = prop.type;
    if (propType === 'title') return (prop.title && prop.title[0] && prop.title[0].plain_text) || '';
    if (propType === 'rich_text') return (prop.rich_text && prop.rich_text[0] && prop.rich_text[0].plain_text) || '';
    if (propType === 'select') return (prop.select && prop.select.name) || '';
    if (propType === 'status') return (prop.status && prop.status.name) || '';
    if (propType === 'number') return prop.number;
    if (propType === 'date') return (prop.date && prop.date.start) || null;
    if (propType === 'formula') {
        if (prop.formula && prop.formula.type === 'string') return prop.formula.string;
        if (prop.formula && prop.formula.type === 'number') return prop.formula.number;
        return '';
    }
    if (propType === 'checkbox') return prop.checkbox;
    return '';
}

function mapConstructionStatus(reviewStatus) {
    const normalized = norm(reviewStatus);
    if (normalized === 'approved') return 'Approved';
    if (normalized.includes('pending') || normalized.includes('comments') || normalized.includes('resubmission')) {
        return 'Submitted';
    }
    return 'Missing';
}

// --- Main Handler ---
export const handler = async(event) => {
        const { httpMethod, path } = event;
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' };
        if (httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

        try {
            if (httpMethod === 'GET' && path.endsWith('/proxy')) {
                const [budgetData, actualsData, milestonesData, deliverablesData, vendorData, paymentsData] = await Promise.all([
                    queryNotionDB(NOTION_BUDGET_DB_ID),
                    queryNotionDB(NOTION_ACTUALS_DB_ID),
                    queryNotionDB(MILESTONES_DB_ID),
                    queryNotionDB(DELIVERABLES_DB_ID),
                    queryNotionDB(VENDOR_REGISTRY_DB_ID),
                    queryNotionDB(PAYMENTS_DB_ID),
                ]);

                const now = new Date();

                const budgetSubtotal = (budgetData.results || [])
                    .filter(p => extractText(getProp(p, 'In Scope')))
                    .reduce((sum, p) => (sum + (extractText(getProp(p, 'Supply (MYR)')) || 0) + (extractText(getProp(p, 'Install (MYR)')) || 0)), 0);
                const budgetMYR = (budgetSubtotal + 27900) * (1 - 0.05) * (1 + 0.10);
                const paidMYR = (actualsData.results || []).filter(p => extractText(getProp(p, 'Status')) === 'Paid').reduce((sum, p) => sum + (extractText(getProp(p, 'Paid (MYR)')) || 0), 0);

                // Unified Deliverables Processing
                const processedDeliverables = (deliverablesData.results || []).map(p => {
                    const categoryProp = getProp(p, 'Category');
                    const categoryArray = (categoryProp && categoryProp.multi_select) || [];
                    const category = (categoryArray[0] && categoryArray[0].name) || '';
                    const isConstruction = category === 'Construction Certificate';

                    let status;
                    if (isConstruction) {
                        const reviewStatus = extractText(getProp(p, 'Review Status'));
                        status = mapConstructionStatus(reviewStatus);
                    } else {
                        status = extractText(getProp(p, 'Status'));
                    }

                    const gateProp = getProp(p, 'Gate (Auto)');
                    const gateFormula = (gateProp && gateProp.formula && gateProp.formula.string) || '';
                    const gates = gateFormula.split(',').map(g => g.trim()).filter(g => g);
                    const primaryGate = gates[0] || '';

                    const criticalPathProp = getProp(p, 'Critical Path');
                    const isCritical = criticalPathProp && criticalPathProp.checkbox;

                    const ownerProp = getProp(p, 'Owner');
                    const assignees = (ownerProp && ownerProp.people) ? ownerProp.people.map(person => person.name || '') : [];

                    return {
                        id: p.id,
                        title: extractText(getProp(p, 'Select Deliverable:')),
                        deliverableType: extractText(getProp(p, 'Select Deliverable:')),
                        gate: primaryGate,
                        status: status || 'Missing',
                        category: category,
                        isCritical: isCritical,
                        assignees: assignees,
                        url: p.url,
                        dueDate: extractText(getProp(p, 'Target Due')),
                        priority: extractText(getProp(p, 'Priority')),
                    };
                });

                const existingDeliverableKeys = new Set(processedDeliverables.map(d => norm(`${d.gate}|${d.deliverableType}`)));
                const allDeliverablesIncludingMissing = [...processedDeliverables];

                Object.entries(REQUIRED_BY_GATE).forEach(([gateName, requiredDocs]) => {
                    requiredDocs.forEach(requiredTitle => {
                        if (!existingDeliverableKeys.has(norm(`${gateName}|${requiredTitle}`))) {
                            allDeliverablesIncludingMissing.push({
                                id: null,
                                title: requiredTitle,
                                deliverableType: requiredTitle,
                                gate: gateName,
                                status: 'Missing',
                                category: 'Design Document',
                                isCritical: true,
                                assignees: [],
                                url: '#'
                            });
                        }
                    });
                });

                const gates = Object.entries(REQUIRED_BY_GATE)
                    .map(([gateName, requiredDocs]) => {
                        const criticalDocs = allDeliverablesIncludingMissing.filter(d =>
                            d.gate === gateName &&
                            requiredDocs.some(reqType => norm(d.deliverableType) === norm(reqType)) &&
                            d.isCritical
                        );
                        const criticalApproved = criticalDocs.filter(d => norm(d.status) === 'approved').length;
                        const criticalTotal = criticalDocs.length;

                        const approvedCount = allDeliverablesIncludingMissing.filter(d =>
                            d.gate === gateName &&
                            requiredDocs.some(reqType => norm(d.deliverableType) === norm(reqType)) &&
                            norm(d.status) === 'approved'
                        ).length;
                        const totalInGate = requiredDocs.length;

                        return {
                            gate: gateName,
                            total: totalInGate,
                            approved: approvedCount,
                            criticalTotal: criticalTotal,
                            criticalApproved: criticalApproved,
                            gateApprovalRate: totalInGate > 0 ? approvedCount / totalInGate : 0,
                            criticalApprovalRate: criticalTotal > 0 ? criticalApproved / criticalTotal : 0
                        };
                    })
                    .filter(g => g.total > 0)
                    .sort((a, b) => a.gate.localeCompare(b.gate));

                const paymentPages = paymentsData.results || [];
                const overduePayments = paymentPages.filter(p => {
                    const status = extractText(getProp(p, 'Status'));
                    const dueDate = extractText(getProp(p, 'DueDate'));
                    return (status === 'Outstanding' || status === 'Overdue') && dueDate && new Date(dueDate) < now;
                }).map(p => ({
                    id: p.id,
                    paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled',
                    vendor: extractText(getProp(p, 'Vendor')),
                    amount: extractText(getProp(p, 'Amount (RM)')) || 0,
                    dueDate: extractText(getProp(p, 'DueDate')),
                    url: p.url
                })).sort((a, b) => (a.dueDate || '0') > (b.dueDate || '0') ? 1 : -1);

                const upcomingPayments = paymentPages.filter(p => {
                    const status = extractText(getProp(p, 'Status'));
                    const dueDate = extractText(getProp(p, 'DueDate'));
                    return status === 'Outstanding' && (!dueDate || new Date(dueDate) >= now);
                }).map(p => ({
                    id: p.id,
                    paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled',
                    vendor: extractText(getProp(p, 'Vendor')),
                    amount: extractText(getProp(p, 'Amount (RM)')) || 0,
                    dueDate: extractText(getProp(p, 'DueDate')),
                    status: extractText(getProp(p, 'Status')),
                    url: p.url
                })).sort((a, b) => (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : -1).slice(0, 10);

                const recentPaidPayments = paymentPages.filter(p => extractText(getProp(p, 'Status')) === 'Paid').map(p => ({
                    id: p.id,
                    paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled',
                    vendor: extractText(getProp(p, 'Vendor')),
                    amount: extractText(getProp(p, 'Amount (RM)')) || 0,
                    paidDate: extractText(getProp(p, 'PaidDate')),
                    url: p.url
                })).sort((a, b) => (b.paidDate || '0') > (a.paidDate || '0') ? 1 : -1).slice(0, 10);

                const outstandingAndOverdue = paymentPages.filter(p => {
                    const status = extractText(getProp(p, 'Status'));
                    return status === 'Outstanding' || status === 'Overdue';
                });

                const totalOutstandingMYR = outstandingAndOverdue.reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)')) || 0), 0);

                // Build vendor lookup
                const vendorLookup = {};
                (vendorData.results || []).forEach(v => {
                    vendorLookup[v.id] = extractText(getProp(v, 'Company_Name')) || 'Unknown';
                });

                // Top vendors
                const vendorSpend = {};
                (actualsData.results || []).filter(p => extractText(getProp(p, 'Status')) === 'Paid').forEach(p => {
                    const vendorRelProp = getProp(p, 'Vendor_Registry');
                    const vendorRels = (vendorRelProp && vendorRelProp.relation) || [];
                    const vendorId = vendorRels[0] && vendorRels[0].id;
                    const vendorName = vendorId && vendorLookup[vendorId] ? vendorLookup[vendorId] : 'Unknown';
                    const amount = extractText(getProp(p, 'Paid (MYR)')) || 0;
                    vendorSpend[vendorName] = (vendorSpend[vendorName] || 0) + amount;
                });

                const topVendors = Object.entries(vendorSpend)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([name, paid]) => ({ name, paid, trade: '—' }));

                // Budget by trade
                const budgetByTrade = (budgetData.results || [])
                    .filter(p => extractText(getProp(p, 'In Scope')))
                    .reduce((acc, p => {
                            const trade = extractText(getProp(p, 'Trade')) || 'Other';
                            const supply = extractText(getProp(p, 'Supply (MYR)')) || 0;
                            const install = extractText(getProp(p, 'Install (MYR)')) || 0;
                            const total = supply + install;
                            acc[trade] = (acc[trade] || 0) + total;
                            return acc;
                        }, {});

                        const mbsaPermit = allDeliverablesIncludingMissing.find(d => norm(d.deliverableType).includes('renovation permit'));
                        const contractorAwarded = allDeliverablesIncludingMissing.find(d => norm(d.deliverableType).includes('contractor awarded'));

                        const g3Gate = gates.find(g => g.gate === 'G3 Design Development');
                        const g3ApprovalRate = g3Gate ? g3Gate.gateApprovalRate : 0;

                        const alerts = {
                            daysToConstructionStart: Math.ceil((new Date(CONSTRUCTION_START_DATE) - now) / (1000 * 60 * 60 * 24)),
                            g3NotApproved: g3ApprovalRate < 1,
                            paymentsOverdue: overduePayments,
                            mbsaPermitApproved: mbsaPermit && norm(mbsaPermit.status) === 'approved',
                            contractorAwarded: contractorAwarded && norm(contractorAwarded.status) === 'approved',
                        };

                        const responseData = {
                            kpis: {
                                budgetMYR,
                                paidMYR,
                                remainingMYR: budgetMYR - paidMYR,
                                deliverablesApproved: allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length,
                                deliverablesTotal: allDeliverablesIncludingMissing.length,
                                totalOutstandingMYR: totalOutstandingMYR,
                                totalOverdueMYR: overduePayments.reduce((sum, p) => sum + p.amount, 0),
                                paidVsBudget: budgetMYR > 0 ? paidMYR / budgetMYR : 0,
                                deliverablesProgress: allDeliverablesIncludingMissing.length > 0 ? allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length / allDeliverablesIncludingMissing.length : 0,
                                milestonesAtRisk: (milestonesData.results || []).filter(m => extractText(getProp(m, 'Risk')) === 'At Risk').length,
                            },
                            gates,
                            topVendors,
                            budgetByTrade,
                            deliverables: allDeliverablesIncludingMissing,
                            paymentsSchedule: {
                                upcoming: upcomingPayments,
                                overdue: overduePayments,
                                recentPaid: recentPaidPayments,
                                forecast: []
                            },
                            alerts,
                            timestamp: new Date().toISOString()
                        };

                        return { statusCode: 200, headers, body: JSON.stringify(responseData) };
                    }

                if (httpMethod === 'POST' && path.endsWith('/proxy')) {
                    const body = JSON.parse(event.body || '{}');
                    const kpis = body.kpis || {};
                    const prompt = `Summarize this project data in 2-3 concise sentences: Budget ${kpis.budgetMYR || 0} MYR, Paid ${kpis.paidMYR || 0} MYR. Deliverables ${kpis.deliverablesApproved || 0}/${kpis.deliverablesTotal || 0} approved. Milestones at risk: ${kpis.milestonesAtRisk || 0}. Overdue payments: ${kpis.totalOverdueMYR > 0 ? 'Yes' : 'No'}. Focus on key risks and overall progress.`;
                    const summary = await callGemini(prompt);
                    return { statusCode: 200, headers, body: JSON.stringify({ summary }) };
                }

                return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

            } catch (error) {
                console.error('Handler error:', error);
                return { statusCode: 500, headers, body: JSON.stringify({ error: error.message, timestamp: new Date().toISOString() }) };
            }
        };