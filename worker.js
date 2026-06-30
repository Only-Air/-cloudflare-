// Cloudflare Worker — 周南中学招生助手 API 代理 + 限流
// 部署: npx wrangler deploy worker.js
// 设置 secrets:
//   wrangler secret put DEEPSEEK_API_KEY
//   wrangler secret put IMA_CLIENT_ID
//   wrangler secret put IMA_API_KEY

// ---------- 限流配置 ----------
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 }; // 每分钟最多10次
const rateMap = new Map(); // ponytail: 单节点内存限流，多区域部署需升级到 KV

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.timestamp > RATE_LIMIT.windowMs) {
    rateMap.set(ip, { count: 1, timestamp: now });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT.maxRequests) {
    return { allowed: false, retryAfter: Math.ceil((entry.timestamp + RATE_LIMIT.windowMs - now) / 1000) };
  }
  entry.count++;
  return { allowed: true };
}

// ---------- 清理过期限流记录（每5分钟） ----------
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateMap) {
    if (now - entry.timestamp > RATE_LIMIT.windowMs) rateMap.delete(ip);
  }
}, 300_000);

// ---------- CORS ----------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ---------- 请求处理 ----------
export default {
  async fetch(request, env) {
    // 处理 CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: '只支持 POST 请求' }, 405);
    }

    // 限流
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
      return jsonResponse({ error: `请求太频繁，请 ${rateCheck.retryAfter} 秒后再试` }, 429);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/chat') {
        return await handleChat(request, env);
      }
      if (path === '/api/knowledge') {
        return await handleKnowledge(request, env);
      }
      return jsonResponse({ error: '路径不存在' }, 404);
    } catch (err) {
      return jsonResponse({ error: `服务器错误: ${err.message}` }, 500);
    }
  },
};

// ---------- /api/chat — 代理 DeepSeek ----------
async function handleChat(request, env) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return jsonResponse({ error: '服务端未配置 DEEPSEEK_API_KEY' }, 500);

  const body = await request.json();
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  return jsonResponse(data, response.status);
}

// ---------- /api/knowledge — 代理 ima 知识库 ----------
async function handleKnowledge(request, env) {
  const clientId = env.IMA_CLIENT_ID;
  const apiKey = env.IMA_API_KEY;
  if (!clientId || !apiKey) {
    return jsonResponse({ error: '服务端未配置 IMA_CLIENT_ID 或 IMA_API_KEY' }, 500);
  }

  const { query } = await request.json();
  if (!query) return jsonResponse({ error: '缺少 query 参数' }, 400);

  const response = await fetch('https://ima.qq.com/openapi/wiki/v1/search_knowledge_base', {
    method: 'POST',
    headers: {
      'ima-openapi-clientid': clientId,
      'ima-openapi-apikey': apiKey,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ query, cursor: '', limit: 5 }),
  });

  const data = await response.json();
  // 清洗成前端需要的格式
  if (data.data?.items?.length) {
    const snippets = data.data.items.map(i => i.content).filter(Boolean);
    return jsonResponse({ knowledge: snippets.join('\n\n') });
  }
  return jsonResponse({ knowledge: null });
}
