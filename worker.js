addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = { KV_TTL: 86400 } // 24小时后自动过期（次日自动清理）

// 获取当前北京日期的字符串作为 Key（格式：YYYY-MM-DD）
function getBeijingDateStr() {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = {
  KV_TTL: 86400, // 24小时后自动过期（次日自动清理）
  UNANSWERED_MIN_COUNT: 3,
  SPAN_THRESHOLD_MS: 60 * 1000 // 1分钟
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

// 获取企业微信接收人 touser，未设置默认 @all，支持多用户用 & 隔开
function getWeComToUser() {
  if (typeof WECOM_TOUSER !== 'undefined' && WECOM_TOUSER) {
    const cleaned = String(WECOM_TOUSER)
      .split('&')
      .map(s => s.trim())
      .filter(Boolean)
      .join('&');
    if (cleaned) return cleaned;
  }
  return '@all';
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

  if (path === '/api/check-status') {
    const status = await MOVE_CAR_STATUS.get('notify_status');
    const reply = await MOVE_CAR_STATUS.get('owner_reply') || '';
    return new Response(JSON.stringify({
      status: status || 'waiting',
      reply: reply
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/api/get-car-data') {
    const message = await MOVE_CAR_STATUS.get('notify_message') || '车旁有人等待';
    const photoBase64 = await MOVE_CAR_STATUS.get('notify_photo') || null;
    return new Response(JSON.stringify({
      message: message,
      photo: photoBase64
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/api/get-today-records') {
    const dateKey = `records_${getBeijingDateStr()}`;
    const rawRecords = await MOVE_CAR_STATUS.get(dateKey);
    const records = rawRecords ? JSON.parse(rawRecords) : [];
    return new Response(JSON.stringify({ records }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/owner-confirm') {
    return renderOwnerPage();
  }

  return renderMainPage(url.origin);
}

async function sendWeComMessage(message, confirmUrl) {
  try {
    if (typeof WECOM_CORPID === 'undefined' || typeof WECOM_APP_SECRET === 'undefined' || typeof WECOM_AGENTID === 'undefined') {
      return;
    }

    const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECOM_CORPID}&corpsecret=${WECOM_APP_SECRET}`;
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
      touser: getWeComToUser(),
      msgtype: "text",
      agentid: WECOM_AGENTID,
      text: { content: textContent },
      enable_duplicate_check: 0
    };

    await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(textBody)
    });
  } catch (e) {
    console.error('WeCom Exception:', e);
  }
}

async function handleNotify(request, url) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let message = '车旁有人等待';
    let imageBase64 = null;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      message = formData.get('message') || '车旁有人等待';

      const imageFile = formData.get('image');
      if (imageFile && typeof imageFile === 'object' && imageFile.size > 0) {
        const buffer = await imageFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        imageBase64 = `data:image/jpeg;base64,${btoa(binary)}`;
      }
    }

    if (!imageBase64) {
      return new Response(JSON.stringify({ success: false, error: '必须上传现场照片才能发送通知' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
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
      photo: imageBase64,
      status: 'waiting',
      reply: '等待车主回应...'
    };
    records.unshift(newRecord);
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

    promises.push(sendWeComMessage(message, confirmUrl));

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
          updated = true;
          if (i === 0) updatedLatest = true;
          break;
        }
      }
    }

    if (!updated && records.length > 0) {
      records[0].status = 'confirmed';
      records[0].reply = replyText;
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
  const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';

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
      #photoInput { display: none; }
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
      .owner-card h3 { color: #0093E9; margin-bottom: 6px; font-size: clamp(20px, 5vw, 26px); }
      .owner-card p { color: #475569; font-size: clamp(14px, 3.8vw, 16px); line-height: 1.4; padding: 0 8px; }

      .history-card { background: rgba(255, 255, 255, 0.95); border-radius: 20px; padding: 18px; margin-top: 10px; }
      .history-card h3 { font-size: 16px; color: #1e293b; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
      .history-list { display: flex; flex-direction: column; gap: 10px; }
      .history-item { background: #f8fafc; border-radius: 12px; padding: 10px 12px; font-size: 13px; border-left: 3px solid #0093E9; display: flex; gap: 10px; align-items: center; }
      .history-thumb { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: #e2e8f0; }
      .history-info { flex: 1; min-width: 0; }
      .history-time { color: #64748b; font-size: 11px; margin-bottom: 2px; }
      .history-msg { color: #334155; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .history-reply { color: #0284c7; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
      <div class="card header">
        <div class="icon-wrap"><span>🚗</span></div>
        <h1>呼叫车主挪车</h1>
        <p>Notify Car Owner</p>
      </div>

      <div class="card input-card">
        <textarea id="msgInput" placeholder="输入留言给车主...（可选）"></textarea>
        
        <div class="photo-upload-wrap">
          <button type="button" class="photo-btn" onclick="document.getElementById('photoInput').click()">
            <span>📷</span> <span>拍摄/上传现场照片 *</span>
          </button>
          <input type="file" id="photoInput" accept="image/*" capture="environment" onchange="handlePhotoSelect(this)" />
          <span id="photoFileName" class="photo-preview-text" style="color:#e11d48">⚠️ 必须上传照片</span>
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

      <div class="history-card">
        <h3>
          <span>📋 今日挪车记录</span>
          <span id="historyCount" style="font-size:12px; font-weight:normal; color:#64748b;"></span>
        </h3>
        <div id="historyList" class="history-list">
          <div class="history-empty">加载中...</div>
        </div>
        <button id="loadMoreBtn" class="load-more-btn" onclick="loadMoreRecords()">
          <span>🔽 查看更多记录 (每次3条)</span>
        </button>
      </div>
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
      let selectedPhotoFile = null;
      let retryCount = 0;
      let allRecords = [];
      let visibleLimit = 3;

      window.onload = () => {
        loadTodayRecords();
      };

      function shouldUnlockPhoneButton(records) {
        if (!Array.isArray(records) || records.length < 3) return false;
        const unansweredCount = records.filter(r => r.status !== 'confirmed').length;
        if (unansweredCount < 3) return false;

        const latestThree = records.slice(0, 3);
        if (!latestThree.every(r => r.status !== 'confirmed' && typeof r.createdAt === 'number')) {
          return false;
        }

        const sortedByTime = [...latestThree].sort((a, b) => a.createdAt - b.createdAt);
        const spanMs = sortedByTime[2].createdAt - sortedByTime[0].createdAt;
        return spanMs > 60000;
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
        } catch (e) {
          document.getElementById('historyList').innerHTML = '<div class="history-empty">加载记录失败</div>';
        }
      }

      function renderRecords() {
        const listEl = document.getElementById('historyList');
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        
        if (allRecords.length === 0) {
          listEl.innerHTML = '<div class="history-empty">今日暂无挪车记录</div>';
          loadMoreBtn.style.display = 'none';
          return;
        }

        const showRecords = allRecords.slice(0, visibleLimit);
        listEl.innerHTML = showRecords.map(r => \`
          <div class="history-item">
            <img src="\${r.photo}" class="history-thumb" alt="照片" />
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

      function handlePhotoSelect(input) {
        if (input.files && input.files[0]) {
          selectedPhotoFile = input.files[0];
          const el = document.getElementById('photoFileName');
          el.innerText = selectedPhotoFile.name;
          el.style.color = '#059669';
        } else {
          selectedPhotoFile = null;
          const el = document.getElementById('photoFileName');
          el.innerText = '⚠️ 必须上传照片';
          el.style.color = '#e11d48';
        }
      }

      function addTag(text) { document.getElementById('msgInput').value = text; }

      async function sendNotify() {
        if (!selectedPhotoFile) {
          showToast('❌ 请先拍摄或选择现场照片！');
          return;
        }

        const msg = document.getElementById('msgInput').value;
        const btn = document.getElementById('notifyBtn');

        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';

        try {
          const formData = new FormData();
          formData.append('message', msg);
          formData.append('image', selectedPhotoFile);

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

      function backToMainView() {
        if (checkTimer) {
          clearInterval(checkTimer);
          checkTimer = null;
        }
        document.getElementById('successView').style.display = 'none';
        document.getElementById('mainView').style.display = 'flex';
        const btn = document.getElementById('notifyBtn');
        btn.disabled = false;
        btn.innerHTML = '<span>🔔</span><span>一键通知车主</span>';
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
                } else if (data.reply.includes('换个角度')) {
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
    </style>
  </head>
  <body>
    <div class="card">
      <span class="emoji">🚗</span>
      <h1>挪车确认与回复</h1>
      <p class="subtitle">选择当日对应的挪车申请并发送回复</p>

      <div class="section-title">
        <span>📋 当日申请记录（点击选择）</span>
        <span id="recCount">0 条</span>
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

        <div id="photoBox" class="photo-container">
          <img id="scenePhoto" src="" alt="现场照片" />
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
            return;
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
        } catch (e) {
          selectorEl.innerHTML = '<div class="empty-tip">加载记录失败，请刷新重试</div>';
        }
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
              <img src="\${r.photo}" class="rec-thumb" alt="照片" />
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
        const photoBox = document.getElementById('photoBox');
        const scenePhoto = document.getElementById('scenePhoto');
        if (rec.photo) {
          scenePhoto.src = rec.photo;
          photoBox.classList.add('show');
        } else {
          photoBox.classList.remove('show');
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
              reply: selectedReply
            })
          });

          if (res.ok) {
            btn.innerHTML = '<span>✅ 已回复</span>';
            btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
            document.getElementById('doneText').innerText = '✅ 已成功回复该条申请！';
            document.getElementById('doneMsg').classList.add('show');
            await loadRecords();
          } else {
            throw new Error('Confirm failed');
          }
        } catch (e) {
          btn.disabled = false;
          btn.innerHTML = '<span>🚀 对选中申请发送回复</span>';
        }
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
    day: '2-digit'
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

// 获取企业微信接收人 touser，未设置默认 @all，支持多用户用 & 隔开
function getWeComToUser() {
  if (typeof WECOM_TOUSER !== 'undefined' && WECOM_TOUSER) {
    const cleaned = String(WECOM_TOUSER)
      .split('&')
      .map(s => s.trim())
      .filter(Boolean)
      .join('&');
    if (cleaned) return cleaned;
  }
  return '@all';
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

  if (path === '/api/check-status') {
    const status = await MOVE_CAR_STATUS.get('notify_status');
    const reply = await MOVE_CAR_STATUS.get('owner_reply') || '';
    return new Response(JSON.stringify({
      status: status || 'waiting',
      reply: reply
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/api/get-car-data') {
    const message = await MOVE_CAR_STATUS.get('notify_message') || '车旁有人等待';
    const photoBase64 = await MOVE_CAR_STATUS.get('notify_photo') || null;
    return new Response(JSON.stringify({
      message: message,
      photo: photoBase64
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/api/get-today-records') {
    const dateKey = `records_${getBeijingDateStr()}`;
    const rawRecords = await MOVE_CAR_STATUS.get(dateKey);
    const records = rawRecords ? JSON.parse(rawRecords) : [];
    return new Response(JSON.stringify({ records }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/owner-confirm') {
    return renderOwnerPage();
  }

  return renderMainPage(url.origin);
}

async function sendWeComMessage(message, confirmUrl) {
  try {
    if (typeof WECOM_CORPID === 'undefined' || typeof WECOM_APP_SECRET === 'undefined' || typeof WECOM_AGENTID === 'undefined') {
      return;
    }

    const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECOM_CORPID}&corpsecret=${WECOM_APP_SECRET}`;
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
      touser: getWeComToUser(),
      msgtype: "text",
      agentid: WECOM_AGENTID,
      text: { content: textContent },
      enable_duplicate_check: 0
    };

    await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(textBody)
    });
  } catch (e) {
    console.error('WeCom Exception:', e);
  }
}

async function handleNotify(request, url) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let message = '车旁有人等待';
    let imageBase64 = null;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      message = formData.get('message') || '车旁有人等待';

      const imageFile = formData.get('image');
      if (imageFile && typeof imageFile === 'object' && imageFile.size > 0) {
        const buffer = await imageFile.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        imageBase64 = `data:image/jpeg;base64,${btoa(binary)}`;
      }
    }

    if (!imageBase64) {
      return new Response(JSON.stringify({ success: false, error: '必须上传现场照片才能发送通知' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const recordId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const confirmUrl = `${url.origin}/owner-confirm?id=${encodeURIComponent(recordId)}`;
    const timeStr = new Date().toLocaleTimeString('zh-CN', {
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
    await MOVE_CAR_STATUS.put('active_record_id', recordId, { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.put('active_record_date', dateStr, { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.delete('owner_reply');

    const rawRecords = await MOVE_CAR_STATUS.get(dateKey);
    const records = rawRecords ? JSON.parse(rawRecords) : [];

    const newRecord = {
      id: recordId,
      time: timeStr,
      message: message,
      photo: imageBase64,
      status: 'waiting',
      reply: '等待车主回应...'
    };
    records.unshift(newRecord);
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

    promises.push(sendWeComMessage(message, confirmUrl));

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
          updated = true;
          if (i === 0) updatedLatest = true;
          break;
        }
      }
    }

    if (!updated && records.length > 0) {
      records[0].status = 'confirmed';
      records[0].reply = replyText;
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
  const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '';

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
      #photoInput { display: none; }
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

      .owner-card { background: white; border: 2px solid #80D0C7; text-align: center; }
      .owner-card.hidden { display: none; }
      .owner-card h3 { color: #0093E9; margin-bottom: 6px; font-size: clamp(20px, 5vw, 26px); }
      .owner-card p { color: #475569; font-size: clamp(14px, 3.8vw, 16px); line-height: 1.4; padding: 0 8px; }

      .history-card { background: rgba(255, 255, 255, 0.95); border-radius: 20px; padding: 18px; margin-top: 10px; }
      .history-card h3 { font-size: 16px; color: #1e293b; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
      .history-list { display: flex; flex-direction: column; gap: 10px; }
      .history-item { background: #f8fafc; border-radius: 12px; padding: 10px 12px; font-size: 13px; border-left: 3px solid #0093E9; display: flex; gap: 10px; align-items: center; }
      .history-thumb { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: #e2e8f0; }
      .history-info { flex: 1; min-width: 0; }
      .history-time { color: #64748b; font-size: 11px; margin-bottom: 2px; }
      .history-msg { color: #334155; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .history-reply { color: #0284c7; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
      
      .btn-retry, .btn-phone {
        color: white; border: none; padding: 14px; border-radius: 14px;
        font-size: 16px; font-weight: 700; cursor: pointer; display: flex;
        align-items: center; justify-content: center; gap: 8px; text-decoration: none;
      }
      .btn-retry { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }
      
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
      <div class="card header">
        <div class="icon-wrap"><span>🚗</span></div>
        <h1>呼叫车主挪车</h1>
        <p>Notify Car Owner</p>
      </div>

      <div class="card input-card">
        <textarea id="msgInput" placeholder="输入留言给车主...（可选）"></textarea>
        
        <div class="photo-upload-wrap">
          <button type="button" class="photo-btn" onclick="document.getElementById('photoInput').click()">
            <span>📷</span> <span>拍摄/上传现场照片 *</span>
          </button>
          <input type="file" id="photoInput" accept="image/*" capture="environment" onchange="handlePhotoSelect(this)" />
          <span id="photoFileName" class="photo-preview-text" style="color:#e11d48">⚠️ 必须上传照片</span>
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

      <div class="history-card">
        <h3>
          <span>📋 今日挪车记录</span>
          <span id="historyCount" style="font-size:12px; font-weight:normal; color:#64748b;"></span>
        </h3>
        <div id="historyList" class="history-list">
          <div class="history-empty">加载中...</div>
        </div>
        <button id="loadMoreBtn" class="load-more-btn" onclick="loadMoreRecords()">
          <span>🔽 查看更多记录 (每次3条)</span>
        </button>
      </div>
    </div>

    <div class="container" id="successView">
      <div id="waitingCard" class="card success-card">
        <span class="success-icon">⏳</span>
        <h2>通知已发送！</h2>
        <p class="loading-text">正在等待车主回应...</p>
      </div>

      <div id="ownerFeedback" class="card owner-card hidden">
        <span id="replyEmoji" style="font-size:56px; display:block; margin-bottom:10px">🏃‍♂️</span>
        <h3 id="replyTitle">车主正飞奔赶来</h3>
        <p id="ownerReplyText" style="margin-top: 6px;">正在赶来！</p>
      </div>

      <div class="card action-card">
        <p id="actionHint" class="action-hint">车主没反应？试试其他方式</p>
        <button id="retryBtn" class="btn-retry" onclick="handleRetryClick()">
          <span>🔔</span>
          <span>再次通知</span>
        </button>
        <a id="phoneBtn" href="tel:${phone}" class="btn-phone">
          <span>📞</span>
          <span>直接打电话</span>
        </a>
      </div>
    </div>

    <script>
      let checkTimer = null;
      let selectedPhotoFile = null;
      let retryCount = 0;
      let allRecords = [];
      let visibleLimit = 3;

      window.onload = () => {
        loadTodayRecords();
      };

      async function loadTodayRecords() {
        try {
          const res = await fetch('/api/get-today-records');
          const data = await res.json();
          allRecords = data.records || [];
          document.getElementById('historyCount').innerText = allRecords.length > 0 ? \`共 \${allRecords.length} 条\` : '';
          renderRecords();
        } catch (e) {
          document.getElementById('historyList').innerHTML = '<div class="history-empty">加载记录失败</div>';
        }
      }

      function renderRecords() {
        const listEl = document.getElementById('historyList');
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        
        if (allRecords.length === 0) {
          listEl.innerHTML = '<div class="history-empty">今日暂无挪车记录</div>';
          loadMoreBtn.style.display = 'none';
          return;
        }

        const showRecords = allRecords.slice(0, visibleLimit);
        listEl.innerHTML = showRecords.map(r => \`
          <div class="history-item">
            <img src="\${r.photo}" class="history-thumb" alt="照片" />
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

      function handlePhotoSelect(input) {
        if (input.files && input.files[0]) {
          selectedPhotoFile = input.files[0];
          const el = document.getElementById('photoFileName');
          el.innerText = selectedPhotoFile.name;
          el.style.color = '#059669';
        } else {
          selectedPhotoFile = null;
          const el = document.getElementById('photoFileName');
          el.innerText = '⚠️ 必须上传照片';
          el.style.color = '#e11d48';
        }
      }

      function addTag(text) { document.getElementById('msgInput').value = text; }

      async function sendNotify() {
        if (!selectedPhotoFile) {
          showToast('❌ 请先拍摄或选择现场照片！');
          return;
        }

        const msg = document.getElementById('msgInput').value;
        const btn = document.getElementById('notifyBtn');

        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';

        try {
          const formData = new FormData();
          formData.append('message', msg);
          formData.append('image', selectedPhotoFile);

          const res = await fetch('/api/notify', {
            method: 'POST',
            body: formData
          });

          const data = await res.json();

          if (res.ok && data.success) {
            showToast('✅ 发送成功！');
            document.getElementById('mainView').style.display = 'none';
            document.getElementById('successView').style.display = 'flex';
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

      function startPolling() {
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
                } else if (data.reply.includes('换个角度')) {
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
    </style>
  </head>
  <body>
    <div class="card">
      <span class="emoji">🚗</span>
      <h1>挪车确认与回复</h1>
      <p class="subtitle">选择当日对应的挪车申请并发送回复</p>

      <div class="section-title">
        <span>📋 当日申请记录（点击选择）</span>
        <span id="recCount">0 条</span>
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

        <div id="photoBox" class="photo-container">
          <img id="scenePhoto" src="" alt="现场照片" />
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
            return;
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
        } catch (e) {
          selectorEl.innerHTML = '<div class="empty-tip">加载记录失败，请刷新重试</div>';
        }
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
              <img src="\${r.photo}" class="rec-thumb" alt="照片" />
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
        const photoBox = document.getElementById('photoBox');
        const scenePhoto = document.getElementById('scenePhoto');
        if (rec.photo) {
          scenePhoto.src = rec.photo;
          photoBox.classList.add('show');
        } else {
          photoBox.classList.remove('show');
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
              reply: selectedReply
            })
          });

          if (res.ok) {
            btn.innerHTML = '<span>✅ 已回复</span>';
            btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
            document.getElementById('doneText').innerText = '✅ 已成功回复该条申请！';
            document.getElementById('doneMsg').classList.add('show');
            await loadRecords();
          } else {
            throw new Error('Confirm failed');
          }
        } catch (e) {
          btn.disabled = false;
          btn.innerHTML = '<span>🚀 对选中申请发送回复</span>';
        }
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
