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
        const title = page.properties['Select Deliverable:'].title[0].plain_text || '';
        return title.trim(); // ADD .trim() HERE
    } catch (e) {
        return '';
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

function getCreatedTime(page) {
    return page.created_time || '';
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

        // Helper function to get deliverable tags
        function getDeliverableTag(page) {
            try {
                const deliverables = page.properties['Deliverable'].multi_select || [];
                return deliverables.map(d => d.name).sort().join(',');
            } catch (e) {
                return '';
            }
        }

        // Group pages by BOTH deliverable tag AND title (composite key)
        const grouped = {};
        response.results.forEach(page => {
            const title = getTitle(page);
            const deliverableTag = getDeliverableTag(page);

            // Create composite key: "deliverableTag::title"
            // Only group entries that have BOTH the same tag AND same title
            const compositeKey = `${deliverableTag}::${title}`;

            if (!deliverableTag || !title) return; // Skip entries missing either field

            if (!grouped[compositeKey]) {
                grouped[compositeKey] = [];
            }
            grouped[compositeKey].push(page);
        });

        // Find duplicates
        const duplicates = Object.entries(grouped).filter(([name, pages]) => pages.length > 1);

        console.log('[INFO] Duplicate deliverables found:', duplicates.length);

        if (duplicates.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ message: 'No duplicates found' })
            };
        }

        let processedCount = 0;

        for (const [deliverableName, pages] of duplicates) {
            console.log('[PROCESS] Merging duplicates for:', deliverableName, '(' + pages.length + ' entries)');

            // Sort by created time - oldest first
            pages.sort((a, b) => getCreatedTime(a).localeCompare(getCreatedTime(b)));

            const originalPage = pages[0];
            const duplicatePages = pages.slice(1);

            console.log('[INFO] Keeping original:', originalPage.id);
            console.log('[INFO] Merging', duplicatePages.length, 'duplicate(s)');

            // Collect all files and comments from duplicates
            const originalFiles = getFiles(originalPage, 'File');
            const originalComments = getRichText(originalPage, 'Comments');

            let allFiles = originalFiles.slice();
            let allComments = originalComments;

            for (const dup of duplicatePages) {
                const dupFiles = getFiles(dup, 'Attach your document').concat(getFiles(dup, 'File'));
                const dupComments = getRichText(dup, 'Comments');

                allFiles = allFiles.concat(dupFiles);

                if (dupComments) {
                    allComments = allComments ?
                        allComments + '\n\n' + dupComments :
                        dupComments;
                }
            }

            // Update the original with merged data
            await updatePage(originalPage.id, {
                'File': { files: allFiles },
                'Comments': {
                    rich_text: [{ text: { content: allComments } }]
                }
            });

            console.log('[SUCCESS] Updated original with merged files/comments');

            // Archive the duplicates
            for (const dup of duplicatePages) {
                await archivePage(dup.id);
                console.log('[SUCCESS] Archived duplicate:', dup.id);
            }

            processedCount++;
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                duplicatesProcessed: processedCount,
                totalMerged: duplicates.reduce((sum, [name, pages]) => sum + pages.length - 1, 0)
            })
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
