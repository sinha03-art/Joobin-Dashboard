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
        const body = { ...filter };
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
function normalizeQuotationLine(page, scopeType) {
    // Map to EXACT column names from flooring intake databases
    const vendor = extractText(getProp(page, 'Vendor')) || 
                   extractText(getProp(page, 'Supplier Brand')) || 
                   extractText(getProp(page, 'Company_Name')) || '';
    
    const itemType = extractText(getProp(page, 'Material Type')) || 
                     extractText(getProp(page, 'Item_Description')) || 
                     extractText(getProp(page, 'Item Type')) || '';
    
    const currency = 'MYR'; // Always MYR for these databases
    
    const area = extractText(getProp(page, 'Area (m²)')) || 0;
    const unitPrice = extractText(getProp(page, 'Unit Price (MYR)')) || 
                      extractText(getProp(page, 'Rate_Per_Unit_Original')) || 0;
    
    const lineTotal = extractText(getProp(page, 'Line Total (MYR)')) || 
                      extractText(getProp(page, 'Line Total')) || 
                      (area * unitPrice);
    
    // Context fields
    const section = scopeType === 'Flooring' ? 
        (extractText(getProp(page, 'Section')) || deriveFlooringSection(itemType, extractText(getProp(page, 'Notes')) || '')) : 
        null;
    const bathroomCode = scopeType.includes('Bathroom') ? 
        (extractText(getProp(page, 'Bathroom Code')) || extractText(getProp(page, 'Bath Code')) || '') : 
        null;
    
    const quoteDate = extractText(getProp(page, 'PDF_Processing_Date')) || extractText(getProp(page, 'Quote Date')) || null;
    const validUntil = extractText(getProp(page, 'Valid Until')) || null;
    const terms = extractText(getProp(page, 'Payment_Terms')) || extractText(getProp(page, 'Terms')) || '';
    const exclusions = extractText(getProp(page, 'Exclusions')) || '';
    const notes = extractText(getProp(page, 'Conversion_Notes')) || extractText(getProp(page, 'Validation_Notes')) || extractText(getProp(page, 'Notes')) || '';
    const leadTimeDays = extractText(getProp(page, 'Duration_Days')) || extractText(getProp(page, 'Lead Time (Days)')) || 
                         extractText(getProp(page, 'Lead Time')) || null;
    
    // Additional flooring-specific fields
    const roomZone = extractText(getProp(page, 'Room / Zone')) || '';
    const roomCode = extractText(getProp(page, 'Room Code')) || '';
    const finishGrade = extractText(getProp(page, 'Finish / Grade')) || '';
    const sizeThickness = extractText(getProp(page, 'Size / Thickness')) || '';
    const supplierBrand = extractText(getProp(page, 'Supplier Brand')) || '';
    const supplierModel = extractText(getProp(page, 'Supplier Model')) || '';
    const installationRate = extractText(getProp(page, 'Installation Rate (MYR/m²)')) || 0;
    
    // Check if lumpsum
    const isLumpsum = norm(itemType).includes('lump sum') || norm(itemType).includes('lot');
    
    // Rate-only detection
    const isRateOnly = (lineTotal === null || lineTotal === 0) && unitPrice > 0;
    
    return {
        id: page.id,
        vendor,
        scopeType,
        currency,
        area,
        unitPrice,
        lineTotal: isRateOnly ? null : lineTotal,
        section,
        bathroomCode,
        itemType,
        roomZone,
        roomCode,
        finishGrade,
        sizeThickness,
        supplierBrand,
        supplierModel,
        installationRate,
        quoteDate,
        validUntil,
        terms,
        exclusions,
        notes: notes + (isRateOnly ? ' [Rate only]' : '') + (isLumpsum ? ' [Lump sum]' : ''),
        leadTimeDays,
        isRateOnly,
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

/**
 * Fetch and process all quotation data
 * @returns {Promise<Object>} - Processed quotation data
 */
async function fetchQuotationData() {
    const [flooringA, flooringB, bathroomSanitary, bathroomTiles, materialImages] = await Promise.all([
        queryNotionDB(FLOORING_GEORGE_A_DB_ID || ''),
        queryNotionDB(FLOORING_GEORGE_B_DB_ID || ''),
        queryNotionDB(BATHROOM_SANITARY_DB_ID || ''),
        queryNotionDB(BATHROOM_TILES_DB_ID || ''),
        queryNotionDB(MATERIAL_IMAGES_DB_ID || ''),
    ]);
    
    // Normalize all lines
    const flooringLines = [
        ...(flooringA.results || []).map(p => normalizeQuotationLine(p, 'Flooring')),
        ...(flooringB.results || []).map(p => normalizeQuotationLine(p, 'Flooring'))
    ];
    
    const bathroomSanitaryLines = (bathroomSanitary.results || [])
        .map(p => normalizeQuotationLine(p, 'Bathroom-Sanitary'));
    
    const bathroomTilesLines = (bathroomTiles.results || [])
        .map(p => normalizeQuotationLine(p, 'Bathroom-Tiles'));
    
    const allBathroomLines = [...bathroomSanitaryLines, ...bathroomTilesLines];
    
    // Calculate rankings
    const flooringRankings = calculateVendorRankings(flooringLines, 'section');
    const bathroomRankings = calculateVendorRankings(allBathroomLines, 'bathroomCode');
    
    // Process material images
    const images = (materialImages.results || []).map(p => ({
        item: extractText(getProp(p, 'Item')) || '',
        category: extractText(getProp(p, 'Category')) || '',
        zone: extractText(getProp(p, 'Zone/Bath Code')) || extractText(getProp(p, 'Zone')) || '',
        imageUrl: extractText(getProp(p, 'Image URL')) || '',
        notes: extractText(getProp(p, 'Notes')) || ''
    }));
    
    return {
        flooring: {
            lines: flooringLines,
            rankings: flooringRankings
        },
        bathroom: {
            lines: allBathroomLines,
            sanitaryLines: bathroomSanitaryLines,
            tilesLines: bathroomTilesLines,
            rankings: bathroomRankings
        },
        images
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

        // GET /quotations - Quotation comparison data endpoint
        if (httpMethod === 'GET' && path.endsWith('/quotations')) {
            try {
                const quotationData = await fetchQuotationData();
                return { 
                    statusCode: 200, 
                    headers, 
                    body: JSON.stringify({
                        success: true,
                        data: quotationData,
                        timestamp: new Date().toISOString()
                    }) 
                };
            } catch (error) {
                console.error('Quotation data error:', error);
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
                    'GET /quotations'
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
