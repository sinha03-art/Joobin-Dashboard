const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DELIVERABLES_DB_ID = '680a1e81192a462587860e795035089c';

exports.handler = async (event) => {
  // Security check
  const authHeader = event.headers['authorization'];
  if (!process.env.WEBHOOK_SECRET || authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  const { pageId } = JSON.parse(event.body);
  
  try {
    // Get the new page
    const newPage = await notion.pages.retrieve({ page_id: pageId });
    
    // Simple title update for now (deduplication can come later)
    const deliverable = newPage.properties['Deliverable']?.multi_select?.[0]?.name;
    
    if (deliverable) {
      await notion.pages.update({
        page_id: pageId,
        properties: {
          'Select Deliverable:': {
            title: [{ text: { content: deliverable } }]
          },
          'Status': { select: { name: 'Submitted' } }
        }
      });
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, deliverable })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
