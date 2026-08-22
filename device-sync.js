(function(){
"use strict";

/* ==============================================================
   LocDailyMar Multi-Device Sync v2
   Transport : HTTP + SSE
   Topology  : 1 room -> banyak device (A, B, C, D, ...)
   ============================================================= */

const VERSION="2.0.0";
const CONFIG_KEY="ldmDeviceSync:config:v2";
const DEVICE_ID_KEY="ldmDeviceSync:deviceId";
const DEVICE_NAME_KEY="ldmDeviceSync:deviceName";
const OUTBOX_KEY="ldmDeviceSync:outbox:v2";
const STATUS_EVENT="ldm-device-sync-status";
const DATA_EVENT="ldm-sync-updated";

const ARRAY_KEYS=new Set([
  "laporan","laporanHistory","riwayatTransaksi","dataBarang","operasional",
  "dataAbsensi","dataStockOpname","dataPurchaseOrder","goodsReceiptSourcePO",
  "dataGoodsReceipt","auditLog","shiftClosingLog","endOfDayLog","daftarKaryawan"
]);

const REPLACE_KEYS=new Set([
  "headerConfig","strukConfig","purchaseOrderLastUpdate","goodsReceiptLastUpdate",
  "approvedPOForGoodsReceiptLastUpdate","endOfDayLastUpdate"
]);

const SYNC_KEYS=new Set([...ARRAY_KEYS,...REPLACE_KEYS]);
const ALIAS_TO_CANONICAL={dataLaporan:"laporan"};
const MIRRORS={laporan:["dataLaporan"]};

/* Credential/session/draft sengaja tidak disinkronkan. */
const BLOCKED_KEYS=new Set([
  "daftarAkun","appAuthPassword","passClosingMap","loginSecurity","loginSession",
  "loginTimestamp","isLoggedIn","loggedInUser","activeUsername","username","userRole",
  "pendingTransactions","currentOpnameTanggal"
]);

const originalSetItem=Storage.prototype.setItem;
const originalRemoveItem=Storage.prototype.removeItem;
const originalGetItem=Storage.prototype.getItem;

let eventSource=null;
let applyingRemote=false;
let flushing=false;
let streamReady=false;
let reconnectTimer=null;
let reconnectAttempt=0;
let lastPresence={onlineCount:0,devices:[],connections:0};
let lastSyncAt=0;
let healthOk=false;
let lastStatus="disconnected";

function safeParse(raw,fallback){try{const v=JSON.parse(raw);return v==null?fallback:v}catch{return fallback}}
function canonicalKey(k){return ALIAS_TO_CANONICAL[k]||k}
function isSyncKey(k){return SYNC_KEYS.has(canonicalKey(k))&&!BLOCKED_KEYS.has(k)}
function normalizeServerBase(v){let s=String(v||defaultServerBase()).trim().replace(/\/+$/,'');return s}
function defaultServerBase(){return (location.protocol==='http:'||location.protocol==='https:')?location.origin:'http://127.0.0.1:8787'}
function normalizeRoom(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8)}
function displayRoom(v){const s=normalizeRoom(v);return s.length>4?s.slice(0,4)+'-'+s.slice(4):s}
function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')}
function nowText(ts){if(!ts)return'-';try{return new Date(ts).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch{return'-'}}

function getDeviceId(){
  let id=originalGetItem.call(localStorage,DEVICE_ID_KEY);
  if(id)return id;
  id=(window.crypto&&crypto.randomUUID)?'dev_'+crypto.randomUUID():'dev_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
  originalSetItem.call(localStorage,DEVICE_ID_KEY,id);return id;
}
function defaultDeviceName(){return 'Device '+getDeviceId().replace(/^dev_/,'').slice(0,6).toUpperCase()}
function getDeviceName(){return originalGetItem.call(localStorage,DEVICE_NAME_KEY)||defaultDeviceName()}
function setDeviceName(v){const n=String(v||'').trim().slice(0,40)||defaultDeviceName();originalSetItem.call(localStorage,DEVICE_NAME_KEY,n);return n}
function getConfig(){const c=safeParse(originalGetItem.call(localStorage,CONFIG_KEY),{});return c&&typeof c==='object'?c:{}}
function saveConfig(c){originalSetItem.call(localStorage,CONFIG_KEY,JSON.stringify(c))}
function clearConfig(){originalRemoveItem.call(localStorage,CONFIG_KEY)}

function hashString(input){let h=2166136261;const t=String(input||'');for(let i=0;i<t.length;i++){h^=t.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(36)}
function itemIdentity(key,item,index){
  if(item==null||typeof item!=='object')return'primitive:'+hashString(JSON.stringify(item));
  const pick=(...names)=>{for(const n of names){const v=item[n];if(v!==undefined&&v!==null&&String(v).trim()!=='')return String(v).trim()}return''};
  let id=pick('id','uuid','uid','_id');if(id)return'id:'+id;
  if(key==='dataBarang'){id=pick('barcode','kodeBarang','kode','sku','plu');if(id)return'barang:'+id.toLowerCase();id=pick('nama','name');if(id)return'barang-nama:'+id.toLowerCase()}
  if(key==='shiftClosingLog'){const d=pick('tanggal','date'),u=pick('kasir','username','user').toLowerCase(),s=pick('shift').toLowerCase();if(d&&u&&s)return'closing:'+d+'|'+u+'|'+s}
  if(key==='dataAbsensi'){const d=pick('tanggal','date'),u=pick('employeeId','nikKaryawan','username','user').toLowerCase(),t=pick('jenis','status','type').toLowerCase();if(d&&u)return'absensi:'+d+'|'+u+'|'+t}
  if(key==='dataPurchaseOrder'||key==='goodsReceiptSourcePO'){id=pick('noPO','nomorPO','poNumber','kodePO','poId');if(id)return'po:'+id.toLowerCase()}
  if(key==='dataGoodsReceipt'){id=pick('noGR','nomorGR','grNumber','kodeGR','receiptNo','noPO','nomorPO');if(id)return'gr:'+id.toLowerCase()}
  if(key==='laporan'||key==='laporanHistory'||key==='riwayatTransaksi'){id=pick('id','timestamp','createdAt','waktu','tanggal');const u=pick('kasir','username','user').toLowerCase();if(id)return'trx:'+id+'|'+u}
  if(key==='daftarKaryawan'){id=pick('employeeId','nikKaryawan','username');if(id)return'employee:'+id.toLowerCase()}
  id=pick('employeeId','nikKaryawan','username','kode','nomor','number','timestamp','createdAt');if(id)return'generic:'+id.toLowerCase();
  return'json:'+hashString(JSON.stringify(item))+':'+index;
}
function arrayMap(key,value){const m=new Map();(Array.isArray(value)?value:[]).forEach((x,i)=>m.set(itemIdentity(key,x,i),x));return m}
function buildArrayPatch(key,oldRaw,newRaw){
  const a=safeParse(oldRaw,[]),b=safeParse(newRaw,[]);if(!Array.isArray(a)||!Array.isArray(b))return null;
  const am=arrayMap(key,a),bm=arrayMap(key,b),upserts=[],deletes=[];
  for(const [id,item] of bm){if(!am.has(id)||JSON.stringify(am.get(id))!==JSON.stringify(item))upserts.push({id,item})}
  for(const id of am.keys())if(!bm.has(id))deletes.push(id);
  return{upserts,deletes};
}

function getOutbox(){const a=safeParse(originalGetItem.call(localStorage,OUTBOX_KEY),[]);return Array.isArray(a)?a:[]}
function saveOutbox(a){originalSetItem.call(localStorage,OUTBOX_KEY,JSON.stringify(a.slice(-2000)))}
function enqueue(op){const cfg=getConfig();if(!cfg.room)return;const a=getOutbox();a.push({...op,room:cfg.room,opId:getDeviceId()+':'+Date.now()+':'+Math.random().toString(36).slice(2,8)});saveOutbox(a);flushOutbox()}
function clearOutboxForOtherRooms(room){saveOutbox(getOutbox().filter(x=>x&&x.room===room))}

function notify(status,extra={}){
  lastStatus=status;
  const detail={status,version:VERSION,serverOnline:healthOk,lastSyncAt,presence:lastPresence,...extra,config:getConfig()};
  window.dispatchEvent(new CustomEvent(STATUS_EVENT,{detail}));
  if(window.LDMDeviceSyncUI?.renderStatus)window.LDMDeviceSyncUI.renderStatus(detail);
}
function dispatchDataEvent(key,value){
  window.dispatchEvent(new CustomEvent(DATA_EVENT,{detail:{key,value}}));
  try{window.dispatchEvent(new StorageEvent('storage',{key,newValue:value,storageArea:localStorage,url:location.href}))}catch{window.dispatchEvent(new Event('storage'))}
}
function rebuildShiftDailyLogs(){const a=safeParse(originalGetItem.call(localStorage,'shiftClosingLog'),[]);if(!Array.isArray(a))return;const m={};for(const x of a){const d=String(x?.tanggal||'');if(!d)continue;(m[d]||(m[d]=[])).push(x)}for(const d in m)m[d].sort((a,b)=>Number(b?.id||0)-Number(a?.id||0));originalSetItem.call(localStorage,'shiftClosingDailyLogs',JSON.stringify(m))}
function applyValue(key,raw){
  if(!SYNC_KEYS.has(key))return;applyingRemote=true;
  try{if(raw==null){originalRemoveItem.call(localStorage,key);for(const m of MIRRORS[key]||[])originalRemoveItem.call(localStorage,m)}else{originalSetItem.call(localStorage,key,String(raw));for(const m of MIRRORS[key]||[])originalSetItem.call(localStorage,m,String(raw))}if(key==='shiftClosingLog')rebuildShiftDailyLogs()}finally{applyingRemote=false}
  dispatchDataEvent(key,raw);
}
function applySnapshot(data,clearMissing=true){
  applyingRemote=true;
  try{
    if(clearMissing){for(const key of SYNC_KEYS){if(!Object.prototype.hasOwnProperty.call(data||{},key)){originalRemoveItem.call(localStorage,key);for(const m of MIRRORS[key]||[])originalRemoveItem.call(localStorage,m)}}}
    for(const [key,val] of Object.entries(data||{})){if(!SYNC_KEYS.has(key))continue;if(val==null){originalRemoveItem.call(localStorage,key);for(const m of MIRRORS[key]||[])originalRemoveItem.call(localStorage,m)}else{originalSetItem.call(localStorage,key,String(val));for(const m of MIRRORS[key]||[])originalSetItem.call(localStorage,m,String(val))}}
    rebuildShiftDailyLogs();
  }finally{applyingRemote=false}
  for(const [k,v] of Object.entries(data||{}))if(SYNC_KEYS.has(k))dispatchDataEvent(k,v);
}
function collectSnapshot(){const o={};for(const k of SYNC_KEYS){const v=originalGetItem.call(localStorage,k);if(v!==null)o[k]=v}return o}
function makeOperation(key,oldRaw,newRaw){const k=canonicalKey(key);if(!SYNC_KEYS.has(k))return null;if(ARRAY_KEYS.has(k)){const p=buildArrayPatch(k,oldRaw,newRaw);if(p&&(p.upserts.length||p.deletes.length))return{action:'arrayPatch',key:k,upserts:p.upserts,deletes:p.deletes,ts:Date.now()}}if(oldRaw!==newRaw)return{action:'replace',key:k,value:newRaw,ts:Date.now()};return null}

Storage.prototype.setItem=function(key,value){
  if(this!==localStorage)return originalSetItem.call(this,key,value);
  const raw=String(value),k=canonicalKey(key),old=originalGetItem.call(localStorage,k);
  originalSetItem.call(this,key,raw);
  if(applyingRemote||!isSyncKey(key))return;
  if(k!==key)originalSetItem.call(localStorage,k,raw);
  for(const m of MIRRORS[k]||[])if(m!==key)originalSetItem.call(localStorage,m,raw);
  const op=makeOperation(k,old,raw);if(op)enqueue(op);
};
Storage.prototype.removeItem=function(key){
  if(this!==localStorage)return originalRemoveItem.call(this,key);
  const k=canonicalKey(key),had=originalGetItem.call(localStorage,k)!==null;
  originalRemoveItem.call(this,key);if(k!==key)originalRemoveItem.call(localStorage,k);for(const m of MIRRORS[k]||[])originalRemoveItem.call(localStorage,m);
  if(!applyingRemote&&isSyncKey(key)&&had)enqueue({action:'deleteKey',key:k,ts:Date.now()});
};

async function jsonFetch(url,options={}){
  const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),10000);
  try{const res=await fetch(url,{...options,signal:ctl.signal,headers:{'Content-Type':'application/json',...(options.headers||{})}});let data={};try{data=await res.json()}catch{}if(!res.ok)throw new Error(data.message||('HTTP '+res.status));return data}finally{clearTimeout(timer)}
}
async function checkHealth(serverBase){
  try{const res=await jsonFetch(normalizeServerBase(serverBase)+'/sync/health',{method:'GET'});healthOk=!!res.ok;notify(lastStatus,{serverVersion:res.version||''});return res}catch(e){healthOk=false;notify('error',{message:'Sync Server tidak dapat dihubungi: '+e.message});throw e}
}
async function postOp(operation){const c=getConfig();if(!c.room||!c.serverBase)throw new Error('Belum terhubung');return jsonFetch(normalizeServerBase(c.serverBase)+'/sync/op',{method:'POST',body:JSON.stringify({room:c.room,deviceId:getDeviceId(),deviceName:getDeviceName(),operation})})}
async function flushOutbox(){
  if(flushing||!streamReady)return;const c=getConfig();if(!c.room||!c.serverBase)return;flushing=true;
  try{while(streamReady){const a=getOutbox();if(!a.length)break;const op=a[0];if(op.room!==c.room){a.shift();saveOutbox(a);continue}try{await postOp(op)}catch(e){notify('reconnecting',{message:e.message});scheduleReconnect();break}const latest=getOutbox();if(latest[0]?.opId===op.opId)latest.shift();else{const i=latest.findIndex(x=>x.opId===op.opId);if(i>=0)latest.splice(i,1)}saveOutbox(latest)}}finally{flushing=false}
}

function closeStream(){streamReady=false;if(eventSource){try{eventSource.close()}catch{}eventSource=null}}
function scheduleReconnect(){if(reconnectTimer||!getConfig().room)return;const delay=Math.min(15000,800*Math.pow(1.7,reconnectAttempt++));reconnectTimer=setTimeout(()=>{reconnectTimer=null;resume().catch(()=>scheduleReconnect())},delay)}
function updatePresence(msg){lastPresence={onlineCount:Number(msg.onlineCount||0),connections:Number(msg.connections||0),devices:Array.isArray(msg.devices)?msg.devices:[]};notify('synced',{presence:lastPresence})}
function handleMessage(msg){
  if(!msg||typeof msg!=='object')return;
  if(msg.type==='connected'){streamReady=true;reconnectAttempt=0;lastSyncAt=Date.now();notify('connected',{room:displayRoom(msg.room)});flushOutbox();return}
  if(msg.type==='snapshot'){applySnapshot(msg.data||{},true);lastSyncAt=Date.now();streamReady=true;notify('synced',{revision:msg.revision||0});flushOutbox();return}
  if(msg.type==='updateKey'){applyValue(msg.key,msg.value);lastSyncAt=Date.now();notify('synced',{revision:msg.revision||0});return}
  if(msg.type==='deleteKey'){applyValue(msg.key,null);lastSyncAt=Date.now();notify('synced',{revision:msg.revision||0});return}
  if(msg.type==='presence'){updatePresence(msg);return}
  if(msg.type==='error'){notify('error',{message:msg.message||'Gagal sync',code:msg.code});return}
}
function openStream(){
  const c=getConfig();if(!c.room||!c.serverBase)return;
  closeStream();notify('connecting',{room:displayRoom(c.room)});
  const u=new URL(normalizeServerBase(c.serverBase)+'/sync/events');u.searchParams.set('room',c.room);u.searchParams.set('device',getDeviceId());u.searchParams.set('name',getDeviceName());
  const es=new EventSource(u.toString());eventSource=es;
  es.onopen=()=>{healthOk=true;streamReady=true;reconnectAttempt=0;notify('connected',{room:displayRoom(c.room)});flushOutbox()};
  es.onmessage=e=>{try{handleMessage(JSON.parse(e.data))}catch{}};
  es.onerror=()=>{if(eventSource!==es)return;closeStream();notify('reconnecting',{message:'Koneksi real-time terputus. Menyambung ulang...'});scheduleReconnect()};
}

async function createRoom(serverBase,deviceName){
  const base=normalizeServerBase(serverBase||defaultServerBase());setDeviceName(deviceName||getDeviceName());notify('connecting',{message:'Membuat grup sync...'});await checkHealth(base);
  const data=await jsonFetch(base+'/sync/create',{method:'POST',body:JSON.stringify({deviceId:getDeviceId(),deviceName:getDeviceName(),snapshot:collectSnapshot()})});
  const room=normalizeRoom(data.room);saveConfig({room,serverBase:base,creator:true,connectedAt:Date.now()});saveOutbox([]);applySnapshot(data.snapshot||{},true);openStream();return room;
}
async function joinRoom(room,serverBase,deviceName){
  const base=normalizeServerBase(serverBase||defaultServerBase()),r=normalizeRoom(room);if(r.length!==8)throw new Error('Kode grup harus 8 karakter.');setDeviceName(deviceName||getDeviceName());notify('connecting',{message:'Bergabung ke grup sync...'});await checkHealth(base);
  const old=getConfig();if(old.room&&old.room!==r)saveOutbox([]);
  const data=await jsonFetch(base+'/sync/join',{method:'POST',body:JSON.stringify({room:r,deviceId:getDeviceId(),deviceName:getDeviceName()})});
  saveConfig({room:r,serverBase:base,creator:data.creatorDevice===getDeviceId(),connectedAt:Date.now()});clearOutboxForOtherRooms(r);applySnapshot(data.snapshot||{},true);lastSyncAt=Date.now();openStream();return data;
}
async function resume(){
  const c=getConfig();if(!c.room||!c.serverBase){notify('disconnected');return}
  setDeviceName(getDeviceName());notify('connecting',{message:'Memulihkan koneksi...'});
  try{await checkHealth(c.serverBase);const data=await jsonFetch(normalizeServerBase(c.serverBase)+'/sync/join',{method:'POST',body:JSON.stringify({room:c.room,deviceId:getDeviceId(),deviceName:getDeviceName(),resume:true})});applySnapshot(data.snapshot||{},true);lastSyncAt=Date.now();openStream()}catch(e){notify('reconnecting',{message:e.message});scheduleReconnect()}
}
async function forceResync(){const c=getConfig();if(!c.room)throw new Error('Belum terhubung');notify('connecting',{message:'Mengambil data terbaru...'});const data=await jsonFetch(normalizeServerBase(c.serverBase)+'/sync/join',{method:'POST',body:JSON.stringify({room:c.room,deviceId:getDeviceId(),deviceName:getDeviceName(),resume:true})});applySnapshot(data.snapshot||{},true);lastSyncAt=Date.now();openStream();return data}
function disconnect(forget=true){if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null}closeStream();lastPresence={onlineCount:0,connections:0,devices:[]};if(forget){clearConfig();saveOutbox([])}notify('disconnected')}

/* ================= Dashboard UI ================= */
function isDashboard(){const p=String(location.pathname||'').toLowerCase();return p.endsWith('/dashboard.html')||p==='/dashboard.html'||p==='dashboard.html'||p.endsWith('/dashboard')}
function uiBase(){return normalizeServerBase(document.getElementById('ldmSyncServer')?.value||defaultServerBase())}
function uiName(){return setDeviceName(document.getElementById('ldmDeviceName')?.value||getDeviceName())}
function showRoom(room){const wrap=document.getElementById('ldmRoomWrap'),code=document.getElementById('ldmRoomCode');if(!wrap||!code)return;if(room){code.textContent=displayRoom(room);wrap.style.display='block'}else wrap.style.display='none'}
function renderDeviceList(presence=lastPresence){
  const box=document.getElementById('ldmDeviceList');if(!box)return;const ds=Array.isArray(presence.devices)?presence.devices:[];
  if(!ds.length){box.innerHTML='<div style="padding:10px;color:var(--label-color);font-size:.68rem;text-align:center;">Belum ada device online.</div>';return}
  const me=getDeviceId();box.innerHTML=ds.map(d=>`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 9px;border-bottom:1px solid var(--border-color);"><div style="min-width:0;"><div style="font-size:.72rem;font-weight:800;color:var(--heading-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🟢 ${esc(d.name||'Device')} ${d.deviceId===me?'<span style="font-size:.58rem;color:#16a34a;">(perangkat ini)</span>':''}</div><div style="font-size:.58rem;color:var(--label-color);margin-top:2px;">${d.role==='primary'?'Device Utama':'Anggota'} • ${esc(String(d.deviceId||'').replace(/^dev_/,'').slice(0,10))}</div></div><span style="font-size:.58rem;color:#16a34a;font-weight:800;">ONLINE</span></div>`).join('')
}
function renderStatus(detail={}){
  const status=detail.status||lastStatus,cfg=detail.config||getConfig(),p=detail.presence||lastPresence;
  const st=document.getElementById('ldmSyncStatus'),count=document.getElementById('ldmSyncCount'),dot=document.getElementById('deviceSyncDot'),bt=document.getElementById('deviceSyncButtonText'),disc=document.getElementById('ldmDisconnect'),sync=document.getElementById('ldmForceSync'),server=document.getElementById('ldmServerStatus'),last=document.getElementById('ldmLastSync');
  let label='Belum terhubung',icon='⚪';if(status==='connecting'){label='Menghubungkan...';icon='🟡'}if(status==='connected'){label='Terhubung';icon='🟢'}if(status==='synced'){label='Terhubung & sinkron';icon='🟢'}if(status==='reconnecting'){label='Menyambung ulang...';icon='🟡'}if(status==='error'){label=detail.message||'Gagal terhubung';icon='🔴'}
  if(st)st.textContent=label;if(count)count.textContent=`${Number(p.onlineCount||0)} device online`;if(dot)dot.textContent=icon;if(bt)bt.textContent=(cfg.room?`${Number(p.onlineCount||0)||1} Device Terhubung`:'Hubungkan Device');if(disc)disc.style.display=cfg.room?'block':'none';if(sync)sync.style.display=cfg.room?'block':'none';if(server)server.textContent=healthOk?'🟢 Server online':'⚪ Server belum dicek';if(last)last.textContent=lastSyncAt?('Sync terakhir '+nowText(lastSyncAt)):'Belum ada sync';showRoom(cfg.room);renderDeviceList(p)
}
function installUI(){
  if(!isDashboard())return;
  const group=document.querySelector('.action-bar-container .btn-action-group')||document.querySelector('.action-bar-container');
  if(group&&!document.getElementById('btnDeviceSync')){const b=document.createElement('button');b.type='button';b.id='btnDeviceSync';b.className='btn-transfer-owner';b.innerHTML='<span id="deviceSyncDot">⚪</span> <span id="deviceSyncButtonText">Hubungkan Device</span>';b.onclick=openModal;group.appendChild(b)}
  if(document.getElementById('ldmDeviceSyncModal'))return;
  const m=document.createElement('div');m.className='modal-alert';m.id='ldmDeviceSyncModal';m.innerHTML=`
  <div class="modal-alert-content" style="width:min(680px,95vw);max-width:680px;text-align:left;max-height:90vh;overflow:auto;">
    <div class="modal-alert-icon" style="text-align:center;">🔗</div>
    <div class="modal-alert-title" style="text-align:center;">Sinkronisasi Multi-Device</div>
    <div style="text-align:center;color:var(--label-color);font-size:.64rem;line-height:1.5;margin-top:4px;">Satu kode grup dapat dipakai Device A, B, C, D, dan device lain secara bersamaan.</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0;">
      <div style="padding:9px 10px;border:1px solid var(--border-color);border-radius:9px;background:var(--bg-primary);"><div style="font-size:.59rem;color:var(--label-color);">STATUS</div><strong id="ldmSyncStatus" style="font-size:.72rem;">Belum terhubung</strong><div id="ldmLastSync" style="font-size:.57rem;color:var(--label-color);margin-top:2px;">Belum ada sync</div></div>
      <div style="padding:9px 10px;border:1px solid var(--border-color);border-radius:9px;background:var(--bg-primary);"><div style="font-size:.59rem;color:var(--label-color);">PERANGKAT</div><strong id="ldmSyncCount" style="font-size:.72rem;">0 device online</strong><div id="ldmServerStatus" style="font-size:.57rem;color:var(--label-color);margin-top:2px;">⚪ Server belum dicek</div></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:10px;">
      <div><label style="display:block;font-size:.63rem;font-weight:700;color:var(--label-color);margin-bottom:4px;">Nama Device Ini</label><input id="ldmDeviceName" maxlength="40" style="width:100%;padding:8px 9px;border:1px solid var(--border-color);border-radius:8px;background:var(--input-bg);color:var(--text-color);" placeholder="Contoh: Kasir Depan"></div>
      <div><label style="display:block;font-size:.63rem;font-weight:700;color:var(--label-color);margin-bottom:4px;">Alamat Sync Server</label><input id="ldmSyncServer" style="width:100%;padding:8px 9px;border:1px solid var(--border-color);border-radius:8px;background:var(--input-bg);color:var(--text-color);" placeholder="http://192.168.1.10:8787"></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div style="border:1px solid var(--border-color);border-radius:10px;padding:11px;"><strong style="font-size:.75rem;">1. Buat Grup Sync</strong><p style="margin:4px 0 9px;color:var(--label-color);font-size:.61rem;line-height:1.5;">Pilih pada device utama. Data device ini menjadi data awal grup.</p><button class="btn-modal-ok" style="background:#0d2240;color:#ffc107;" onclick="LDMDeviceSyncUI.createRoom()">Buat Grup Baru</button></div>
      <div style="border:1px solid var(--border-color);border-radius:10px;padding:11px;"><strong style="font-size:.75rem;">2. Tambah Device</strong><p style="margin:4px 0 7px;color:var(--label-color);font-size:.61rem;line-height:1.5;">Masukkan kode grup yang sama pada Device B, C, D, dst.</p><input id="ldmJoinCode" maxlength="9" placeholder="ABCD-EFGH" style="width:100%;padding:8px;text-align:center;text-transform:uppercase;letter-spacing:.12em;border:1px solid var(--border-color);border-radius:8px;background:var(--input-bg);color:var(--text-color);margin-bottom:7px;"><button class="btn-modal-ok" style="background:#16a34a;" onclick="LDMDeviceSyncUI.joinRoom()">Gabung ke Grup</button></div>
    </div>

    <div id="ldmRoomWrap" style="display:none;margin-top:11px;padding:11px;border:1px dashed var(--border-color);border-radius:10px;text-align:center;"><div style="font-size:.59rem;color:var(--label-color);">KODE GRUP MULTI-DEVICE</div><div id="ldmRoomCode" style="font:800 1.3rem monospace;letter-spacing:.14em;color:var(--heading-color);margin:4px 0;">--------</div><div style="font-size:.58rem;color:var(--label-color);margin-bottom:7px;">Kode ini boleh dipakai berulang kali untuk menambah banyak device.</div><button class="btn-copy-code" onclick="LDMDeviceSyncUI.copyCode()">📋 Salin Kode</button></div>

    <div style="margin-top:11px;border:1px solid var(--border-color);border-radius:10px;overflow:hidden;"><div style="padding:8px 9px;background:var(--bg-primary);font-size:.66rem;font-weight:800;color:var(--heading-color);">Device Online</div><div id="ldmDeviceList"><div style="padding:10px;color:var(--label-color);font-size:.68rem;text-align:center;">Belum ada device online.</div></div></div>

    <div style="margin-top:10px;padding:9px 10px;border-radius:8px;background:rgba(2,132,199,.08);font-size:.61rem;line-height:1.55;color:var(--label-color);">Data bisnis yang sync: transaksi/laporan, barang, harga, stok, promo, absensi, stock opname, PO, Goods Receipt, Closing Shift, End of Day, audit, tema dan struk. Password, daftar akun, session login, serta draft transaksi tidak dikirim.</div>

    <div style="display:flex;gap:7px;margin-top:12px;flex-wrap:wrap;"><button id="ldmForceSync" class="btn-modal-ok" style="display:none;background:#0284c7;" onclick="LDMDeviceSyncUI.forceSync()">↻ Sinkronkan Sekarang</button><button id="ldmDisconnect" class="btn-modal-ok" style="display:none;background:#dc2626;" onclick="LDMDeviceSyncUI.disconnect()">Putuskan Device Ini</button><button class="btn-modal-ok" onclick="LDMDeviceSyncUI.close()">Tutup</button></div>
  </div>`;
  document.body.appendChild(m);
  const j=m.querySelector('#ldmJoinCode');j.addEventListener('input',()=>j.value=displayRoom(j.value));
  m.querySelector('#ldmDeviceName').value=getDeviceName();const c=getConfig();m.querySelector('#ldmSyncServer').value=c.serverBase||defaultServerBase();if(c.room)showRoom(c.room);renderStatus({status:lastStatus,config:c,presence:lastPresence});
}
function openModal(){installUI();const m=document.getElementById('ldmDeviceSyncModal');if(m)m.style.display='flex';const c=getConfig();const s=document.getElementById('ldmSyncServer');if(s)s.value=c.serverBase||defaultServerBase();const n=document.getElementById('ldmDeviceName');if(n)n.value=getDeviceName();renderStatus({status:lastStatus,config:c,presence:lastPresence})}
function closeModal(){const m=document.getElementById('ldmDeviceSyncModal');if(m)m.style.display='none'}
async function copyCode(){const r=getConfig().room;if(!r)return;const v=displayRoom(r);try{await navigator.clipboard.writeText(v);window.tampilkanAlertCustom?.('Tersalin','Kode grup berhasil disalin.','success')}catch{window.prompt('Salin kode grup:',v)}}
function uiError(e){window.tampilkanAlertCustom?.('Sync Device',e.message||String(e),'warning');notify('error',{message:e.message||String(e)})}

window.LDMDeviceSync={version:VERSION,createRoom,joinRoom,resume,forceResync,disconnect,getConfig,getDeviceId,getDeviceName,setDeviceName,collectSnapshot,syncKeys:[...SYNC_KEYS]};
window.LDMDeviceSyncUI={open:openModal,close:closeModal,renderStatus,async createRoom(){try{const room=await createRoom(uiBase(),uiName());showRoom(room)}catch(e){uiError(e)}},async joinRoom(){try{const input=document.getElementById('ldmJoinCode'),room=normalizeRoom(input?.value);if(room.length!==8)throw new Error('Masukkan kode grup 8 karakter.');await joinRoom(room,uiBase(),uiName());showRoom(room)}catch(e){uiError(e)}},async forceSync(){try{await forceResync();window.tampilkanAlertCustom?.('Sinkron','Data terbaru berhasil diambil dari grup.','success')}catch(e){uiError(e)}},disconnect(){disconnect(true);renderStatus({status:'disconnected',config:{},presence:{onlineCount:0,devices:[],connections:0}})},copyCode};

document.addEventListener('DOMContentLoaded',()=>{installUI();setTimeout(()=>resume(),120)});
})();
