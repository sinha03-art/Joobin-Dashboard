import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DELIVERABLES_DB_ID = '680a1e81192a462587860e795035089c';

export async function handleDeliverableSubmission(pageId) {
  try {
    // 1. Get the new submission
    const newPage = await notion.pages.retrieve({ page_id: pageId });
    
    // 2. Extract deliverable name from multi-select
    const deliverableProperty = newPage.properties['Deliverable'];
    if (!deliverableProperty?.multi_select?.length) {
      console.log('No deliverable selected, skipping dedupe');
      return { success: true, action: 'skipped' };
    }
    
    const deliverableName = deliverableProperty.multi_select[0].name;
    const newPageTitle = newPage.properties['Select Deliverable:']?.title?.[0]?.plain_text;
    
    // Skip if title already set (not "New submission")
    if (newPageTitle && newPageTitle !== 'New submission' && newPageTitle !== '') {
      console.log('Page already has title, skipping dedupe');
      return { success: true, action: 'skipped' };
    }

    // 3. Search for existing page with same name
    const searchResults = await notion.databases.query({
      database_id: DELIVERABLES_DB_ID,
      filter: {
        property: 'Select Deliverable:',
        title: {
          equals: deliverableName
        }
      }
    });

    // 4. Find existing page (exclude the current submission)
    const existingPage = searchResults.results.find(page => page.id !== pageId);
    
    if (!existingPage) {
      // No duplicate found - this is a new deliverable
      // Update title to match deliverable name
      await notion.pages.update({
        page_id: pageId,
        properties: {
          'Select Deliverable:': {
            title: [{ text: { content: deliverableName } }]
          }
        }
      });
      
      console.log(`New deliverable created: ${deliverableName}`);
      return { success: true, action: 'created', deliverable: deliverableName };
    }

    // 5. Duplicate found - merge data
    const updateProperties = {};
    
    // Merge Files (append, don't replace)
    const newFiles = newPage.properties['File']?.files || [];
    const existingFiles = existingPage.properties['File']?.files || [];
    if (newFiles.length > 0) {
      updateProperties['File'] = {
        files: [...existingFiles, ...newFiles]
      };
    }
    
    // Merge Attach your document
    const newDocs = newPage.properties['Attach your document']?.files || [];
    const existingDocs = existingPage.properties['Attach your document']?.files || [];
    if (newDocs.length > 0) {
      updateProperties['Attach your document'] = {
        files: [...existingDocs, ...newDocs]
      };
    }
    
    // Append Comments
    const newComments = newPage.properties['Comments']?.rich_text?.[0]?.plain_text || '';
    const existingComments = existingPage.properties['Comments']?.rich_text?.[0]?.plain_text || '';
    if (newComments) {
      const mergedComments = existingComments 
        ? `${existingComments}\n\n[${new Date().toISOString().split('T')[0]}] ${newComments}`
        : newComments;
      updateProperties['Comments'] = {
        rich_text: [{ text: { content: mergedComments } }]
      };
    }
    
    // Update Status
    updateProperties['Status'] = { select: { name: 'Submitted' } };
    
    // Copy other fields if not empty
    const fieldsToCopy = ['Category', 'Gate', 'Submitted By', 'Trade'];
    for (const field of fieldsToCopy) {
      const newValue = newPage.properties[field];
      if (newValue?.multi_select?.length > 0) {
        updateProperties[field] = newValue;
      } else if (newValue?.select?.name) {
        updateProperties[field] = newValue;
      }
    }
    
    // Copy Target Due date if provided
    if (newPage.properties['Target Due']?.date) {
      updateProperties['Target Due'] = newPage.properties['Target Due'];
    }

    // 6. Update existing page
    await notion.pages.update({
      page_id: existingPage.id,
      properties: updateProperties
    });

    // 7. Delete duplicate submission
    await notion.blocks.delete({ block_id: pageId });

    console.log(`Merged duplicate into existing: ${deliverableName}`);
    return { 
      success: true, 
      action: 'merged', 
      deliverable: deliverableName,
      existingPageId: existingPage.id,
      deletedPageId: pageId
    };

  } catch (error) {
    console.error('Dedupe error:', error);
    return { success: false, error: error.message };
  }
}