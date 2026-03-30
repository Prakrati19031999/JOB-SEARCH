exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY is not set in environment variables.' } }),
    };
  }

  try {
    const body = JSON.parse(event.body);

    // Detect if this is a job search request to allocate more tokens
    const lastMessage = (body.messages || []).slice(-1)[0]?.content || '';
    const isJobSearch = typeof lastMessage === 'string' &&
      /find|job|search|opening|role|position|hiring|career/i.test(lastMessage);

    const payload = {
      ...body,
      max_tokens: isJobSearch ? 4000 : (body.max_tokens || 2000),
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: isJobSearch ? 8 : 3 },
        ...(body.tools || []),
      ],
    };

    // Race the API call against a 55s timeout so we never hit Netlify's hard limit
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);

    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const data = await response.json();

    // Surface Anthropic error messages clearly
    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: data.error || { message: `API error ${response.status}` } }),
      };
    }

    // Collapse all text blocks into one so the frontend parses cleanly
    const textContent = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const simplified = {
      ...data,
      content: textContent
        ? [{ type: 'text', text: textContent }]
        : data.content,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(simplified),
    };

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    return {
      statusCode: isTimeout ? 504 : 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        error: {
          message: isTimeout
            ? 'Job search timed out — try a more specific query like "senior PM jobs in New York"'
            : err.message,
        },
      }),
    };
  }
};
