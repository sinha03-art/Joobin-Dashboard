/**
 * JOOBIN Renovation Hub Proxy v13.0.1 (Corrected)
 * - FIX: Corrected vendor name property lookup to fix "Top Vendors by Spend".
 * - FIX: Reverted "Approve Gate" logic to be more robust, fetching and then filtering deliverables in code.
 * - This version is a complete implementation of the technical framework document.
 * - Includes stable API endpoints, critical path logic, and all data processing.
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
} = process.env;

// --- Constants ---
const NOTION_VERSION = '2022-06-28';
const GEMINI_MODEL = 'gemini-1.5-flash-latest';
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

// --- API & Utility Helpers ---
const notionHeaders = () => ({ 'Authorization': `Bearer ${NOTION_API_KEY}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' });
const norm = (s) => String(s || '').trim().toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function queryNotionDB(dbId, filter = {}) {
  if (!dbId) return { results: [] };
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  try {
    const res = await fetch(url, { method: 'POST', headers: notionHeaders(), body: JSON.stringify(filter) });
    if (!res.ok) throw new Error(`Notion API query error for DB ${dbId}: ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (error) { console.error('queryNotionDB error:', error); throw error; }
}

async function updateNotionPage(pageId, properties) {
    if (!pageId) throw new Error("A page ID is required to update.");
    const url = `https://api.notion.com/v1/pages/${pageId}`;
    try {
        const res = await fetch(url, { method: 'PATCH', headers: notionHeaders(), body: JSON.stringify({ properties }) });
        if (!res.ok) throw new Error(`Notion API PATCH error: ${res.status}: ${await res.text()}`);
        return await res.json();
    } catch (error) { console.error('updateNotionPage error:', error); throw error; }
}

async function callGemini(prompt) { 
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured.');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
        if (!res.ok) throw new Error(`Gemini API error: ${res.status}: ${await res.text()}`);
        return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (error) { console.error('callGemini error:', error); throw error; }
}

function getProp(page, name, fallback) { return page.properties?.[name] || page.properties?.[fallback];}
function extractText(prop) {
  if (!prop) return '';
  const propType = prop.type;
  if (propType === 'title' || propType === 'rich_text') return prop[propType]?.[0]?.plain_text || '';
  if (propType === 'select' || propType === 'status') return prop[propType]?.name || '';
  if (propType === 'number') return prop.number;
  if (propType === 'date') return prop.date?.start || null;
  if (propType === 'formula') return prop.formula[prop.formula.type];
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
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' };
  if (httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try {
    if (httpMethod === 'GET' && path.endsWith('/proxy')) {
      const [
        budgetData = { results: [] }, actualsData = { results: [] }, milestonesData = { results: [] },
        deliverablesData = { results: [] }, vendorData = { results: [] }, paymentsData = { results: [] },
        workPackagesData = { results: [] }
      ] = await Promise.all([
        queryNotionDB(NOTION_BUDGET_DB_ID), queryNotionDB(NOTION_ACTUALS_DB_ID),
        queryNotionDB(MILESTONES_DB_ID), queryNotionDB(DELIVERABLES_DB_ID),
        queryNotionDB(VENDOR_REGISTRY_DB_ID), queryNotionDB(PAYMENTS_DB_ID),
        queryNotionDB(NOTION_WORK_PACKAGES_DB_ID, { sorts: [{ property: 'Start Date', direction: 'ascending' }] }),
      ]);

      const now = new Date();
      
      const budgetSubtotal = (budgetData.results || []).filter(p => extractText(getProp(p, 'inScope'))).reduce((sum, p) => sum + (extractText(getProp(p, 'Supply (MYR)')) || 0) + (extractText(getProp(p, 'Install (MYR)')) || 0), 0);
      const budgetMYR = (budgetSubtotal + 27900) * (1 - 0.05) * (1 + 0.10);
      
      const processedDeliverables = (deliverablesData.results || []).map(p => {
          const category = extractText(getProp(p, 'Category'));
          const isConstruction = category === 'Construction Certificate';
          const status = isConstruction ? mapConstructionStatus(extractText(getProp(p, 'Review Status'))) : extractText(getProp(p, 'Status'));
          return {
            id: p.id, title: extractText(getProp(p, 'Select Deliverable:')), gate: extractText(getProp(p, 'Gate (Auto)')),
            status: status || 'Missing', assignees: (getProp(p, 'Owner')?.people || []).map(person => person.name || ''),
            url: p.url, dueDate: extractText(getProp(p, 'Target Due')), priority: extractText(getProp(p, 'Priority')),
          };
      });

      const existingDeliverableKeys = new Set(processedDeliverables.map(d => norm(`${d.gate}|${d.title}`)));
      const allDeliverablesIncludingMissing = [...processedDeliverables];
      Object.entries(REQUIRED_BY_GATE).forEach(([gateName, requiredDocs]) => {
        requiredDocs.forEach(requiredTitle => {
          if (!existingDeliverableKeys.has(norm(`${gateName}|${requiredTitle}`))) {
            allDeliverablesIncludingMissing.push({ id: null, title: requiredTitle, gate: gateName, status: 'Missing', assignees: [], url: '#' });
          }
        });
      });
      
      const gates = Object.entries(REQUIRED_BY_GATE).map(([gateName, requiredDocs]) => {
        const approvedCount = allDeliverablesIncludingMissing.filter(d => d.gate === gateName && norm(d.status) === 'approved' && requiredDocs.some(req => norm(req) === norm(d.title))).length;
        return { gate: gateName, total: requiredDocs.length, approved: approvedCount };
      }).filter(g => g.total > 0).sort((a, b) => a.gate.localeCompare(b.gate));
      
      const paymentPages = paymentsData.results || [];
      const overduePayments = paymentPages.filter(p => new Date(extractText(getProp(p, 'DueDate'))) < now && ['outstanding', 'overdue'].includes(norm(extractText(getProp(p, 'Status'))))).map(p => ({ id: p.id, paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled', vendor: extractText(getProp(p, 'Vendor')), amount: extractText(getProp(p, 'Amount (RM)')) || 0, dueDate: extractText(getProp(p, 'DueDate')), url: p.url })).sort((a, b) => (a.dueDate || '0').localeCompare(b.dueDate || '0'));
      const upcomingPayments = paymentPages.filter(p => new Date(extractText(getProp(p, 'DueDate'))) >= now && norm(extractText(getProp(p, 'Status'))) === 'outstanding').map(p => ({ id: p.id, paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled', vendor: extractText(getProp(p, 'Vendor')), amount: extractText(getProp(p, 'Amount (RM)')) || 0, dueDate: extractText(getProp(p, 'DueDate')), url: p.url })).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
      const recentPaidPayments = paymentPages.filter(p => norm(extractText(getProp(p, 'Status'))) === 'paid').map(p => ({ id: p.id, paymentFor: extractText(getProp(p, 'Payment For')) || 'Untitled', vendor: extractText(getProp(p, 'Vendor')), amount: extractText(getProp(p, 'Amount (RM)')) || 0, paidDate: extractText(getProp(p, 'PaidDate')), url: p.url })).sort((a, b) => (b.paidDate || '0').localeCompare(a.paidDate || '0')).slice(0, 10);
      
      const forecastData = {};
      for (let i = 0; i < 4; i++) {
        const date = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const monthKey = date.toLocaleString('default', { month: 'short', year: '2-digit' });
        forecastData[monthKey] = 0;
      }
      [...upcomingPayments, ...overduePayments].forEach(p => {
        if(p.dueDate) {
            const date = new Date(p.dueDate);
            const monthKey = date.toLocaleString('default', { month: 'short', year: '2-digit' });
            if (forecastData.hasOwnProperty(monthKey)) {
                forecastData[monthKey] += p.amount;
            }
        }
      });
      const forecast = Object.entries(forecastData).map(([month, totalAmount]) => ({ month, totalAmount }));
      
      // --- FIX #1: Corrected vendor name property lookup ---
      const vendorMap = (vendorData.results || []).reduce((acc, p) => { acc[p.id] = extractText(getProp(p, 'Company_Name', 'Name')) || 'Unknown'; return acc; }, {});
      
      const paidMYRByVendor = (actualsData.results || []).filter(p => norm(extractText(getProp(p, 'Status'))) === 'paid').reduce((acc, p) => {
          const vendorId = extractText(getProp(p, 'Vendor_Registry', 'Vendor'));
          const vendorName = vendorMap[vendorId] || 'Unknown';
          acc[vendorName] = (acc[vendorName] || 0) + (extractText(getProp(p, 'Paid (MYR)')) || 0);
          return acc;
      }, {});
      const topVendors = Object.entries(paidMYRByVendor).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, paid]) => ({ name, paid }));
      const paidMYR = Object.values(paidMYRByVendor).reduce((sum, amount) => sum + amount, 0);

      const mbsaPermitApproved = !!allDeliverablesIncludingMissing.find(d => norm(d.title) === 'renovation permit' && norm(d.status) === 'approved');
      const contractorAwarded = !!allDeliverablesIncludingMissing.find(d => norm(d.title) === 'contractor awarded' && norm(d.status) === 'approved');
      const blockers = [];
      if (overduePayments.length > 0) blockers.push('Overdue payments require action');
      if (!mbsaPermitApproved) blockers.push('MBSA Permit is not approved');
      if (!contractorAwarded) blockers.push('A main contractor has not been awarded');
      
      const daysToConstructionStart = Math.ceil((new Date(CONSTRUCTION_START_DATE) - now) / (1000 * 60 * 60 * 24));
      let riskLevel = 'red';
      if (blockers.length === 0 && daysToConstructionStart > 60) riskLevel = 'green';
      else if (blockers.length <= 1 && daysToConstructionStart > 30) riskLevel = 'yellow';
      
      const responseData = {
        kpis: { budgetMYR, paidMYR, remainingMYR: budgetMYR - paidMYR, deliverablesApproved: allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length, deliverablesTotal: allDeliverablesIncludingMissing.length, totalOutstandingMYR: [...overduePayments, ...upcomingPayments].reduce((sum, p) => sum + p.amount, 0), totalOverdueMYR: overduePayments.reduce((sum, p) => sum + p.amount, 0), paidVsBudget: budgetMYR > 0 ? paidMYR / budgetMYR : 0, deliverablesProgress: allDeliverablesIncludingMissing.length > 0 ? allDeliverablesIncludingMissing.filter(d => norm(d.status) === 'approved').length / allDeliverablesIncludingMissing.length : 0, milestonesAtRisk: (milestonesData.results || []).filter(m => norm(extractText(getProp(m, 'Risk_Status'))) === 'at risk').length },
        gates, topVendors, deliverables: allDeliverablesIncludingMissing,
        paymentsSchedule: { upcoming: upcomingPayments, overdue: overduePayments, recentPaid: recentPaidPayments, forecast },
        criticalPath: { daysToConstructionStart, riskLevel, blockers },
        timestamp: new Date().toISOString()
      };
      return { statusCode: 200, headers, body: JSON.stringify(responseData) };
    }

    if (httpMethod === 'POST' && path.endsWith('/proxy')) {
      const body = JSON.parse(event.body || '{}');
      if (body.action) {
        if (!UPDATE_PASSWORD || body.password !== UPDATE_PASSWORD) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized.' }) };
        switch (body.action) {
          case 'mark_payment_paid':
            await updateNotionPage(body.pageId, { "Status": { "status": { "name": "Paid" } }, "PaidDate": { "date": { "start": new Date().toISOString().split('T')[0] } } });
            return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
          
          // --- FIX #2: Reverted to more robust "Approve Gate" logic ---
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
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: `All deliverables for ${body.gateName} approved.` }) };
        }
      } 
      else { 
        const prompt = `Summarize this project data for an executive: Budget ${body.kpis?.budgetMYR || 0} MYR, Paid ${body.kpis?.paidMYR || 0} MYR. Deliverables ${body.kpis?.deliverablesApproved || 0}/${body.kpis?.deliverablesTotal || 0} approved. Key blockers: ${body.criticalPath?.blockers.join(', ') || 'None'}. Focus on key risks and overall progress in 2-3 concise sentences.`;
        const summary = await callGemini(prompt);
        return { statusCode: 200, headers, body: JSON.stringify({ summary }) };
       }
    }
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
  } catch (error) {
    console.error('Handler error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};