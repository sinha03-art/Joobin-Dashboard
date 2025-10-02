/**
 * JOOBIN Renovation Hub Proxy v6.4.0
 * Added: Payment Schedule integration with KPIs, upcoming/overdue/recent, and 4-month forecast
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
  return '';
}

exports.handler = async (event) => {
  const { httpMethod, path } = event;

  // CORS headers
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
    // === GET: Dashboard data ===
    if (httpMethod === 'GET' && path.endsWith('/proxy')) {
      // Query all databases
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

      // === KPIs ===
      const budgetMYR = budgetPages.reduce((sum, p) => {
        const subtotal = extractText(getProp(p, 'Subtotal (Formula)', 'Subtotal'));
        return sum + (typeof subtotal === 'number' ? subtotal : 0);
      }, 0);

      const paidMYR = actualsPages
        .filter(p => extractText(getProp(p, 'Status', 'Status')) === 'Paid')
        .reduce((sum, p) => {
          const paid = extractText(getProp(p, 'Paid (MYR)', 'Paid'));
          return sum + (typeof paid === 'number' ? paid : 0);
        }, 0);

      const remainingMYR = budgetMYR - paidMYR;

      const deliverablesApproved = deliverablePages.filter(p => 
        extractText(getProp(p, 'Approval_Status', 'Approval Status')) === 'Approved'
      ).length;
      const deliverablesTotal = deliverablePages.length;

      // Payment Schedule KPIs
      const now = new Date();
      const totalOutstandingMYR = paymentPages
        .filter(p => ['Outstanding', 'Overdue'].includes(extractText(getProp(p, 'Status', 'Status'))))
        .reduce((sum, p) => {
          const amt = extractText(getProp(p, 'Amount (RM)', 'Amount'));
          return sum + (typeof amt === 'number' ? amt : 0);
        }, 0);

      const totalOverdueMYR = paymentPages
        .filter(p => {
          const status = extractText(getProp(p, 'Status', 'Status'));
          const dueDateProp = getProp(p, 'DueDate', 'Due Date');
          const dueDate = dueDateProp?.date?.start;
          return (status === 'Outstanding' || status === 'Overdue') && dueDate && new Date(dueDate) < now;
        })
        .reduce((sum, p) => {
          const amt = extractText(getProp(p, 'Amount (RM)', 'Amount'));
          return sum + (typeof amt === 'number' ? amt : 0);
        }, 0);

      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const recentPaymentsCount = paymentPages.filter(p => {
        const status = extractText(getProp(p, 'Status', 'Status'));
        const paidDateProp = getProp(p, 'PaidDate', 'Paid Date');
        const paidDate = paidDateProp?.date?.start;
        return status === 'Paid' && paidDate && new Date(paidDate) >= thirtyDaysAgo;
      }).length;

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
      for (let i = 0; i < 4; i++) {
        const monthDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const monthKey = monthDate.toISOString().slice(0, 7); // YYYY-MM
        const monthName = monthDate.toLocaleString('en-US', { month: 'short', year: 'numeric' });
        
        const monthPayments = paymentPages.filter(p => {
          const dueDateProp = getProp(p, 'DueDate', 'Due Date');
          const dueDate = dueDateProp?.date?.start;
          return dueDate && dueDate.startsWith(monthKey);
        });

        const totalAmount = monthPayments.reduce((sum, p) => {
          const amt = extractText(getProp(p, 'Amount (RM)', 'Amount'));
          return sum + (typeof amt === 'number' ? amt : 0);
        }, 0);

        forecastMonths.push({
          month: monthName,
          monthKey,
          totalAmount,
          paymentCount: monthPayments.length,
        });
      }

      // === Gates ===
      const gateMap = {};
      deliverablePages.forEach(p => {
        const gate = extractText(getProp(p, 'Gate', 'Gate')) || 'Unknown';
        const approvalStatus = extractText(getProp(p, 'Approval_Status', 'Approval Status'));
        if (!gateMap[gate]) gateMap[gate] = { total: 0, approved: 0 };
        gateMap[gate].total += 1;
        if (approvalStatus === 'Approved') gateMap[gate].approved += 1;
      });

      const gates = Object.keys(gateMap).map(gate => ({
        gate,
        total: gateMap[gate].total,
        approved: gateMap[gate].approved,
        gateApprovalRate: gateMap[gate].total > 0 ? gateMap[gate].approved / gateMap[gate].total : 0,
      }));

      // === Top Vendors ===
      const vendorSpendMap = {};
      actualsPages
        .filter(p => extractText(getProp(p, 'Status', 'Status')) === 'Paid')
        .forEach(p => {
          const vendor = extractText(getProp(p, 'Vendor', 'Vendor')) || 'Unknown';
          const paid = extractText(getProp(p, 'Paid (MYR)', 'Paid'));
          const amount = typeof paid === 'number' ? paid : 0;
          if (!vendorSpendMap[vendor]) vendorSpendMap[vendor] = 0;
          vendorSpendMap[vendor] += amount;
        });

      const topVendors = Object.keys(vendorSpendMap)
        .map(vendor => {
          const vendorPage = vendorPages.find(v => 
            extractText(getProp(v, 'Company_Name', 'Company Name')) === vendor
          );
          const trade = vendorPage ? extractText(getProp(vendorPage, 'Trade_Specialization', 'Trade Specialization')) : '—';
          
          return {
            name: vendor,
            trade,
            paid: vendorSpendMap[vendor],
          };
        })
        .sort((a, b) => b.paid - a.paid)
        .slice(0, 5);

      // === Milestones ===
      const milestones = milestonePages.map(p => ({
        title: extractText(getProp(p, 'MilestoneTitle', 'Milestone Title')) || 'Untitled',
        phase: extractText(getProp(p, 'Phase', 'Phase')),
        status: extractText(getProp(p, 'Risk_Status', 'Risk Status')),
        risk: extractText(getProp(p, 'Risk_Status', 'Risk Status')),
        url: p.url,
      }));

      // === Payments (legacy - for overdue list) ===
      const payments = actualsPages.map(p => ({
        recipient: extractText(getProp(p, 'Vendor', 'Vendor')),
        vendor: extractText(getProp(p, 'Vendor', 'Vendor')),
        amount: extractText(getProp(p, 'Paid (MYR)', 'Paid')) || 0,
        status: extractText(getProp(p, 'Status', 'Status')),
        dueDate: extractText(getProp(p, 'Paid Date', 'PaidDate')),
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
          recentPaymentsCount,
          paidVsBudget: budgetMYR > 0 ? paidMYR / budgetMYR : 0,
          deliverablesProgress: deliverablesTotal > 0 ? deliverablesApproved / deliverablesTotal : 0,
          milestonesAtRisk: milestones.filter(m => m.status === 'At Risk').length,
        },
        gates,
        topVendors,
        milestones,
        payments,
        paymentsSchedule: {
          upcoming: upcomingPayments,
          overdue: overduePayments,
          recentPaid: recentPaidPayments,
          forecast: forecastMonths,
        },
        timestamp: new Date().toISOString(),
      };

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(responseData),
      };
    }

    // === POST: AI Summary ===
    if (httpMethod === 'POST' && path.endsWith('/proxy')) {
      const body = JSON.parse(event.body || '{}');
      const { kpis, gates, milestones, payments } = body;

      const prompt = `You are a project assistant. Summarize this renovation project data in 2-3 concise sentences:
- Budget: ${kpis?.budgetMYR || 0} MYR, Paid: ${kpis?.paidMYR || 0} MYR
- Deliverables: ${kpis?.deliverablesApproved || 0}/${kpis?.deliverablesTotal || 0} approved
- Gates: ${gates?.length || 0} total
- Milestones at risk: ${kpis?.milestonesAtRisk || 0}
- Overdue payments: ${payments?.filter(p => p.status === 'Overdue').length || 0}

Focus on key risks and progress.`;

      const summary = await callGemini(prompt);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ summary }),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' }),
    };

  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message, timestamp: new Date().toISOString() }),
    };
  }
};
