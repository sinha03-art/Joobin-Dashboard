/**
 * JOOBIN Renovation Hub Proxy v7.2.0
 * Patched: Implemented the deliverableType fix as per user specification.
 * - Real deliverables now have a 'deliverableType' property extracted from Notion.
 * - Missing placeholder deliverables are also assigned a 'deliverableType'.
 * - Gate progress calculation now correctly compares 'deliverableType' for accurate matching.
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
      "MOODBOARD",
      "PROPOSED RENOVATION FLOOR PLAN"
    ],
    "G2 Schematic": [
      // Currently no specific deliverables defined
    ],
    "G3 Design Development": [
      "DOORS AND WINDOWS",
      "Construction Drawings",
      "MEP Drawings",
      "Interior Design Plans",
      "Schedules",
      "Finishes"
    ],
    "G4 Authority Submission": [
      "RENOVATION PERMIT",
      "Structural Drawings",
      "BQ Complete",
      "Quotation Package Ready"
    ],
    "G5 Construction Documentation": [
      "Contractor Awarded",
      "Tender Package Issued",
      "Site Mobilization Complete",
      "Demolition Complete Certificate",
      "Structural Works Complete",
      "Carpentry Complete",
      "Finishes Complete"
    ],
    "G6 Design Close-out": [
      "Final Inspection Complete",
      "Handover Certificate"
    ]
};

const notionHeaders = () => ({
  'Authorization': `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

// Helper to normalize strings for reliable comparison
const norm = (s) => String(s || '').trim().toLowerCase();

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
      throw new Error(`Notion API error: ${res.status}: ${errText}`);
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
  if (!res.ok) {
      const errText = await res.text();
      console.error(`Gemini API error: ${res.status}`, errText);
      throw new Error(`Gemini API error: ${res.status}: ${errText}`);
  }
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
  if (prop.type === 'formula') {
      if (prop.formula?.type === 'number') return prop.formula.number;
      if (prop.formula?.type === 'string') return prop.formula.string;
  }
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
      
      const shippingMYR = 27900;
      const discountPct = 0.05;
      const contingencyPct = 0.10;

      const budgetSubtotal = budgetPages
        .filter(p => getProp(p, 'inScope', 'In Scope')?.checkbox === true)
        .reduce((sum, p) => {
          const supply = extractText(getProp(p, 'supply_myr', 'Supply (MYR)')) || 0;
          const install = extractText(getProp(p, 'install_myr', 'Install (MYR)')) || 0;
          return sum + supply + install;
        }, 0);

      const subtotalWithShipping = budgetSubtotal + shippingMYR;
      const afterDiscount = subtotalWithShipping * (1 - discountPct);
      const budgetMYR = afterDiscount * (1 + contingencyPct);
      
      // === DELIVERABLES FIX AS PER BUG REPORT ===
      const processedDeliverables = deliverablePages.map(p => ({
        title: extractText(getProp(p, 'Deliverable Name')),
        deliverableType: extractText(getProp(p, 'Deliverable Name')), // Same as title for this database
        gate: extractText(getProp(p, 'Gate')),
        status: extractText(getProp(p, 'Status')), // Correct property name
        assignees: ...,
        url: p.url
      }));
      
      const existingDeliverableKeys = new Set(processedDeliverables.map(d => norm(`${d.gate}|${d.deliverableType}`)));
      const allDeliverablesIncludingMissing = [...processedDeliverables];

      Object.entries(REQUIRED_BY_GATE).forEach(([gateName, requiredDocs]) => {
          requiredDocs.forEach(requiredTitle => {
              if (!existingDeliverableKeys.has(norm(`${gateName}|${requiredTitle}`))) {
                  allDeliverablesIncludingMissing.push({
                      title: requiredTitle,
                      deliverableType: requiredTitle, // <<< FIX 2
                      gate: gateName,
                      status: 'Missing',
                      assignees: [],
                      url: '#'
                  });
              }
          });
      });

      const deliverablesTotal = allDeliverablesIncludingMissing.length;
      const deliverablesApproved = allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length;

      const gates = Object.entries(REQUIRED_BY_GATE).map(([gateName, requiredDocs]) => {
          const approvedCount = allDeliverablesIncludingMissing.filter(d => 
              d.gate === gateName && 
              requiredDocs.some(reqType => norm(d.deliverableType) === norm(reqType)) && // <<< FIX 3
              norm(d.status) === 'approved'
          ).length;
          
          const gateDeliverablesCount = requiredDocs.length;

          return {
              gate: gateName,
              total: gateDeliverablesCount,
              approved: approvedCount,
              gateApprovalRate: gateDeliverablesCount > 0 ? approvedCount / gateDeliverablesCount : 0,
          };
      }).sort((a, b) => a.gate.localeCompare(b.gate));
      // === END DELIVERABLES FIX ===

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

      const upcomingPayments = paymentPages
        .filter(p => extractText(getProp(p, 'Status', 'Status')) === 'Outstanding')
        .map(p => ({
            paymentFor: extractText(getProp(p, 'Payment For', 'PaymentFor')) || 'Untitled',
            vendor: extractText(getProp(p, 'Vendor', 'Vendor')),
            amount: extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0,
            status: extractText(getProp(p, 'Status', 'Status')),
            dueDate: extractText(getProp(p, 'DueDate', 'Due Date')) || null,
            url: p.url,
          }))
        .sort((a, b) => (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : -1)
        .slice(0, 10);

      const overduePayments = paymentPages
        .filter(p => {
          const status = extractText(getProp(p, 'Status', 'Status'));
          const dueDate = extractText(getProp(p, 'DueDate', 'Due Date'));
          return (status === 'Outstanding' || status === 'Overdue') && dueDate && new Date(dueDate) < now;
        })
        .map(p => ({
            paymentFor: extractText(getProp(p, 'Payment For', 'PaymentFor')) || 'Untitled',
            vendor: extractText(getProp(p, 'Vendor', 'Vendor')),
            amount: extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0,
            status: extractText(getProp(p, 'Status', 'Status')),
            dueDate: extractText(getProp(p, 'DueDate', 'Due Date')) || null,
            url: p.url,
          }))
        .sort((a, b) => (a.dueDate || '0') > (b.dueDate || '0') ? 1 : -1);

      const recentPaidPayments = paymentPages
        .filter(p => extractText(getProp(p, 'Status', 'Status')) === 'Paid')
        .map(p => ({
            paymentFor: extractText(getProp(p, 'Payment For', 'PaymentFor')) || 'Untitled',
            vendor: extractText(getProp(p, 'Vendor', 'Vendor')),
            amount: extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0,
            status: extractText(getProp(p, 'Status', 'Status')),
            paidDate: extractText(getProp(p, 'PaidDate', 'Paid Date')) || null,
            url: p.url,
          }))
        .sort((a, b) => (b.paidDate || '0') > (a.paidDate || '0') ? 1 : -1)
        .slice(0, 10);

      const forecastMonths = [];
      const outstandingAndOverduePayments = paymentPages.filter(p =>
        ['Outstanding', 'Overdue'].includes(extractText(getProp(p, 'Status', 'Status')))
      );
      
      const firstMonthDate = new Date(now.getFullYear(), now.getMonth(), 1);

      const cumulativeUnscheduledOverdue = outstandingAndOverduePayments
        .filter(p => {
          const dueDate = extractText(getProp(p, 'DueDate', 'Due Date'));
          return !dueDate || new Date(dueDate) < firstMonthDate;
        })
        .reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0), 0);

      for (let i = 0; i < 4; i++) {
        const monthDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
        const monthName = monthDate.toLocaleString('en-US', { month: 'short' });
        
        let totalAmountForMonth = outstandingAndOverduePayments
          .filter(p => {
            const dueDate = extractText(getProp(p, 'DueDate', 'Due Date'));
            if (!dueDate) return false;
            const paymentDate = new Date(dueDate);
            return paymentDate >= monthDate && paymentDate < nextMonthDate;
          })
          .reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)', 'Amount')) || 0), 0);
        
        if (i === 0) {
            totalAmountForMonth += cumulativeUnscheduledOverdue;
        }
        
        forecastMonths.push({ month: monthName, totalAmount: totalAmountForMonth });
      }

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
        deliverables: allDeliverablesIncludingMissing,
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


LS
