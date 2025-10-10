/**
 * JOOBIN Renovation Hub Proxy v12.3.2
 */

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

const NOTION_VERSION = '2022-06-28';
const GEMINI_MODEL = 'gemini-2.5-flash-preview-05-20';
const CONSTRUCTION_START_DATE = '2025-11-22';

const REQUIRED_BY_GATE = {
  "G0 Pre Construction": ['Move Out to Temporary Residence'],
  "G1 Concept": ["MOODBOARD", "PROPOSED RENOVATION FLOOR PLAN"],
  "G2 Schematic": [],
  "G3 Design Development": ["DOORS AND WINDOWS", "Construction Drawings", "MEP Drawings", "Interior Design Plans", "Schedules", "Finishes"],
  "G4 Authority Submission": ["RENOVATION PERMIT", "Structural Drawings", "BQ Complete", "Quotation Package Ready"],
  "G5 Construction Documentation": ["Contractor Awarded", "Tender Package Issued", "Site Mobilization Complete", "Demolition Complete Certificate", "Structural Works Complete", "Carpentry Complete", "Finishes Complete", "MEP Rough-in Complete", "MEP Final Complete", "Plumbing Complete", "Electrical Complete", "HVAC Complete", "Painting Complete", "Tiling Complete", "Joinery Complete", "Hardware Installation Complete", "Testing & Commissioning Complete", "Defects Rectification Complete", "Site Cleanup Complete", "Pre-handover Inspection Complete"],
  "G6 Design Close-out": ["Final Inspection Complete", "Handover Certificate"]
};

const notionHeaders = () => ({ 'Authorization': `Bearer ${NOTION_API_KEY}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' });
const norm = (s) => String(s || '').trim().toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function queryNotionDB(dbId, filter = {}) {
  if (!dbId) return { results: [] };
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  const res = await fetch(url, { method: 'POST', headers: notionHeaders(), body: JSON.stringify(filter) });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  let delay = 1000;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (res.ok) return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (res.status === 503) { await sleep(delay); delay *= 2; continue; }
      throw new Error(await res.text());
    } catch (e) {
      if (i === 2) throw e;
      await sleep(delay); delay *= 2;
    }
  }
}

function getProp(page, ...names) {
  for (const name of names) {
    const prop = page.properties?.[name];
    if (prop) return prop;
  }
  return null;
}

function extractText(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title': return prop.title?.[0]?.plain_text || '';
    case 'rich_text': return prop.rich_text?.[0]?.plain_text || '';
    case 'select': return prop.select?.name || '';
    case 'status': return prop.status?.name || '';
    case 'number': return prop.number;
    case 'date': return prop.date?.start || null;
    case 'checkbox': return prop.checkbox;
    case 'formula': return prop.formula?.string || prop.formula?.number || '';
    case 'relation': return prop.relation?.[0]?.id || '';
    default: return '';
  }
}

export const handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const now = new Date();

  if (event.httpMethod === 'GET' && event.path.endsWith('/proxy')) {
    try {
      const [budgetData, actualsData, milestonesData, deliverablesData, vendorData, paymentsData, workPackagesData] = await Promise.all([
        queryNotionDB(NOTION_BUDGET_DB_ID),
        queryNotionDB(NOTION_ACTUALS_DB_ID),
        queryNotionDB(MILESTONES_DB_ID),
        queryNotionDB(DELIVERABLES_DB_ID),
        queryNotionDB(VENDOR_REGISTRY_DB_ID),
        queryNotionDB(PAYMENTS_DB_ID),
        queryNotionDB(NOTION_WORK_PACKAGES_DB_ID)
      ]);

      const vendorMap = (vendorData.results || []).reduce((acc, p) => {
        acc[p.id] = extractText(getProp(p, 'Company_Name', 'Name')) || 'Unknown';
        return acc;
      }, {});

      const processedDeliverables = (deliverablesData.results || []).map(p => {
        const title = extractText(getProp(p, 'Select Deliverable', 'Deliverable')) || 'Untitled';
        const category = extractText(getProp(p, 'Category'));
        const gate = extractText(getProp(p, 'Gate (Auto)', 'Gate'));
        const status = extractText(getProp(p, 'Status')) || extractText(getProp(p, 'Review Status')) || 'Missing';
        const dueDate = extractText(getProp(p, 'Target Due'));
        const url = p.url;
        const assignees = (getProp(p, 'Owner')?.people || []).map(p => p.name).filter(Boolean);
        const priority = getProp(p, 'Critical Path')?.checkbox ? 'Critical' : 'Low';
        return { title, deliverableType: title, category, gate, status, dueDate, url, assignees, confirmed: !!dueDate, priority };
      });

      const allDeliverables = [...processedDeliverables];
      Object.entries(REQUIRED_BY_GATE).forEach(([gate, requiredItems]) => {
        requiredItems.forEach(req => {
          const exists = allDeliverables.some(d => d.gate === gate && norm(d.title) === norm(req));
          if (!exists) allDeliverables.push({ title: req, deliverableType: req, category: '', gate, status: 'Missing', dueDate: null, url: '', assignees: [], confirmed: false, priority: 'Low' });
        });
      });

      const gates = Object.entries(REQUIRED_BY_GATE).map(([gate, required]) => {
        const items = allDeliverables.filter(d => d.gate === gate);
        const approved = items.filter(d => norm(d.status) === 'approved').length;
        return { gate, approved, total: required.length, gateApprovalRate: required.length > 0 ? approved / required.length : 1 };
      });

      const overduePayments = paymentsData.results.filter(p => {
        const status = norm(extractText(getProp(p, 'Status')));
        const due = extractText(getProp(p, 'DueDate'));
        return ['outstanding', 'overdue'].includes(status) && due && new Date(due) < now;
      }).map(p => ({
        id: p.id,
        paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled',
        vendor: extractText(getProp(p, 'Vendor')),
        amount: extractText(getProp(p, 'Amount (RM)')) || 0,
        dueDate: extractText(getProp(p, 'DueDate')),
        url: p.url
      }));

      const alerts = {
        daysToConstructionStart: Math.ceil((new Date(CONSTRUCTION_START_DATE) - now) / (1000 * 60 * 60 * 24)),
        paymentsOverdue: overduePayments,
        mbsaPermitApproved: allDeliverables.some(d => norm(d.deliverableType) === 'renovation permit' && norm(d.status) === 'approved'),
        contractorAwarded: allDeliverables.some(d => norm(d.deliverableType) === 'contractor awarded' && norm(d.status) === 'approved'),
        g3NotApproved: gates.find(g => g.gate === 'G3 Design Development')?.gateApprovalRate < 1
      };

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          deliverables: allDeliverables,
          gates,
          alerts,
          timestamp: now.toISOString()
        })
      };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
};
