const { Client } = require('@notionhq/client');
const nodemailer = require('nodemailer');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DELIVERABLES_DB_ID = '680a1e81192a462587860e795035089c';

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

async function sendNotification(deliverable, submittedBy, pageUrl) {
  const emailBody = `
<h2>📋 New Deliverable Submitted</h2>

<p><strong>Deliverable:</strong> ${deliverable}</p>
<p><strong>Submitted by:</strong> ${submittedBy}</p>
<p><strong>Status:</strong> Submitted</p>

<p><a href="${pageUrl}" style="background: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">View in Notion →</a></p>

<hr>
<p style="color: #999; font-size: 12px;">JOOBIN RENOVATION COMMAND CENTER</p>
  `;

  const recipients = [
    'solomonchong2011@gmail.com',
    'sinha03@gmail.com'
  ];

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: recipients.join(', '),
    subject: `📋 New Deliverable: ${deliverable}`,
    html: emailBody
  });
}

exports.handler = async (event) => {
  // Security check
  const authHeader = event.headers['authorization'];
  if (!process.env.WEBHOOK_SECRET || authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { pageId } = JSON.parse(event.body);
  
  try {
    const newPage = await notion.pages.retrieve({ page_id: pageId });
    const deliverable = newPage.properties['Deliverable']?.multi_select?.[0]?.name;
    
    if (!deliverable) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No deliverable selected' }) };
    }
    
    // Search for existing page
    const searchResults = await notion.databases.query({
      database_id: DELIVERABLES_DB_ID,
      filter: { property: 'Select Deliverable:', title: { equals: deliverable } }
    });
    
    const existingPage = searchResults.results.find(page => page.id !== pageId);
    
    if (!existingPage) {
      // New submission - update and notify
      await notion.pages.update({
        page_id: pageId,
        properties: {
          'Select Deliverable:': { title: [{ text: { content: deliverable } }] },
          'Status': { select: { name: 'Submitted' } }
        }
      });
      
      // Send email notification
      const submittedBy = newPage.properties['Submitted By']?.multi_select?.[0]?.name || 'Unknown';
      const pageUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;
      await sendNotification(deliverable, submittedBy, pageUrl);
      
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, action: 'created', deliverable, notified: true })
      };
    }
    
    // Duplicate found - merge
    const updateProperties = {};
    
    const newFiles = newPage.properties['File']?.files || [];
    const existingFiles = existingPage.properties['File']?.files || [];
    if (newFiles.length > 0) {
      updateProperties['File'] = { files: [...existingFiles, ...newFiles] };
    }
    
    const newDocs = newPage.properties['Attach your document']?.files || [];
    const existingDocs = existingPage.properties['Attach your document']?.files || [];
    if (newDocs.length > 0) {
      updateProperties['Attach your document'] = { files: [...existingDocs, ...newDocs] };
    }
    
    const newComments = newPage.properties['Comments']?.rich_text?.[0]?.plain_text || '';
    const existingComments = existingPage.properties['Comments']?.rich_text?.[0]?.plain_text || '';
    if (newComments) {
      const timestamp = new Date().toISOString().split('T')[0];
      const merged = existingComments 
        ? `${existingComments}\n\n[${timestamp}] ${newComments}`
        : newComments;
      updateProperties['Comments'] = { rich_text: [{ text: { content: merged.slice(0, 2000) } }] };
    }
    
    updateProperties['Status'] = { select: { name: 'Submitted' } };
    
    await notion.pages.update({
      page_id: existingPage.id,
      properties: updateProperties
    });
    
    await notion.blocks.delete({ block_id: pageId });
    
    // Send email notification
    const submittedBy = newPage.properties['Submitted By']?.multi_select?.[0]?.name || 'Unknown';
    const pageUrl = `https://notion.so/${existingPage.id.replace(/-/g, '')}`;
    await sendNotification(deliverable, submittedBy, pageUrl);
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        action: 'merged', 
        deliverable,
        existingPageId: existingPage.id,
        notified: true
      })
    };
    
  } catch (error) {
    console.error('Webhook error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};