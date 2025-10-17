const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DELIVERABLES_DB_ID = process.env.DELIVERABLES_DB_ID;
const NOTION_VERSION = '2022-06-28';

const notionHeaders = () => ({
    'Authorization': `Bearer ${NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
});

async function queryNotionDB(dbId, filter = {}) {
    const url = `https://api.notion.com/v1/databases/${dbId}/query`;
    const res = await fetch(url, {
        method: 'POST',
        headers: notionHeaders(),
        body: JSON.stringify(filter)
    });
    return await res.json();
}

async function updatePage(pageId, properties) {
    const url = `https://api.notion.com/v1/pages/${pageId}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: notionHeaders(),
        body: JSON.stringify({ properties })
    });
    return await res.json();
}

async function archivePage(pageId) {
    const url = `https://api.notion.com/v1/pages/${pageId}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: notionHeaders(),
        body: JSON.stringify({ archived: true })
    });
    return await res.json();
}

function getTitle(page) {
    try {
        return page.properties['Select Deliverable:'].title[0].plain_text || '';
    } catch (e) {
        return '';
    }
}

function getMultiSelect(page, propName) {
    try {
        return page.properties[propName].multi_select || [];
    } catch (e) {
        return [];
    }
}

function getFiles(page, propName) {
    try {
        return page.properties[propName].files || [];
    } catch (e) {
        return [];
    }
}

function getRichText(page, propName) {
    try {
        return page.properties[propName].rich_text[0].plain_text || '';
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

        const response = await queryNotionDB(DELIVERABLES_DB_ID);
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

            const targetResponse = await queryNotionDB(DELIVERABLES_DB_ID, {
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

            await updatePage(targetPage.id, {
                'File': { files: existingFiles.concat(submissionFiles) },
                'Status': { select: { name: 'Submitted' } },
                'Comments': {
                    rich_text: [{ text: { content: mergedComments } }]
                }
            });

            console.log('[SUCCESS] Updated target:', targetPage.id);

            await archivePage(submission.id);

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