const { Client } = require('@notionhq/client');
const nodemailer = require('nodemailer');

const DELIVERABLES_DB_ID = '680a1e81192a462587860e795035089c';
const ACTIVITY_LOG_DB_ID = 'd754a17902804b77a16dc4fdd3e59695'; // Your new Activity Log DB

exports.handler = async (event) => {
  const authHeader = event.headers['authorization'];
  if (!process.env.WEBHOOK_SECRET || authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { pageId } = JSON.parse(event.body);
  
  try {
    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    
    // Get page details
    const page = await notion.pages.retrieve({ page_id: pageId });
    
    const deliverable = page.properties['Deliverable']?.multi_select?.[0]?.name || 'Unknown';
    const submittedBy = page.properties['Submitted By']?.multi_select?.[0]?.name || 'Designer';
    const comments = page.properties['Comments']?.rich_text?.[0]?.plain_text || '';
    const pageUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;
    
    // Log submission activity
    await notion.pages.create({
      parent: { database_id: ACTIVITY_LOG_DB_ID },
      properties: {
        'Name': { title: [{ text: { content: `${deliverable} submitted` } }] },
        'date:Timestamp:start': new Date().toISOString(),
        'date:Timestamp:is_datetime': 1,
        'Event Type': { select: { name: 'Submitted' } },
        'Deliverable': { relation: [{ id: pageId }] },
        'Details': { rich_text: [{ text: { content: `Deliverable "${deliverable}" submitted by ${submittedBy}. Comments: ${comments || 'None'}` } }] },
        'Source': { select: { name: 'Webhook' } }
      }
    });
    
    // Send email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: 'solomonchong2011@gmail.com, sinha03@gmail.com',
      subject: `📋 New Deliverable: ${deliverable}`,
      html: `
<h2>📋 New Deliverable Submitted</h2>
<p><strong>Deliverable:</strong> ${deliverable}</p>
<p><strong>Submitted by:</strong> ${submittedBy}</p>
<p><strong>Comments:</strong> ${comments || 'None'}</p>
<p><a href="${pageUrl}" style="background: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">View in Notion →</a></p>
<hr>
<p style="color: #999; font-size: 12px;">JOOBIN RENOVATION COMMAND CENTER</p>
      `
    });
    
    // Log email sent activity
    await notion.pages.create({
      parent: { database_id: ACTIVITY_LOG_DB_ID },
      properties: {
        'Name': { title: [{ text: { content: `Email sent for ${deliverable}` } }] },
        'date:Timestamp:start': new Date().toISOString(),
        'date:Timestamp:is_datetime': 1,
        'Event Type': { select: { name: 'Email Sent' } },
        'Deliverable': { relation: [{ id: pageId }] },
        'Details': { rich_text: [{ text: { content: `Notification email sent to reviewers (Solomon & Harminder)` } }] },
        'Source': { select: { name: 'Webhook' } }
      }
    });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, deliverable, notified: true, logged: true })
    };
    
  } catch (error) {
    console.error('Webhook error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};