/**
 * JOOBIN Renovation Hub Proxy v11.0.2 - Syntax Safety Fix
 * SOURCE OF TRUTH: Sourcing Master List
 */

const { Client } = require('@notionhq/client');

// --- Environment Variables ---
const {
    NOTION_API_KEY,
    SOURCING_MASTER_LIST_DB_ID, // The Source of Truth
    // Keep these for the main dashboard widgets
    NOTION_BUDGET_DB_ID,
    NOTION_ACTUALS_DB_ID,
    MILESTONES_DB_ID,
    DELIVERABLES_DB_ID,
    VENDOR_REGISTRY_DB_ID,
    PAYMENTS_DB_ID
} = process.env;

const notion = new Client({ auth: NOTION_API_KEY });
const NOTION_VERSION = '2022-06-28';

// --- Helpers ---
const notionHeaders = () => ({
    'Authorization': `Bearer ${NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
});

const norm = (s) => String(s || '').trim().toLowerCase();

function getProp(page, name) {
    return page.properties && page.properties[name];
}

/**
 * SAFE TEXT EXTRACTION
 * Uses standard && checks to prevent build parser errors with optional chaining
 */
function extractText(prop) {
    if (!prop) return '';

    if (prop.type === 'title') {
        return (prop.title && prop.title[0] && prop.title[0].plain_text) || '';
    }
    if (prop.type === 'rich_text') {
        return (prop.rich_text && prop.rich_text[0] && prop.rich_text[0].plain_text) || '';
    }
    if (prop.type === 'select') {
        return (prop.select && prop.select.name) || '';
    }
    if (prop.type === 'status') {
        return (prop.status && prop.status.name) || '';
    }
    if (prop.type === 'number') {
        return prop.number !== null ? prop.number : 0;
    }
    if (prop.type === 'date') {
        return (prop.date && prop.date.start) || null;
    }
    if (prop.type === 'formula') {
        // Handle both number and string formulas
        if (!prop.formula) return 0;
        if (prop.formula.type === 'number') return prop.formula.number || 0;
        if (prop.formula.type === 'string') return prop.formula.string || '';
        return 0;
    }
    if (prop.type === 'url') {
        return prop.url || '';
    }

    return '';
}

async function queryNotionDB(dbId, filter = {}) {
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
        const body = {...filter };
        if (startCursor) body.start_cursor = startCursor;

        try {
            const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
                method: 'POST',
                headers: notionHeaders(),
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(JSON.stringify(data));

            allResults = [...allResults, ...data.results];
            hasMore = data.has_more;
            startCursor = data.next_cursor;
        } catch (e) {
            console.error("Notion Query Error:", e);
            hasMore = false;
        }
    }
    return { results: allResults };
}

// --- CORE LOGIC: Sourcing Master List Processor ---
async function fetchAndProcessMasterList() {
    const rawData = await queryNotionDB(SOURCING_MASTER_LIST_DB_ID);

    // Buckets
    const flooring = { lines: [], rankings: {} };
    const bathroom = { lines: [], rankings: {} };
    const kitchen = { lines: [], rankings: {} };

    const allLines = rawData.results.map(page => {
        // Extract per Brief
        const itemName = extractText(getProp(page, 'Item Name'));
        const category = extractText(getProp(page, 'Category'));
        const room = extractText(getProp(page, 'Room')) || 'General';
        const vendor = extractText(getProp(page, 'Vendor')) || 'Unknown';
        const unitPrice = extractText(getProp(page, 'Unit Price (MYR)'));
        const quantity = extractText(getProp(page, 'Quantity'));
        // Brief says Total is a formula, but fallback to calculation if missing
        let total = extractText(getProp(page, 'Total Price (MYR)'));
        if (!total && total !== 0) {
            total = Number(unitPrice) * Number(quantity);
        }

        const notes = extractText(getProp(page, 'Notes'));

        return {
            id: page.id,
            vendor,
            itemType: itemName,
            category,
            room, // Critical for grouping
            unitPrice,
            quantity,
            total: Number(total) || 0,
            currency: 'MYR', // Master list is normalized to MYR
            notes
        };
    });

    // Bucket Logic
    allLines.forEach(line => {
        const cat = norm(line.category);
        if (cat.includes('flooring') || cat.includes('decking')) {
            flooring.lines.push(line);
        } else if (cat.includes('bath') || cat.includes('sanitary') || cat.includes('tile') || cat.includes('toilet')) {
            bathroom.lines.push(line);
        } else if (cat.includes('kitchen') || cat.includes('cabinet') || cat.includes('counter') || cat.includes('appliance')) {
            kitchen.lines.push(line);
        }
    });

    // Ranking Logic: Group by Room, Compare Vendors
    const generateRankings = (lines) => {
        const roomGroups = {};

        // 1. Organize by Room
        lines.forEach(line => {
            if (!roomGroups[line.room]) roomGroups[line.room] = {};
            if (!roomGroups[line.room][line.vendor]) {
                roomGroups[line.room][line.vendor] = {
                    vendor: line.vendor,
                    total: 0,
                    items: [],
                    currency: 'MYR'
                };
            }
            roomGroups[line.room][line.vendor].items.push(line);
            roomGroups[line.room][line.vendor].total += line.total;
        });

        // 2. Flatten and Rank
        const finalRankings = {};
        Object.keys(roomGroups).forEach(room => {
            const vendors = Object.values(roomGroups[room]);

            // Sort by Lowest Price first
            vendors.sort((a, b) => a.total - b.total);

            // Assign Ranks & Badges
            vendors.forEach((v, index) => {
                v.rank = index + 1;
                v.isCheapest = (index === 0);
                v.isHighest = (index === vendors.length - 1 && vendors.length > 1);
                v.completenessScore = 1;
            });

            finalRankings[room] = vendors;
        });
        return finalRankings;
    };

    flooring.rankings = generateRankings(flooring.lines);
    bathroom.rankings = generateRankings(bathroom.lines);
    kitchen.rankings = generateRankings(kitchen.lines);

    return { flooring, bathroom, kitchen };
}

// --- HANDLER ---
exports.handler = async(event) => {
    const { httpMethod, path } = event;
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    if (httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    try {
        // Route: Quotations (Flooring, Bath, Kitchen)
        if (path.endsWith('/quotations')) {
            if (!SOURCING_MASTER_LIST_DB_ID) throw new Error("Missing SOURCING_MASTER_LIST_DB_ID");
            const data = await fetchAndProcessMasterList();
            return { statusCode: 200, headers, body: JSON.stringify({ data }) };
        }

        // Route: Main Dashboard Data (Keep existing logic structure but empty to prevent crashes)
        if (path.endsWith('/proxy')) {
            return { statusCode: 200, headers, body: JSON.stringify({ kpis: {}, gates: [], deliverables: [] }) };
        }

        return { statusCode: 404, headers, body: 'Not Found' };
    } catch (e) {
        console.error(e);
        return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
};