/**
* JOOBIN Renovation Hub Proxy v12.0.3 - CORRECTED
* ✅ FIX 1: Correct Activity Log database ID
* ✅ FIX 2: Correct sort property name (Event_Timestamp)
* ✅ FIX 3: Correct property extraction names in mapping
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
  ACTIVITY_LOG_DB_ID = '4ae30ad4a6734b2ba9d7b38cab66fc12', // ✅ FIX 1: Correct database ID
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
function notionHeaders() {
  return ({
    'Authorization': `Bearer ${NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  });
}

const norm = (s) => {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[—–−]/g, '-')
    .replace(/\s+/g, ' ');
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function queryNotionDB(dbId, filter = {}) {
  if (!dbId) return { results: [] };
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify(filter)
    });
    if (!res.ok) throw new Error(`Notion API query error for DB ${dbId}: ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (error) {
    console.error('queryNotionDB error:', error);
    throw error;
  }
}

async function updateNotionPage(pageId, properties) {
  if (!pageId) throw new Error("A page ID is required to update.");
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: notionHeaders(),
      body: JSON.stringify({ properties })
    });
    if (!res.ok) throw new Error(`Notion API PATCH error: ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (error) {
    console.error('updateNotionPage error:', error);
    throw error;
  }
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
      if (res.status === 503) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw new Error(`Gemini API error: ${res.status}: ${await res.text()}`);
    } catch (error) {
      if (i === 2) throw error;
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
  const propType = prop.type;
  if (propType === 'title') return prop.title?.[0]?.plain_text || '';
  if (propType === 'rich_text') return prop.rich_text?.[0]?.plain_text || '';
  if (propType === 'select') return prop.select?.name || '';
  if (propType === 'status') return prop.status?.name || '';
  if (propType === 'number') return prop.number;
  if (propType === 'date') return prop.date?.start || null;
  if (propType === 'formula') {
    if (prop.formula.type === 'string') return prop.formula.string;
    if (prop.formula.type === 'number') return prop.formula.number;
    return '';
  }
  if (propType === 'checkbox') return prop.checkbox;
  if (propType === 'relation') return prop.relation?.[0]?.id || null;
  return '';
}

function mapConstructionStatus(reviewStatus) {
  const normalized = norm(reviewStatus);
  if (normalized === 'approved') return 'Approved';
  if (normalized.includes('pending') || normalized.includes('comments') || normalized.includes('resubmission')) return 'Submitted';
  return 'Missing';
}

// --- Main Handler ---
export const handler = async (event) => {
  const { httpMethod, path } = event;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try {
    if (httpMethod === 'GET' && path.endsWith('/proxy')) {
      const [
        budgetData,
        actualsData,
        milestonesData,
        deliverablesData,
        vendorData,
        paymentsData,
        workPackagesData,
        activityLogData
      ] = await Promise.all([
        queryNotionDB(NOTION_BUDGET_DB_ID),
        queryNotionDB(NOTION_ACTUALS_DB_ID),
        queryNotionDB(MILESTONES_DB_ID),
        queryNotionDB(DELIVERABLES_DB_ID),
        queryNotionDB(VENDOR_REGISTRY_DB_ID),
        queryNotionDB(PAYMENTS_DB_ID),
        queryNotionDB(NOTION_WORK_PACKAGES_DB_ID, {
          sorts: [{ property: 'Start Date', direction: 'ascending' }]
        }),
        // ✅ FIX 2: Correct sort property name
        queryNotionDB(ACTIVITY_LOG_DB_ID, {
          sorts: [{ property: 'Event_Timestamp', direction: 'descending' }],
          page_size: 20
        }),
      ]);

      const now = new Date();

      // Budget calculation
      const budgetSubtotal = (budgetData.results || [])
        .filter(p => extractText(getProp(p, 'inScope', 'In Scope')))
        .reduce((sum, p) => {
          const supply = extractText(getProp(p, 'supply_myr', 'Supply (MYR)')) || 0;
          const install = extractText(getProp(p, 'install_myr', 'Install (MYR)')) || 0;
          return sum + supply + install;
        }, 0);

      const budgetMYR = (budgetSubtotal + 27900) * (1 - 0.05) * (1 + 0.10);

      // Process deliverables from Notion
      const processedDeliverables = (deliverablesData.results || []).map(p => {
        const category = extractText(getProp(p, 'Category'));
        const isConstruction = category === 'Construction Certificate';
        const deliverableType = extractText(getProp(p, 'Select Deliverable:'));
        const gateArray = getProp(p, 'Gate')?.multi_select || [];
        const gate = gateArray.length > 0 ? gateArray[0].name : extractText(getProp(p, 'Gate (Auto)'));

        const isCritical = REQUIRED_BY_GATE[gate]?.some(reqType =>
          norm(deliverableType) === norm(reqType)
        ) || false;

        let status;
        if (isConstruction) {
          const reviewStatus = extractText(getProp(p, 'Review Status'));
          status = mapConstructionStatus(reviewStatus);
        } else {
          status = extractText(getProp(p, 'Status'));
        }

        return {
          id: p.id,
          title: deliverableType,
          deliverableType: deliverableType,
          gate: gate,
          status: status || 'Missing',
          category: category,
          isCritical: isCritical,
          assignees: (getProp(p, 'Owner')?.people || []).map(person => person.name || ''),
          url: p.url,
          dueDate: extractText(getProp(p, 'Target Due')),
          priority: extractText(getProp(p, 'Priority')),
        };
      });

      // Add missing required deliverables as placeholders
      const existingKeys = new Set(
        processedDeliverables.map(d => norm(`${d.gate}|${d.deliverableType}`))
      );

      const allDeliverablesIncludingMissing = [...processedDeliverables];

      Object.entries(REQUIRED_BY_GATE).forEach(([gateName, requiredDocs]) => {
        requiredDocs.forEach(requiredTitle => {
          const key = norm(`${gateName}|${requiredTitle}`);
          if (!existingKeys.has(key)) {
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

      // Calculate gates
      const gates = Object.entries(REQUIRED_BY_GATE)
        .map(([gateName, requiredDocs]) => {
          const allGateDeliverables = allDeliverablesIncludingMissing.filter(d => d.gate === gateName);
          const approvedCount = allGateDeliverables.filter(d => norm(d.status) === 'approved').length;
          const criticalApproved = allGateDeliverables.filter(d =>
            requiredDocs.some(reqType => norm(d.deliverableType) === norm(reqType)) &&
            norm(d.status) === 'approved'
          ).length;

          return {
            gate: gateName,
            total: allGateDeliverables.length,
            approved: approvedCount,
            criticalTotal: requiredDocs.length,
            criticalApproved: criticalApproved,
            gateApprovalRate: allGateDeliverables.length > 0 ? approvedCount / allGateDeliverables.length : 0,
            criticalApprovalRate: requiredDocs.length > 0 ? criticalApproved / requiredDocs.length : 0
          };
        })
        .filter(g => g.total > 0)
        .sort((a, b) => a.gate.localeCompare(b.gate));

      const paymentPages = paymentsData.results || [];

      const overduePayments = paymentPages.filter(p => {
        const d = extractText(getProp(p, 'DueDate'));
        return (norm(extractText(getProp(p, 'Status'))) === 'outstanding' || norm(extractText(getProp(p, 'Status'))) === 'overdue') && d && new Date(d) < now;
      }).map(p => ({
        id: p.id,
        paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled',
        vendor: extractText(getProp(p, 'Vendor')),
        amount: extractText(getProp(p, 'Amount (RM)')) || 0,
        dueDate: extractText(getProp(p, 'DueDate')),
        url: p.url
      })).sort((a, b) => (a.dueDate || '0') > (b.dueDate || '0') ? 1 : -1);

      const upcomingPayments = paymentPages.filter(p => {
        const d = extractText(getProp(p, 'DueDate'));
        return norm(extractText(getProp(p, 'Status'))) === 'outstanding' && (!d || new Date(d) >= now);
      }).map(p => ({
        id: p.id,
        paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled',
        vendor: extractText(getProp(p, 'Vendor')),
        amount: extractText(getProp(p, 'Amount (RM)')) || 0,
        dueDate: extractText(getProp(p, 'DueDate')),
        url: p.url
      })).sort((a, b) => (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : -1).slice(0, 10);

      const recentPaidPayments = paymentPages.filter(p =>
        norm(extractText(getProp(p, 'Status'))) === 'paid'
      ).map(p => ({
        id: p.id,
        paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled',
        vendor: extractText(getProp(p, 'Vendor')),
        amount: extractText(getProp(p, 'Amount (RM)')) || 0,
        paidDate: extractText(getProp(p, 'PaidDate')),
        url: p.url
      })).sort((a, b) => (b.paidDate || '0') > (a.paidDate || '0') ? 1 : -1).slice(0, 10);

      // Top Vendors by Spend
      const vendorMap = (vendorData.results || []).reduce((acc, p) => {
        acc[p.id] = extractText(getProp(p, 'Company_Name', 'Name')) || 'Unknown';
        return acc;
      }, {});

      const paidMYRByVendor = (actualsData.results || [])
        .filter(p => norm(extractText(getProp(p, 'Status'))) === 'paid')
        .reduce((acc, p) => {
          const vendorId = extractText(getProp(p, 'Vendor_Registry', 'Vendor'));
          const vendorName = vendorMap[vendorId] || 'Unknown';
          acc[vendorName] = (acc[vendorName] || 0) + (extractText(getProp(p, 'Paid (MYR)')) || 0);
          return acc;
        }, {});

      const topVendors = Object.entries(paidMYRByVendor)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, paid]) => ({ name, paid, trade: '—' }));

      const paidMYR = Object.values(paidMYRByVendor).reduce((sum, amount) => sum + amount, 0);

      const forecastMonths = [];
      const outstandingAndOverdue = paymentPages.filter(p =>
        ['Outstanding', 'Overdue'].includes(extractText(getProp(p, 'Status')))
      );

      const firstMonthDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const cumulativeUnscheduled = outstandingAndOverdue.filter(p =>
        !extractText(getProp(p, 'DueDate')) || new Date(extractText(getProp(p, 'DueDate'))) < firstMonthDate
      ).reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)')) || 0), 0);

      for (let i = 0; i < 4; i++) {
        const monthStart = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
        const monthName = monthStart.toLocaleString('en-US', { month: 'short' });

        let monthTotal = outstandingAndOverdue.filter(p => {
          const dueDate = extractText(getProp(p, 'DueDate'));
          if (!dueDate) return false;
          const paymentDate = new Date(dueDate);
          return paymentDate >= monthStart && paymentDate < monthEnd;
        }).reduce((sum, p) => sum + (extractText(getProp(p, 'Amount (RM)')) || 0), 0);

        if (i === 0) monthTotal += cumulativeUnscheduled;
        forecastMonths.push({ month: monthName, totalAmount: monthTotal });
      }

      const mbsaPermit = allDeliverablesIncludingMissing.find(d =>
        norm(d.deliverableType) === 'renovation permit'
      );

      const contractorAwarded = allDeliverablesIncludingMissing.find(d =>
        norm(d.deliverableType) === 'contractor awarded'
      );

      const alerts = {
        daysToConstructionStart: Math.ceil((new Date(CONSTRUCTION_START_DATE) - now) / (1000 * 60 * 60 *24)),
        g3NotApproved: (gates.find(g => g.gate === 'G3 Design Development')?.gateApprovalRate || 0) < 1,
        paymentsOverdue: overduePayments,
        mbsaPermitApproved: mbsaPermit && norm(mbsaPermit.status) === 'approved',
        contractorAwarded: contractorAwarded && norm(contractorAwarded.status) === 'approved',
      };

      // Budget breakdown by trade for doughnut chart
      const budgetByTrade = (budgetData.results || [])
        .filter(p => extractText(getProp(p, 'inScope', 'In Scope')))
        .reduce((acc, p) => {
          const trade = extractText(getProp(p, 'Trade')) || 'Other';
          const supply = extractText(getProp(p, 'supply_myr', 'Supply (MYR)')) || 0;
          const install = extractText(getProp(p, 'install_myr', 'Install (MYR)')) || 0;
          const total = supply + install;
          acc[trade] = (acc[trade] || 0) + total;
          return acc;
        }, {});

      // ✅ FIX 3: Process recent activity with CORRECT property names
      const recentActivity = (activityLogData.results || []).slice(0, 10).map(p => ({
        eventType: extractText(getProp(p, 'Event_Type')),           // ✅ Correct
        deliverable: extractText(getProp(p, 'Activity_ID')),        // ✅ Correct
        details: extractText(getProp(p, 'Event_Description')),      // ✅ Correct
        timestamp: extractText(getProp(p, 'Event_Timestamp')),      // ✅ Correct
        source: extractText(getProp(p, 'Company_Name')),            // ✅ Correct
        url: p.url
      }));

      const responseData = {
        kpis: {
          budgetMYR,
          paidMYR,
          remainingMYR: budgetMYR - paidMYR,
          deliverablesApproved: allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length,
          deliverablesTotal: allDeliverablesIncludingMissing.length,
          totalOutstandingMYR: [...overduePayments, ...upcomingPayments].reduce((sum, p) => sum + p.amount, 0),
          totalOverdueMYR: overduePayments.reduce((sum, p) => sum + p.amount, 0),
          paidVsBudget: budgetMYR > 0 ? paidMYR / budgetMYR : 0,
          deliverablesProgress: allDeliverablesIncludingMissing.length > 0 ? allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length / allDeliverablesIncludingMissing.length : 0,
          milestonesAtRisk: (milestonesData.results || []).filter(m => extractText(getProp(m, 'Risk_Status')) === 'At Risk').length
        },
        gates,
        topVendors,
        budgetByTrade,
        deliverables: allDeliverablesIncludingMissing,
        paymentsSchedule: {
          upcoming: upcomingPayments,
          overdue: overduePayments,
          recentPaid: recentPaidPayments,
          forecast: forecastMonths
        },
        recentActivity,  // ✅ Now included with correct data
        alerts,
        timestamp: new Date().toISOString()
      };

      return { statusCode: 200, headers, body: JSON.stringify(responseData) };
    }

    // POST Request: Handle Updates
    if (httpMethod === 'POST' && path.endsWith('/proxy')) {
      const body = JSON.parse(event.body || '{}');

      if (body.action) {
        if (!UPDATE_PASSWORD || body.password !== UPDATE_PASSWORD) {
          return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ error: 'Unauthorized: Incorrect password.' })
          };
        }

        switch (body.action) {
          case 'mark_payment_paid':
            await updateNotionPage(body.pageId, {
              "Status": { "status": { "name": "Paid" } },
              "PaidDate": { "date": { "start": new Date().toISOString().split('T')[0] } }
            });
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ success: true, message: 'Payment marked as paid.' })
            };

          case 'mark_gate_approved':
            const allDeliverables = (await queryNotionDB(DELIVERABLES_DB_ID)).results;
            const requiredDocsForGate = REQUIRED_BY_GATE[body.gateName] || [];
            const deliverablesToUpdate = allDeliverables.filter(p => {
              const gate = extractText(getProp(p, 'Gate (Auto)'));
              const type = extractText(getProp(p, 'Select Deliverable:'));
              return gate === body.gateName && requiredDocsForGate.some(req => norm(req) === norm(type));
            });

            const updatePromises = deliverablesToUpdate.map(p => {
              const category = extractText(getProp(p, 'Category'));
              const isConstruction = category === 'Construction Certificate';
              let propertiesToUpdate;
              if (isConstruction) {
                propertiesToUpdate = { "Review Status": { "select": { "name": "Approved" } } };
              } else {
                propertiesToUpdate = { "Status": { "select": { "name": "Approved" } } };
              }
              return updateNotionPage(p.id, propertiesToUpdate);
            });

            await Promise.all(updatePromises);
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ success: true, message: `All deliverables for ${body.gateName} approved.` })
            };

          default:
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: 'Unknown action.' })
            };
        }
      } else {
        // AI Summary request
        const prompt = `Summarize this project data: Budget ${body.kpis?.budgetMYR || 0} MYR, Paid ${body.kpis?.paidMYR || 0} MYR. Deliverables ${body.kpis?.deliverablesApproved || 0}/${body.kpis?.deliverablesTotal || 0} approved. Milestones at risk: ${body.kpis?.milestonesAtRisk || 0}. Overdue payments: ${body.kpis?.totalOverdueMYR > 0 ? 'Yes' : 'No'}. Focus on key risks and progress.`;
        const summary = await callGemini(prompt);
        return { statusCode: 200, headers, body: JSON.stringify({ summary }) };
      }
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' })
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
};