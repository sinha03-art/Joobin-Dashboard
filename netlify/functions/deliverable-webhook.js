const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DELIVERABLES_DB_ID = process.env.DELIVERABLES_DB_ID;

exports.handler = async(event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    try {
        console.log('[START] Querying database:', DELIVERABLES_DB_ID);

        // Query all deliverables
        const response = await notion.databases.query({
            database_id: DELIVERABLES_DB_ID
        });

        console.log('[INFO] Total pages found:', response.results.length);

        // Find "New submission" entries
        const newSubmissions = response.results.filter(page => {
            const title = page.properties['Select Deliverable:'] ? .title ? .[0] ? .plain_text || '';
            return title === 'New submission';
        });

        console.log('[INFO] New submissions found:', newSubmissions.length);

        if (newSubmissions.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ message: 'No new submissions' })
            };
        }

        // Process each submission
        for (const submission of newSubmissions) {
            const deliverableOptions = submission.properties['Deliverable'] ? .multi_select || [];

            if (deliverableOptions.length === 0) {
                console.log('[SKIP] No deliverable selected:', submission.id);
                continue;
            }

            const deliverableName = deliverableOptions[0].name;
            console.log('[PROCESS] Deliverable:', deliverableName);

            // Find target page
            const targetResponse = await notion.databases.query({
                database_id: DELIVERABLES_DB_ID,
                filter: {
                    property: 'Select Deliverable:',
                    title: {
                        equals: deliverableName
                    }
                }
            });

            const targetPages = targetResponse.results.filter(p => p.id !== submission.id);
            console.log('[INFO] Target pages found:', targetPages.length);

            if (targetPages.length === 0) {
                console.log('[SKIP] No target for:', deliverableName);
                continue;
            }

            const targetPage = targetPages[0];

            // Get files and comments
            const submissionFiles = submission.properties['Attach your document'] ? .files || [];
            const existingFiles = targetPage.properties['File'] ? .files || [];
            const submissionComments = submission.properties['Comments'] ? .rich_text ? .[0] ? .plain_text || '';
            const existingComments = targetPage.properties['Comments'] ? .rich_text ? .[0] ? .plain_text || '';

            console.log('[INFO] Files to merge:', submissionFiles.length);

            // Update target
            await notion.pages.update({
                page_id: targetPage.id,
                properties: {
                    'File': { files: [...existingFiles, ...submissionFiles] },
                    'Status': { select: { name: 'Submitted' } },
                    'Comments': {
                        rich_text: [{
                            text: {
                                content: existingComments ?
                                    `${existingComments}\n\n${submissionComments}` :
                                    submissionComments
                            }
                        }]
                    }
                }
            });

            console.log('[SUCCESS] Updated target:', targetPage.id);

            // Archive submission
            await notion.pages.update({
                page_id: submission.id,
                archived: true
            });

            console.log('[SUCCESS] Archived submission:', submission.id);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ processed: newSubmissions.length })
        };

    } catch (error) {
        console.error('[ERROR]', error.message);
        console.error('[STACK]', error.stack);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};