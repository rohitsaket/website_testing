/**
 * WTE — Embedded dashboard (Sections 54, 52). Single self-contained page:
 * execution feed (SSE), quality score, release readiness, findings, scans.
 * No external assets/CDN — works fully offline behind any proxy.
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>WTE Platform</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--muted:#8b949e;--good:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:16px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font-size:18px;margin:0}.accent{color:var(--accent)}
.status{font-size:12px;color:var(--muted)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--bad);margin-right:6px}
.dot.on{background:var(--good)}
main{display:grid;grid-template-columns:380px 1fr;gap:16px;padding:16px 24px}
@media(max-width:900px){main{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px}
.card h2{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
button{background:#238636;border:1px solid #2ea043;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-weight:600}
button:disabled{opacity:.5;cursor:wait}
input,textarea{width:100%;background:#0d1117;border:1px solid var(--border);color:var(--fg);padding:8px;border-radius:6px;margin-bottom:8px;font:inherit}
label{font-size:12px;color:var(--muted);display:block;margin:6px 0 2px}
.exec{padding:8px;border-bottom:1px solid var(--border);cursor:pointer}
.exec:hover{background:#1c2128}
.exec .id{color:var(--accent);font-weight:600}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;border:1px solid var(--border)}
.b-READY,.b-COMPLETED{color:var(--good);border-color:var(--good)}
.b-CONDITIONALLY_READY{color:var(--warn);border-color:var(--warn)}
.b-NOT_READY,.b-FAILED,.b-TIMEOUT{color:var(--bad);border-color:var(--bad)}
.b-RUNNING,.b-STARTING,.b-QUEUED,.b-HEALING,.b-ANALYZING{color:var(--accent);border-color:var(--accent)}
.scores{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px}
.score{text-align:center;padding:8px;border:1px solid var(--border);border-radius:8px;background:#0d1117}
.score b{display:block;font-size:20px}
.s-good{color:var(--good)}.s-warn{color:var(--warn)}.s-bad{color:var(--bad)}.s-na{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-bottom:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.log{font:12px/1.4 ui-monospace,monospace;background:#0d1117;border:1px solid var(--border);border-radius:8px;padding:10px;height:180px;overflow:auto;white-space:pre-wrap}
.muted{color:var(--muted)}
a{color:var(--accent)}
.sev{padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700;color:#0d1117}
.sev-critical{background:#f85149}.sev-high{background:#f0883e}.sev-medium{background:#d29922}.sev-low{background:#3fb950}.sev-info{background:#58a6ff}
</style>
</head>
<body>
<header>
  <h1><span class="accent">WTE</span> · Enterprise Quality Engineering Platform</h1>
  <span class="status"><span class="dot" id="sseDot"></span><span id="sseStatus">connecting…</span></span>
  <span class="status" id="worker"></span>
</header>
<main>
  <div>
    <div class="card">
      <h2>New authorized scan</h2>
      <label>Target URL (host must appear in the allowlist)</label>
      <input id="target" placeholder="https://staging.example.com" value=""/>
      <label>Authorized hosts (comma-separated allowlist)</label>
      <input id="allow" placeholder="staging.example.com, localhost, 127.0.0.1"/>
      <label>API endpoints to probe (comma-separated paths, optional)</label>
      <input id="endpoints" placeholder="/api/health, /api/status"/>
      <button id="scanBtn">Run full scan</button>
      <div class="muted" style="margin-top:8px" id="scanMsg"></div>
    </div>
    <div class="card">
      <h2>Executions</h2>
      <div id="execs"><span class="muted">none yet</span></div>
    </div>
  </div>
  <div>
    <div class="card">
      <h2>Quality score <span id="execTitle" class="muted"></span></h2>
      <div class="scores" id="scores"></div>
      <div id="readiness" style="margin-top:12px"></div>
    </div>
    <div class="card">
      <h2>Findings</h2>
      <div id="findings"><span class="muted">select an execution</span></div>
    </div>
    <div class="card">
      <h2>Reports</h2>
      <div id="reports"><span class="muted">—</span></div>
    </div>
    <div class="card">
      <h2>Real-time event log</h2>
      <div class="log" id="log"></div>
    </div>
  </div>
</main>
<script>
const $=(id)=>document.getElementById(id);
const logEl=$('log'), execsEl=$('execs');
function log(msg){const d=document.createElement('div');d.textContent=new Date().toLocaleTimeString()+' '+msg;logEl.prepend(d);while(logEl.childNodes.length>200)logEl.removeChild(logEl.lastChild);}
function badge(txt){return '<span class="badge b-'+txt+'">'+txt+'</span>';}
async function loadHealth(){try{const r=await fetch('api/health');const j=await r.json();$('worker').textContent='worker '+j.workerId;}catch(e){}}
async function loadExecs(selectId){
  try{
    const r=await fetch('api/executions');const j=await r.json();
    if(!j.executions.length){execsEl.innerHTML='<span class="muted">none yet</span>';return;}
    execsEl.innerHTML=j.executions.map(e=>'<div class="exec" data-id="'+e.id+'"><span class="id">'+e.id+'</span> '+badge(e.state)+'<br/>'+
      '<span class="muted">'+e.target+'</span><br/>'+(e.score!==null?('score <b>'+e.score+'</b> · '):'')+(e.readiness?badge(e.readiness)+' · ':'')+e.findings+' finding(s)</div>').join('');
    execsEl.querySelectorAll('.exec').forEach(el=>el.addEventListener('click',()=>showExec(el.dataset.id)));
    if(selectId)showExec(selectId);
  }catch(e){log('load executions failed: '+e.message);}
}
function scoreCell(label,v){if(v===null||v===undefined)return '<div class="score"><b class="s-na">–</b><span class="muted">'+label+'</span></div>';
  const c=v>=85?'s-good':v>=70?'s-warn':'s-bad';return '<div class="score"><b class="'+c+'">'+v+'</b><span class="muted">'+label+'</span></div>';}
async function showExec(id){
  try{
    const r=await fetch('api/executions/'+encodeURIComponent(id));const j=await r.json();const e=j.execution;
    $('execTitle').textContent='· '+id;
    const s=e.score||{};
    $('scores').innerHTML=[['Overall',s.overall],['Functional',s.functional],['UI',s.ui],['API',s.api],['Perf',s.performance],['A11y',s.accessibility],['SEO',s.seo],['Security',s.security],['Reliab',s.reliability]].map(([l,v])=>scoreCell(l,v)).join('');
    let readiness='';
    if(e.release){readiness='<div>'+badge(e.release.readiness)+'</div><ul class="muted">'+e.release.reasons.map(x=>'<li>'+x+'</li>').join('')+'</ul>';}
    $('readiness').innerHTML=readiness;
    $('findings').innerHTML=e.findings.length?('<table><tr><th>Severity</th><th>Category</th><th>Title</th><th>Where</th></tr>'+
      e.findings.map(f=>'<tr><td><span class="sev sev-'+f.severity+'">'+f.severity+'</span></td><td>'+f.category+'</td><td>'+f.title+(f.rootCause?'<br/><span class="muted">RCA: '+f.rootCause.classification+' ('+Math.round(f.rootCause.confidence*100)+'%)</span>':'')+'</td><td class="muted">'+(f.url||'')+'</td></tr>').join('')+'</table>'):'<span class="muted">no findings — clean</span>';
    $('reports').innerHTML=(e.reportPaths||[]).map(p=>'<a href="'+p+'" target="_blank">'+p+'</a>').join('<br/>')||'<span class="muted">—</span>';
  }catch(err){log('detail load failed: '+err.message);}
}
$('scanBtn').addEventListener('click',async()=>{
  const btn=$('scanBtn');btn.disabled=true;$('scanMsg').textContent='scanning… (this takes a few seconds)';
  try{
    const body={target:$('target').value.trim(),allow:$('allow').value,endpoints:$('endpoints').value.split(',').map(s=>s.trim()).filter(Boolean)};
    const r=await fetch('api/scans',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    if(!r.ok){$('scanMsg').textContent='DENIED/ERROR: '+j.error;log('scan denied: '+j.error);}
    else{
      $('scanMsg').textContent='execution '+j.executionId+' → '+j.readiness+' (score '+j.score.overall+', '+j.findings+' findings)';
      log('scan complete: '+j.executionId+' '+j.readiness);
      if(j.degraded)j.degradationNotes.forEach(n=>log('degraded: '+n));
      await loadExecs(j.executionId);
    }
  }catch(e){$('scanMsg').textContent='scan failed: '+e.message;}
  btn.disabled=false;
});
function connectSSE(){
  const es=new EventSource('api/events');
  es.onopen=()=>{$('sseDot').classList.add('on');$('sseStatus').textContent='live';};
  es.onerror=()=>{$('sseDot').classList.remove('on');$('sseStatus').textContent='reconnecting…';};
  es.onmessage=(m)=>{try{const e=JSON.parse(m.data);
    if(e.type==='step.state')log('['+e.executionId+'] step '+e.data.name+' → '+e.data.state);
    else if(e.type==='execution.state')log('['+e.executionId+'] execution → '+e.data.state);
    else if(e.type==='healing.applied')log('['+e.executionId+'] HEALING '+e.data.strategy+' (conf '+Math.round(e.data.confidence*100)+'%): '+e.data.description);
    else if(e.type==='score.computed')log('['+e.executionId+'] score '+e.data.score.overall+' → '+e.data.readiness);
    else if(e.type==='report.generated')log('['+e.executionId+'] report: '+e.data.paths.join(', '));
    else if(e.type==='authorization.denied')log('['+e.executionId+'] DENIED '+e.data.reason);
  }catch(_){}};
}
loadHealth();loadExecs();connectSSE();
</script>
</body>
</html>`;
}
