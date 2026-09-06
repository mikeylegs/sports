#!/usr/bin/env node
// Art-Net DMX controller — zero dependencies. Data-driven with a live in-app
// fixture editor. Fixtures/profiles persist to patch.json + profiles.json
// (auto-created next to this file on first run). Add/edit fixtures from the
// browser — no restart, no code edits.
//
// Run:  node artnet-controller.js   then open the printed URL on your iPhone.

const http  = require('http');
const dgram = require('dgram');
const os    = require('os');
const fs    = require('fs');
const path  = require('path');

const HTTP_PORT   = 8080;
const ARTNET_PORT = 6454;
const PATCH_FILE   = path.join(__dirname, 'patch.json');
const PROFILE_FILE = path.join(__dirname, 'profiles.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const SCENES_FILE   = path.join(__dirname, 'scenes.json');

// --- seed defaults on first run ---------------------------------------------
const SEED_PROFILES = {
  "line-anim-34": ["Total Switch","Out of Bounds Mode & Pattern Size","Animation & Line Gallery Selection","Animation Pattern & Line Effect Selection","Pattern Scaling","Pattern Rotation","Horizontal Movement","Vertical Movement","Horizontal Zoom","Vertical Zoom","Force Tinting","Color Change","Node Highlighting","Node Expansion","Gradient","Degree of Distortion","Filter Selection","2nd Pattern Switch","Out of Bounds Mode & Pattern Size","No Function","2nd Pattern Selection","Pattern Scaling","Pattern Rotation","Horizontal Movement","Vertical Movement","Horizontal Zoom","Vertical Zoom","Force Tinting","Color Change","Node Highlighting","Node Expansion","Gradient","Degree of Distortion","Filter Selection"]
};
const SEED_PATCH = [ { name:"Fixture 1", profile:"line-anim-34", universe:0, start:1 } ];

function load(file, seed){
  try { return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(e){ fs.writeFileSync(file, JSON.stringify(seed,null,2)); return JSON.parse(JSON.stringify(seed)); }
}
let profiles = load(PROFILE_FILE, SEED_PROFILES);
let patch    = load(PATCH_FILE,   SEED_PATCH);
function save(){ fs.writeFileSync(PATCH_FILE, JSON.stringify(patch,null,2)); fs.writeFileSync(PROFILE_FILE, JSON.stringify(profiles,null,2)); }

let state = load(SETTINGS_FILE, { targetIP: '192.168.1.255' });
if(!Array.isArray(state.kasa)) state.kasa = [];
function saveSettings(){ fs.writeFileSync(SETTINGS_FILE, JSON.stringify(state,null,2)); }

let scenes = load(SCENES_FILE, []);
function saveScenes(){ fs.writeFileSync(SCENES_FILE, JSON.stringify(scenes,null,2)); }

// --- DMX buffers, one per universe used by the patch ------------------------
const universes = {};
function rebuildUniverses(){ for(const f of patch) if(!universes[f.universe]) universes[f.universe] = new Array(512).fill(0); }
rebuildUniverses();
const seq = {};

// --- UDP / Art-Net ----------------------------------------------------------
const sock = dgram.createSocket({ type:'udp4', reuseAddr:true });
sock.bind(() => sock.setBroadcast(true));
function frame(u){
  const d = universes[u], buf = Buffer.alloc(18+512);
  buf.write('Art-Net\0',0,'latin1');
  buf.writeUInt16LE(0x5000,8); buf.writeUInt16BE(14,10);
  seq[u] = (seq[u]||0)>=255 ? 1 : (seq[u]||0)+1;
  buf[12]=seq[u]; buf[13]=0;
  buf[14]=u & 0xff; buf[15]=(u>>8)&0x7f;
  buf.writeUInt16BE(512,16);
  for(let i=0;i<512;i++) buf[18+i]=d[i]&0xff;
  return buf;
}
function sendU(u){ if(!universes[u]) return; const p=frame(u); sock.send(p,0,p.length,ARTNET_PORT,state.targetIP); }
function sendAll(){ for(const u in universes) sendU(+u); }
setInterval(sendAll, 500);

// --- Kasa smart plugs (legacy local protocol, TCP/UDP 9999) -----------------
const net = require('net');
function kEnc(str){ let k=0xAB; const b=Buffer.from(str,'utf8'), o=Buffer.alloc(b.length); for(let i=0;i<b.length;i++){k^=b[i];o[i]=k;} return o; }
function kDec(buf){ let k=0xAB; const o=Buffer.alloc(buf.length); for(let i=0;i<buf.length;i++){const c=buf[i];o[i]=k^c;k=c;} return o.toString('utf8'); }
function kEncTCP(str){ const e=kEnc(str); const h=Buffer.alloc(4); h.writeUInt32BE(e.length,0); return Buffer.concat([h,e]); }

function kasaDiscover(timeout){
  return new Promise(resolve=>{
    const s=dgram.createSocket({type:'udp4',reuseAddr:true}); const out=[];
    s.on('message',(msg,rinfo)=>{
      try{
        const info=JSON.parse(kDec(msg)).system.get_sysinfo;
        const dev={ ip:rinfo.address, alias:info.alias||info.dev_name||'Kasa', model:info.model||'', outlets:[] };
        if(Array.isArray(info.children) && info.children.length){
          const base=info.deviceId||'';
          info.children.forEach(c=>{ const id=(c.id&&c.id.length>2)?c.id:(base+(c.id||'')); dev.outlets.push({ id:id, alias:c.alias||('Outlet '+(c.id||'')), on:!!c.state }); });
        } else { dev.outlets.push({ id:null, alias:dev.alias, on:!!info.relay_state }); }
        out.push(dev);
      }catch(e){}
    });
    s.bind(()=>{ s.setBroadcast(true); const p=kEnc('{"system":{"get_sysinfo":{}}}'); s.send(p,0,p.length,9999,'255.255.255.255'); });
    setTimeout(()=>{ try{s.close();}catch(e){} resolve(out); }, timeout||1600);
  });
}
function kasaSet(ip, childId, on){
  return new Promise(resolve=>{
    const cmd = childId
      ? '{"context":{"child_ids":["'+childId+'"]},"system":{"set_relay_state":{"state":'+(on?1:0)+'}}}'
      : '{"system":{"set_relay_state":{"state":'+(on?1:0)+'}}}';
    const sk=new net.Socket(); let done=false;
    const fin=ok=>{ if(done)return; done=true; try{sk.destroy();}catch(e){} resolve(ok); };
    sk.setTimeout(2500);
    sk.connect(9999, ip, ()=>sk.write(kEncTCP(cmd)));
    sk.on('data',()=>fin(true)); sk.on('timeout',()=>fin(false)); sk.on('error',()=>fin(false));
  });
}
async function kasaSetAll(on){ for(const o of (state.kasa||[])) await kasaSet(o.ip, o.childId, on); }

// --- config mutations -------------------------------------------------------
function genNames(n){ const a=[]; for(let i=1;i<=n;i++) a.push('Ch '+i); return a; }
function applyConfig(d){
  if(d.newProfile && d.newProfile.id){
    const id=String(d.newProfile.id).trim();
    const n=Math.max(1,Math.min(512, d.newProfile.channels|0));
    if(id){ profiles[id]=genNames(n); if(d.fixture && (!d.fixture.profile || d.fixture.profile==='__new__')) d.fixture.profile=id; }
  }
  if(d.action==='addFixture'){
    const f=d.fixture||{};
    if(!profiles[f.profile]) throw new Error('unknown profile: '+f.profile);
    patch.push({ name:String(f.name||'Fixture').trim(), profile:f.profile, universe:Math.max(0,f.universe|0), start:Math.max(1,Math.min(512,f.start|0)) });
  } else if(d.action==='updateFixture'){
    const f=d.fixture||{};
    if(!patch[d.index]) throw new Error('bad index');
    if(!profiles[f.profile]) throw new Error('unknown profile: '+f.profile);
    patch[d.index]={ name:String(f.name||'Fixture').trim(), profile:f.profile, universe:Math.max(0,f.universe|0), start:Math.max(1,Math.min(512,f.start|0)) };
  } else if(d.action==='deleteFixture'){
    if(!patch[d.index]) throw new Error('bad index');
    patch.splice(d.index,1);
  }
  save(); rebuildUniverses();
}

// --- scenes: named snapshots of the live DMX state --------------------------
function snapshotUniverses(){
  const snap = {};
  for(const u in universes) snap[u] = universes[u].slice();
  return snap;
}
function applySnapshot(snap){
  for(const u in snap){
    if(!universes[u]) universes[u] = new Array(512).fill(0);
    universes[u] = snap[u].slice();
    sendU(+u);
  }
}
function applyScenes(d){
  if(d.action==='save'){
    const name = String(d.name||'Scene').trim();
    if(!name) throw new Error('name required');
    if(d.id){
      const s = scenes.find(x=>x.id===d.id);
      if(!s) throw new Error('unknown scene');
      s.name = name; s.snapshot = snapshotUniverses();
    } else {
      scenes.push({ id:'scene-'+Date.now(), name:name, snapshot:snapshotUniverses() });
    }
  } else if(d.action==='rename'){
    const s = scenes.find(x=>x.id===d.id);
    if(!s) throw new Error('unknown scene');
    s.name = String(d.name||s.name).trim();
  } else if(d.action==='delete'){
    const i = scenes.findIndex(x=>x.id===d.id);
    if(i<0) throw new Error('unknown scene');
    scenes.splice(i,1);
  } else if(d.action==='reorder'){
    if(!Array.isArray(d.order)) throw new Error('bad order');
    const byId = {}; scenes.forEach(s=>byId[s.id]=s);
    const next = d.order.map(id=>byId[id]).filter(Boolean);
    scenes.forEach(s=>{ if(!d.order.includes(s.id)) next.push(s); });
    scenes = next;
  } else throw new Error('bad action');
  saveScenes();
}

// --- HTTP -------------------------------------------------------------------
function setCh(u,a,val){ if(universes[u]&&a>=1&&a<=512) universes[u][a-1]=Math.max(0,Math.min(255,val|0)); }
function readBody(req){ return new Promise(res=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>res(b)); }); }

const server = http.createServer(async (req,res) => {
  if(req.method==='POST' && req.url==='/dmx'){
    try{
      const d=JSON.parse(await readBody(req));
      if(typeof d.targetIP==='string'){ state.targetIP=d.targetIP.trim(); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(state,null,2)); }
      if(typeof d.u==='number'){ setCh(d.u,d.a,d.val); sendU(d.u); }
      if(Array.isArray(d.bulk)){ const t=new Set(); for(const [u,a,val] of d.bulk){setCh(u,a,val);t.add(u);} t.forEach(u=>sendU(u)); }
      res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}');
    }catch(e){ res.writeHead(400); res.end('bad json'); }
    return;
  }
  if(req.method==='POST' && req.url==='/config'){
    try{
      applyConfig(JSON.parse(await readBody(req)));
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    }catch(e){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if(req.method==='POST' && req.url==='/kasa'){
    try{
      const d=JSON.parse(await readBody(req));
      if(d.action==='discover'){ const devices=await kasaDiscover(1600); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,devices:devices,saved:state.kasa||[]})); return; }
      if(d.action==='save'){ state.kasa=Array.isArray(d.outlets)?d.outlets:[]; saveSettings(); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); return; }
      if(d.action==='set'){ await kasaSetAll(!!d.state); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); return; }
      if(d.action==='setOne'){ const ok=await kasaSet(d.ip, d.childId||null, !!d.state); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:ok})); return; }
      res.writeHead(400); res.end('bad action');
    }catch(e){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if(req.method==='GET' && req.url==='/scenes'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ scenes: scenes.map(s=>({id:s.id,name:s.name})) }));
    return;
  }
  if(req.method==='POST' && req.url==='/scenes'){
    try{
      applyScenes(JSON.parse(await readBody(req)));
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, scenes: scenes.map(s=>({id:s.id,name:s.name})) }));
    }catch(e){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if(req.method==='POST' && req.url==='/fire'){
    try{
      const d=JSON.parse(await readBody(req));
      const s=scenes.find(x=>x.id===d.id);
      if(!s) throw new Error('unknown scene');
      applySnapshot(s.snapshot);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}');
    }catch(e){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }
  if(req.method==='POST' && req.url==='/blackout'){
    for(const u in universes){ universes[u].fill(0); sendU(+u); }
    res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}');
    return;
  }
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(pageHTML());
});
server.listen(HTTP_PORT,'0.0.0.0',()=>{
  const ips=[]; const ifs=os.networkInterfaces();
  for(const name of Object.keys(ifs)) for(const i of ifs[name]) if(i.family==='IPv4'&&!i.internal) ips.push(i.address);
  console.log('\n  Art-Net controller running.');
  console.log('  Sending DMX to '+state.targetIP+':'+ARTNET_PORT+'  ·  universes: '+Object.keys(universes).join(', ')+'\n');
  console.log('  Open this on your iPhone (same Wi-Fi):');
  if(ips.length) ips.forEach(ip=>console.log('     ->  http://'+ip+':'+HTTP_PORT)); else console.log('     ->  http://<this-machine-ip>:'+HTTP_PORT);
  console.log('');
});

// --- UI ---------------------------------------------------------------------
function pageHTML(){ return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="DMX">
<title>Art-Net Controller</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font:15px -apple-system,system-ui,sans-serif;background:#0d0f12;color:#e8eaed}
  header{position:sticky;top:0;background:#15181d;padding:12px 14px;border-bottom:1px solid #262b33;display:flex;gap:8px;align-items:center;flex-wrap:wrap;z-index:2}
  header b{font-size:16px;margin-right:auto}
  input.cfg{background:#0d0f12;border:1px solid #2c333d;color:#e8eaed;border-radius:8px;padding:6px 8px;width:130px}
  button{background:#2c333d;border:0;color:#e8eaed;border-radius:8px;padding:8px 12px;font-weight:600}
  button.blk{background:#5a1f24} button.blk.on{background:#3a86ff}
  .rows{padding:8px 14px 40px}
  .fx{margin:16px 0 6px;display:flex;justify-content:space-between;align-items:baseline}
  .fx b{font-weight:700;color:#8fb3ff;font-size:14px;letter-spacing:.3px}
  .fx span{color:#6b7280;font-size:12px}
  .row{padding:9px 0;border-bottom:1px solid #191d23}
  .lbl{display:block;margin-bottom:5px;color:#9aa4b2;font-size:13px}
  .lbl b{color:#e8eaed;font-variant-numeric:tabular-nums}
  .ctl{display:flex;align-items:center;gap:12px}
  input[type=range]{-webkit-appearance:none;appearance:none;flex:1;height:44px;background:transparent}
  input[type=range]::-webkit-slider-runnable-track{height:14px;border-radius:7px;background:#2c333d}
  input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:40px;height:40px;border-radius:50%;background:#3a86ff;margin-top:-13px;box-shadow:0 1px 4px rgba(0,0,0,.5)}
  .val{width:64px;text-align:center;font-variant-numeric:tabular-nums;color:#fff;background:#0d0f12;border:1px solid #2c333d;border-radius:8px;padding:7px 4px;font-size:15px}
  /* editor modal */
  .scrim{position:fixed;inset:0;background:rgba(4,5,7,.6);display:none;z-index:10}
  .scrim.open{display:block}
  .modal{position:fixed;inset:0;margin:auto;max-width:520px;max-height:88vh;overflow:auto;background:#0d0f14;border:1px solid #1c1f27;border-radius:16px;padding:20px;z-index:11;display:none}
  .modal.open{display:block}
  .modal h2{margin:0 0 14px;font-size:19px}
  .fxrow{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #191d23;font-size:14px}
  .fxrow .info{flex:1}.fxrow .info small{color:#6b7280;display:block}
  .mini{padding:6px 10px;font-size:13px}
  .form{margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .form .full{grid-column:1/-1}
  .form label{display:block;font-size:12px;color:#6b7280;margin-bottom:4px}
  .form input,.form select{width:100%;background:#08090c;border:1px solid #232733;color:#e8eaed;border-radius:9px;padding:9px 10px;font-size:15px}
  .err{color:#ff6b6b;font-size:13px;margin-top:8px;min-height:16px}
</style></head><body>
<header>
  <b>Art-Net Controller</b>
  <label>IP <input class="cfg" id="ip" value="${state.targetIP}"></label>
  <button id="apply">Apply</button>
  <button id="fxbtn">Fixtures</button>
  <button id="konb" style="background:#1f5a2a">Lights On</button>
  <button id="koffb">Lights Off</button>
  <button class="blk" id="blk">Blackout</button>
</header>
<div class="rows" id="rows"></div>

<div class="scrim" id="scrim"></div>
<div class="modal" id="modal">
  <h2>Fixtures</h2>
  <div id="fxlist"></div>
  <div class="form" id="form">
    <div class="full"><label>Name</label><input id="f_name" placeholder="e.g. Strobe L"></div>
    <div class="full"><label>Profile</label><select id="f_profile"></select></div>
    <div id="newprof" style="display:none;grid-column:1/-1;grid-template-columns:1fr 1fr;gap:10px" >
      <div><label>New profile name</label><input id="f_pid" placeholder="e.g. strobe-7"></div>
      <div><label>Channel count</label><input id="f_pcount" type="number" min="1" max="512" value="7"></div>
    </div>
    <div><label>Universe</label><input id="f_uni" type="number" min="0" value="0"></div>
    <div><label>Start address</label><input id="f_start" type="number" min="1" max="512" value="1"></div>
    <div class="full"><button id="save" style="width:100%">Add fixture</button></div>
    <div class="full err" id="err"></div>
  </div>
  <h2 style="margin-top:24px">Power (Kasa)</h2>
  <div style="color:#6b7280;font-size:12px;margin-bottom:8px">Scan, tap On/Off to identify each outlet, tick the ones that power your rig, then Save. "Lights On/Off" up top drives the ticked set.</div>
  <button class="mini" id="kscan">Scan plugs</button>
  <div id="klist" style="margin-top:10px"></div>
  <button class="mini" id="ksave" style="margin-top:10px;display:none">Save rig selection</button>

  <h2 style="margin-top:24px">Scenes</h2>
  <div style="color:#6b7280;font-size:12px;margin-bottom:8px">Dial in a look with the sliders above, name it, and save. These become the pads in Performance mode.</div>
  <div id="scenelist"></div>
  <div style="display:flex;gap:8px;margin-top:10px">
    <input id="sc_name" placeholder="Scene name" style="flex:1;background:#08090c;border:1px solid #232733;color:#e8eaed;border-radius:9px;padding:9px 10px;font-size:14px">
    <button class="mini" id="sc_save">Save current</button>
  </div>
  <div style="margin-top:12px"><a href="/perform" style="color:#3a86ff;font-size:13px;text-decoration:none">&rarr; Open Performance mode</a></div>

  <button class="mini" id="close" style="margin-top:20px">Done</button>
</div>

<script>
var PATCH=${JSON.stringify(patch)}, PROFILES=${JSON.stringify(profiles)}, LEVELS=${JSON.stringify(universes)};
var rows=document.getElementById('rows'), ALL=[];
var blk=document.getElementById('blk'); var blackoutOn=false, saved=null;
function post(o){fetch('/dmx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});}
function lvl(u,a){ return (LEVELS[u]&&LEVELS[u][a-1])||0; }

function buildSliders(){
  rows.innerHTML=''; ALL=[];
  PATCH.forEach(function(f){
    var prof=PROFILES[f.profile]||[];
    var h=document.createElement('div');h.className='fx';
    h.innerHTML='<b>'+f.name+'</b><span>'+f.profile+' \u00b7 U'+f.universe+' \u00b7 ch '+f.start+'-'+(f.start+prof.length-1)+'</span>';
    rows.appendChild(h);
    prof.forEach(function(c,i){
      var a=f.start+i, u=f.universe, v0=lvl(u,a);
      var r=document.createElement('div');r.className='row';
      r.innerHTML='<span class="lbl"><b>'+a+'</b> \u00b7 '+c+'</span>'+
        '<div class="ctl"><input type="range" min="0" max="255" value="'+v0+'">'+
        '<input type="number" class="val" min="0" max="255" value="'+v0+'" inputmode="numeric"></div>';
      var s=r.querySelector('input[type=range]'), v=r.querySelector('.val');
      ALL.push({s:s,v:v,u:u,a:a});
      function push(val){val=Math.max(0,Math.min(255,val|0));s.value=val;v.value=val;post({u:u,a:a,val:val});
        if(blackoutOn){blackoutOn=false;blk.classList.remove('on');blk.textContent='Blackout';}}
      s.addEventListener('input',function(){push(+s.value);});
      v.addEventListener('change',function(){push(+v.value);});
      rows.appendChild(r);
    });
  });
}
buildSliders();

blk.onclick=function(){
  if(!blackoutOn){ saved=ALL.map(function(x){return +x.s.value;});
    ALL.forEach(function(x){x.s.value=0;x.v.value=0;});
    post({bulk:ALL.map(function(x){return [x.u,x.a,0];})});
    blackoutOn=true;blk.classList.add('on');blk.textContent='Restore';
  }else{ ALL.forEach(function(x,i){x.s.value=saved[i];x.v.value=saved[i];});
    post({bulk:ALL.map(function(x,i){return [x.u,x.a,saved[i]];})});
    blackoutOn=false;blk.classList.remove('on');blk.textContent='Blackout';
  }
};
document.getElementById('apply').onclick=function(){post({targetIP:document.getElementById('ip').value});};

// ---- fixture editor ----
var scrim=document.getElementById('scrim'), modal=document.getElementById('modal');
var fxlist=document.getElementById('fxlist'), sel=document.getElementById('f_profile');
var editIndex=-1;
function openMod(){ renderList(); fillProfiles(); resetForm(); loadScenes(); scrim.classList.add('open'); modal.classList.add('open'); }
function closeMod(){ scrim.classList.remove('open'); modal.classList.remove('open'); }
document.getElementById('fxbtn').onclick=openMod;
scrim.onclick=closeMod; document.getElementById('close').onclick=closeMod;

function renderList(){
  fxlist.innerHTML='';
  PATCH.forEach(function(f,idx){
    var prof=PROFILES[f.profile]||[];
    var row=document.createElement('div');row.className='fxrow';
    row.innerHTML='<div class="info">'+f.name+'<small>'+f.profile+' \u00b7 U'+f.universe+' \u00b7 ch '+f.start+'-'+(f.start+prof.length-1)+'</small></div>';
    var e=document.createElement('button');e.className='mini';e.textContent='Edit';e.onclick=function(){loadForm(idx);};
    var d=document.createElement('button');d.className='mini';d.textContent='Delete';d.onclick=function(){sendConfig({action:'deleteFixture',index:idx});};
    row.appendChild(e); row.appendChild(d); fxlist.appendChild(row);
  });
}
function fillProfiles(){
  sel.innerHTML='';
  Object.keys(PROFILES).forEach(function(id){ var o=document.createElement('option');o.value=id;o.textContent=id+' ('+PROFILES[id].length+'ch)';sel.appendChild(o); });
  var o=document.createElement('option');o.value='__new__';o.textContent='\uff0b New generic profile\u2026';sel.appendChild(o);
}
sel.onchange=function(){ document.getElementById('newprof').style.display = sel.value==='__new__' ? 'grid' : 'none'; };
function resetForm(){
  editIndex=-1; document.getElementById('save').textContent='Add fixture';
  document.getElementById('f_name').value=''; document.getElementById('f_uni').value=0;
  document.getElementById('f_start').value=1; document.getElementById('err').textContent='';
  sel.value=Object.keys(PROFILES)[0]||'__new__'; sel.onchange();
}
function loadForm(idx){
  editIndex=idx; var f=PATCH[idx];
  document.getElementById('save').textContent='Save changes';
  document.getElementById('f_name').value=f.name;
  document.getElementById('f_uni').value=f.universe;
  document.getElementById('f_start').value=f.start;
  sel.value=f.profile; sel.onchange();
  document.getElementById('err').textContent='';
}
document.getElementById('save').onclick=function(){
  var body={ fixture:{ name:document.getElementById('f_name').value,
      profile:sel.value, universe:+document.getElementById('f_uni').value, start:+document.getElementById('f_start').value } };
  if(sel.value==='__new__'){
    var pid=document.getElementById('f_pid').value.trim();
    body.newProfile={ id:pid, channels:+document.getElementById('f_pcount').value };
    body.fixture.profile=pid;
  }
  body.action = editIndex>=0 ? 'updateFixture' : 'addFixture';
  if(editIndex>=0) body.index=editIndex;
  sendConfig(body);
};
function sendConfig(body){
  fetch('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json();})
    .then(function(j){ if(j.error){ document.getElementById('err').textContent=j.error; } else { location.reload(); } })
    .catch(function(){ document.getElementById('err').textContent='request failed'; });
}

// ---- Scenes ----
var scenelist=document.getElementById('scenelist');
function loadScenes(){
  fetch('/scenes').then(function(r){return r.json();}).then(function(j){
    scenelist.innerHTML='';
    (j.scenes||[]).forEach(function(s){
      var row=document.createElement('div');row.className='fxrow';
      row.innerHTML='<div class="info">'+s.name+'</div>';
      var recall=document.createElement('button');recall.className='mini';recall.textContent='Recall';
      recall.onclick=function(){
        fetch('/fire',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:s.id})})
          .then(function(){location.reload();});
      };
      var ren=document.createElement('button');ren.className='mini';ren.textContent='Rename';
      ren.onclick=function(){
        var nm=prompt('Rename scene',s.name);
        if(nm) fetch('/scenes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'rename',id:s.id,name:nm})}).then(loadScenes);
      };
      var del=document.createElement('button');del.className='mini';del.textContent='Delete';
      del.onclick=function(){
        if(confirm('Delete "'+s.name+'"?')) fetch('/scenes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',id:s.id})}).then(loadScenes);
      };
      row.appendChild(recall); row.appendChild(ren); row.appendChild(del);
      scenelist.appendChild(row);
    });
  });
}
document.getElementById('sc_save').onclick=function(){
  var nm=document.getElementById('sc_name').value.trim();
  if(!nm) return;
  fetch('/scenes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',name:nm})})
    .then(function(r){return r.json();})
    .then(function(){ document.getElementById('sc_name').value=''; loadScenes(); });
};

// ---- Kasa power ----
function kfetch(b){ return fetch('/kasa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json();}); }
document.getElementById('konb').onclick=function(){ kfetch({action:'set',state:1}); };
document.getElementById('koffb').onclick=function(){ kfetch({action:'set',state:0}); };
var klist=document.getElementById('klist'), ksave=document.getElementById('ksave'), scanned=[];
function keyOf(ip,cid){ return ip+'|'+(cid||''); }
document.getElementById('kscan').onclick=function(){
  klist.textContent='Scanning\u2026'; ksave.style.display='none';
  kfetch({action:'discover'}).then(function(j){
    scanned=[]; klist.innerHTML='';
    var savedKeys={}; (j.saved||[]).forEach(function(o){ savedKeys[keyOf(o.ip,o.childId)]=true; });
    (j.devices||[]).forEach(function(dev){
      dev.outlets.forEach(function(o){
        var idx=scanned.length; scanned.push({ip:dev.ip,childId:o.id,alias:o.alias});
        var multi=dev.outlets.length>1;
        var row=document.createElement('div');row.className='fxrow';
        var cb=document.createElement('input');cb.type='checkbox';cb.dataset.i=idx;cb.checked=!!savedKeys[keyOf(dev.ip,o.id)];
        var lab=document.createElement('div');lab.className='info';
        lab.innerHTML=(multi?dev.alias+' \u2014 ':'')+o.alias+'<small>'+dev.ip+(o.on?' \u00b7 on':' \u00b7 off')+'</small>';
        var on=document.createElement('button');on.className='mini';on.textContent='On';on.onclick=function(){kfetch({action:'setOne',ip:dev.ip,childId:o.id,state:1});};
        var off=document.createElement('button');off.className='mini';off.textContent='Off';off.onclick=function(){kfetch({action:'setOne',ip:dev.ip,childId:o.id,state:0});};
        row.appendChild(cb);row.appendChild(lab);row.appendChild(on);row.appendChild(off);
        klist.appendChild(row);
      });
    });
    if(!scanned.length){ klist.textContent='No plugs answered.'; } else { ksave.style.display=''; ksave.textContent='Save rig selection'; }
  }).catch(function(){ klist.textContent='Scan failed.'; });
};
ksave.onclick=function(){
  var picked=[]; var cbs=klist.querySelectorAll('input[type=checkbox]');
  for(var i=0;i<cbs.length;i++){ if(cbs[i].checked) picked.push(scanned[+cbs[i].dataset.i]); }
  kfetch({action:'save',outlets:picked}).then(function(){ ksave.textContent='Saved \u2713'; setTimeout(function(){ksave.textContent='Save rig selection';},1200); });
};
</script></body></html>`; }
