const {
  GEMINI_API_KEY,
  NOTION_API_KEY,
  NOTION_BUDGET_DB_ID,
  NOTION_ACTUALS_DB_ID,
  MILESTONES_DB_ID,
  DELIVERABLES_DB_ID,
  VENDOR_REGISTRY_DB_ID,
  NOTION_WORK_PACKAGES_DB_ID,
  PAYMENTS_DB_ID
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

const notionHeaders = () => ({
  'Authorization': `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json'
});

const norm = s => String(s || '').trim().toLowerCase();

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

async function queryNotionDB(dbId, filter = {}) {
  if (!dbId) return { results: [] };
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify(filter)
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}
// --- Update Records ---
let updateRecords = [];
try {
  const updatesData = await queryNotionDB(CONFIG_DB_ID);
  updateRecords = (updatesData.results || []).map(u => ({
    id: u.id,
    title: extractText(getProp(u, 'Title')),
    summary: extractText(getProp(u, 'Summary')),
    date: extractText(getProp(u, 'Date')),
    author: extractText(getProp(u, 'Author')),
    url: u.url
  }));
} catch (e) {
  console.warn('UpdateRecords fetch failed:', e.message);
}
export const handler = async () => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const now = new Date();

  try {
    const [budgetData, actualsData, milestonesData, deliverablesData, vendorData, paymentsData] = await Promise.all([
      queryNotionDB(NOTION_BUDGET_DB_ID),
      queryNotionDB(NOTION_ACTUALS_DB_ID),
      queryNotionDB(MILESTONES_DB_ID),
      queryNotionDB(DELIVERABLES_DB_ID),
      queryNotionDB(VENDOR_REGISTRY_DB_ID),
      queryNotionDB(PAYMENTS_DB_ID)
    ]);

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
            assignees: [],
            url: '#'
          });
        }
      });
    });
    // --- Reminders ---
    const reminders = allDeliverablesIncludingMissing
      .filter(d => !d.dueDate || norm(d.status) === 'submitted')
      .map(d => ({
        id: d.id || `missing-${d.deliverableType}`,
        message: `Deliverable "${d.deliverableType}" is pending or missing a due date.`,
        dueDate: d.dueDate,
        type: (!d.dueDate ? 'warning' : 'info')
      }));
    const gates = Object.entries(REQUIRED_BY_GATE).map(([gateName, requiredDocs]) => {
      const approved = allDeliverablesIncludingMissing.filter(d =>
        d.gate === gateName &&
        requiredDocs.some(req => norm(d.deliverableType) === norm(req)) &&
        norm(d.status) === 'approved'
      ).length;

      return {
        gate: gateName,
        approved,
        total: requiredDocs.length,
        gateApprovalRate: requiredDocs.length > 0 ? approved / requiredDocs.length : 1
      };
    });

    const paidMYR = actualsData.results
      .filter(p => norm(extractText(getProp(p, 'Status'))) === 'paid')
      .reduce((sum, p) => sum + (extractText(getProp(p, 'Paid (MYR)')) || 0), 0);

    const budgetSubtotal = budgetData.results
      .filter(p => extractText(getProp(p, 'In Scope')))
      .reduce((sum, p) =>
        sum +
        (extractText(getProp(p, 'Supply (MYR)')) || 0) +
        (extractText(getProp(p, 'Install (MYR)')) || 0), 0);

    const budgetMYR = (budgetSubtotal + 27900) * (1 - 0.05) * (1 + 0.10);

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
    // --- Top Vendors ---
    const topVendorsMap = {};
    (actualsData.results || []).forEach(p => {
      const vendor = extractText(getProp(p, 'Vendor')) || 'Unknown';
      const paid = extractText(getProp(p, 'Paid (MYR)')) || 0;
      if (!topVendorsMap[vendor]) topVendorsMap[vendor] = 0;
      topVendorsMap[vendor] += paid;
    });
    const topVendors = Object.entries(topVendorsMap)
      .map(([vendor, paidMYR]) => ({ vendor, paidMYR }))
      .sort((a, b) => b.paidMYR - a.paidMYR)
      .slice(0, 5);

    const kpis = {
      budgetMYR,
      paidMYR,
      remainingMYR: budgetMYR - paidMYR,
      deliverablesApproved: allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length,
      deliverablesTotal: allDeliverablesIncludingMissing.length,
      totalOutstandingMYR: overduePayments.reduce((sum, p) => sum + p.amount, 0),
      totalOverdueMYR: overduePayments.reduce((sum, p) => sum + p.amount, 0),
      paidVsBudget: budgetMYR > 0 ? paidMYR / budgetMYR : 0,
      deliverablesProgress:
        allDeliverablesIncludingMissing.length > 0
          ? allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length / allDeliverablesIncludingMissing.length
          : 0,
      milestonesAtRisk: (milestonesData.results || []).filter(m => extractText(getProp(m, 'Risk_Status')) === 'At Risk').length,
    };

    const alerts = {
      daysToConstructionStart: Math.ceil((new Date(CONSTRUCTION_START_DATE) - now) / (1000 * 60 * 60 * 24)),
      paymentsOverdue: overduePayments,
      mbsaPermitApproved: allDeliverablesIncludingMissing.some(d => norm(d.deliverableType) === 'renovation permit' && norm(d.status) === 'approved'),
      contractorAwarded: allDeliverablesIncludingMissing.some(d => norm(d.deliverableType) === 'contractor awarded' && norm(d.status) === 'approved'),
    };

    // --- Final Response Data ---
    const responseData = {
      kpis,
      gates,
      deliverables: allDeliverablesIncludingMissing,
      paymentsSchedule,
      alerts,
      topVendors,
      updateRecords,
      reminders,
      timestamp: new Date().toISOString()
    };

    // ✅ Return the JSON response to the frontend
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(responseData)
    };

  } catch (error) {
    // 🛑 Error fallback response
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: error.message })
    };
  }
};

