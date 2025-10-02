/**
 * JOOBIN Renovation Hub Proxy v6.6.0
 * Patched: Centralized required deliverables list in backend to ensure
 * accurate KPI and gate progress calculations, syncing dashboard with deliverables board.
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

// Central source of truth for all required deliverables
const REQUIRED_BY_GATE = {
    "G1 Concept": [
      "Moodboard — Approved",
      "Space Analysis and Planning (Draft)",
      "Concept Design R&D and Moodboard",
      "Furniture Layout Plan (Draft)"
    ],
    "G2 Schematic": [
      "Schematic Plans (1:100) — Approved",
      "Area Takeoffs",
      "Key Dimensions Plan",
      "Zoning / Room Data Sheets (if applicable)"
    ],
    "G3 Design Development": [
      "DOORS AND WINDOWS — Approved",
      "Room Finish Schedule — Approved",
      "Finishes Plan — Floors/Walls/Paint — Approved",
      "MEP Coordination Plans — Approved",
      "Electrical/Lighting Layout with Load Schedule — Approved",
      "Low-Voltage/Controls (Data/AV/Security/Blinds) — Approved",
      "Cabinetry/Joinery Shop Drawings — Approved",
      "Kitchen Package (Cabinetry, Countertops, Appliances cut-sheets) — Approved",
      "Sanitary Ware Schedule and Cut-sheets — Approved",
      "Flooring System Data and Cut-sheets — Approved",
      "Motorized Blinds Submittals — Approved",
      "Coordinated Plans/Elevations/Sections/Details — Approved"
    ],
    "G4 Authority Submission": [
      "Authority Submission Set — Approved",
      "Approved Permit (Authority)"
    ],
    "G5 Construction Documentation": [
      "Windows Package Shop Drawings — Approved",
      "Construction Documentation Set (IFC) — Approved",
      "Schedules and Specs — Approved"
    ],
    "G6 Design Close‑out": [
      "As-built Drawings — Approved",
      "O&M Manuals — Approved"
    ]
  };

const notionHeaders = () => ({
  'Authorization': `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

async function queryNotionDB(dbId, filter = {}) {
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify(filter),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Notion API error: ${res.status}`, errText);
      throw new Error(`Notion API error: ${res.status}`);
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
  if (prop.type === 'number' && typeof prop.number === 'number') return prop.number;
  if (prop.type === 'date' && prop.date?.start) return prop.date.start;
  if (prop.type === 'formula' && prop.formula?.type === 'number' && typeof prop.formula.number === 'number') return prop.formula.number;
  return '';
}

export const handler = async (event) => {
  const { httpMethod, path } = event;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    if (httpMethod === 'GET' && path.endsWith('/proxy')) {
      const [budgetData, actualsData, milestonesData, deliverablesData, vendorData, paymentsData] = await Promise.all([
        queryNotionDB(NOTION_BUDGET_DB_ID, {}),
        queryNotionDB(NOTION_ACTUALS_DB_ID, {}),
        queryNotionDB(MILESTONES_DB_ID, {}),
        queryNotionDB(DELIVERABLES_DB_ID, {}),
        queryNotionDB(VENDOR_REGISTRY_DB_ID, {}),
        PAYMENTS_DB_ID ? queryNotionDB(PAYMENTS_DB_ID, {}) : Promise.resolve({ results: [] }),
      ]);

      const budgetPages = budgetData.results || [];
      const actualsPages = actualsData.results || [];
      const milestonePages = milestonesData.results || [];
      const deliverablePages = deliverablesData.results || [];
      const vendorPages = vendorData.results || [];
      const paymentPages = paymentsData.results || [];
      
      const now = new Date();

      // === Deliverables & Gates (Calculated from single source of truth) ===
      const allRequiredDeliverables = Object.values(REQUIRED_BY_GATE).flat();
      const deliverablesTotal = allRequiredDeliverables.length;
      
      const processedDeliverables = deliverablePages.map(p => ({
          title: extractText(getProp(p, 'Deliverable', 'Name')),
          gate: extractText(getProp(p, 'Gate', 'Gate')),
          status: extractText(getProp(p, 'Approval_Status', 'Approval Status')),
          assignees: (getProp(p, 'Assignees(text)', 'Assignees')?.rich_text || []).map(rt => rt.plain_text),
          url: p.url,
      }));

      const deliverablesApproved = processedDeliverables.filter(d => d.status === 'Approved').length;

      const gates = Object.entries(REQUIRED_BY_GATE).map(([gateName, requiredDocs]) => {
          const approvedCount = requiredDocs.filter(reqTitle => 
              processedDeliverables.some(d => d.gate === gateName && d.title === reqTitle && d.status === 'Approved')
          ).length;
          
          return {
              gate: gateName,
              total: requiredDocs.length,
              approved: approvedCount,
              gateApprovalRate: requiredDocs.length > 0 ? approvedCount / requiredDocs.length : 0,
          };
      });


      // === KPIs ===
      const budgetMYR = budgetPages.reduce((sum, p) => sum + (extractText(getProp(p, 'Subtotal (Formula)', 'Subtotal')) || 0), 0);
      const paidMYR = actualsPages
        .filter(p => extractText(getProp(p, 'Status', 'Status')) === 'Paid')
        .reduce((sum, p) => sum + (extractText(getProp(p, 'Paid (MYR)', 'Paid')) || 0), 0);

      const remainingMYR = budgetMYR - paidMYR;
      
      const totalOutstandingMYR = paymentPages
        .filter(p => ['Outstanding', 'Overdue'].includes(extractText(getProp(p, 'Status', 'Status'))))
        .reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0), 0);

      const totalOverdueMYR = paymentPages
        .filter(p => {
          const status = extractText(getProp(p, 'Status', 'Status'));
          const dueDate = extractText(getProp(p, 'DueDate', 'Due Date'));
          return (status === 'Outstanding' || status === 'Overdue') && dueDate && new Date(dueDate) < now;
        })
        .reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0), 0);

      // ... (rest of the handler remains largely the same)
      // === Payments Schedule ===
      const upcomingPayments = paymentPages
        .filter(p => extractText(getProp(p, 'Status', 'Status')) === 'Outstanding')
        .map(p => {
          const dueDateProp = getProp(p, 'DueDate', 'Due Date');
          return {
            paymentFor: extractText(getProp(p, 'Payment For', 'PaymentFor')) || 'Untitled',
            vendor: extractText(getProp(p, 'Vendor', 'Vendor')),
            amount: extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0,
            status: extractText(getProp(p, 'Status', 'Status')),
            dueDate: dueDateProp?.date?.start || null,
            url: p.url,
          };
        })
        .sort((a, b) => (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : -1)
        .slice(0, 10);

      const overduePayments = paymentPages
        .filter(p => {
          const status = extractText(getProp(p, 'Status', 'Status'));
          const dueDateProp = getProp(p, 'DueDate', 'Due Date');
          const dueDate = dueDateProp?.date?.start;
          return (status === 'Outstanding' || status === 'Overdue') && dueDate && new Date(dueDate) < now;
        })
        .map(p => {
          const dueDateProp = getProp(p, 'DueDate', 'Due Date');
          return {
            paymentFor: extractText(getProp(p, 'Payment For', 'PaymentFor')) || 'Untitled',
            vendor: extractText(getProp(p, 'Vendor', 'Vendor')),
            amount: extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0,
            status: extractText(getProp(p, 'Status', 'Status')),
            dueDate: dueDateProp?.date?.start || null,
            url: p.url,
          };
        })
        .sort((a, b) => (a.dueDate || '0') > (b.dueDate || '0') ? 1 : -1);

      const recentPaidPayments = paymentPages
        .filter(p => extractText(getProp(p, 'Status', 'Status')) === 'Paid')
        .map(p => {
          const paidDateProp = getProp(p, 'PaidDate', 'Paid Date');
          return {
            paymentFor: extractText(getProp(p, 'Payment For', 'PaymentFor')) || 'Untitled',
            vendor: extractText(getProp(p, 'Vendor', 'Vendor')),
            amount: extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0,
            status: extractText(getProp(p, 'Status', 'Status')),
            paidDate: paidDateProp?.date?.start || null,
            url: p.url,
          };
        })
        .sort((a, b) => (b.paidDate || '0') > (a.paidDate || '0') ? 1 : -1)
        .slice(0, 10);

      // Payment Forecast (4 months)
      const forecastMonths = [];
      const outstandingPayments = paymentPages.filter(p =>
        ['Outstanding', 'Overdue'].includes(extractText(getProp(p, 'Status', 'Status')))
      );
      const firstMonthDate = new Date(now.getFullYear(), now.getMonth(), 1);

      const overdueAndUnscheduledAmount = outstandingPayments
        .filter(p => {
          const dueDate = extractText(getProp(p, 'DueDate', 'Due Date'));
          if (!dueDate) return true;
          return new Date(dueDate) < firstMonthDate;
        })
        .reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0), 0);

      for (let i = 0; i < 4; i++) {
        const monthDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const monthKey = monthDate.toISOString().slice(0, 7);
        const monthName = monthDate.toLocaleString('en-US', { month: 'short' });
        
        const monthScheduledAmount = outstandingPayments
            .filter(p => (extractText(getProp(p, 'DueDate', 'Due Date')) || '').startsWith(monthKey))
            .reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0), 0);

        let totalAmount = monthScheduledAmount;
        if (i === 0) {
            totalAmount += overdueAndUnscheduledAmount;
        }
        
        forecastMonths.push({ month: monthName, totalAmount });
      }

      // === Top Vendors, Milestones, etc. ===
      const vendorSpendMap = {};
      actualsPages
        .filter(p => extractText(getProp(p, 'Status', 'Status')) === 'Paid')
        .forEach(p => {
          const vendor = extractText(getProp(p, 'Vendor', 'Vendor')) || 'Unknown';
          const paid = extractText(getProp(p, 'Paid (MYR)', 'Paid')) || 0;
          vendorSpendMap[vendor] = (vendorSpendMap[vendor] || 0) + paid;
        });

      const topVendors = Object.entries(vendorSpendMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([vendorName, paidAmount]) => {
            const vendorPage = vendorPages.find(v => extractText(getProp(v, 'Company_Name', 'Company Name')) === vendorName);
            const trade = vendorPage ? extractText(getProp(vendorPage, 'Trade_Specialization', 'Trade Specialization')) : '—';
            return { name: vendorName, trade, paid: paidAmount };
        });
      
      const milestones = milestonePages.map(p => ({
        title: extractText(getProp(p, 'MilestoneTitle', 'Milestone Title')) || 'Untitled',
        phase: extractText(getProp(p, 'Phase', 'Phase')),
        status: extractText(getProp(p, 'Risk_Status', 'Risk Status')),
        url: p.url,
      }));

      // === Response ===
      const responseData = {
        kpis: {
          budgetMYR,
          paidMYR,
          remainingMYR,
          deliverablesApproved,
          deliverablesTotal,
          totalOutstandingMYR,
          totalOverdueMYR,
          paidVsBudget: budgetMYR > 0 ? paidMYR / budgetMYR : 0,
          deliverablesProgress: deliverablesTotal > 0 ? deliverablesApproved / deliverablesTotal : 0,
          milestonesAtRisk: milestones.filter(m => m.status === 'At Risk').length,
        },
        gates,
        topVendors,
        milestones,
        deliverables: processedDeliverables, // Pass processed deliverables to frontend
        paymentsSchedule: {
          upcoming: upcomingPayments,
          overdue: overduePayments,
          recentPaid: recentPaidPayments,
          forecast: forecastMonths,
        },
        timestamp: new Date().toISOString(),
      };

      return { statusCode: 200, headers, body: JSON.stringify(responseData) };
    }

    if (httpMethod === 'POST' && path.endsWith('/proxy')) {
        const body = JSON.parse(event.body || '{}');
        const { kpis } = body;
        const prompt = `You are a project assistant. Summarize this renovation project data in 2-3 concise sentences:
- Budget: ${kpis?.budgetMYR || 0} MYR, Paid: ${kpis?.paidMYR || 0} MYR
- Deliverables: ${kpis?.deliverablesApproved || 0}/${kpis?.deliverablesTotal || 0} approved
- Milestones at risk: ${kpis?.milestonesAtRisk || 0}
- Overdue payments: ${kpis?.totalOverdueMYR > 0 ? 'Yes' : 'No'}

Focus on key risks and overall progress.`;
        const summary = await callGemini(prompt);
        return { statusCode: 200, headers, body: JSON.stringify({ summary }) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message, timestamp: new Date().toISOString() }),
    };
  }
};


