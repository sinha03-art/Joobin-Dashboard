const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DELIVERABLES_DB_ID = process.env.DELIVERABLES_DB_ID;

function getTitle(page) {
    try {
        const titleProp = page.properties['Select Deliverable:'];
        if (titleProp && titleProp.title && titleProp.title[0]) {
            return titleProp.title[0].plain_text || '';
        }
        return '';
    } catch (e) {
        return '';
    }
}

function getMultiSelect(page, propName) {
    try {
        const prop = page.properties[propName];
        if (prop && prop.multi_select) {
            return prop.multi_select;
        }
        return [];
    } catch (e) {
        return [];
    }
}

function getFiles(page, propName) {
    try {
        const prop = page.properties[propName];
        if (prop && prop.files) {
            return prop.files;
        }
        return [];
    } catch (e) {
        return [];
    }
}

function getRichText(page, propName) {
    try {
        const prop = page.properties[propName];
        if (prop && prop.rich_text && prop.rich_text[0]) {
            return prop.rich_text[0].plain_text || '';
        }
        return '';
    } catch (e) {
        return '';
    }
}

exports.handler = async(event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    try {
        console.log('[START] Querying database:', DELIVERABLES_DB_ID);

        const response = await notion.databases.query({
            database_id: DELIVERABLES_DB_ID
        });

        console.log('[INFO] Total pages found:', response.results.length);

        const newSubmissions = response.results.filter(page => {
            const title = getTitle(page);
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

        for (const submission of newSubmissions) {
            const deliverableOptions = getMultiSelect(submission, 'Deliverable');

            if (deliverableOptions.length === 0) {
                console.log('[SKIP] No deliverable selected:', submission.id);
                continue;
            }

            const deliverableName = deliverableOptions[0].name;
            console.log('[PROCESS] Deliverable:', deliverableName);

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

            const submissionFiles = getFiles(submission, 'Attach your document');
            const existingFiles = getFiles(targetPage, 'File');
            const submissionComments = getRichText(submission, 'Comments');
            const existingComments = getRichText(targetPage, 'Comments');

            console.log('[INFO] Files to merge:', submissionFiles.length);

            const mergedComments = existingComments ?
                existingComments + '\n\n' + submissionComments :
                submissionComments;

            await notion.pages.update({
                page_id: targetPage.id,
                properties: {
                    'File': { files: existingFiles.concat(submissionFiles) },
                    'Status': { select: { name: 'Submitted' } },
                    'Comments': {
                        rich_text: [{ text: { content: mergedComments } }]
                    }
                }
            });

            console.log('[SUCCESS] Updated target:', targetPage.id);

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