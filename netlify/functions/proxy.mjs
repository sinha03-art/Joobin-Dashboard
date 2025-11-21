/**
 * JOOBIN Renovation Hub Proxy v10.0.8 - Netlify Compatible
 * IMPROVEMENTS: Added validation, 404 handling, extracted constants, security hardening
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
    // Quotation intake sources
    FLOORING_GEORGE_A_DB_ID,
    FLOORING_GEORGE_B_DB_ID,
    BATHROOM_SANITARY_DB_ID,
    BATHROOM_TILES_DB_ID,
    MATERIAL_IMAGES_DB_ID,
    QUOTATIONS_HUB_ID,
    // Sourcing master list for trade-room bid comparison
    SOURCING_MASTER_LIST_DB_ID,
} = process.env;

// --- Constants ---
const NOTION_VERSION = '2022-06-28';
const GEMINI_MODEL = 'gemini-1.5-flash';
const CONSTRUCTION_START_DATE = '2025-11-22';

// Budget calculation constants
const BUDGET_CONSTANTS = {
    BASE_FEE: 27900,
    DISCOUNT_RATE: 0.05,
    TAX_RATE: 0.10,
};

const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_API_KEY });

const REQUIRED_BY_GATE = {
    "G0 Pre Construction": ["G0 - Move out to temporary residence"],
    "G1 Concept": [
        "G1 - Moodboard",
        "G1 - Proposed renovation floor plan",
        "G1 - Concept sketches",
        "G1 - 3D render"
    ],
    "G2 Schematic": [
        "G2 - 3D render",
        "G2 - Floor plans 1:100",
        "G2 - Building elevations",
        "G2 - Area schedules"
    ],
    "G3 Design Development": [
        "G3 - Doors and windows",
        "G3 - Construction drawings",
        "G3 - MEP drawings",
        "G3 - Interior design plans",
        "G3 - Schedules",
        "G3 - Finishes"
    ],
    "G4 Authority Submission": [
        "G4 - Renovation permit",
        "G4 - Structural drawings",
        "G4 - BQ complete",
        "G4 - Quotation package ready",
        "G4 - Authority submission set",
        "G4 - MEP single-line diagrams",
        "G4 - Structural calculations"
    ],
    "G5 Construction Documentation": [
        "G5 - Contractor awarded",
        "G5 - Tender package issued",
        "G5 - Site mobilization complete",
        "G5 - Demolition complete certificate",
        "G5 - Structural works complete",
        "G5 - Carpentry complete",
        "G5 - Finishes complete",
        "G5 - IFC construction drawings",
        "G5 - Method statements",
        "G5 - Work plans"
    ],
    "G6 Design Close-out": [
        "G6 - Final inspection complete",
        "G6 - Handover certificate",
        "G6 - As-built drawings"
    ]
};

// --- Validation Helper ---
/**
 * Validates required environment variables
 * @throws {Error} If any required variable is missing
 */
function validateEnvironment() {
    const required = [
        'NOTION_API_KEY',
        'NOTION_BUDGET_DB_ID',
        'NOTION_ACTUALS_DB_ID',
        'MILESTONES_DB_ID',
        'DELIVERABLES_DB_ID',
        'VENDOR_REGISTRY_DB_ID',
        'PAYMENTS_DB_ID'
    ];

    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}

// --- API & Utility Helpers ---
const notionHeaders = () => ({
    'Authorization': `Bearer ${NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
});

const norm = (s) => String(s || '').trim().toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Call Gemini AI API with retry logic
 * @param {string} prompt - The prompt to send to Gemini
 * @returns {Promise<string>} - The AI response text
 * NOTE: Currently unused but kept for future AI features
 */
/*
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
*/

/**
 * Get property from Notion page with fallback
 * @param {Object} page - Notion page object
 * @param {string} name - Primary property name
 * @param {string} fallback - Fallback property name
 * @returns {Object|undefined} - Property object or undefined
 */
function getProp(page, name, fallback) {
    if (!page.properties) return undefined;
    return page.properties[name] || page.properties[fallback];
}

/**
 * Extract text/value from Notion property based on type
 * @param {Object} prop - Notion property object
 * @returns {string|number|boolean|null} - Extracted value
 */
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

/**
 * Query Notion database with pagination support
 * @param {string} dbId - Database ID
 * @param {Object} filter - Query filter object
 * @returns {Promise<Object>} - Results object with all pages
 */
async function queryNotionDB(dbId, filter = {}) {
    if (!dbId) {
        console.warn(`queryNotionDB called with no dbId. Skipping.`);
        return { results: [] };
    }

    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
        const body = {...filter };
        if (startCursor) body.start_cursor = startCursor;

        const url = `https://api.notion.com/v1/databases/${dbId}/query`;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: notionHeaders(),
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errText = await res.text();
                console.error(`Notion API error for DB ${dbId}: ${res.status}`, errText);
                throw new Error(`Notion API error: ${res.status}`);
            }

            const data = await res.json();
            allResults = allResults.concat(data.results || []);
            hasMore = data.has_more || false;
            startCursor = data.next_cursor;
        } catch (error) {
            console.error('queryNotionDB error:', error);
            throw error;
        }
    }

    return { results: allResults };
}

/**
 * Map review status to construction status
 * @param {string} reviewStatus - Review status from Notion
 * @returns {string} - Mapped construction status
 */
function mapConstructionStatus(reviewStatus) {
    const normalized = norm(reviewStatus);
    if (normalized === 'approved') return 'Approved';
    if (normalized.includes('pending') || normalized.includes('comments') || normalized.includes('resubmission')) {
        return 'Submitted';
    }
    return 'Missing';
}

// --- QUOTATION PROCESSING FUNCTIONS ---

/**
 * Derive flooring section from item description/keywords
 * @param {string} itemType - Item type or description
 * @param {string} notes - Additional notes
 * @returns {string} - Derived section
 */
function deriveFlooringSection(itemType, notes) {
    const text = norm(itemType + ' ' + notes);
    if (text.includes('deck') || text.includes('balcony') || text.includes('porch') ||
        text.includes('outdoor') || text.includes('garden path')) {
        return 'Outdoor & Balconies';
    }
    if (text.includes('stair')) return 'Staircase';
    if (text.includes('first floor') || text.includes('1f')) return '1F Interior';
    if (text.includes('ground floor') || text.includes('gf')) return 'GF Interior';
    return 'GF Interior'; // default
}

/**
 * Normalize a quotation line item to canonical schema
 * @param {Object} page - Notion page object
 * @param {string} scopeType - The scope type (Flooring, Bathroom-Sanitary, etc.)
 * @returns {Object} - Normalized line item
 */
/**
 * UPDATED: Normalize a quotation line item (Supports Old DBs + New Master List)
 */
function normalizeQuotationLine(page, scopeType) {
    // 1. Vendor Name
    const vendor = extractText(getProp(page, 'Vendor')) ||
        extractText(getProp(page, 'Supplier Brand')) ||
        extractText(getProp(page, 'Company_Name')) ||
        'Unknown Vendor';

    // 2. Item Name (Maps new 'Item Name' to old 'Item Type')
    const itemType = extractText(getProp(page, 'Item Name')) ||
        extractText(getProp(page, 'Material Type')) ||
        extractText(getProp(page, 'Item_Description')) ||
        extractText(getProp(page, 'Name')) ||
        'Untitled Item';

    const currency = 'MYR';

    // 3. Pricing Logic
    const quantity = extractText(getProp(page, 'Quantity')) || 0;
    // Fallback: Use Quantity as Area if Area is missing
    const area = extractText(getProp(page, 'Area (m²)')) || quantity;

    const unitPrice = extractText(getProp(page, 'Unit Price (MYR)')) ||
        extractText(getProp(page, 'Unit Price')) ||
        extractText(getProp(page, 'Rate_Per_Unit_Original')) || 0;

    // Try to get Total (Formula or Number)
    const totalProp = getProp(page, 'Total Price (MYR)') || getProp(page, 'Line Total (MYR)');
    let lineTotal = null;
    if (totalProp) {
        lineTotal = (totalProp.formula ? totalProp.formula.number : totalProp.number);
    }
    // Auto-calculate if missing
    if (!lineTotal && unitPrice) {
        lineTotal = unitPrice * (area || 1);
    }

    // 4. Context Fields
    const notes = extractText(getProp(page, 'Notes')) || extractText(getProp(page, 'Conversion_Notes')) || '';
    // Important: Map 'Room' to 'Section' so sorting works
    const section = extractText(getProp(page, 'Room')) || extractText(getProp(page, 'Zone')) || extractText(getProp(page, 'Section')) || 'General';
    const bathroomCode = scopeType.includes('Bathroom') ? (extractText(getProp(page, 'Room')) || '') : null;

    const quoteDate = extractText(getProp(page, 'Quote Date')) || null;
    const validUntil = extractText(getProp(page, 'Valid Until')) || null;
    const leadTimeDays = extractText(getProp(page, 'Lead Time')) || null;
    const terms = extractText(getProp(page, 'Terms')) || '';
    const exclusions = extractText(getProp(page, 'Exclusions')) || '';

    // Flooring specific fields (keep explicitly to prevent UI errors)
    const finishGrade = extractText(getProp(page, 'Finish / Grade')) || '';
    const sizeThickness = extractText(getProp(page, 'Size / Thickness')) || '';
    const isLumpsum = norm(itemType).includes('lump sum');

    return {
        id: page.id,
        vendor,
        scopeType,
        currency,
        area,
        unitPrice,
        lineTotal: lineTotal || 0,
        section,
        bathroomCode,
        itemType,
        roomZone: section,
        finishGrade,
        sizeThickness,
        quoteDate,
        validUntil,
        terms,
        exclusions,
        notes,
        leadTimeDays,
        isLumpsum
    };
}

/**
 * Calculate vendor rankings by section/bathroom code
 * @param {Array} normalizedLines - Normalized quotation lines
 * @param {string} groupBy - 'section' or 'bathroomCode'
 * @returns {Object} - Rankings by group
 */
function calculateVendorRankings(normalizedLines, groupBy = 'section') {
    const groups = {};

    // Group lines
    normalizedLines.forEach(line => {
        const groupKey = line[groupBy] || 'Uncategorized';
        if (!groups[groupKey]) {
            groups[groupKey] = {};
        }

        const vendor = line.vendor || 'Unknown';
        if (!groups[groupKey][vendor]) {
            groups[groupKey][vendor] = {
                vendor,
                lines: [],
                total: 0,
                filledLines: 0,
                totalLines: 0,
                leadTimeDays: line.leadTimeDays,
                terms: line.terms,
                exclusions: line.exclusions,
                currency: line.currency
            };
        }

        groups[groupKey][vendor].lines.push(line);
        groups[groupKey][vendor].totalLines++;

        if (line.lineTotal !== null && line.lineTotal > 0) {
            groups[groupKey][vendor].total += line.lineTotal;
            groups[groupKey][vendor].filledLines++;
        }
    });

    // Calculate rankings for each group
    const rankings = {};
    Object.keys(groups).forEach(groupKey => {
        const vendors = Object.values(groups[groupKey]);

        // Calculate completeness scores
        vendors.forEach(v => {
            v.completenessScore = v.totalLines > 0 ? v.filledLines / v.totalLines : 0;
            v.missingPrices = v.filledLines < v.totalLines;

            // Gap flags
            if (v.exclusions) v.exclusionsPresent = true;
            if (v.terms && norm(v.terms).includes('exw')) v.termsRisk = true;

            // Validity check
            const validLine = v.lines.find(l => l.validUntil);
            if (validLine && validLine.validUntil) {
                const daysToExpiry = Math.floor((new Date(validLine.validUntil) - new Date()) / (1000 * 60 * 60 * 24));
                v.shortValidity = daysToExpiry <= 3;
                v.daysToExpiry = daysToExpiry;
            }
        });

        // Filter vendors with sufficient completeness (≥ 70%)
        const eligibleVendors = vendors.filter(v => v.completenessScore >= 0.7);

        // Sort: ascending by total, then desc by completeness, then asc by lead time
        const sortedVendors = [...vendors].sort((a, b) => {
            if (a.total !== b.total) return a.total - b.total;
            if (a.completenessScore !== b.completenessScore) return b.completenessScore - a.completenessScore;
            return (a.leadTimeDays || 999) - (b.leadTimeDays || 999);
        });

        // Assign ranks
        sortedVendors.forEach((v, idx) => {
            v.rank = idx + 1;
        });

        // Find cheapest and highest among eligible vendors
        if (eligibleVendors.length > 0) {
            const cheapest = eligibleVendors.reduce((min, v) => v.total < min.total ? v : min);
            const highest = eligibleVendors.reduce((max, v) => v.total > max.total ? v : max);
            cheapest.isCheapest = true;
            highest.isHighest = true;
        }

        rankings[groupKey] = sortedVendors;
    });

    return rankings;
}
// Query the database
const sourcingData = await queryNotionDB(dbId);
const allProcessedBids = [];

// 2. Normalize Rows
for (const page of sourcingData.results || []) {
    // Extraction logic
    const item_name = extractText(getProp(page, 'Item Name')) ||
        extractText(getProp(page, 'Name')) || 'Untitled Item';

    const trade = extractText(getProp(page, 'Category')) ||
        extractText(getProp(page, 'Trade')) || 'Uncategorized';

    const room = extractText(getProp(page, 'Room')) || 'General';
    const vendor = extractText(getProp(page, 'Vendor')) || 'Unknown Vendor';
    const notes = extractText(getProp(page, 'Notes')) || '';
    const coverage = extractText(getProp(page, 'Coverage')) || '';

    // Numbers
    const quantity = extractText(getProp(page, 'Quantity')) || 0;
    const unit_price_myr = extractText(getProp(page, 'Unit Price (MYR)')) ||
        extractText(getProp(page, 'Unit Price')) || 0;

    // Formula Handling
    const totalProp = getProp(page, 'Total Price (MYR)');
    let formula_total = null;
    if (totalProp) {
        if (totalProp.type === 'formula') formula_total = totalProp.formula.number;
        else if (totalProp.type === 'number') formula_total = totalProp.number;
    }

    // Filter out empty rows
    if (!unit_price_myr && formula_total === null) continue;

    // Calculate Effective Total
    let effective_total;
    if (formula_total !== null) {
        effective_total = formula_total;
    } else if (quantity > 0) {
        effective_total = unit_price_myr * quantity;
    } else {
        effective_total = unit_price_myr;
    }

    // Trip/Source (Metadata)
    const trip = extractText(getProp(page, 'Trip')) || extractText(getProp(page, 'Source')) || null;

    allProcessedBids.push({
        trade,
        room,
        data: {
            vendor,
            total_price_myr: formula_total !== null ? formula_total : (quantity > 0 ? unit_price_myr * quantity : null),
            unit_price_myr,
            quantity,
            item_name,
            notes,
            coverage,
            trip,
            _sort_val: effective_total // Internal use only
        }
    });
}

// 3. Group by Trade + Room
const grouped = {};
for (const row of allProcessedBids) {
    const key = `${row.trade}|||${row.room}`;
    if (!grouped[key]) {
        grouped[key] = { trade: row.trade, room: row.room, bids: [] };
    }
    grouped[key].bids.push(row.data);
}

// 4. Aggregate High/Low
const results = [];
for (const key in grouped) {
    const group = grouped[key];
    const bids = group.bids;

    // Sort Ascending (Lowest First)
    bids.sort((a, b) => a._sort_val - b._sort_val);

    // Clean up internal sort key
    const cleanBids = bids.map(b => {
        const { _sort_val, ...rest } = b;
        return rest;
    });

    const lowest = cleanBids[0];
    const highest = cleanBids[cleanBids.length - 1];

    results.push({
        trade: group.trade,
        room: group.room,
        lowest_bid: lowest,
        highest_bid: highest,
        all_bids: cleanBids,
        vendor_count: new Set(cleanBids.map(b => b.vendor)).size
    });
}

// 5. Final Sort (Trade A-Z, then Room A-Z)
results.sort((a, b) => {
    if (a.trade !== b.trade) return a.trade.localeCompare(b.trade);
    return a.room.localeCompare(b.room);
});

return {
    trade_room_comparisons: results,
    meta: {
        total_groups: results.length,
        timestamp: new Date().toISOString()
    }
};
}

// --- Main Handler ---
export const handler = async(event) => {
    const { httpMethod, path } = event;
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

    try {
        // Validate environment on first request
        validateEnvironment();

        // GET /proxy - Main data endpoint
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

            // Calculate budget with named constants
            const budgetSubtotal = (budgetData.results || [])
                .filter(p => extractText(getProp(p, 'In Scope')))
                .reduce((sum, p) => (sum + (extractText(getProp(p, 'Supply (MYR)')) || 0) + (extractText(getProp(p, 'Install (MYR)')) || 0)), 0);

            const budgetMYR = (budgetSubtotal + BUDGET_CONSTANTS.BASE_FEE) *
                (1 - BUDGET_CONSTANTS.DISCOUNT_RATE) *
                (1 + BUDGET_CONSTANTS.TAX_RATE);

            const paidMYR = (actualsData.results || [])
                .filter(p => extractText(getProp(p, 'Status')) === 'Paid')
                .reduce((sum, p) => sum + (extractText(getProp(p, 'Paid (MYR)')) || 0), 0);

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
                let gates = gateFormula.split(',').map(g => g.trim()).filter(g => g);

                // FALLBACK: If Gate (Auto) is empty, use manual Gate property
                if (gates.length === 0) {
                    const manualGateProp = getProp(p, 'Gate');
                    if (manualGateProp && manualGateProp.multi_select) {
                        gates = manualGateProp.multi_select.map(g => g.name);
                    }
                }

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
                .reduce((acc, p) => {
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

            // Get detailed at-risk milestone information
            const atRiskMilestones = (milestonesData.results || [])
                .filter(m => extractText(getProp(m, 'Risk')) === 'At Risk')
                .map(m => ({
                    title: extractText(getProp(m, 'MilestoneTitle')),
                    dueDate: extractText(getProp(m, 'EndDate')),
                    issue: extractText(getProp(m, 'GateIssue')),
                    progress: extractText(getProp(m, 'Progress')) || 0,
                    phase: extractText(getProp(m, 'Phase')),
                    status: extractText(getProp(m, 'Status')),
                    url: m.url
                }))
                .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));

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
                atRiskMilestones,
                timestamp: new Date().toISOString()
            };

            return { statusCode: 200, headers, body: JSON.stringify(responseData) };
        }

        // POST /create-task - Create new task endpoint
        if (httpMethod === 'POST' && path.endsWith('/create-task')) {
            const body = JSON.parse(event.body || '{}');
            const { taskName, gate, dueDate, comments } = body;

            if (!taskName || !taskName.trim() || !gate) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Task name and gate are required' }) };
            }

            try {
                // Map gate to a generic deliverable option
                const gateDeliverableMap = {
                    'G0 Pre Construction': 'G0 - Move out to temporary residence',
                    'G1 Concept': 'G1 - Concept sketches',
                    'G2 Schematic': 'G2 - Floor plans 1:100',
                    'G3 Design Development': 'G3 - Construction drawings',
                    'G4 Authority Submission': 'G4 - Authority submission set',
                    'G5 Construction Documentation': 'G5 - IFC construction drawings',
                    'G6 Close-out': 'G6 - As-built drawings'
                };

                const properties = {
                    'Select Deliverable:': {
                        title: [{ text: { content: taskName } }]
                    },
                    'Gate': {
                        multi_select: [{ name: gate }]
                    },
                    'Deliverable': {
                        multi_select: [{ name: gateDeliverableMap[gate] || 'G1 - Concept sketches' }]
                    },
                    'Status': {
                        select: { name: 'Missing' }
                    },
                    'Submitted By': {
                        multi_select: [{ name: 'Designer' }]
                    }
                };

                if (dueDate) {
                    // Check if dueDate includes time (datetime-local format: "2025-10-19T14:30")
                    const hasTime = dueDate.includes('T');
                    properties['Target Due'] = {
                        date: {
                            start: hasTime ? new Date(dueDate).toISOString() : dueDate,
                            time_zone: hasTime ? 'Asia/Kuala_Lumpur' : null
                        }
                    };
                }

                if (comments) {
                    properties['Comments'] = {
                        rich_text: [{ text: { content: comments } }]
                    };
                }

                const createRes = await fetch('https://api.notion.com/v1/pages', {
                    method: 'POST',
                    headers: notionHeaders(),
                    body: JSON.stringify({
                        parent: { database_id: DELIVERABLES_DB_ID },
                        properties
                    })
                });

                if (!createRes.ok) {
                    const errText = await createRes.text();
                    console.error('Notion API error:', errText);
                    throw new Error(`Notion API error: ${createRes.status}`);
                }

                const newPage = await createRes.json();
                return { statusCode: 200, headers, body: JSON.stringify({ success: true, pageId: newPage.id }) };

            } catch (error) {
                console.error('Create task error:', error);
                return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
            }
        }

        /**
         * UPDATED: Fetch all data from Single Master List and categorize for Dashboard
         */
        async function fetchQuotationData() {
            // 1. Query the NEW Master List
            const dbId = SOURCING_MASTER_LIST_DB_ID || process.env.SOURCING_MASTER_LIST_DB_ID;

            // Fail gracefully if ID is missing
            if (!dbId) return { error: "Master DB ID missing" };

            const masterData = await queryNotionDB(dbId);
            const allRows = masterData.results || [];

            // 2. Buckets for the Dashboard
            const flooringRaw = [];
            const bathroomRaw = [];
            const kitchenRaw = [];
            const imagesRaw = [];

            // 3. Sort Rows into Buckets based on Category/Trade
            allRows.forEach(page => {
                const category = (extractText(getProp(page, 'Category')) || '').toLowerCase();
                const trade = (extractText(getProp(page, 'Trade')) || '').toLowerCase();
                // Combine them to catch keywords in either column
                const fullText = category + " " + trade;

                if (fullText.includes('flooring') || fullText.includes('tile') || fullText.includes('stone')) {
                    flooringRaw.push(page);
                } else if (fullText.includes('bathroom') || fullText.includes('sanitary') || fullText.includes('plumbing') || fullText.includes('wc') || fullText.includes('basin')) {
                    bathroomRaw.push(page);
                } else if (fullText.includes('kitchen') || fullText.includes('cabinetry') || fullText.includes('appliance') || fullText.includes('backsplash')) {
                    kitchenRaw.push(page);
                }

                // Capture images if they exist
                const photo = extractText(getProp(page, 'Photo')) || extractText(getProp(page, 'Image URL'));
                if (photo) imagesRaw.push(page);
            });

            // 4. Normalize Data (Map to standard format the UI expects)
            const flooringLines = flooringRaw.map(p => normalizeQuotationLine(p, 'Flooring'));
            const bathroomLines = bathroomRaw.map(p => normalizeQuotationLine(p, 'Bathroom-Sanitary'));
            // We treat Kitchen as 'Flooring' type structurally so the ranking logic works
            const kitchenLines = kitchenRaw.map(p => normalizeQuotationLine(p, 'Flooring'));

            // 5. Calculate Rankings (Re-using your existing logic)
            const flooringRankings = calculateVendorRankings(flooringLines, 'section');
            const bathroomRankings = calculateVendorRankings(bathroomLines, 'bathroomCode');
            const kitchenRankings = calculateVendorRankings(kitchenLines, 'section');

            // 6. Process Images
            const images = imagesRaw.map(p => ({
                item: extractText(getProp(p, 'Item Name')) || 'Untitled',
                category: extractText(getProp(p, 'Category')),
                zone: extractText(getProp(p, 'Room')),
                imageUrl: extractText(getProp(p, 'Photo')) || extractText(getProp(p, 'Image URL')),
                notes: extractText(getProp(p, 'Notes'))
            }));

            // 7. Return Combined Object
            return {
                flooring: {
                    lines: flooringLines,
                    rankings: flooringRankings
                },
                bathroom: {
                    lines: bathroomLines,
                    sanitaryLines: bathroomLines,
                    tilesLines: [], // Deprecated specific list
                    rankings: bathroomRankings
                },
                // This enables the Kitchen view
                kitchen: {
                    lines: kitchenLines,
                    rankings: kitchenRankings
                },
                images
            };
        }

        // GET /bids - Trade-room bid comparison from Sourcing Master List
        if (httpMethod === 'GET' && path.endsWith('/bids')) {
            try {
                const bidsData = await fetchTradeRoomBids();
                return {
                    statusCode: 200,
                    headers: {...headers, 'Cache-Control': 'no-store' },
                    body: JSON.stringify({
                        success: true,
                        data: bidsData,
                        timestamp: new Date().toISOString()
                    })
                };
            } catch (error) {
                console.error('Bids data error:', error);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ error: error.message })
                };
            }
        }

        // 404 - Route not found
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({
                error: 'Not Found',
                message: `Route ${httpMethod} ${path} not found`,
                availableRoutes: [
                    'GET /proxy',
                    'POST /create-task',
                    'GET /quotations',
                    'GET /bids'
                ]
            })
        };

    } catch (error) {
        console.error('Handler error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: error.message,
                timestamp: new Date().toISOString()
            })
        };
    }
}; // v10.0.8 - Nov 18 2025

/**
<<<<<<< HEAD
 * STRICT IMPLEMENTATION: Trade & Room Bid Comparison
 * Based on Engineering Brief: Pulls bids, computes totals, finds High/Low per (Trade, Room).
 */
// 2. Normalize Rows
for (const page of sourcingData.results || []) {
    // Extraction based on Brief
    const item_name = extractText(getProp(page, 'Item Name')) ||
        extractText(getProp(page, 'Name')) || 'Untitled Item';

    const trade = extractText(getProp(page, 'Category')) || 'Uncategorized'; // Mapped Category -> Trade
    const room = extractText(getProp(page, 'Room')) || 'General';
    const vendor = extractText(getProp(page, 'Vendor')) || 'Unknown Vendor';
    const notes = extractText(getProp(page, 'Notes')) || '';
    const coverage = extractText(getProp(page, 'Coverage')) || '';

    // Numbers
    const quantity = extractText(getProp(page, 'Quantity')) || 0;
    const unit_price_myr = extractText(getProp(page, 'Unit Price (MYR)')) || 0;

    // Formula Handling: 'Total Price (MYR)' is usually a formula
    const totalProp = getProp(page, 'Total Price (MYR)');
    let formula_total = null;
    if (totalProp) {
        if (totalProp.type === 'formula') {
            formula_total = totalProp.formula.number;
        } else if (totalProp.type === 'number') {
            formula_total = totalProp.number;
        }
    }

    // Logic: Filter out rows where both Unit and Total are missing
    if (!unit_price_myr && formula_total === null) continue;

    // Logic: Compute Effective Total
    // If Formula exists, use it. 
    // Else, if Qty exists, Calc it. 
    // Else (Qty is 0/null), fallback to Unit Price for ordering purposes.
    let effective_total;
    if (formula_total !== null) {
        effective_total = formula_total;
    } else if (quantity > 0) {
        effective_total = unit_price_myr * quantity;
    } else {
        effective_total = unit_price_myr;
    }

    // Rounding (Integers only per brief)
    effective_total = Math.round(effective_total);
    const display_unit = Math.round(unit_price_myr);
    const display_total = formula_total !== null ? Math.round(formula_total) :
        (quantity > 0 ? Math.round(unit_price_myr * quantity) : null);

    // Capture Trip/Source if available (Nice-to-have from previous context)
    const trip = extractText(getProp(page, 'Trip')) || extractText(getProp(page, 'Source')) || null;

    allProcessedBids.push({
        trade,
        room,
        // Bid Object Shape
        data: {
            vendor,
            total_price_myr: display_total !== null ? display_total : effective_total, // Prefer explicit total
            unit_price_myr: display_unit,
            quantity,
            item_name,
            notes,
            coverage,
            trip, // Added as nice-to-have metadata
            // Hidden field for sorting
            _sort_val: effective_total
        }
    });
}

// 3. Grouping
const grouped = {};
for (const row of allProcessedBids) {
    const key = `${row.trade}|||${row.room}`;
    if (!grouped[key]) {
        grouped[key] = {
            trade: row.trade,
            room: row.room,
            bids: []
        };
    }
    grouped[key].bids.push(row.data);
}

// 4. Aggregation (High/Low)
const results = [];
for (const key in grouped) {
    const group = grouped[key];
    const bids = group.bids;

    // Sort by effective total ascending
    bids.sort((a, b) => a._sort_val - b._sort_val);

    // Clean up the _sort_val from final output to keep JSON clean
    const cleanBids = bids.map(b => {
        const { _sort_val, ...rest } = b;
        return rest;
    });

    const lowest = cleanBids[0];
    const highest = cleanBids[cleanBids.length - 1];

    // Optional: Price Range
    const range = (highest.total_price_myr || highest.unit_price_myr) - (lowest.total_price_myr || lowest.unit_price_myr);

    results.push({
        trade: group.trade,
        room: group.room,
        lowest_bid: lowest,
        highest_bid: highest,
        all_bids: cleanBids,
        // Optional Aggregates
        vendor_count: new Set(cleanBids.map(b => b.vendor)).size,
        price_range_myr: range
    });
}
/**
 * STRICT IMPLEMENTATION: Trade & Room Bid Comparison
 * Endpoint: GET /bids
 */
async function fetchTradeRoomBids() {
    // 1. Source of Truth
    const dbId = SOURCING_MASTER_LIST_DB_ID || process.env.SOURCING_MASTER_LIST_DB_ID;

    if (!dbId) {
        console.error("Error: SOURCING_MASTER_LIST_DB_ID is missing.");
        return { error: "Database ID not configured" };
    }

    // Query the database
    const sourcingData = await queryNotionDB(dbId);
    const allProcessedBids = [];

    // 2. Normalize Rows
    for (const page of sourcingData.results || []) {
        // Extraction logic
        const item_name = extractText(getProp(page, 'Item Name')) ||
            extractText(getProp(page, 'Name')) || 'Untitled Item';

        const trade = extractText(getProp(page, 'Category')) ||
            extractText(getProp(page, 'Trade')) || 'Uncategorized';

        const room = extractText(getProp(page, 'Room')) || 'General';
        const vendor = extractText(getProp(page, 'Vendor')) || 'Unknown Vendor';
        const notes = extractText(getProp(page, 'Notes')) || '';
        const coverage = extractText(getProp(page, 'Coverage')) || '';

        // Numbers
        const quantity = extractText(getProp(page, 'Quantity')) || 0;
        const unit_price_myr = extractText(getProp(page, 'Unit Price (MYR)')) ||
            extractText(getProp(page, 'Unit Price')) || 0;

        // Formula Handling
        const totalProp = getProp(page, 'Total Price (MYR)');
        let formula_total = null;
        if (totalProp) {
            if (totalProp.type === 'formula') formula_total = totalProp.formula.number;
            else if (totalProp.type === 'number') formula_total = totalProp.number;
        }

        // Filter out empty rows
        if (!unit_price_myr && formula_total === null) continue;

        // Calculate Effective Total
        let effective_total;
        if (formula_total !== null) {
            effective_total = formula_total;
        } else if (quantity > 0) {
            effective_total = unit_price_myr * quantity;
        } else {
            effective_total = unit_price_myr;
        }

        // Trip/Source (Metadata)
        const trip = extractText(getProp(page, 'Trip')) || extractText(getProp(page, 'Source')) || null;

        allProcessedBids.push({
            trade,
            room,
            data: {
                vendor,
                total_price_myr: formula_total !== null ? formula_total : (quantity > 0 ? unit_price_myr * quantity : null),
                unit_price_myr,
                quantity,
                item_name,
                notes,
                coverage,
                trip,
                _sort_val: effective_total // Internal use only
            }
        });
    }

    // 3. Group by Trade + Room
    const grouped = {};
    for (const row of allProcessedBids) {
        const key = `${row.trade}|||${row.room}`;
        if (!grouped[key]) {
            grouped[key] = { trade: row.trade, room: row.room, bids: [] };
        }
        grouped[key].bids.push(row.data);
    }

    // 4. Aggregate High/Low
    const results = [];
    for (const key in grouped) {
        const group = grouped[key];
        const bids = group.bids;

        // Sort Ascending (Lowest First)
        bids.sort((a, b) => a._sort_val - b._sort_val);

        // Clean up internal sort key
        const cleanBids = bids.map(b => {
            const { _sort_val, ...rest } = b;
            return rest;
        });

        const lowest = cleanBids[0];
        const highest = cleanBids[cleanBids.length - 1];

        results.push({
            trade: group.trade,
            room: group.room,
            lowest_bid: lowest,
            highest_bid: highest,
            all_bids: cleanBids,
            vendor_count: new Set(cleanBids.map(b => b.vendor)).size
        });
    }

    // 5. Final Sort (Trade A-Z, then Room A-Z)
    results.sort((a, b) => {
        if (a.trade !== b.trade) return a.trade.localeCompare(b.trade);
        return a.room.localeCompare(b.room);
    });

    return {
        trade_room_comparisons: results,
        meta: {
            total_groups: results.length,
            timestamp: new Date().toISOString()
        }
    };
}