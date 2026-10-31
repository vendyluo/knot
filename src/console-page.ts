import type { ReminderControl } from "./reminder-control";
import type { Reminder } from "./reminders";

export interface ConsoleReminder extends Pick<Reminder, "id" | "due_at" | "status" | "attempts" | "last_error"> {
  location: string;
}
export interface ConsoleModel {
  control: ReminderControl;
  enabled: boolean;
  parser: "rule" | "ai";
  reminders: ConsoleReminder[];
  hasMore: boolean;
  filter: string;
  page: number;
  now: number;
}

const escape = (text: string | number) => String(text).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);
const time = (seconds: number | null) => seconds === null ? "尚無紀錄" : new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(new Date(seconds * 1000));
const statuses: Record<Reminder["status"], string> = {
  pending: "待發送", sending: "發送中／等待重試", accepted: "已送交 LINE", cancelled: "已取消",
  failed: "發送失敗", expired: "已過期", unknown: "結果未確認",
};
function diagnosis(code: string | null): string {
  if (!code) return "—";
  if (code === "network_timeout") return "網路錯誤或逾時";
  if (code === "deadline_or_attempt_limit") return "超過期限或嘗試上限";
  if (code === "http_401" || code === "http_403") return "LINE 憑證或權限";
  if (code === "http_429") return "LINE 限流或額度";
  if (/^http_[45]\d{2}$/.test(code)) return `LINE HTTP ${code.slice(5)}`;
  return "未分類錯誤";
}

function dashboard(model: ConsoleModel): string {
  const { control, enabled } = model;
  const state = !enabled ? "部署設定未啟用" : control.paused ? "提醒已暫停" : "允許建立與發送";
  const stale = control.last_tick_started_at === null || model.now - control.last_tick_started_at > 300;
  const heartbeat = stale ? "排程狀態待確認" : control.last_tick_status === "error" ? "最近一次檢查失敗" :
    control.last_tick_status === "running" ? "檢查中／尚未完成" : "最近一次檢查完成";
  const link = (page: number, label: string) => `<a class="button" href="/console?filter=${model.filter}&amp;page=${page}">${label}</a>`;
  return `<section class="overview" aria-label="運作狀態">
    <div class="operation"><p class="eyebrow">提醒控制</p><h2>${state}</h2>
      <p>${!enabled ? "需先在部署設定啟用 NOTIFY_ENABLED。" : control.paused ? "新的提醒與後續工作領取已停止。" : "到期工作以分鐘級處理，不是準秒鬧鐘。"}</p>
      <form method="post" action="/console/pause" ${control.paused ? 'data-confirm="恢復後，仍在補發期限內的提醒可能立即發送並使用 LINE 額度。確定恢復？"' : ""}>
        <input type="hidden" name="revision" value="${control.revision}"><input type="hidden" name="paused" value="${control.paused ? 0 : 1}">
        <button class="primary" ${!enabled && control.paused ? "disabled" : ""}>${control.paused ? "恢復提醒" : "暫停提醒"}</button>
      </form>
      <p class="small">${control.changed_at ? `控制更新於 ${time(control.changed_at)}` : "尚未從控制台調整"}</p>
    </div>
    <div><p class="eyebrow">時間解析</p><h2>${model.parser === "ai" ? "AI 輔助" : "規則模式"}</h2>
      <p>${model.parser === "ai" ? "規則優先，無法解析才呼叫 Workers AI。" : "明確時間格式，不呼叫 AI。"}</p>
      <p class="small">模式由部署設定決定。<br>所有日期均顯示台北時間 UTC+8。</p>
    </div>
    <div><p class="eyebrow">每分鐘排程</p><h2 class="heartbeat">${heartbeat}</h2>
      <dl><dt>最近開始</dt><dd>${time(control.last_tick_started_at)}</dd><dt>該次結束</dt><dd>${time(control.last_tick_finished_at)}</dd></dl>
      <p class="small">${stale ? "尚無紀錄或超過 5 分鐘未更新，請檢查 Cron 與 Worker logs。" : "檢查完成只代表該輪處理結束，不代表全部提醒送達。"}</p>
    </div>
  </section>
  <aside class="notice">暫停不會撤回已領取的發送；過期與清理仍會執行。恢復時可能補發到期後 1 小時內的提醒。記事保存不受影響。</aside>
  <section aria-labelledby="records-title" class="records">
    <div class="section-heading"><div><h2 id="records-title">提醒紀錄</h2><p>最新建立優先 · 僅顯示維運資訊，不載入私人事項或聊天室 ID</p></div>
      <span class="small">更新於 ${time(model.now)}</span></div>
    <nav class="filters" aria-label="提醒篩選">${[["all", "全部紀錄"], ["active", "待發／處理中"], ["issues", "失敗／未確認／過期"]].map(([value, label]) =>
      `<a href="/console?filter=${value}" ${model.filter === value ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>
    ${model.reminders.length ? '<p class="small scroll-hint">左右滑動表格，查看完整狀態與操作 →</p>' : ""}
    ${model.reminders.length ? `<div class="table-scroll" role="region" aria-label="提醒紀錄表格，可水平捲動" tabindex="0"><table>
      <thead><tr><th scope="col">編號</th><th scope="col">位置</th><th scope="col">原訂提醒時間</th><th scope="col">狀態</th><th scope="col">嘗試</th><th scope="col">診斷</th><th scope="col">操作</th></tr></thead>
      <tbody>${model.reminders.map((row) => `<tr><th scope="row">#${row.id}</th><td>${escape(row.location)}</td><td class="numeric">${time(row.due_at)}</td>
        <td><span class="badge ${row.status}">${statuses[row.status]}</span></td><td class="numeric">${row.attempts}</td><td>${diagnosis(row.last_error)}</td>
        <td>${row.status === "pending" ? `<form method="post" action="/console/cancel" data-confirm="取消提醒 #${row.id}？這不會刪除紀錄，且無法撤回已開始的發送。">
          <input type="hidden" name="id" value="${row.id}"><button aria-label="取消提醒 #${row.id}">取消</button></form>` : '<span class="small">—</span>'}</td></tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty"><h3>這一頁沒有提醒紀錄</h3><p>${model.filter === "all" && model.page === 0
      ? !enabled || control.paused ? "目前未開放建立提醒，請先確認上方控制狀態。" : "從 LINE 輸入 @notify 建立第一筆提醒。"
      : "可切換篩選或回到第一頁查看。"}終態紀錄會在 30 天後清理。</p></div>`}
    <div class="pagination"><span class="small">第 ${model.page + 1} 頁 · 每頁最多 20 筆</span><nav aria-label="紀錄分頁">
      ${model.page > 0 ? link(model.page - 1, "上一頁") : '<span class="button disabled" aria-disabled="true">上一頁</span>'}
      ${model.hasMore ? link(model.page + 1, "下一頁") : '<span class="button disabled" aria-disabled="true">下一頁</span>'}
    </nav></div>
    <p class="small footnote">「已送交 LINE」不代表送達或已讀。「結果未確認」可能已送出，因此不提供手動補發。翻頁期間紀錄可能移動，可回全部紀錄重新整理。</p>
  </section>`;
}

export function consolePage(model: ConsoleModel | null, error: string, nonce: string): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Knot 管理控制台</title><style nonce="${escape(nonce)}">
  :root{color-scheme:light;--ink:#25332e;--muted:#596b61;--green:#116b4d;--surface:#f3f8f5;--border:rgba(37,51,46,.13);--white:#fff}
  *{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif}
  a{color:var(--green)}button,a{-webkit-tap-highlight-color:transparent}button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 16px;border:1px solid var(--border);border-radius:7px;background:var(--white);color:var(--ink);font:inherit;font-size:14px;text-decoration:none;cursor:pointer}
  button:hover,.button:hover{background:var(--surface)}button:active,.button:active{transform:translateY(1px)}:focus-visible{outline:3px solid var(--green);outline-offset:3px}
  button:disabled,.disabled{background:#edf0ee;color:#6b756f;cursor:default}button.primary{background:var(--green);color:white;border-color:var(--green)}button.primary:hover{background:#0d563d}button.primary:disabled{background:#edf0ee;color:#6b756f;border-color:var(--border)}
  header{background:var(--white);border-bottom:1px solid var(--border)}.header-inner,main{max-width:1200px;margin:auto;padding:22px 32px}.header-inner{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:baseline;gap:16px}.brand strong{font-size:25px;letter-spacing:.08em;color:var(--green)}.brand span{font-size:14px;color:var(--muted)}.header-actions{display:flex;align-items:center;gap:12px}.header-actions a:last-child{padding:10px;font-size:14px}
  main{padding-top:32px;padding-bottom:48px}h1{font-size:28px;letter-spacing:-.02em;margin:0}h2{font-size:20px;line-height:1.4;margin:0 0 12px}h3{font-size:18px;margin:0}.intro{margin:6px 0 24px;color:var(--muted)}p{margin:0 0 16px}.small{font-size:13px;color:var(--muted)}.eyebrow{font-size:13px;font-weight:600;color:var(--muted);margin-bottom:12px}
  .overview{display:grid;grid-template-columns:1.1fr .9fr 1.2fr;background:white;border:1px solid var(--border);border-radius:12px}.overview>div{padding:24px}.overview>div+div{border-left:1px solid var(--border)}.overview .small{margin:16px 0 0}.operation{background:#eaf4ee;border-radius:12px 0 0 12px}.operation h2{color:var(--green)}.heartbeat{font-size:18px}dl{font-size:13px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}
  .notice{font-size:14px;border-left:3px solid #b08835;background:#faf5e9;padding:14px 18px;margin:20px 0 32px}.error{padding:18px;border:1px solid #b34536;background:#fff1ee;border-radius:8px;margin-bottom:24px;color:#862b20}.error strong{display:block;margin-bottom:4px}.records{background:white;border:1px solid var(--border);border-radius:12px;overflow:hidden}.section-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:24px 24px 12px}.section-heading h2{margin:0 0 4px}.section-heading p{font-size:13px;color:var(--muted);margin:0}
  .filters{display:flex;gap:8px;padding:8px 24px 20px;flex-wrap:wrap}.filters a{padding:9px 14px;min-height:44px;text-decoration:none;color:var(--muted);font-size:14px;border-radius:6px}.filters a:hover{background:var(--surface)}.filters [aria-current]{background:#eaf4ee;color:var(--green);font-weight:600}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;white-space:nowrap;font-size:13px}th,td{padding:13px 18px;border-bottom:1px solid var(--border)}thead{background:#f7f9f8;color:var(--muted)}thead th{font-weight:500}tbody th{font-weight:600}tbody tr:hover{background:#fafcfb}.numeric{font-variant-numeric:tabular-nums}.badge{display:inline-block;padding:4px 8px;border-radius:5px;background:#edf1ee;font-size:12px}.accepted{background:#eaf4ee;color:#146344}.sending{background:#edf3fb;color:#315a88}.failed,.unknown{background:#fff1ee;color:#923e2e}.expired{background:#faf2df;color:#79581b}.pagination{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;gap:12px}.pagination nav{display:flex;gap:8px}.footnote{padding:0 24px 20px;margin:0}.empty{padding:48px 24px;text-align:center;border-block:1px solid var(--border)}.empty p{color:var(--muted);font-size:14px;margin:8px 0 0}footer{font-size:12px;color:var(--muted);margin-top:24px}
  @media(max-width:850px){.overview{grid-template-columns:1fr}.overview>div+div{border-left:0;border-top:1px solid var(--border)}.operation{border-radius:12px 12px 0 0}.section-heading{flex-direction:column}.header-inner,main{padding-left:20px;padding-right:20px}.brand{gap:8px}.brand span{display:none}.section-heading,.overview>div{padding:20px}.filters{padding-inline:12px}.pagination{padding:16px;flex-wrap:wrap}}
  @media(prefers-reduced-motion:reduce){button:active,.button:active{transform:none}}
  .scroll-hint{display:none}@media(max-width:850px){.scroll-hint{display:block;padding:0 20px;margin:0 0 16px}}
  </style></head><body><header><div class="header-inner"><div class="brand"><strong>KNOT</strong><span>自架 LINE 記憶工具</span></div><nav class="header-actions" aria-label="控制台操作"><a class="button" href="/console">重新整理</a><a href="/cdn-cgi/access/logout">登出</a></nav></div></header>
  <main><h1>管理控制台</h1><p class="intro">看清提醒狀態，需要時停下來。</p>
  ${error ? `<div class="error" role="alert"><strong>需要確認</strong>${escape(error)}</div>` : ""}
  ${model ? dashboard(model) : '<p><a href="/console">重新開啟控制台</a></p>'}
  <footer>僅供部署者管理 · 不顯示私人事項 · 不提供手動補發</footer></main>
  <script nonce="${escape(nonce)}">document.addEventListener('submit',function(event){
    const form=event.target;if(form.dataset.confirm&&!window.confirm(form.dataset.confirm)){event.preventDefault();return;}
    for(const button of document.querySelectorAll('button'))button.disabled=true;
    if(event.submitter)event.submitter.textContent='處理中…';
  });window.addEventListener('pageshow',function(event){if(event.persisted)window.location.reload();});</script></body></html>`;
}
