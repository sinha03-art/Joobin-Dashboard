/**
 * JOOBIN Renovation Hub Proxy v7.4.0
 * Patched:
 * - Added new fields to deliverables for the "To Complete" tab.
 * - Updated upcoming payments logic to exclude overdue items.
 * - Implemented exponential backoff for the Gemini API call.
 */

const {
  GEMINI_API_KEY,
  NOTION_API_KEY,
  NOTION_BUDGET_DB_ID,
  NOTION_ACTUALS_DB_ID,
  MILESTONES_DB_ID,
  DELIVERABLES_DB_ID,
  VENDOR_REGISTRY_DB_ID,
  CONFIG_DB_ID,
  PAYMENTS_DB_ID,
} = process.env;

const NOTION_VERSION = '2022-06-28';
const GEMINI_MODEL = 'gemini-2.5-flash-preview-05-20';

const REQUIRED_BY_GATE = {
    "G1 Concept": ["MOODBOARD", "PROPOSED RENOVATION FLOOR PLAN"],
    "G2 Schematic": [],
    "G3 Design Development": ["DOORS AND WINDOWS", "Construction Drawings", "MEP Drawings", "Interior Design Plans", "Schedules", "Finishes"],
    "G4 Authority Submission": ["RENOVATION PERMIT", "Structural Drawings", "BQ Complete", "Quotation Package Ready"],
    "G5 Construction Documentation": ["Contractor Awarded", "Tender Package Issued", "Site Mobilization Complete", "Demolition Complete Certificate", "Structural Works Complete", "Carpentry Complete", "Finishes Complete"],
    "G6 Design Close-out": ["Final Inspection Complete", "Handover Certificate"]
};

const notionHeaders = () => ({
  'Authorization': `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

const norm = (s) => String(s || '').trim().toLowerCase();

async function queryNotionDB(dbId, filter = {}) {
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  try {
    const res = await fetch(url, { method: 'POST', headers: notionHeaders(), body: JSON.stringify(filter) });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Notion API error: ${res.status}`, errText);
      throw new Error(`Notion API error: ${res.status}: ${errText}`);
    }
    return await res.json();
  } catch (error) {
    console.error('queryNotionDB error:', error);
    throw error;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callGemini(prompt) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured.');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    let delay = 1000;
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
            if (res.ok) return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
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
  return page.properties?.[name] || page.properties?.[fallback];
}

function extractText(prop) {
  if (!prop) return '';
  if (prop.type === 'title' && prop.title?.[0]?.plain_text) return prop.title[0].plain_text;
  if (prop.type === 'rich_text' && prop.rich_text?.[0]?.plain_text) return prop.rich_text[0].plain_text;
  if (prop.type === 'select' && prop.select?.name) return prop.select.name;
  if (prop.type === 'status' && prop.status?.name) return prop.status.name;
  if (prop.type === 'number') return prop.number;
  if (prop.type === 'date' && prop.date?.start) return prop.date.start;
  if (prop.type === 'formula') return prop.formula?.number;
  return '';
}

export const handler = async (event) => {
  const { httpMethod, path } = event;
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' };
  if (httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try {
    if (httpMethod === 'GET' && path.endsWith('/proxy')) {
      const [budgetData, actualsData, milestonesData, deliverablesData, vendorData, paymentsData] = await Promise.all([
        queryNotionDB(NOTION_BUDGET_DB_ID), queryNotionDB(NOTION_ACTUALS_DB_ID),
        queryNotionDB(MILESTONES_DB_ID), queryNotionDB(DELIVERABLES_DB_ID),
        queryNotionDB(VENDOR_REGISTRY_DB_ID), PAYMENTS_DB_ID ? queryNotionDB(PAYMENTS_DB_ID) : Promise.resolve({ results: [] }),
      ]);

      const budgetPages = budgetData.results || [];
      const actualsPages = actualsData.results || [];
      const deliverablePages = deliverablesData.results || [];
      const paymentPages = paymentsData.results || [];
      const now = new Date();
      
      const budgetSubtotal = budgetPages
        .filter(p => getProp(p, 'inScope', 'In Scope')?.checkbox === true)
        .reduce((sum, p) => sum + (extractText(getProp(p, 'supply_myr')) || 0) + (extractText(getProp(p, 'install_myr')) || 0), 0);
      const budgetMYR = (budgetSubtotal + 27900) * (1 - 0.05) * (1 + 0.10);
      
      const processedDeliverables = deliverablePages.map(p => ({
          title: extractText(getProp(p, 'Deliverable Name')),
          deliverableType: extractText(getProp(p, 'Deliverable Name')),
          gate: extractText(getProp(p, 'Gate')),
          status: extractText(getProp(p, 'Status')),
          assignees: (getProp(p, 'Owner')?.people || []).map(person => person.name || ''),
          url: p.url,
          dueDate: getProp(p, 'Due Date')?.date?.start || null,
          dueTime: extractText(getProp(p, 'Due Time')),
          confirmed: getProp(p, 'Confirmed?')?.checkbox || false,
          vendor: extractText(getProp(p, 'Vendor')),
          priority: extractText(getProp(p, 'Priority'))
      }));

      const existingDeliverableKeys = new Set(processedDeliverables.map(d => norm(`${d.gate}|${d.deliverableType}`)));
      const allDeliverablesIncludingMissing = [...processedDeliverables];

      Object.entries(REQUIRED_BY_GATE).forEach(([gateName, requiredDocs]) => {
          requiredDocs.forEach(requiredTitle => {
              if (!existingDeliverableKeys.has(norm(`${gateName}|${requiredTitle}`))) {
                  allDeliverablesIncludingMissing.push({
                      title: requiredTitle, deliverableType: requiredTitle, gate: gateName,
                      status: 'Missing', assignees: [], url: '#'
                  });
              }
          });
      });

      const gates = Object.entries(REQUIRED_BY_GATE).map(([gateName, requiredDocs]) => {
          const approvedCount = allDeliverablesIncludingMissing.filter(d => 
              d.gate === gateName && requiredDocs.some(reqType => norm(d.deliverableType) === norm(reqType)) && norm(d.status) === 'approved'
          ).length;
          const totalInGate = requiredDocs.length;
          return { gate: gateName, total: totalInGate, approved: approvedCount, gateApprovalRate: totalInGate > 0 ? approvedCount / totalInGate : 0 };
      }).sort((a, b) => a.gate.localeCompare(b.gate));

      const paidMYR = actualsPages.filter(p => extractText(getProp(p, 'Status')) === 'Paid').reduce((sum, p) => sum + (extractText(getProp(p, 'Paid (MYR)')) || 0), 0);
      
      const overduePayments = paymentPages.filter(p => {
          const status = extractText(getProp(p, 'Status'));
          const dueDate = extractText(getProp(p, 'DueDate'));
          return (status === 'Outstanding' || status === 'Overdue') && dueDate && new Date(dueDate) < now;
      }).map(p => ({
          paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled', vendor: extractText(getProp(p, 'Vendor')),
          amount: extractText(getProp(p, 'Amount (RM)')) || 0, status: extractText(getProp(p, 'Status')),
          dueDate: extractText(getProp(p, 'DueDate')) || null, url: p.url,
      })).sort((a, b) => (a.dueDate || '0') > (b.dueDate || '0') ? 1 : -1);

      const upcomingPayments = paymentPages.filter(p => {
          const status = extractText(getProp(p, 'Status'));
          const dueDate = extractText(getProp(p, 'DueDate'));
          return status === 'Outstanding' && (!dueDate || new Date(dueDate) >= now);
      }).map(p => ({
          paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled', vendor: extractText(getProp(p, 'Vendor')),
          amount: extractText(getProp(p, 'Amount (RM)')) || 0, status: extractText(getProp(p, 'Status')),
          dueDate: extractText(getProp(p, 'DueDate')) || null, url: p.url,
      })).sort((a, b) => (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : -1).slice(0, 10);
      
      const recentPaidPayments = paymentPages.filter(p => extractText(getProp(p, 'Status')) === 'Paid').map(p => ({
          paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled', vendor: extractText(getProp(p, 'Vendor')),
          amount: extractText(getProp(p, 'Amount (RM)')) || 0, status: extractText(getProp(p, 'Status')),
          paidDate: extractText(getProp(p, 'PaidDate')) || null, url: p.url,
      })).sort((a, b) => (b.paidDate || '0') > (a.paidDate || '0') ? 1 : -1).slice(0, 10);
      
      const forecastMonths = [];
      // ... (forecast logic remains the same)

      const responseData = {
        kpis: {
          budgetMYR, paidMYR, remainingMYR: budgetMYR - paidMYR,
          deliverablesApproved: allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length,
          deliverablesTotal: allDeliverablesIncludingMissing.length,
          totalOutstandingMYR: paymentPages.filter(p => ['Outstanding', 'Overdue'].includes(extractText(getProp(p, 'Status')))).reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)')) || 0), 0),
          totalOverdueMYR: overduePayments.reduce((sum, p) => sum + p.amount, 0),
          paidVsBudget: budgetMYR > 0 ? paidMYR / budgetMYR : 0,
          deliverablesProgress: allDeliverablesIncludingMissing.length > 0 ? allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length / allDeliverablesIncludingMissing.length : 0,
          milestonesAtRisk: (milestonesData.results || []).filter(m => extractText(getProp(m, 'Risk_Status')) === 'At Risk').length,
        },
        gates,
        // ... (rest of the response data remains the same)
        deliverables: allDeliverablesIncludingMissing,
        paymentsSchedule: { upcoming: upcomingPayments, overdue: overduePayments, recentPaid: recentPaidPayments, forecast: forecastMonths },
      };
      return { statusCode: 200, headers, body: JSON.stringify(responseData) };
    }

    if (httpMethod === 'POST' && path.endsWith('/proxy')) {
        const body = JSON.parse(event.body || '{}');
        const prompt = `Summarize this project data: Budget ${body.kpis?.budgetMYR || 0} MYR, Paid ${body.kpis?.paidMYR || 0} MYR. Deliverables ${body.kpis?.deliverablesApproved || 0}/${body.kpis?.deliverablesTotal || 0} approved. Milestones at risk: ${body.kpis?.milestonesAtRisk || 0}. Overdue payments: ${body.kpis?.totalOverdueMYR > 0 ? 'Yes' : 'No'}. Focus on risks and progress.`;
        const summary = await callGemini(prompt);
        return { statusCode: 200, headers, body: JSON.stringify({ summary }) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  } catch (error) {
    console.error('Handler error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message, timestamp: new Date().toISOString() }) };
  }
};


