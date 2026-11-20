addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = {
  KV_TTL: 86400, // 24小时后自动过期（次日自动清理）
  UNANSWERED_MIN_COUNT: 3,
  SPAN_THRESHOLD_MS: 60 * 1000, // 1分钟
  MAX_PHOTO_BYTES: 15 * 1024 * 1024, // 服务端兜底：原图最大 15MB（前端已压缩，正常不会触发）
  DEFAULT_MAX_RECORDS: 10, // 环境变量 MAX_RECORDS 未设置时的默认保留条数
  NOTIFY_RATE_LIMIT: 5, // 每 IP 每限流窗口内最多发送通知次数
  NOTIFY_RATE_WINDOW: 60 // 限流窗口（秒），KV TTL 最小 60s
}

// 读取环境变量 MAX_RECORDS（当天最多保留的挪车记录条数），未设置或非法时回退默认值
function getMaxRecords() {
  if (typeof MAX_RECORDS !== 'undefined' && MAX_RECORDS) {
    const parsed = parseInt(String(MAX_RECORDS).trim(), 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return CONFIG.DEFAULT_MAX_RECORDS;
}

// 读取环境变量 ACCESS_PIN（车主确认页访问口令）；不设置则不鉴权
function getAccessPin() {
  if (typeof ACCESS_PIN !== 'undefined' && ACCESS_PIN) return String(ACCESS_PIN).trim();
  return '';
}

// 通知接口按 IP 限流，防止被恶意刷（KV 按窗口 TTL 自动清理）
async function checkNotifyRateLimit(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = 'rl_notify_' + ip;
  const raw = await MOVE_CAR_STATUS.get(key);
  const count = raw ? (parseInt(raw, 10) || 0) : 0;
  if (count >= CONFIG.NOTIFY_RATE_LIMIT) return false;
  await MOVE_CAR_STATUS.put(key, String(count + 1), { expirationTtl: CONFIG.NOTIFY_RATE_WINDOW });
  return true;
}

// 解析 QYWX_AM 变量：corpid,corpsecret,agentid[,touser]（支持中英文逗号，touser 多用户用 & 分隔）
function getWeComConfig() {
  if (typeof QYWX_AM !== 'undefined' && QYWX_AM) {
    const parts = String(QYWX_AM)
      .split(/[,，]/)
      .map(s => s.trim());
    const corpid = parts[0] || '';
    const corpsecret = parts[1] || '';
    const agentid = parts[2] || '';
    const rawToUser = parts.slice(3).join(',').trim();
    const touser = rawToUser
      ? rawToUser.split('&').map(s => s.trim()).filter(Boolean).join('&') || '@all'
      : '@all';

    if (corpid && corpsecret && agentid) {
      return { corpid, corpsecret, agentid, touser };
    }
  }

  // 兼容旧的独立变量写法
  if (
    typeof WECOM_CORPID !== 'undefined' && WECOM_CORPID &&
    typeof WECOM_APP_SECRET !== 'undefined' && WECOM_APP_SECRET &&
    typeof WECOM_AGENTID !== 'undefined' && WECOM_AGENTID
  ) {
    const touser = (typeof WECOM_TOUSER !== 'undefined' && WECOM_TOUSER)
      ? String(WECOM_TOUSER).split('&').map(s => s.trim()).filter(Boolean).join('&') || '@all'
      : '@all';
    return {
      corpid: String(WECOM_CORPID).trim(),
      corpsecret: String(WECOM_APP_SECRET).trim(),
      agentid: String(WECOM_AGENTID).trim(),
      touser
    };
  }

  return null;
}

function hasAnyNotifyChannel() {
  const hasWeCom = Boolean(getWeComConfig());
  const hasBark = typeof BARK_URL !== 'undefined' && Boolean(String(BARK_URL).trim());
  return hasWeCom || hasBark;
}

// 获取当前北京日期的字符串作为 Key（格式：YYYY-MM-DD）
function getBeijingDateStr() {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/api/notify' && request.method === 'POST') {
    return handleNotify(request, url);
  }

  if (path === '/api/owner-confirm' && request.method === 'POST') {
    return handleOwnerConfirmAction(request);
  }

  if (path === '/api/debug-wecom' && request.method === 'GET') {
    const upload = await MOVE_CAR_STATUS.get('debug_wecom_upload');
    const last = await MOVE_CAR_STATUS.get('debug_wecom_last');
    return new Response(JSON.stringify({ upload: upload ? JSON.parse(upload) : null, last: last ? JSON.parse(last) : null }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  if (path === '/api/check-status') {
    const status = await MOVE_CAR_STATUS.get('notify_status');
    const reply = await MOVE_CAR_STATUS.get('owner_reply') || '';
    return new Response(JSON.stringify({
      status: status || 'waiting',
      reply: reply
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  if (path === '/api/get-photo' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    // n=1 车头，n=2 车尾；旧记录只有一张图，任意 n 都返回那张
    const n = url.searchParams.get('n') === '2' ? '2' : '1';
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
      return new Response(JSON.stringify({ success: false, error: 'invalid id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // 优先读独立存储的原图；旧记录无独立 key 时回退读记录里的 photo
    let photo = await MOVE_CAR_STATUS.get('photo_' + id + '_' + n);
    if (!photo) {
      photo = await MOVE_CAR_STATUS.get('photo_' + id);
    }
    if (!photo) {
      const dateKey = `records_${getBeijingDateStr()}`;
      const rawRecords = await MOVE_CAR_STATUS.get(dateKey);
      if (rawRecords) {
        const rec = JSON.parse(rawRecords).find(r => r.id === id);
        if (rec && rec.photo) photo = rec.photo;
      }
    }
    if (!photo) {
      return new Response(JSON.stringify({ success: false, error: 'photo not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ photo }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  if (path === '/api/get-car-data') {
    const message = await MOVE_CAR_STATUS.get('notify_message') || '车旁有人等待';
    const photoBase64 = await MOVE_CAR_STATUS.get('notify_photo') || null;
    return new Response(JSON.stringify({
      message: message,
      photo: photoBase64
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  if (path === '/api/get-today-records') {
    const dateKey = `records_${getBeijingDateStr()}`;
    const rawRecords = await MOVE_CAR_STATUS.get(dateKey);
    const records = rawRecords ? JSON.parse(rawRecords) : [];
    return new Response(JSON.stringify({ records, pinRequired: Boolean(getAccessPin()) }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  if (path === '/owner-confirm') {
    return renderOwnerPage();
  }

  return renderMainPage(url.origin);
}

async function sendWeComMessage(message, confirmUrl, frontThumbBytes, rearThumbBytes) {
  try {
    const wecom = getWeComConfig();
    if (!wecom) return;

    const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(wecom.corpid)}&corpsecret=${encodeURIComponent(wecom.corpsecret)}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) return;
    const accessToken = tokenData.access_token;

    const textContent = `🚗 收到新的挪车请求
💬 留言: ${message || '无留言'}
📷 现场照片: 已上传至网页端
⏱️ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

请点击下方链接查看现场照片并回复确认：
${confirmUrl}`;

    const textBody = {
      touser: wecom.touser,
      msgtype: "text",
      agentid: wecom.agentid,
      text: { content: textContent },
      enable_duplicate_check: 0
    };

    await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(textBody)
    });

    // 随后推送现场照片（msgtype:image，应用消息接口必须先上传素材拿 media_id，不支持 base64 直传）
    const photos = [frontThumbBytes, rearThumbBytes].filter(Boolean);
    for (const bytes of photos) {
      try {
        const mediaId = await uploadWeComImage(accessToken, bytes);
        if (!mediaId) {
          await MOVE_CAR_STATUS.put('debug_wecom_last', JSON.stringify({ ts: new Date().toISOString(), step: 'upload', ok: false }), { expirationTtl: 3600 });
          continue;
        }
        const imageBody = {
          touser: wecom.touser,
          msgtype: "image",
          agentid: wecom.agentid,
          image: { media_id: mediaId }
        };
        const sendRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(imageBody)
        });
        // 记录最近一次图片推送结果，供 /api/debug-wecom 排查
        await MOVE_CAR_STATUS.put('debug_wecom_last', JSON.stringify({ ts: new Date().toISOString(), step: 'send', httpStatus: sendRes.status, body: await sendRes.text() }), { expirationTtl: 3600 });
      } catch (imgErr) {
        await MOVE_CAR_STATUS.put('debug_wecom_last', JSON.stringify({ ts: new Date().toISOString(), step: 'exception', error: String(imgErr) }), { expirationTtl: 3600 });
      }
    }
  } catch (e) {
    console.error('WeCom Exception:', e);
  }
}

// 上传临时素材（type=image，有效期 3 天）换取 media_id
async function uploadWeComImage(accessToken, bytes) {
  const boundary = '----MoveCarBoundary' + Date.now();
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=image`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body: body
  });
  const data = await res.json();
  await MOVE_CAR_STATUS.put('debug_wecom_upload', JSON.stringify({ ts: new Date().toISOString(), httpStatus: res.status, body: JSON.stringify(data).slice(0, 500) }), { expirationTtl: 3600 });
  return data.media_id || null;
}

// Cloudflare Workers 的 WebCrypto 额外支持 MD5（企业微信图片消息需要）
// （当前图片改走素材上传 media_id 方式，md5Hex 暂留备用）
async function md5Hex(bytes) {
  const digest = await crypto.subtle.digest('MD5', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 分块 base64 编码，避免大文件逐字节拼接字符串导致的性能问题
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function handleNotify(request, url) {
  try {
    // 按 IP 限流，防刷
    const allowed = await checkNotifyRateLimit(request);
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: '请求太频繁，请稍后再试' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const contentType = request.headers.get('content-type') || '';
    let message = '车旁有人等待';
    let imageBase64 = null;      // 车头原图（同时作为 notify_photo，兼容旧接口）
    let thumbBase64 = null;      // 车头缩略图
    let rearImageBase64 = null;  // 车尾原图
    let rearThumbBase64 = null;  // 车尾缩略图
    let frontThumbBytes = null;  // 车头缩略图原始字节（企微素材上传用）
    let rearThumbBytes = null;   // 车尾缩略图原始字节

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      message = formData.get('message') || '车旁有人等待';

      // 读取并处理一对文件（原图 + 可选缩略图）；缺原图返回 null
      const readPair = async (mainFile, thumbFile, label) => {
        if (!mainFile || typeof mainFile !== 'object' || mainFile.size <= 0) return null;
        if (mainFile.size > CONFIG.MAX_PHOTO_BYTES) {
          throw new Error(label + '照片过大，请重拍或换张清晰度低一点的照片');
        }
        const buffer = await mainFile.arrayBuffer();
        const full = `data:image/jpeg;base64,${bytesToBase64(new Uint8Array(buffer))}`;
        let thumb, thumbBytes;
        if (thumbFile && typeof thumbFile === 'object' && thumbFile.size > 0) {
          const tBuffer = await thumbFile.arrayBuffer();
          thumbBytes = new Uint8Array(tBuffer);
          thumb = `data:image/jpeg;base64,${bytesToBase64(thumbBytes)}`;
        } else {
          thumb = full; // 兼容旧客户端
          thumbBytes = new Uint8Array(buffer);
        }
        return { full, thumb, thumbBytes };
      };

      const front = await readPair(formData.get('image1'), formData.get('thumb1'), '车头');
      const rear = await readPair(formData.get('image2'), formData.get('thumb2'), '车尾');

      if (!front || !rear) {
        return new Response(JSON.stringify({ success: false, error: '必须上传车头和车尾两张现场照片' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      imageBase64 = front.full;
      thumbBase64 = front.thumb;
      rearImageBase64 = rear.full;
      rearThumbBase64 = rear.thumb;
      frontThumbBytes = front.thumbBytes;
      rearThumbBytes = rear.thumbBytes;
    }

    const nowMs = Date.now();
    const recordId = `${nowMs}_${Math.random().toString(36).slice(2, 8)}`;
    const confirmUrl = `${url.origin}/owner-confirm?id=${encodeURIComponent(recordId)}`;
    const timeStr = new Date(nowMs).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const dateStr = getBeijingDateStr();
    const dateKey = `records_${dateStr}`;

    await MOVE_CAR_STATUS.put('notify_status', 'waiting', { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.put('notify_message', message, { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.put('notify_photo', imageBase64, { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.put('photo_' + recordId + '_1', imageBase64, { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.put('photo_' + recordId + '_2', rearImageBase64, { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.put('active_record_id', recordId, { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.put('active_record_date', dateStr, { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.delete('owner_reply');

    const rawRecords = await MOVE_CAR_STATUS.get(dateKey);
    const records = rawRecords ? JSON.parse(rawRecords) : [];

    const newRecord = {
      id: recordId,
      createdAt: nowMs,
      time: timeStr,
      message: message,
      photo: thumbBase64, // 兼容旧前端：车头缩略图
      photos: [thumbBase64, rearThumbBase64], // [车头缩略图, 车尾缩略图]
      status: 'waiting',
      reply: '等待车主回应...'
    };
    records.unshift(newRecord);

    // 超出最大保留条数时，丢弃最旧的记录（防止当日记录数无限膨胀，也降低 KV 单值超限风险）
    const maxRecords = getMaxRecords();
    if (records.length > maxRecords) {
      records.length = maxRecords;
    }

    await MOVE_CAR_STATUS.put(dateKey, JSON.stringify(records), { expirationTtl: CONFIG.KV_TTL });

    let notifyBody = `🚗 挪车请求\n💬 留言: ${message}\n📷 [已附带现场照片]`;

    const promises = [];

    if (typeof BARK_URL !== 'undefined' && BARK_URL) {
      const barkApiUrl = `${BARK_URL}/挪车请求/${encodeURIComponent(notifyBody)}?group=MoveCar&level=critical&call=1&sound=minuet&icon=https://cdn-icons-png.flaticon.com/512/741/741407.png&url=${encodeURIComponent(confirmUrl)}`;
      promises.push(
        fetch(barkApiUrl).then(res => {
          if (!res.ok) throw new Error('Bark API Error');
        })
      );
    }

    promises.push(sendWeComMessage(message, confirmUrl, frontThumbBytes, rearThumbBytes));

    await Promise.allSettled(promises);

    return new Response(JSON.stringify({ success: true, recordId }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

async function handleOwnerConfirmAction(request) {
  let replyText = '抱歉挡了您的道，车主正飞奔而来，请稍后！';
  let targetRecordId = null;

  try {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await request.json();
      if (body.reply) {
        replyText = body.reply;
      }
      if (body.recordId) {
        targetRecordId = body.recordId;
      }

      // 鉴权：设置了 ACCESS_PIN 环境变量时，车主确认必须携带正确口令
      const requiredPin = getAccessPin();
      if (requiredPin && String(body.pin || '') !== requiredPin) {
        return new Response(JSON.stringify({ success: false, needPin: true, error: '需要访问口令' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  } catch (e) {}

  const dateStr = getBeijingDateStr();
  const dateKey = `records_${dateStr}`;
  const rawRecords = await MOVE_CAR_STATUS.get(dateKey);
  let updatedLatest = false;

  if (rawRecords) {
    const records = JSON.parse(rawRecords);
    let updated = false;

    if (targetRecordId) {
      for (let i = 0; i < records.length; i++) {
        if (records[i].id === targetRecordId) {
          records[i].status = 'confirmed';
          records[i].reply = replyText;
          records[i].confirmedAt = Date.now(); // 回复时间戳：申请页 5 分钟内专注展示该回复
          updated = true;
          if (i === 0) updatedLatest = true;
          break;
        }
      }
    }

    if (!updated && records.length > 0) {
      records[0].status = 'confirmed';
      records[0].reply = replyText;
      records[0].confirmedAt = Date.now();
      updatedLatest = true;
    }

    await MOVE_CAR_STATUS.put(dateKey, JSON.stringify(records), { expirationTtl: CONFIG.KV_TTL });
  }

  const activeRecordId = await MOVE_CAR_STATUS.get('active_record_id');
  if (updatedLatest || !targetRecordId || targetRecordId === activeRecordId) {
    await MOVE_CAR_STATUS.put('notify_status', 'confirmed', { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.put('owner_reply', replyText, { expirationTtl: CONFIG.KV_TTL });
  }

  return new Response(JSON.stringify({ success: true, recordId: targetRecordId, reply: replyText }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function renderMainPage(origin) {
  const phone = typeof PHONE_NUMBER !== 'undefined' ? String(PHONE_NUMBER).trim() : '';
  const phoneOnlyMode = Boolean(phone) && !hasAnyNotifyChannel();

  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#0093E9">
    <title>通知车主挪车</title>
    <style>
      :root {
        --sat: env(safe-area-inset-top, 0px);
        --sar: env(safe-area-inset-right, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --sal: env(safe-area-inset-left, 0px);
      }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
      html { font-size: 16px; -webkit-text-size-adjust: 100%; }
      html, body { height: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%);
        min-height: 100vh;
        min-height: -webkit-fill-available;
        padding: clamp(16px, 4vw, 24px);
        padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
        padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
        display: flex;
        justify-content: center;
        align-items: flex-start;
      }
      .container {
        width: 100%;
        max-width: 500px;
        display: flex;
        flex-direction: column;
        gap: clamp(12px, 3vw, 20px);
      }
      .card {
        background: rgba(255, 255, 255, 0.95);
        border-radius: clamp(20px, 5vw, 28px);
        padding: clamp(18px, 4vw, 28px);
        box-shadow: 0 10px 40px rgba(0, 147, 233, 0.2);
      }
      .header {
        text-align: center;
        padding: clamp(20px, 5vw, 32px) clamp(16px, 4vw, 28px);
        background: white;
      }
      .icon-wrap {
        width: clamp(72px, 18vw, 100px);
        height: clamp(72px, 18vw, 100px);
        background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
        border-radius: clamp(22px, 5vw, 32px);
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto clamp(14px, 3vw, 24px);
        box-shadow: 0 12px 32px rgba(0, 147, 233, 0.35);
      }
      .icon-wrap span { font-size: clamp(36px, 9vw, 52px); }
      .header h1 {
        font-size: clamp(22px, 5.5vw, 30px);
        font-weight: 700;
        color: #1a202c;
        margin-bottom: 6px;
      }
      .header p {
        font-size: clamp(13px, 3.5vw, 16px);
        color: #718096;
        font-weight: 500;
      }
      .direct-call-card {
        text-align: center;
        background: white;
        border: 2px solid #fecaca;
      }
      .direct-call-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        padding: 15px 18px;
        border-radius: 16px;
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        color: white;
        font-size: 17px;
        font-weight: 700;
        text-decoration: none;
        box-shadow: 0 8px 24px rgba(239, 68, 68, 0.3);
      }
      .direct-call-sub {
        margin-top: 8px;
        font-size: 12px;
        color: #64748b;
      }
      .input-card { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
      .input-card textarea {
        width: 100%;
        min-height: clamp(90px, 20vw, 120px);
        border: none;
        padding: clamp(16px, 4vw, 24px);
        font-size: clamp(15px, 4vw, 18px);
        font-family: inherit;
        resize: none;
        outline: none;
        color: #2d3748;
        background: transparent;
        line-height: 1.5;
      }
      .input-card textarea::placeholder { color: #a0aec0; }
      .photo-upload-wrap {
        padding: 0 clamp(16px, 4vw, 24px) clamp(16px, 4vw, 24px);
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .photo-btn {
        background: #e0f2fe;
        color: #0369a1;
        border: 1px dashed #38bdf8;
        padding: 10px 16px;
        border-radius: 12px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s;
      }
      .photo-btn:active { background: #bae6fd; }
      .photo-upload-wrap input[type="file"] { display: none !important; }
      .photo-preview-text {
        font-size: 13px;
        color: #0369a1;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tags {
        display: flex;
        gap: clamp(6px, 2vw, 10px);
        padding: 0 clamp(12px, 3vw, 20px) clamp(14px, 3vw, 20px);
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .tags::-webkit-scrollbar { display: none; }
      .tag {
        background: linear-gradient(135deg, #e0f7fa 0%, #b2ebf2 100%);
        color: #00796b;
        padding: clamp(8px, 2vw, 12px) clamp(12px, 3vw, 18px);
        border-radius: 20px;
        font-size: clamp(13px, 3.5vw, 15px);
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
        border: 1px solid #80cbc4;
        min-height: 44px;
        display: flex;
        align-items: center;
      }
      .btn-main {
        background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
        color: white;
        border: none;
        padding: clamp(16px, 4vw, 22px);
        border-radius: clamp(16px, 4vw, 22px);
        font-size: clamp(16px, 4.2vw, 20px);
        font-weight: 700;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 10px;
        box-shadow: 0 10px 30px rgba(0, 147, 233, 0.35);
        min-height: 56px;
      }
      .btn-main:active { transform: scale(0.98); }
      .btn-main:disabled {
        background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%);
        box-shadow: none;
        cursor: not-allowed;
      }
      .toast {
        position: fixed;
        top: calc(20px + var(--sat));
        left: 50%;
        transform: translateX(-50%) translateY(-100px);
        background: white;
        padding: clamp(12px, 3vw, 16px) clamp(20px, 5vw, 32px);
        border-radius: 16px;
        font-size: clamp(14px, 3.5vw, 16px);
        font-weight: 600;
        color: #e11d48;
        box-shadow: 0 10px 40px rgba(0,0,0,0.15);
        opacity: 0;
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        z-index: 100;
      }
      .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      #successView { display: none; }

      .success-card {
        text-align: center;
        background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
        border: 2px solid #28a745;
      }
      .success-icon { font-size: clamp(56px, 14vw, 80px); margin-bottom: 12px; display: block; }
      .success-card h2 { color: #155724; margin-bottom: 8px; font-size: clamp(20px, 5vw, 28px); }
      .success-card p { color: #1e7e34; font-size: clamp(14px, 3.5vw, 16px); }
      .waiting-tip {
        margin-top: 10px;
        font-size: 12px !important;
        color: #166534 !important;
        opacity: 0.9;
        line-height: 1.45;
      }

      .owner-card { background: white; border: 2px solid #80D0C7; text-align: center; }
      .owner-card.hidden { display: none; }
      .hidden { display: none !important; }
      .retake-title { font-size: 15px; font-weight: 700; color: #1e293b; text-align: center; padding: 14px 16px 4px; }
      .retake-sub { font-size: 12px; color: #64748b; text-align: center; padding: 0 16px 12px; }
      .owner-card h3 { color: #0093E9; margin-bottom: 6px; font-size: clamp(20px, 5vw, 26px); }
      .owner-card p { color: #475569; font-size: clamp(14px, 3.8vw, 16px); line-height: 1.4; padding: 0 8px; }

      .history-card { background: rgba(255, 255, 255, 0.95); border-radius: 20px; padding: 18px; margin-top: 10px; }
      .history-card h3 { font-size: 16px; color: #1e293b; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
      .refresh-btn {
        background: #f1f5f9; border: none; border-radius: 50%;
        width: 30px; height: 30px; font-size: 15px; line-height: 1;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        color: #475569; flex-shrink: 0; transition: background 0.2s, transform 0.2s;
      }
      .refresh-btn:hover { background: #e2e8f0; }
      .refresh-btn:active { transform: scale(0.9); }
      @keyframes refreshSpin { to { transform: rotate(360deg); } }
      .refresh-btn.refreshing > span { display: inline-block; animation: refreshSpin 0.8s linear infinite; }
      .refresh-btn.refreshing { pointer-events: none; opacity: 0.7; }
      .history-list { display: flex; flex-direction: column; gap: 10px; }
      .history-item { background: #f8fafc; border-radius: 12px; padding: 10px 12px; font-size: 13px; border-left: 3px solid #0093E9; display: flex; gap: 10px; align-items: center; }
      .history-thumb { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: #e2e8f0; }
      .history-info { flex: 1; min-width: 0; }
      .history-time { color: #64748b; font-size: 11px; margin-bottom: 2px; }
      .history-msg { color: #334155; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .history-reply { color: #0284c7; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* 车主最新回复专注展示（回复后 5 分钟内只显示这条回复） */
      .reply-focus {
        background: linear-gradient(135deg, #eff6ff 0%, #f0fdfa 100%);
        border: 1.5px solid #bae6fd;
        border-radius: 14px;
        padding: 20px 16px;
        text-align: center;
      }
      .reply-focus .rf-badge { font-size: 11px; color: #0284c7; font-weight: 700; letter-spacing: 1px; }
      .reply-focus .rf-emoji { font-size: 30px; display: block; margin: 8px 0 4px; }
      .reply-focus .rf-text { font-size: 17px; font-weight: 700; color: #0f172a; margin: 4px 0 8px; line-height: 1.5; }
      .reply-focus .rf-time { font-size: 12px; color: #64748b; }
      .reply-focus .rf-hint { font-size: 11px; color: #94a3b8; margin-top: 10px; }
      .history-empty { text-align: center; color: #94a3b8; font-size: 13px; padding: 10px 0; }

      .load-more-btn {
        width: 100%; margin-top: 12px; padding: 10px; border-radius: 12px;
        background: #f1f5f9; color: #0284c7; border: 1px dashed #38bdf8;
        font-size: 13px; font-weight: 600; cursor: pointer; display: none;
        align-items: center; justify-content: center; gap: 4px; transition: all 0.2s;
      }
      .load-more-btn:active { background: #e0f2fe; }

      .action-card { display: flex; flex-direction: column; gap: 10px; }
      .action-hint { text-align: center; font-size: 13px; color: #718096; display: none; }
      .action-hint.show { display: block; }

      .btn-retry, .btn-phone, .btn-back {
        color: white; border: none; padding: 14px; border-radius: 14px;
        font-size: 16px; font-weight: 700; cursor: pointer; display: flex;
        align-items: center; justify-content: center; gap: 8px; text-decoration: none;
      }
      .btn-retry { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }
      .btn-retry:disabled { opacity: 0.6; }
      .btn-back { background: #64748b; font-size: 15px; padding: 12px; }

      .btn-phone {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        display: none;
      }
      .btn-phone.show { display: flex; }

      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .loading-text { animation: pulse 1.5s ease-in-out infinite; }
    </style>
  </head>
  <body>
    <div id="toast" class="toast"></div>

    <div class="container" id="mainView">
      <div class="history-card">
        <h3>
          <span>📋 今日挪车记录</span>
          <span style="display:flex; align-items:center; gap:8px;">
            <span id="historyCount" style="font-size:12px; font-weight:normal; color:#64748b;"></span>
            <button id="refreshHistoryBtn" class="refresh-btn" onclick="refreshTodayRecords()" aria-label="刷新记录"><span>🔄</span></button>
          </span>
        </h3>
        <div id="historyList" class="history-list">
          <div class="history-empty">加载中...</div>
        </div>
        <button id="loadMoreBtn" class="load-more-btn" onclick="loadMoreRecords()">
          <span>🔽 查看更多记录 (每次3条)</span>
        </button>
      </div>

      ${phoneOnlyMode ? `
      <div class="card direct-call-card">
        <a href="tel:${phone}" class="direct-call-btn">
          <span>📞</span>
          <span>电话联系车主</span>
        </a>
        <p class="direct-call-sub">当前仅配置了车主联系电话，点击可直接拨号</p>
      </div>
      ` : ''}

      <div class="card input-card">
        <textarea id="msgInput" placeholder="输入留言给车主...（可选）"></textarea>

        <div class="photo-upload-wrap">
          <button type="button" class="photo-btn" onclick="document.getElementById('photoInput1').click()">
            <span>📷</span> <span>拍摄车头照片 *</span>
          </button>
          <input type="file" id="photoInput1" accept="image/*" capture="environment" onchange="handlePhotoSelect(this, 1)" />
          <span id="photoFileName1" class="photo-preview-text" style="color:#e11d48">⚠️ 未上传</span>
        </div>

        <div class="photo-upload-wrap">
          <button type="button" class="photo-btn" onclick="document.getElementById('photoInput2').click()">
            <span>📷</span> <span>拍摄车尾照片 *</span>
          </button>
          <input type="file" id="photoInput2" accept="image/*" capture="environment" onchange="handlePhotoSelect(this, 2)" />
          <span id="photoFileName2" class="photo-preview-text" style="color:#e11d48">⚠️ 未上传</span>
        </div>

        <div class="tags">
          <div class="tag" onclick="addTag('您的车挡住我了')">🚧 挡路</div>
          <div class="tag" onclick="addTag('临时停靠一下')">⏱️ 临停</div>
          <div class="tag" onclick="addTag('电话打不通')">📞 没接</div>
          <div class="tag" onclick="addTag('麻烦尽快')">🙏 加急</div>
        </div>
      </div>

      <button id="notifyBtn" class="card btn-main" onclick="sendNotify()">
        <span>🔔</span>
        <span>一键通知车主</span>
      </button>
    </div>

    <div class="container" id="successView">
      <div id="waitingCard" class="card success-card">
        <span class="success-icon">⏳</span>
        <h2>通知已发送！</h2>
        <p class="loading-text">正在等待车主回应...</p>
        <p class="waiting-tip">若页面长时间未变化，请稍后刷新查看申请页记录！</p>
      </div>

      <div id="ownerFeedback" class="card owner-card hidden">
        <span id="replyEmoji" style="font-size:56px; display:block; margin-bottom:10px">🏃‍♂️</span>
        <h3 id="replyTitle">车主正飞奔赶来</h3>
        <p id="ownerReplyText" style="margin-top: 6px;">正在赶来！</p>
      </div>

      <div id="retakeCard" class="card input-card hidden">
        <p class="retake-title">📷 车主看不清照片，请重新拍摄</p>
        <p class="retake-sub">重新拍摄车头、车尾两张照片后才能再次通知车主</p>

        <div class="photo-upload-wrap">
          <button type="button" class="photo-btn" onclick="document.getElementById('photoInputR1').click()">
            <span>📷</span> <span>拍摄车头照片 *</span>
          </button>
          <input type="file" id="photoInputR1" accept="image/*" capture="environment" onchange="handlePhotoSelect(this, 1, 'R')" />
          <span id="photoFileNameR1" class="photo-preview-text" style="color:#e11d48">⚠️ 未上传</span>
        </div>

        <div class="photo-upload-wrap">
          <button type="button" class="photo-btn" onclick="document.getElementById('photoInputR2').click()">
            <span>📷</span> <span>拍摄车尾照片 *</span>
          </button>
          <input type="file" id="photoInputR2" accept="image/*" capture="environment" onchange="handlePhotoSelect(this, 2, 'R')" />
          <span id="photoFileNameR2" class="photo-preview-text" style="color:#e11d48">⚠️ 未上传</span>
        </div>
      </div>

      <div class="card action-card">
        <p id="actionHint" class="action-hint">车主没反应？试试其他方式</p>
        <button id="retryBtn" class="btn-retry" onclick="handleRetryClick()">
          <span>🔔</span>
          <span>再次通知</span>
        </button>
        <button id="backMainBtn" class="btn-back" onclick="backToMainView()">
          <span>← 返回申请页</span>
        </button>
        <a id="phoneBtn" href="tel:${phone}" class="btn-phone">
          <span>📞</span>
          <span>直接打电话</span>
        </a>
      </div>
    </div>

    <script>
      let checkTimer = null;
      let selectedPhotos = { 1: null, 2: null }; // 1=车头 2=车尾
      let retryCount = 0;
      let allRecords = [];
      let visibleLimit = 3;
      let lastRetryTime = 0;
      let retryCooldownTimer = null;
      const RETRY_COOLDOWN_MS = 30 * 1000; // 再次通知间隔 30 秒
      // 最新挪车记录 1 分钟内：锁定“一键通知车主”按钮防重复发送
      const NOTIFY_LOCK_MS = 60 * 1000;
      let notifyLockTimer = null;

      // 是否为“车主要求重新拍摄”类回复
      function isRetakeReply(reply) {
        return typeof reply === 'string' && (reply.includes('换个角度') || reply.includes('重新拍摄'));
      }

      // 根据最新记录时间计算锁定状态（每次拉完记录后调用，刷新页面也不失效）
      // 例外：最新记录的回复是“请重新拍摄现场照片”类时，主页按钮不锁定
      //（返回主页后可直接再次通知，未重新上传照片仍由 sendNotify/handleRetryClick 拦截）
      function updateNotifyLock() {
        const btn = document.getElementById('notifyBtn');
        if (notifyLockTimer) {
          clearInterval(notifyLockTimer);
          notifyLockTimer = null;
        }
        let latest = null;
        for (const r of allRecords) {
          if (!latest || (r.createdAt || 0) > (latest.createdAt || 0)) latest = r;
        }
        if (latest && isRetakeReply(latest.reply)) {
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>一键通知车主</span>';
          return;
        }
        const remainMs = latest && latest.createdAt ? NOTIFY_LOCK_MS - (Date.now() - latest.createdAt) : 0;
        if (remainMs > 0) {
          let remainSec = Math.ceil(remainMs / 1000);
          btn.disabled = true;
          btn.innerHTML = \`⏳ 刚刚已通知车主，\${remainSec}s 后可再次通知\`;
          notifyLockTimer = setInterval(() => {
            remainSec--;
            if (remainSec <= 0) {
              clearInterval(notifyLockTimer);
              notifyLockTimer = null;
              btn.disabled = false;
              btn.innerHTML = '<span>🔔</span><span>一键通知车主</span>';
            } else {
              btn.innerHTML = \`⏳ 刚刚已通知车主，\${remainSec}s 后可再次通知\`;
            }
          }, 1000);
        } else {
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>一键通知车主</span>';
        }
      }

      window.onload = () => {
        loadTodayRecords();
        restoreRetryCooldown();
      };

      // 刷新/重新打开页面后，从 localStorage 恢复“再次通知”的 30 秒冷却剩余时间
      function restoreRetryCooldown() {
        const saved = parseInt(localStorage.getItem('movecar_last_retry') || '0', 10);
        if (!saved) return;
        lastRetryTime = saved;
        const remainMs = saved + RETRY_COOLDOWN_MS - Date.now();
        if (remainMs > 0) {
          startRetryCooldown(Math.ceil(remainMs / 1000));
        }
      }

      // 前端压缩照片，同时生成两档：
      //   full  ：最长边 1600px / 质量 0.75（存 KV 供查看大图）
      //   thumb ：最长边 320px  / 质量 0.6（随记录存 KV，列表展示，大幅减小接口流量）
      function compressImage(file, maxDim = 1600, quality = 0.75) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          const objectUrl = URL.createObjectURL(file);
          img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            const draw = (maxSide, q, cb) => {
              let { width, height } = img;
              const scale = Math.min(1, maxSide / Math.max(width, height));
              width = Math.round(width * scale);
              height = Math.round(height * scale);
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d');
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, width, height);
              ctx.drawImage(img, 0, 0, width, height);
              canvas.toBlob(
                blob => cb(blob),
                'image/jpeg',
                q
              );
            };
            draw(maxDim, quality, fullBlob => {
              if (!fullBlob) { reject(new Error('照片压缩失败')); return; }
              draw(320, 0.6, thumbBlob => {
                if (!thumbBlob) { reject(new Error('缩略图生成失败')); return; }
                resolve({ full: fullBlob, thumb: thumbBlob });
              });
            });
          };
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('无法读取照片，请重拍'));
          };
          img.src = objectUrl;
        });
      }

      function shouldUnlockPhoneButton(records) {
        if (!Array.isArray(records) || records.length < 3) return false;
        const unansweredCount = records.filter(r => r.status !== 'confirmed').length;
        if (unansweredCount < 3) return false;

        const latestThree = records.slice(0, 3);
        if (!latestThree.every(r => r.status !== 'confirmed' && typeof r.createdAt === 'number')) {
          return false;
        }

        const sortedByTime = [...latestThree].sort((a, b) => a.createdAt - b.createdAt);
        return (sortedByTime[2].createdAt - sortedByTime[0].createdAt) > 60000;
      }

      function evaluatePhoneEscalation(records) {
        if (shouldUnlockPhoneButton(records) || retryCount >= 3) {
          document.getElementById('actionHint').classList.add('show');
          document.getElementById('phoneBtn').classList.add('show');
        }
      }

      async function loadTodayRecords() {
        try {
          const res = await fetch('/api/get-today-records');
          const data = await res.json();
          allRecords = data.records || [];
          document.getElementById('historyCount').innerText = allRecords.length > 0 ? \`共 \${allRecords.length} 条\` : '';
          evaluatePhoneEscalation(allRecords);
          renderRecords();
          updateNotifyLock();
          return true;
        } catch (e) {
          document.getElementById('historyList').innerHTML = '<div class="history-empty">加载记录失败</div>';
          return false;
        }
      }

      // 手动刷新今日挪车记录（重置分页，转圈反馈）
      let isRefreshingHistory = false;
      async function refreshTodayRecords() {
        if (isRefreshingHistory) return;
        isRefreshingHistory = true;
        const btn = document.getElementById('refreshHistoryBtn');
        btn.classList.add('refreshing');
        visibleLimit = 3;
        const ok = await loadTodayRecords();
        btn.classList.remove('refreshing');
        isRefreshingHistory = false;
        showToast(ok ? '🔄 已更新最新记录' : '❌ 刷新失败，请稍后再试');
      }

      // 车主回复后 5 分钟内：申请页专注展示最新回复，超过 5 分钟恢复正常列表
      const REPLY_FOCUS_MS = 5 * 60 * 1000;
      let replyFocusTimer = null;

      function getFocusedReply() {
        let latest = null;
        for (const r of allRecords) {
          if (r.status === 'confirmed' && r.reply && r.confirmedAt) {
            if (!latest || r.confirmedAt > latest.confirmedAt) latest = r;
          }
        }
        if (latest && Date.now() - latest.confirmedAt < REPLY_FOCUS_MS) return latest;
        return null;
      }

      function renderRecords() {
        const listEl = document.getElementById('historyList');
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        clearTimeout(replyFocusTimer);

        if (allRecords.length === 0) {
          listEl.innerHTML = '<div class="history-empty">今日暂无挪车记录</div>';
          loadMoreBtn.style.display = 'none';
          return;
        }

        // 5 分钟内有车主回复：只显示最新回复内容（隐藏其余记录和查看更多）
        const focus = getFocusedReply();
        if (focus) {
          listEl.innerHTML = \`
            <div class="reply-focus">
              <div class="rf-badge">—— 车主最新回复 ——</div>
              <span class="rf-emoji">💬</span>
              <div class="rf-text">\${escapeHtml(focus.reply)}</div>
              <div class="rf-time">回复时间 \${new Date(focus.confirmedAt).toLocaleTimeString('zh-CN', { hour12: false })}</div>
              <div class="rf-hint">⏱ 专注展示中，稍后自动恢复完整记录列表</div>
            </div>\`;
          loadMoreBtn.style.display = 'none';
          // 时间窗口过期后自动切回正常列表（多刷新一次开销极小）
          const remainMs = REPLY_FOCUS_MS - (Date.now() - focus.confirmedAt);
          replyFocusTimer = setTimeout(renderRecords, remainMs + 500);
          return;
        }

        const showRecords = allRecords.slice(0, visibleLimit);
        listEl.innerHTML = showRecords.map(r => \`
          <div class="history-item">
            \${((r.photos && r.photos.length ? r.photos : [r.photo]).filter(Boolean)).map(p => \`<img src="\${p}" class="history-thumb" alt="照片" />\`).join('')}
            <div class="history-info">
              <div class="history-time">\${r.time}</div>
              <div class="history-msg">💬 \${escapeHtml(r.message || '无留言')}</div>
              <div class="history-reply">👉 \${escapeHtml(r.reply)}</div>
            </div>
          </div>
        \`).join('');

        if (allRecords.length > visibleLimit) {
          loadMoreBtn.style.display = 'flex';
        } else {
          loadMoreBtn.style.display = 'none';
        }
      }

      function loadMoreRecords() {
        visibleLimit += 3;
        renderRecords();
      }

      function handlePhotoSelect(input, idx, suffix) {
        suffix = suffix || '';
        const el = document.getElementById('photoFileName' + suffix + idx);
        // 重拍区选择时，同步更新申请页对应状态显示
        const mainEl = suffix ? document.getElementById('photoFileName' + idx) : null;
        if (input.files && input.files[0]) {
          selectedPhotos[idx] = input.files[0];
          if (el) { el.innerText = selectedPhotos[idx].name; el.style.color = '#059669'; }
          if (mainEl) { mainEl.innerText = selectedPhotos[idx].name; mainEl.style.color = '#059669'; }
        } else {
          selectedPhotos[idx] = null;
          if (el) { el.innerText = '⚠️ 未上传'; el.style.color = '#e11d48'; }
          if (mainEl) { mainEl.innerText = '⚠️ 未上传'; mainEl.style.color = '#e11d48'; }
        }
      }

      // 重置指定区（''=申请页，'R'=重拍区）的照片状态显示
      function resetPhotoLabels(suffix) {
        for (const idx of [1, 2]) {
          const el = document.getElementById('photoFileName' + suffix + idx);
          if (el) { el.innerText = '⚠️ 未上传'; el.style.color = '#e11d48'; }
        }
      }

      function addTag(text) { document.getElementById('msgInput').value = text; }

      async function sendNotify() {
        if (!selectedPhotos[1] || !selectedPhotos[2]) {
          showToast('❌ 请分别拍摄车头和车尾两张照片！');
          return;
        }

        const msg = document.getElementById('msgInput').value;
        const btn = document.getElementById('notifyBtn');

        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';

        try {
          const formData = new FormData();
          formData.append('message', msg);

          // 两张照片分别压缩后上传：image1/thumb1=车头，image2/thumb2=车尾
          const labels = { 1: '车头', 2: '车尾' };
          for (const idx of [1, 2]) {
            let photoBlob, thumbBlob;
            try {
              const compressed = await compressImage(selectedPhotos[idx]);
              photoBlob = compressed.full;
              thumbBlob = compressed.thumb;
            } catch (compressErr) {
              // 兼容极少数不支持 canvas 压缩的浏览器：原文件直传
              photoBlob = selectedPhotos[idx];
              thumbBlob = selectedPhotos[idx];
            }
            formData.append('image' + idx, photoBlob, 'photo' + idx + '.jpg');
            formData.append('thumb' + idx, thumbBlob, 'thumb' + idx + '.jpg');
          }

          const res = await fetch('/api/notify', {
            method: 'POST',
            body: formData
          });

          const data = await res.json();

          if (res.ok && data.success) {
            showToast('✅ 发送成功！');
            await loadTodayRecords();
            document.getElementById('mainView').style.display = 'none';
            document.getElementById('successView').style.display = 'flex';
            // 新一轮等待：恢复等待卡片、隐藏上次的车主回复和重拍上传区
            document.getElementById('waitingCard').style.display = '';
            document.getElementById('ownerFeedback').classList.add('hidden');
            document.getElementById('retakeCard').classList.add('hidden');
            // 新发起通知后，重置“再次通知”按钮状态（锁定由最新记录时间控制）
            const retryBtnEl = document.getElementById('retryBtn');
            if (retryCooldownTimer) {
              clearInterval(retryCooldownTimer);
              retryCooldownTimer = null;
            }
            retryBtnEl.style.display = 'flex';
            retryBtnEl.disabled = false;
            retryBtnEl.style.opacity = '';
            retryBtnEl.style.cursor = '';
            retryBtnEl.innerHTML = '<span>🔔</span><span>再次通知</span>';
            document.getElementById('retakeCard').classList.add('hidden');
            document.getElementById('actionHint').classList.remove('show');
            startPolling();
          } else {
            throw new Error(data.error || 'API Error');
          }
        } catch (e) {
          showToast('❌ ' + (e.message || '发送失败，请重试'));
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>一键通知车主</span>';
        }
      }

      function handleRetryClick() {
        // 未上传照片时禁止再次通知（车主要求重拍后必须先重新拍摄）
        if (!selectedPhotos[1] || !selectedPhotos[2]) {
          showToast('❌ 请先重新拍摄车头和车尾两张照片！');
          return;
        }
        // 冷却检查：距离上次点击不足 30 秒则拦截
        if (Date.now() - lastRetryTime < RETRY_COOLDOWN_MS) {
          const remainSec = Math.ceil((RETRY_COOLDOWN_MS - (Date.now() - lastRetryTime)) / 1000);
          showToast(\`⏳ 通知太频繁，请等待 \${remainSec} 秒后再试\`);
          return;
        }

        lastRetryTime = Date.now();
        localStorage.setItem('movecar_last_retry', String(lastRetryTime));
        startRetryCooldown();

        retryCount++;
        if (retryCount >= 3) {
          document.getElementById('actionHint').classList.add('show');
          document.getElementById('phoneBtn').classList.add('show');
          showToast('📞 已解锁直接打电话选项');
        } else {
          showToast(\`🔔 已再次通知 (\${retryCount}/3)\`);
        }
        sendNotify();
      }

      // 再次通知按钮 30 秒冷却倒计时（initSec 可选：页面刷新后恢复剩余秒数）
      function startRetryCooldown(initSec) {
        const btn = document.getElementById('retryBtn');
        if (retryCooldownTimer) clearInterval(retryCooldownTimer);
        let remainSec = initSec && initSec > 0 ? initSec : Math.ceil(RETRY_COOLDOWN_MS / 1000);
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'not-allowed';
        btn.innerHTML = \`⏳ 再次通知 (\${remainSec}s)\`;
        retryCooldownTimer = setInterval(() => {
          remainSec--;
          if (remainSec <= 0) {
            clearInterval(retryCooldownTimer);
            retryCooldownTimer = null;
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.cursor = '';
            btn.innerHTML = '<span>🔔</span><span>再次通知</span>';
          } else {
            btn.innerHTML = \`⏳ 再次通知 (\${remainSec}s)\`;
          }
        }, 1000);
      }

      function backToMainView() {
        if (checkTimer) {
          clearInterval(checkTimer);
          checkTimer = null;
        }
        document.getElementById('successView').style.display = 'none';
        document.getElementById('mainView').style.display = 'flex';
        // 锁定状态由 loadTodayRecords → updateNotifyLock 按最新记录时间计算，刷新页面也不失效
        loadTodayRecords();
      }

      function startPolling() {
        if (checkTimer) clearInterval(checkTimer);
        let count = 0;
        checkTimer = setInterval(async () => {
          count++;
          if (count > 120) { clearInterval(checkTimer); return; }
          try {
            const res = await fetch('/api/check-status');
            const data = await res.json();
            if (data.status === 'confirmed') {
              document.getElementById('waitingCard').style.display = 'none';

              if (data.reply) {
                document.getElementById('ownerReplyText').innerText = data.reply;
                const emojiEl = document.getElementById('replyEmoji');
                const titleEl = document.getElementById('replyTitle');

                if (data.reply.includes('飞奔而来')) {
                  emojiEl.innerText = '🏃‍♂️';
                  titleEl.innerText = '车主正飞奔赶来';
                } else if (isRetakeReply(data.reply)) {
                  emojiEl.innerText = '📷';
                  titleEl.innerText = '请重新拍摄现场照片';
                } else if (data.reply.includes('没挡您的道')) {
                  emojiEl.innerText = '🛑';
                  titleEl.innerText = '车主反馈未挡道';
                }
              }

              const fb = document.getElementById('ownerFeedback');
              fb.classList.remove('hidden');
              clearInterval(checkTimer);

              // 车主已回复：按回复内容决定“再次通知”按钮状态
              const retryBtnEl = document.getElementById('retryBtn');
              const isRetakeRequest = isRetakeReply(data.reply);
              if (retryCooldownTimer) {
                clearInterval(retryCooldownTimer);
                retryCooldownTimer = null;
              }
              if (isRetakeRequest) {
                // 车主要求重新拍摄：清空已选照片，在等待页显示重新上传区，未重拍不能再次通知
                selectedPhotos = { 1: null, 2: null };
                document.getElementById('photoInput1').value = '';
                document.getElementById('photoInput2').value = '';
                resetPhotoLabels('');
                resetPhotoLabels('R');
                document.getElementById('retakeCard').classList.remove('hidden');
                retryBtnEl.style.display = 'flex';
                retryBtnEl.disabled = false;
                retryBtnEl.style.opacity = '';
                retryBtnEl.style.cursor = '';
                retryBtnEl.innerHTML = '<span>📷</span><span>重新拍照并通知车主</span>';
                showToast('📷 车主看不清照片，请重新拍摄车头和车尾照片');
              } else {
                // 其他回复：不提供再次通知入口，避免重复催促（按钮由最新记录时间 1 分钟锁定控制）
                document.getElementById('retakeCard').classList.add('hidden');
                retryBtnEl.style.display = 'none';
              }
              document.getElementById('actionHint').classList.remove('show');
              if(navigator.vibrate) navigator.vibrate([200, 100, 200]);
            }
          } catch(e) {}
        }, 3000);
      }

      function showToast(text) {
        const t = document.getElementById('toast');
        t.innerText = text;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
      }

      function escapeHtml(str) {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function renderOwnerPage() {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#667eea">
    <title>确认挪车</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
      html { font-size: 16px; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(160deg, #667eea 0%, #764ba2 100%);
        min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
        padding: 20px;
      }
      .card {
        background: rgba(255,255,255,0.96); padding: 24px; border-radius: 28px;
        text-align: center; width: 100%; max-width: 440px; box-shadow: 0 20px 60px rgba(102, 126, 234, 0.3);
      }
      .emoji { font-size: 46px; margin-bottom: 8px; display: block; }
      h1 { font-size: 22px; color: #2d3748; margin-bottom: 4px; }
      .subtitle { color: #718096; font-size: 13px; margin-bottom: 16px; }

      .section-title {
        font-size: 13px; font-weight: 700; color: #475569; text-align: left;
        margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;
      }
      .refresh-btn {
        background: #f1f5f9; border: none; border-radius: 50%;
        width: 30px; height: 30px; font-size: 15px; line-height: 1;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        color: #475569; flex-shrink: 0; transition: background 0.2s, transform 0.2s;
      }
      .refresh-btn:hover { background: #e2e8f0; }
      .refresh-btn:active { transform: scale(0.9); }
      @keyframes refreshSpin { to { transform: rotate(360deg); } }
      .refresh-btn.refreshing > span { display: inline-block; animation: refreshSpin 0.8s linear infinite; }
      .refresh-btn.refreshing { pointer-events: none; opacity: 0.7; }

      .toast {
        position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%) translateY(20px);
        background: rgba(15, 23, 42, 0.92); color: white; padding: 10px 20px;
        border-radius: 999px; font-size: 14px; opacity: 0; pointer-events: none;
        transition: opacity 0.3s, transform 0.3s; z-index: 1100; white-space: nowrap;
      }
      .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

      .record-selector {
        display: flex; flex-direction: column; gap: 8px; text-align: left;
      }
      .rec-item {
        background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 12px;
        padding: 10px 12px; cursor: pointer; transition: all 0.15s;
        display: flex; align-items: center; gap: 10px;
      }
      .rec-item:hover { border-color: #a5b4fc; }
      .rec-item.selected {
        background: #eef2ff; border-color: #6366f1;
        box-shadow: 0 2px 8px rgba(99, 102, 241, 0.15);
      }
      .rec-thumb {
        width: 40px; height: 40px; border-radius: 8px; object-fit: cover;
        flex-shrink: 0; background: #e2e8f0;
      }
      .rec-meta { flex: 1; min-width: 0; }
      .rec-top { display: flex; justify-content: space-between; align-items: center; font-size: 12px; margin-bottom: 2px; }
      .rec-time { color: #64748b; font-weight: 600; }
      .rec-badge { font-size: 11px; padding: 1px 6px; border-radius: 6px; font-weight: 600; }
      .badge-wait { background: #fef3c7; color: #b45309; }
      .badge-done { background: #d1fae5; color: #065f46; }
      .rec-msg { font-size: 13px; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .load-more-btn {
        width: 100%; margin-top: 8px; margin-bottom: 14px; padding: 8px; border-radius: 10px;
        background: #f1f5f9; color: #4f46e5; border: 1px dashed #a5b4fc;
        font-size: 12px; font-weight: 600; cursor: pointer; display: none;
        align-items: center; justify-content: center; gap: 4px; transition: all 0.2s;
      }
      .load-more-btn:active { background: #e0e7ff; }

      .message-box {
        background: #f8fafc; border-radius: 12px; padding: 12px; margin-top: 6px; margin-bottom: 14px;
        text-align: left; font-size: 14px; color: #475569; border-left: 4px solid #667eea;
      }

      .photo-container {
        margin-bottom: 16px; border-radius: 12px; overflow: hidden; display: none; background: #eee;
        border: 1px solid #e2e8f0;
      }
      .photo-container.show { display: block; }
      .photo-container img { width: 100%; height: auto; display: block; max-height: 220px; object-fit: cover; }
      .photo-label {
        font-size: 12px; font-weight: 700; color: #475569;
        padding: 8px 10px 4px; text-align: left;
      }

      .quick-replies {
        display: flex; gap: 8px; margin-bottom: 16px; justify-content: center;
      }
      .qr-btn {
        flex: 1; padding: 10px 4px; border-radius: 12px; font-size: 14px; font-weight: 600;
        cursor: pointer; border: 1px solid #cbd5e1; background: #f8fafc; color: #334155;
        transition: all 0.2s;
      }
      .qr-btn:active { background: #e2e8f0; }
      .qr-btn.active { background: #e0e7ff; border-color: #6366f1; color: #4f46e5; }

      .btn {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        color: white; border: none; width: 100%; padding: 16px; border-radius: 16px;
        font-size: 17px; font-weight: 700; cursor: pointer; box-shadow: 0 8px 24px rgba(16, 185, 129, 0.35);
      }
      .btn:disabled { opacity: 0.7; cursor: not-allowed; }
      .done-msg {
        background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%);
        border-radius: 16px; padding: 14px; margin-top: 14px; display: none;
      }
      .done-msg.show { display: block; }
      .done-msg p { color: #065f46; font-weight: 600; font-size: 14px; }
      .empty-tip { padding: 18px; color: #94a3b8; font-size: 13px; background: #f8fafc; border-radius: 12px; }

      /* 图片全屏查看（lightbox） */
      .lightbox {
        display: none; position: fixed; inset: 0; z-index: 999;
        background: rgba(0, 0, 0, 0.92);
        align-items: center; justify-content: center; flex-direction: column;
        cursor: pointer;
      }
      .lightbox.show { display: flex; }
      .lightbox img {
        max-width: 100%; max-height: 86vh; object-fit: contain;
        border-radius: 8px; cursor: default;
      }
      .lightbox-close {
        position: absolute; top: calc(12px + env(safe-area-inset-top, 0px)); right: 16px;
        width: 40px; height: 40px; border-radius: 50%;
        background: rgba(255, 255, 255, 0.15); color: white;
        font-size: 20px; display: flex; align-items: center; justify-content: center;
        cursor: pointer;
      }
      .lightbox-tip { color: rgba(255, 255, 255, 0.7); font-size: 12px; margin-top: 14px; }

      /* 访问口令弹窗 */
      .pin-modal {
        display: none; position: fixed; inset: 0; z-index: 1000;
        background: rgba(0, 0, 0, 0.55);
        align-items: center; justify-content: center;
      }
      .pin-modal.show { display: flex; }
      .pin-box {
        background: white; border-radius: 20px; padding: 24px;
        width: 86%; max-width: 320px; text-align: center;
      }
      .pin-box p { font-size: 16px; font-weight: 700; color: #1e293b; margin-bottom: 14px; }
      .pin-box input {
        width: 100%; padding: 12px; border: 1.5px solid #cbd5e1; border-radius: 12px;
        font-size: 18px; text-align: center; letter-spacing: 2px; outline: none;
      }
      .pin-box input:focus { border-color: #6366f1; }
      .pin-btns { display: flex; gap: 10px; margin-top: 16px; }
      .pin-btns button {
        flex: 1; padding: 12px; border-radius: 12px; font-size: 15px; font-weight: 600;
        cursor: pointer; border: none;
      }
      .pin-btn-cancel { background: #f1f5f9; color: #64748b; }
      .pin-btn-ok { background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="emoji">🚗</span>
      <h1>挪车确认与回复</h1>
      <p class="subtitle">选择当日对应的挪车申请并发送回复</p>

      <div class="section-title">
        <span>📋 当日申请记录（点击选择）</span>
        <span style="display:flex; align-items:center; gap:8px;">
          <span id="recCount">0 条</span>
          <button id="refreshOwnerBtn" class="refresh-btn" onclick="refreshOwnerRecords()" aria-label="刷新申请"><span>🔄</span></button>
        </span>
      </div>

      <div id="recordSelector" class="record-selector">
        <div class="empty-tip">加载当日记录中...</div>
      </div>

      <button id="ownerLoadMoreBtn" class="load-more-btn" onclick="loadMoreOwnerRecords()">
        <span>🔽 查看更多申请 (每次3条)</span>
      </button>

      <div id="detailPanel">
        <div id="messageBox" class="message-box">
          💬 <b>当前选中留言：</b><span id="msgText">无</span>
        </div>

        <div id="photoBox1" class="photo-container">
          <div class="photo-label">🚗 车头</div>
          <img id="scenePhoto1" src="" alt="车头照片" />
        </div>

        <div id="photoBox2" class="photo-container">
          <div class="photo-label">🚗 车尾</div>
          <img id="scenePhoto2" src="" alt="车尾照片" />
        </div>

        <div class="quick-replies">
          <button type="button" class="qr-btn active" onclick="setReply(this, '抱歉挡了您的道，车主正飞奔而来，请稍后！')">🏃 马上</button>
          <button type="button" class="qr-btn" onclick="setReply(this, '你拍的照片看不清我挡了您的道，请换个角度再拍一张！')">📷 重拍</button>
          <button type="button" class="qr-btn" onclick="setReply(this, '我确定没挡您的道，不要联系我，另寻他法，抱歉！')">❌ 拒绝</button>
        </div>

        <button id="confirmBtn" class="btn" onclick="confirmMove()">
          <span>🚀 对选中申请发送回复</span>
        </button>

        <div id="doneMsg" class="done-msg">
          <p id="doneText">✅ 已成功回复该条申请！</p>
        </div>
      </div>
    </div>

    <div id="lightbox" class="lightbox" onclick="closeLightbox()">
      <span class="lightbox-close">✕</span>
      <img id="lightboxImg" src="" alt="现场照片放大" onclick="event.stopPropagation()" />
      <p class="lightbox-tip">点击空白处关闭</p>
    </div>

    <div id="pinModal" class="pin-modal">
      <div class="pin-box">
        <p>🔐 请输入访问口令</p>
        <input id="pinInput" type="password" inputmode="numeric" placeholder="访问口令" />
        <div class="pin-btns">
          <button type="button" class="pin-btn-cancel" onclick="closePinModal()">取消</button>
          <button type="button" class="pin-btn-ok" onclick="submitPin()">确定</button>
        </div>
      </div>
    </div>

    <script>
      let records = [];
      let selectedRecordId = null;
      let selectedReply = '抱歉挡了您的道，车主正飞奔而来，请稍后！';
      let ownerVisibleLimit = 3;

      window.onload = async () => {
        await loadRecords();
      };

      async function loadRecords() {
        const selectorEl = document.getElementById('recordSelector');
        try {
          const res = await fetch('/api/get-today-records');
          if (!res.ok) throw new Error('fetch failed');
          const data = await res.json();
          records = data.records || [];
          document.getElementById('recCount').innerText = records.length + ' 条';

          if (records.length === 0) {
            selectorEl.innerHTML = '<div class="empty-tip">今日暂无挪车申请记录</div>';
            document.getElementById('detailPanel').style.display = 'none';
            document.getElementById('ownerLoadMoreBtn').style.display = 'none';
            return true;
          }

          document.getElementById('detailPanel').style.display = 'block';
          const urlParams = new URLSearchParams(window.location.search);
          const paramId = urlParams.get('id');

          if (paramId && records.some(r => r.id === paramId)) {
            selectedRecordId = paramId;
          } else if (!selectedRecordId || !records.some(r => r.id === selectedRecordId)) {
            selectedRecordId = records[0].id;
          }

          renderRecordList();
          syncSelectedDetail();
          return true;
        } catch (e) {
          selectorEl.innerHTML = '<div class="empty-tip">加载记录失败，请刷新重试</div>';
          return false;
        }
      }

      // 手动刷新当日申请记录（重置分页，转圈反馈）
      let isRefreshingOwner = false;
      async function refreshOwnerRecords() {
        if (isRefreshingOwner) return;
        isRefreshingOwner = true;
        const btn = document.getElementById('refreshOwnerBtn');
        btn.classList.add('refreshing');
        ownerVisibleLimit = 3;
        const ok = await loadRecords();
        btn.classList.remove('refreshing');
        isRefreshingOwner = false;
        showToast(ok ? '🔄 已更新最新申请' : '❌ 刷新失败，请稍后再试');
      }

      function showToast(text) {
        const t = document.getElementById('toast');
        t.innerText = text;
        t.classList.add('show');
        clearTimeout(showToast._timer);
        showToast._timer = setTimeout(() => t.classList.remove('show'), 2000);
      }

      function renderRecordList() {
        const selectorEl = document.getElementById('recordSelector');
        const loadMoreBtn = document.getElementById('ownerLoadMoreBtn');
        const showRecords = records.slice(0, ownerVisibleLimit);

        selectorEl.innerHTML = showRecords.map(r => {
          const isSelected = r.id === selectedRecordId;
          const isDone = r.status === 'confirmed';
          return \`
            <div class="rec-item \${isSelected ? 'selected' : ''}" onclick="selectRecord('\${r.id}')">
              <img src="\${(r.photos && r.photos[0]) || r.photo}" data-id="\${r.id}" class="rec-thumb" alt="照片" />
              <div class="rec-meta">
                <div class="rec-top">
                  <span class="rec-time">⏱️ \${r.time}</span>
                  <span class="rec-badge \${isDone ? 'badge-done' : 'badge-wait'}">\${isDone ? '已回复' : '待回复'}</span>
                </div>
                <div class="rec-msg">💬 \${escapeHtml(r.message || '无留言')}</div>
              </div>
            </div>
          \`;
        }).join('');

        if (records.length > ownerVisibleLimit) {
          loadMoreBtn.style.display = 'flex';
        } else {
          loadMoreBtn.style.display = 'none';
        }
      }

      function loadMoreOwnerRecords() {
        ownerVisibleLimit += 3;
        renderRecordList();
      }

      function selectRecord(id) {
        selectedRecordId = id;
        document.getElementById('doneMsg').classList.remove('show');
        const btn = document.getElementById('confirmBtn');
        btn.disabled = false;
        btn.innerHTML = '<span>🚀 对选中申请发送回复</span>';
        btn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
        renderRecordList();
        syncSelectedDetail();
      }

      function syncSelectedDetail() {
        const rec = records.find(r => r.id === selectedRecordId);
        if (!rec) return;

        document.getElementById('msgText').innerText = rec.message || '无留言';
        // 兼容旧记录：photos 数组为 [车头, 车尾]，旧记录只有 photo 单张
        const photos = ((rec.photos && rec.photos.length ? rec.photos : [rec.photo]) || []).filter(Boolean);
        const box1 = document.getElementById('photoBox1');
        const box2 = document.getElementById('photoBox2');
        const sp1 = document.getElementById('scenePhoto1');
        const sp2 = document.getElementById('scenePhoto2');
        if (photos[0]) {
          sp1.src = photos[0];
          box1.classList.add('show');
        } else {
          box1.classList.remove('show');
        }
        if (photos[1]) {
          sp2.src = photos[1];
          box2.classList.add('show');
        } else {
          box2.classList.remove('show');
        }

        if (rec.status === 'confirmed' && rec.reply) {
          document.getElementById('doneText').innerText = '✅ 当前已回复：' + rec.reply;
          document.getElementById('doneMsg').classList.add('show');
        }
      }

      function setReply(btn, text) {
        document.querySelectorAll('.qr-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedReply = text;
      }

      async function confirmMove() {
        if (!selectedRecordId) return;
        const btn = document.getElementById('confirmBtn');
        btn.disabled = true;
        btn.innerHTML = '<span>⏳ 提交中...</span>';

        try {
          const res = await fetch('/api/owner-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recordId: selectedRecordId,
              reply: selectedReply,
              pin: localStorage.getItem('movecar_owner_pin') || ''
            })
          });

          if (res.ok) {
            btn.innerHTML = '<span>✅ 已回复</span>';
            btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
            document.getElementById('doneText').innerText = '✅ 已成功回复该条申请！';
            document.getElementById('doneMsg').classList.add('show');
            await loadRecords();
          } else {
            const errData = await res.json().catch(() => ({}));
            if (res.status === 403 && errData.needPin) {
              // 首次使用或口令错误：弹出口令输入框，输入后自动重试
              resetConfirmBtn();
              askPinAndRetry();
            } else {
              throw new Error(errData.error || 'Confirm failed');
            }
          }
        } catch (e) {
          resetConfirmBtn();
        }
      }

      function resetConfirmBtn() {
        const btn = document.getElementById('confirmBtn');
        btn.disabled = false;
        btn.innerHTML = '<span>🚀 对选中申请发送回复</span>';
      }

      let pinRetryPending = false;

      function askPinAndRetry() {
        pinRetryPending = true;
        document.getElementById('pinInput').value = '';
        document.getElementById('pinModal').classList.add('show');
        setTimeout(() => document.getElementById('pinInput').focus(), 100);
      }

      function closePinModal() {
        pinRetryPending = false;
        document.getElementById('pinModal').classList.remove('show');
      }

      function submitPin() {
        const v = document.getElementById('pinInput').value.trim();
        if (!v) return;
        localStorage.setItem('movecar_owner_pin', v);
        closePinModal();
        if (pinRetryPending) {
          pinRetryPending = false;
        }
        confirmMove();
      }

      function escapeHtml(str) {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      // 图片全屏查看：点击车头/车尾大图或列表缩略图均可放大，点击空白处关闭
      let lightboxRecordId = null;
      let lightboxPhotoIndex = 1;

      function openLightbox(src, recordId, n) {
        if (!src) return;
        lightboxRecordId = recordId || null;
        lightboxPhotoIndex = n || 1;
        const lb = document.getElementById('lightbox');
        const lbImg = document.getElementById('lightboxImg');
        lbImg.src = src;
        lb.classList.add('show');

        // 先用缩略图秒开，同时按需加载原图替换（看清车牌/遮挡细节）
        if (lightboxRecordId) {
          const reqId = lightboxRecordId;
          const reqN = lightboxPhotoIndex;
          fetch('/api/get-photo?id=' + encodeURIComponent(reqId) + '&n=' + reqN)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
              if (d && d.photo && lb.classList.contains('show') && lightboxRecordId === reqId && lightboxPhotoIndex === reqN) {
                lbImg.src = d.photo;
              }
            })
            .catch(() => {});
        }
      }

      function closeLightbox() {
        const lb = document.getElementById('lightbox');
        lb.classList.remove('show');
        lightboxRecordId = null;
        lightboxPhotoIndex = 1;
        document.getElementById('lightboxImg').src = '';
      }

      document.addEventListener('click', function (e) {
        const img = e.target;
        if (!img || img.tagName !== 'IMG' || !img.src) return;
        if (img.id === 'scenePhoto1' || img.id === 'scenePhoto2') {
          openLightbox(img.src, selectedRecordId, img.id === 'scenePhoto2' ? 2 : 1);
        } else if (img.classList.contains('rec-thumb')) {
          openLightbox(img.src, img.dataset.id || null, 1);
        }
      });
    </script>

    <div id="toast" class="toast"></div>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
