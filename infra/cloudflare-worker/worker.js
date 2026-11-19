// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    // Pages Functions 中 KV 需要从 env 中获取
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV
    }
    
    return handleRequest(request, ctx)
  }
}

// 常量配置（避免重复创建）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Inkline-Update-Source',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

const INKLINE_GITHUB = 'https://github.com/jshmztl/Inkline'
const INKLINE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// ---------- 安全版：错误日志 ----------
async function logError(type, info) {
  // 保留错误输出，便于调试
  console.error('[ERROR]', type, info)

  // 禁止写入 KV
  return
}

// ---------- 主逻辑 ----------
async function handleRequest(request, ctx) {
  // 快速处理 OPTIONS 请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const targetUrlParam = reqUrl.searchParams.get('url')

  const currentOrigin = reqUrl.origin

  // 🩺 健康检查（最常见的性能检查，提前处理）
  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // Inkline 更新源：国内镜像 / GitHub 直连
  if (pathname === '/inkline/latest.json') {
    return handleInklineManifest(request, currentOrigin)
  }
  if (pathname.startsWith('/inkline/download/')) {
    return handleInklineAsset(request, pathname, ctx)
  }

  // 通用代理请求处理
  if (targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // 返回首页文档
  return handleHomePage(currentOrigin)
}

// ---------- 代理请求处理子模块 ----------
async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  // 🚨 防止递归调用自身
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected: self-fetch blocked', { url: targetUrlParam }, 400)
  }

  // 🚨 防止无效 URL
  if (!/^https?:\/\//i.test(targetUrlParam)) {
    return errorResponse('Invalid target URL', { url: targetUrlParam }, 400)
  }

  let fullTargetUrl = targetUrlParam
  const urlMatch = request.url.match(/[?&]url=([^&]+(?:&.*)?)/)
  if (urlMatch) fullTargetUrl = decodeURIComponent(urlMatch[1])

  let targetURL
  try {
    targetURL = new URL(fullTargetUrl)
  } catch {
    await logError('proxy', { message: 'Invalid URL', url: fullTargetUrl })
    return errorResponse('Invalid URL', { url: fullTargetUrl }, 400)
  }

  try {
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.arrayBuffer()
        : undefined,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch (err) {
    await logError('proxy', { message: err.message || '代理请求失败', url: fullTargetUrl })
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: fullTargetUrl,
      timestamp: new Date().toISOString()
    }, 502)
  }
}

// ---------- Inkline 更新源 ----------
async function handleInklineManifest(request, currentOrigin) {
  const source = (request.headers.get('x-inkline-update-source') || 'domestic').toLowerCase()

  try {
    const res = await fetch(`${INKLINE_GITHUB}/releases/latest/download/latest.json`, {
      headers: { 'User-Agent': 'Inkline-Update-Proxy' },
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)

    const data = await res.json()
    if (source !== 'github') {
      const version = String(data.version || '')
      const tag = version.startsWith('v') ? version : `v${version}`
      for (const item of Object.values(data.platforms || {})) {
        if (!item || !item.url) continue
        try {
          const parsed = new URL(item.url)
          if (parsed.hostname !== 'github.com') continue
          const name = parsed.pathname.split('/').filter(Boolean).pop()
          if (name && INKLINE_ASSET.test(name)) {
            item.url = `${currentOrigin}/inkline/download/${tag}/${name}`
          }
        } catch {
          // 保留原始地址
        }
      }
    }

    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Inkline-Update-Source': source === 'github' ? 'github' : 'domestic',
        ...CORS_HEADERS,
      },
    })
  } catch (err) {
    await logError('inkline-manifest', { message: err.message, source })
    return errorResponse('Inkline manifest error', { message: err.message }, 502)
  }
}

async function handleInklineAsset(request, pathname, ctx) {
  const match = pathname.match(/^\/inkline\/download\/(v[0-9][0-9A-Za-z._-]*)\/([^/]+)$/)
  if (!match || !INKLINE_ASSET.test(match[2])) {
    return errorResponse('Invalid asset path', {}, 400)
  }
  const [, tag, name] = match

  const cache = typeof caches !== 'undefined' ? caches.default : null
  const cacheKey = new Request(request.url, { method: 'GET' })
  const hit = cache ? await cache.match(cacheKey) : null
  if (hit) return hit

  try {
    const res = await fetch(`${INKLINE_GITHUB}/releases/download/${tag}/${name}`, {
      headers: { 'User-Agent': 'Inkline-Update-Proxy' },
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)

    const headers = new Headers(CORS_HEADERS)
    headers.set('Content-Type', res.headers.get('Content-Type') || 'application/octet-stream')
    const length = res.headers.get('Content-Length')
    if (length) headers.set('Content-Length', length)
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')

    const response = new Response(res.body, { status: res.status, headers })
    if (res.status === 200 && cache && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cache.put(cacheKey, response.clone()))
    }
    return response
  } catch (err) {
    await logError('inkline-asset', { message: err.message, tag, name })
    return errorResponse('Inkline asset error', { message: err.message }, 502)
  }
}

// ---------- 首页文档处理 ----------
async function handleHomePage(currentOrigin) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Inkline 更新与中转服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; }
  </style>
</head>
<body>
  <h1>Inkline 更新与中转服务</h1>
  <p>为 Inkline 桌面端提供国内更新镜像，并保留通用 API 中转能力。</p>

  <h2>更新源</h2>
  <div class="section">
    <p>更新清单：<code>${currentOrigin}/inkline/latest.json</code></p>
    <p>安装包：<code>${currentOrigin}/inkline/download/v版本号/文件名</code></p>
  </div>

  <h2>通用中转</h2>
  <p>在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
  <pre>${currentOrigin}/?url=<示例API地址></pre>

  <h2>支持的功能</h2>
  <ul>
    <li>✅ 支持 GET、POST、PUT、DELETE 等所有 HTTP 方法</li>
    <li>✅ 自动转发请求头和请求体</li>
    <li>✅ 保留原始响应头（除敏感信息）</li>
    <li>✅ 完整的 CORS 支持</li>
    <li>✅ 超时保护（9 秒）</li>
    <li>✅ Inkline 更新清单与安装包镜像</li>
  </ul>
</body>
</html>`

  return new Response(html, { 
    status: 200, 
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS } 
  })
}

// ---------- 统一错误响应处理 ----------
function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
