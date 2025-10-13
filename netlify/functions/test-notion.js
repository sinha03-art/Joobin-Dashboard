const { Client } = require('@notionhq/client');

exports.handler = async (event) => {
  try {
    const notion = new Client({ auth: process.env.NOTION_API_KEY });
    
    console.log('Notion client created:', typeof notion);
    console.log('Has databases:', typeof notion.databases);
    console.log('Has query:', typeof notion.databases?.query);
    
    const result = await notion.databases.retrieve({ 
      database_id: '680a1e81192a462587860e795035089c'
    });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        dbName: result.title[0]?.plain_text || 'Unknown'
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message, stack: error.stack })
    };
  }
};