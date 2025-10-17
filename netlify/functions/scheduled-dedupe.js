const { Client } = require('@notionhq/client');

exports.handler = async(event) => {
    console.log('[Scheduled] Checking for duplicate submissions...');

    try {
        // Initialize notion client inside handler
        const notion = new Client({ auth: process.env.NOTION_API_KEY });
        const DELIVERABLES_DB_ID = process.env.DELIVERABLES_DB_ID;

        // Find "New submission" entries
        const response = await notion.databases.query({
            database_id: DELIVERABLES_DB_ID,
            filter: {
                property: 'Select Deliverable:',
                title: { equals: 'New submission' }
            }
        });

        if (response.results.length === 0) {
            console.log('[Scheduled] No new submissions found');
            return { statusCode: 200, body: 'No submissions to process' };
        }

        console.log(`[Scheduled] Found ${response.results.length} new submission(s)`);

        // Process each submission by calling the webhook
        const results = await Promise.all(
            response.results.map(page =>
                fetch(`${process.env.URL}/.netlify/functions/deliverable-webhook`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WEBHOOK_SECRET}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ pageId: page.id })
                })
            )
        );

        return {
            statusCode: 200,
            body: JSON.stringify({
                processed: response.results.length,
                results: results.map(r => r.status)
            })
        };

    } catch (error) {
        console.error('[Scheduled] Error:', error);
        return { statusCode: 500, body: error.message };
    }
};