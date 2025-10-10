/**
 * JOOBIN Renovation Hub Proxy v12.1.0
 * - FEAT: Implemented payment forecast logic to populate the monthly forecast chart.
 * - FIX: Correctly resolved vendor names by querying the Vendor_Registry relation.
 * - This version is based on the v12.0.1 codebase.
 */

// --- Environment Variables & Constants (No Change) ---
const { GEMINI_API_KEY, NOTION_API_KEY, NOTION_BUDGET_DB_ID, NOTION_ACTUALS_DB_ID, MILESTONES_DB_ID, DELIVERABLES_DB_ID, VENDOR_REGISTRY_DB_ID, NOTION_WORK_PACKAGES_DB_ID, PAYMENTS_DB_ID, UPDATE_PASSWORD, } = process.env;
const NOTION_VERSION = '2022-06-28';
const GEMINI_MODEL = 'gemini-1.5-flash-preview-0514';
const CONSTRUCTION_START_DATE = '2025-11-22';
const REQUIRED_BY_GATE = { /* ... No Change ... */ };

// --- API & Utility Helpers (No Change) ---
const notionHeaders = () => ({ 'Authorization': `Bearer ${NOTION_API_KEY}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' });
const norm = (s) => String(s || '').trim().toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function queryNotionDB(dbId, filter = {}) { /* ... No Change ... */ }
async function updateNotionPage(pageId, properties) { /* ... No Change ... */ }
async function callGemini(prompt) { /* ... No Change ... */ }
function getProp(page, name, fallback) { /* ... No Change ... */ }
function extractText(prop) { /* ... No Change ... */ }
function mapConstructionStatus(reviewStatus) { /* ... No Change ... */ }

// --- Main Handler ---
export const handler = async (event) => {
  const { httpMethod, path } = event;
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' };
  if (httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try {
    if (httpMethod === 'GET' && path.endsWith('/proxy')) {
      const [budgetData, actualsData, milestonesData, deliverablesData, vendorData, paymentsData, workPackagesData] = await Promise.all([ /* ... No Change ... */ ]);

      const now = new Date();
      
      // --- Data Processing (No Change until Payment Schedule) ---
      const budgetSubtotal = (budgetData.results || []).filter(p => extractText(getProp(p, 'inScope', 'In Scope'))).reduce((sum, p) => (sum + (extractText(getProp(p, 'supply_myr', 'Supply (MYR)')) || 0) + (extractText(getProp(p, 'install_myr', 'Install (MYR)')) || 0)), 0);
      const budgetMYR = (budgetSubtotal + 27900) * (1 - 0.05) * (1 + 0.10);
      
      const processedDeliverables = (deliverablesData.results || []).map(p => { /* ... No Change ... */ });
      const existingDeliverableKeys = new Set(processedDeliverables.map(d => norm(`${d.gate}|${d.deliverableType}`)));
      const allDeliverablesIncludingMissing = [...processedDeliverables];
      Object.entries(REQUIRED_BY_GATE).forEach(([gateName, requiredDocs]) => { /* ... No Change ... */ });
      
      const gates = Object.entries(REQUIRED_BY_GATE).map(([gateName, requiredDocs]) => { /* ... No Change ... */ }).filter(g => g.total > 0).sort((a, b) => a.gate.localeCompare(b.gate));
      
      const paymentPages = paymentsData.results || [];
      const overduePayments = paymentPages.filter(p => { const d = extractText(getProp(p, 'DueDate')); return (norm(extractText(getProp(p, 'Status'))) === 'outstanding' || norm(extractText(getProp(p, 'Status'))) === 'overdue') && d && new Date(d) < now; }).map(p => ({ id: p.id, paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled', vendor: extractText(getProp(p, 'Vendor')), amount: extractText(getProp(p, 'Amount (RM)')) || 0, dueDate: extractText(getProp(p, 'DueDate')), url: p.url })).sort((a, b) => (a.dueDate || '0') > (b.dueDate || '0') ? 1 : -1);
      const upcomingPayments = paymentPages.filter(p => { const d = extractText(getProp(p, 'DueDate')); return norm(extractText(getProp(p, 'Status'))) === 'outstanding' && d && new Date(d) >= now; }).map(p => ({ id: p.id, paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled', vendor: extractText(getProp(p, 'Vendor')), amount: extractText(getProp(p, 'Amount (RM)')) || 0, dueDate: extractText(getProp(p, 'DueDate')), url: p.url })).sort((a, b) => (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : -1).slice(0, 10);
      const recentPaidPayments = paymentPages.filter(p => norm(extractText(getProp(p, 'Status'))) === 'paid').map(p => ({ id: p.id, paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled', vendor: extractText(getProp(p, 'Vendor')), amount: extractText(getProp(p, 'Amount (RM)')) || 0, paidDate: extractText(getProp(p, 'PaidDate')), url: p.url })).sort((a, b) => (b.paidDate || '0') > (a.paidDate || '0') ? 1 : -1).slice(0, 10);
      
      // --- FIX START: Generate Payment Forecast Data ---
      const forecastData = upcomingPayments.reduce((acc, payment) => {
          if (payment.dueDate) {
              const date = new Date(payment.dueDate);
              const month = date.toLocaleString('default', { month: 'short', year: '2-digit' });
              if (!acc[month]) acc[month] = 0;
              acc[month] += payment.amount;
          }
          return acc;
      }, {});

      const forecast = Object.entries(forecastData)
          .map(([month, totalAmount]) => ({ month, totalAmount }))
          .sort((a, b) => new Date(`1 ${a.month}`) - new Date(`1 ${b.month}`));
      // --- FIX END ---
      
      const vendorMap = (vendorData.results || []).reduce((acc, p) => { /* ... No Change ... */ });
      const paidMYRByVendor = (actualsData.results || []).filter(p => norm(extractText(getProp(p, 'Status'))) === 'paid').reduce((acc, p) => { /* ... No Change ... */ });
      const topVendors = Object.entries(paidMYRByVendor).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, paid]) => ({ name, paid, trade: '—' }));
      const paidMYR = Object.values(paidMYRByVendor).reduce((sum, amount) => sum + amount, 0);

      const mbsaPermit = allDeliverablesIncludingMissing.find(d => norm(d.deliverableType) === 'renovation permit');
      const contractorAwarded = allDeliverablesIncludingMissing.find(d => norm(d.deliverableType) === 'contractor awarded');
      const alerts = { /* ... No Change ... */ };
      
      const responseData = {
        kpis: { budgetMYR, paidMYR, remainingMYR: budgetMYR - paidMYR, /* ... more KPIs, no change ... */ },
        gates,
        topVendors,
        deliverables: allDeliverablesIncludingMissing,
        // Replace the placeholder with our new forecast data
        paymentsSchedule: { upcoming: upcomingPayments, overdue: overduePayments, recentPaid: recentPaidPayments, forecast: forecast },
        alerts,
        timestamp: new Date().toISOString()
      };
      return { statusCode: 200, headers, body: JSON.stringify(responseData) };
    }

    // --- POST Request: Handle Updates (No Change) ---
    if (httpMethod === 'POST' && path.endsWith('/proxy')) {
      // ... All POST logic remains the same
    }
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
  } catch (error) {
    console.error('Handler error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message, timestamp: new Date().toISOString() }) };
  }
};