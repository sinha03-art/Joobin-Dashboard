import { handleDeliverableSubmission } from '../../webhooks/deliverable-dedupe.js';

exports.handler = async (event) => {
  // Security: Verify webhook secret
  const authHeader = event.headers['authorization'];
  const expectedSecret = process.env.WEBHOOK_SECRET;
  
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  // Parse webhook payload
  const payload = JSON.parse(event.body);
  const pageId = payload.pageId;
  
  if (!pageId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing pageId' })
    };
  }

  // Process the submission
  const result = await handleDeliverableSubmission(pageId);

  return {
    statusCode: 200,
    body: JSON.stringify(result)
  };
};