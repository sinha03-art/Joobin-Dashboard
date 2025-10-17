const fetch = require('node-fetch');

exports.handler = async(event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    // If called manually with pageId
    if (event.body) {
        const payload = JSON.parse(event.body);
        // Process deduplication logic here
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // If called as scheduled function (no body)
    try {
        console.log('[Scheduled] Checking for duplicates via proxy...');

        // Call your existing proxy endpoint to get all deliverables
        const response = await fetch(`${process.env.URL}/.netlify/functions/proxy`);
        const data = await response.json();

        // Find "New submission" entries
        const newSubmissions = data.deliverables.filter(d =>
            d.title === 'New submission'
        );

        if (newSubmissions.length === 0) {
            console.log('[Scheduled] No new submissions');
            return { statusCode: 200, headers, body: 'No duplicates found' };
        }

        console.log(`[Scheduled] Found ${newSubmissions.length} new submissions`);

        // TODO: Process duplicates here

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ found: newSubmissions.length })
        };

    } catch (error) {
        console.error('[Scheduled] Error:', error);
        return { statusCode: 500, headers, body: error.message };
    }
};