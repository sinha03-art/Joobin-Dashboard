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
    // 1. Get the new submission
    const newPage = await notion.pages.retrieve({ page_id: pageId });
    
    // 2. Extract deliverable name
    const deliverable = newPage.properties['Deliverable']?.multi_select?.[0]?.name;
    
    if (!deliverable) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No deliverable selected' }) };
    }
    
    // 3. Search for existing page with same name
    const searchResults = await notion.databases.query({
      database_id: DELIVERABLES_DB_ID,
      filter: {
        property: 'Select Deliverable:',
        title: { equals: deliverable }
      }
    });
    
    // 4. Find existing page (exclude current submission)
    const existingPage = searchResults.results.find(page => page.id !== pageId);
    
    if (!existingPage) {
      // No duplicate - just update title and status
      await notion.pages.update({
        page_id: pageId,
        properties: {
          'Select Deliverable:': { title: [{ text: { content: deliverable } }] },
          'Status': { select: { name: 'Submitted' } }
        }
      });
      
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, action: 'created', deliverable })
      };
    }
    
    // 5. Duplicate found - merge data
    const updateProperties = {};
    
    // Merge files
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
    
    // Append comments with timestamp
    const newComments = newPage.properties['Comments']?.rich_text?.[0]?.plain_text || '';
    const existingComments = existingPage.properties['Comments']?.rich_text?.[0]?.plain_text || '';
    if (newComments) {
      const timestamp = new Date().toISOString().split('T')[0];
      const merged = existingComments 
        ? `${existingComments}\n\n[${timestamp}] ${newComments}`
        : newComments;
      updateProperties['Comments'] = { rich_text: [{ text: { content: merged.slice(0, 2000) } }] };
    }
    
    // Always set to Submitted
    updateProperties['Status'] = { select: { name: 'Submitted' } };
    
    // 6. Update existing page
    await notion.pages.update({
      page_id: existingPage.id,
      properties: updateProperties
    });
    
    // 7. Delete duplicate
    await notion.blocks.delete({ block_id: pageId });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        action: 'merged', 
        deliverable,
        existingPageId: existingPage.id
      })
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};