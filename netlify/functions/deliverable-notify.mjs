import nodemailer from 'nodemailer';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// UPDATE THESE EMAIL ADDRESSES
const OWNER_EMAILS = [
  'gheeball.73@gmail.com', // HAM
  'solomonchong2011@gmail.com', // ← UPDATE Solomon's email
  'harmindersinghj@hotmail.com' // ← UPDATE Harminder's email
];

export const handler = async (event) => {
  // Security check
  const authHeader = event.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  try {
    const payload = JSON.parse(event.body);
    const pageId = payload.pageId;

    console.log(`[Deliverable Notify] Processing pageId: ${pageId}`);

    // Get page details from Notion
    const page = await notion.pages.retrieve({ page_id: pageId });
    const props = page.properties;

    // Extract properties
    const deliverableName = props['Select Deliverable:']?.title?.[0]?.plain_text || 'Untitled';
    const status = props['Status']?.select?.name || 'N/A';
    const reviewStatus = props['Review Status']?.select?.name || 'N/A';
    const gate = props['Gate']?.multi_select?.map(g => g.name).join(', ') || 'N/A';
    const submittedBy = props['Submitted By']?.multi_select?.map(p => p.name).join(', ') || 'N/A';
    const targetDue = props['Target Due']?.date?.start || 'Not set';
    const comments = props['Comments']?.rich_text?.[0]?.plain_text || 'None';

    // Build page URL
    const pageUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;

    // Create Gmail transporter
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    // Email content
    const emailSubject = `🎨 Designer Deliverable Updated: ${deliverableName}`;
    const emailBody = `
A Designer Deliverable has been updated:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 DELIVERABLE: ${deliverableName}
🚪 GATE: ${gate}
📊 STATUS: ${status}
✅ REVIEW STATUS: ${reviewStatus}
👤 SUBMITTED BY: ${submittedBy}
📅 TARGET DUE: ${targetDue}

💬 COMMENTS:
${comments}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔗 View in Notion: ${pageUrl}

---
JOOBIN RENOVATION COMMAND CENTER
Automated notification from Designer Deliverables database
    `;

    // Send email
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: OWNER_EMAILS.join(','),
      subject: emailSubject,
      text: emailBody
    };

    await transporter.sendMail(mailOptions);

    console.log(`✅ Email sent for deliverable: ${deliverableName} to ${OWNER_EMAILS.length} recipients`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Email notifications sent',
        deliverable: deliverableName,
        recipients: OWNER_EMAILS.length
      })
    };

  } catch (error) {
    console.error('❌ Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};