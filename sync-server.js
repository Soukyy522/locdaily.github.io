"use strict";

/* LocDailyMar Multi-Device Sync Server v2
 * Dependency: hanya modul bawaan Node.js.
 * Start: node sync-server.js
 */

const http=require('http');
const fs=require('fs');
const path=require('path');
const os=require('os');
const crypto=require('crypto');

const VERSION='2.0.0';
const ROOT=__dirname;
const PORT=Number(process.env.PORT||8787);
const STORE_FILE=path.join(ROOT,'sync-store.json');
const MAX_BODY=32*1024*1024;
const MAX_ONLINE_DEVICES=50;

const ARRAY_KEYS=new Set(['laporan','laporanHistory','riwayatTransaksi','dataBarang','operasional','dataAbsensi','dataStockOpname','dataPurchaseOrder','goodsReceiptSourcePO','dataGoodsReceipt','auditLog','shiftClosingLog','endOfDayLog','daftarKaryawan']);
const REPLACE_KEYS=new Set(['headerConfig','strukConfig','purchaseOrderLastUpdate','goodsReceiptLastUpdate','approvedPOForGoodsReceiptLastUpdate','endOfDayLastUpdate']);
const SYNC_KEYS=new Set([...ARRAY_KEYS,...REPLACE_KEYS]);

function safeParse(raw,fallback){try{const v=JSON.parse(raw);return v==null?fallback:v}catch{return fallback}}
function normalizeRoom(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8)}
function normalizeName(v){return String(v||'Device').replace(/[<>]/g,'').trim().slice(0,40)||'Device'}
function randomRoom(){const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let out='';for(const b of crypto.randomBytes(8))out+=a[b%a.length];return out}
function hashString(v){return crypto.createHash('sha1').update(String(v||'')).digest('hex').slice(0,16)}

function loadStore(){try{const x=JSON.parse(fs.readFileSync(STORE_FILE,'utf8'));return x&&typeof x==='object'?x:{rooms:{}}}catch{return{rooms:{}}}}
const store=loadStore();if(!store.rooms||typeof store.rooms!=='object')store.rooms={};
const live=new Map();let persistTimer=null;
function persistSoon(){clearTimeout(persistTimer);persistTimer=setTimeout(()=>{const tmp=STORE_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(store,null,2));fs.renameSync(tmp,STORE_FILE)},80)}
function getRoom(code){const c=normalizeRoom(code);return store.rooms[c]?{code:c,data:store.rooms[c]}:null}
function ensureLive(code){if(!live.has(code))live.set(code,{devices:new Map()});return live.get(code)}
function deviceMeta(room,deviceId,name,role){room.data.devices=room.data.devices||{};const old=room.data.devices[deviceId]||{};room.data.devices[deviceId]={name:normalizeName(name||old.name),role:role||old.role||'member',firstSeen:old.firstSeen||Date.now(),lastSeen:Date.now()};persistSoon();return room.data.devices[deviceId]}
function onlineDevices(room){const l=ensureLive(room.code);const arr=[];for(const [id,entry] of l.devices){if(entry.connections.size>0){const meta=room.data.devices?.[id]||{};arr.push({deviceId:id,name:meta.name||entry.name||'Device',role:meta.role||'member',lastSeen:meta.lastSeen||Date.now(),connections:entry.connections.size})}}return arr.sort((a,b)=>(a.role==='primary'?-1:1)-(b.role==='primary'?-1:1)||String(a.name).localeCompare(String(b.name),'id'))}
function totalConnections(room){const l=ensureLive(room.code);let n=0;for(const e of l.devices.values())n+=e.connections.size;return n}

function itemIdentity(key,item,index){
 if(item==null||typeof item!=='object')return'primitive:'+hashString(JSON.stringify(item));
 const pick=(...ns)=>{for(const n of ns){const v=item[n];if(v!==undefined&&v!==null&&String(v).trim()!=='')return String(v).trim()}return''};
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
function applyArrayPatch(key,raw,upserts,deletes){const cur=safeParse(raw,[]),m=arrayMap(key,Array.isArray(cur)?cur:[]);for(const id of Array.isArray(deletes)?deletes:[])m.delete(String(id));for(const e of Array.isArray(upserts)?upserts:[])if(e&&e.id)m.set(String(e.id),e.item);return JSON.stringify([...m.values()])}
function sanitizeSnapshot(incoming){const out={};for(const [k,v] of Object.entries(incoming&&typeof incoming==='object'?incoming:{})){if(SYNC_KEYS.has(k))out[k]=v==null?null:String(v)}return out}

function cors(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS')}
function json(res,status,payload){cors(res);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(payload))}
function readJson(req,cb){let body='',done=false;req.on('data',c=>{if(done)return;body+=c;if(Buffer.byteLength(body)>MAX_BODY){done=true;cb(new Error('Payload terlalu besar'));req.destroy()}});req.on('end',()=>{if(done)return;try{cb(null,JSON.parse(body||'{}'))}catch{cb(new Error('JSON tidak valid'))}});req.on('error',e=>{if(!done)cb(e)})}
function sse(res,p){try{res.write('data: '+JSON.stringify(p)+'\n\n')}catch{}}
function broadcast(room,p){const l=ensureLive(room.code);for(const e of l.devices.values())for(const res of e.connections)sse(res,p)}
function broadcastPresence(room){const devices=onlineDevices(room);broadcast(room,{type:'presence',onlineCount:devices.length,connections:totalConnections(room),devices})}
function snapshotPayload(room){return{type:'snapshot',data:room.data.state||{},revision:Number(room.data.revision||0)}}
function touchRevision(room){room.data.revision=Number(room.data.revision||0)+1;room.data.updatedAt=Date.now();persistSoon();return room.data.revision}

const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json; charset=utf-8'};

const server=http.createServer((req,res)=>{
 cors(res);if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
 let url;try{url=new URL(req.url,'http://localhost')}catch{return json(res,400,{ok:false,message:'URL tidak valid'})}

 if(url.pathname==='/sync/health'&&req.method==='GET')return json(res,200,{ok:true,version:VERSION,rooms:Object.keys(store.rooms).length,time:Date.now()});

 if(url.pathname==='/sync/create'&&req.method==='POST'){
  return readJson(req,(err,b)=>{if(err)return json(res,400,{ok:false,message:err.message});const deviceId=String(b.deviceId||'').slice(0,160);if(!deviceId)return json(res,400,{ok:false,message:'Device ID tidak valid.'});let code;for(let i=0;i<20;i++){const c=randomRoom();if(!store.rooms[c]){code=c;break}}if(!code)return json(res,500,{ok:false,message:'Gagal membuat kode grup.'});store.rooms[code]={creatorDevice:deviceId,state:sanitizeSnapshot(b.snapshot),devices:{},revision:1,createdAt:Date.now(),updatedAt:Date.now()};const room=getRoom(code);deviceMeta(room,deviceId,b.deviceName,'primary');persistSoon();return json(res,200,{ok:true,room:code,creatorDevice:deviceId,snapshot:room.data.state,revision:room.data.revision})})
 }

 if(url.pathname==='/sync/join'&&req.method==='POST'){
  return readJson(req,(err,b)=>{if(err)return json(res,400,{ok:false,message:err.message});const room=getRoom(b.room);if(!room)return json(res,404,{ok:false,message:'Kode grup tidak ditemukan pada Sync Server ini.'});const deviceId=String(b.deviceId||'').slice(0,160);if(!deviceId)return json(res,400,{ok:false,message:'Device ID tidak valid.'});deviceMeta(room,deviceId,b.deviceName,deviceId===room.data.creatorDevice?'primary':'member');return json(res,200,{ok:true,room:room.code,creatorDevice:room.data.creatorDevice,snapshot:room.data.state||{},revision:Number(room.data.revision||0),knownDevices:Object.keys(room.data.devices||{}).length})})
 }

 if(url.pathname==='/sync/events'&&req.method==='GET'){
  const room=getRoom(url.searchParams.get('room'));if(!room){res.writeHead(404);return res.end('Room not found')}
  const deviceId=String(url.searchParams.get('device')||'').slice(0,160),name=normalizeName(url.searchParams.get('name'));if(!deviceId){res.writeHead(400);return res.end('Device required')}
  const l=ensureLive(room.code);if(!l.devices.has(deviceId)&&onlineDevices(room).length>=MAX_ONLINE_DEVICES){res.writeHead(429);return res.end('Room penuh')}
  deviceMeta(room,deviceId,name,deviceId===room.data.creatorDevice?'primary':'member');if(!l.devices.has(deviceId))l.devices.set(deviceId,{name,connections:new Set()});const entry=l.devices.get(deviceId);entry.name=name;entry.connections.add(res);
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','Access-Control-Allow-Origin':'*','X-Accel-Buffering':'no'});res.write(': LocDailyMar Multi Device Sync v2\n\n');sse(res,{type:'connected',room:room.code,revision:Number(room.data.revision||0)});sse(res,snapshotPayload(room));broadcastPresence(room);
  const ping=setInterval(()=>{try{res.write(': ping '+Date.now()+'\n\n')}catch{}},15000);
  req.on('close',()=>{clearInterval(ping);entry.connections.delete(res);if(entry.connections.size===0)l.devices.delete(deviceId);if(room.data.devices?.[deviceId]){room.data.devices[deviceId].lastSeen=Date.now();persistSoon()}broadcastPresence(room)});return;
 }

 if(url.pathname==='/sync/op'&&req.method==='POST'){
  return readJson(req,(err,b)=>{if(err)return json(res,400,{ok:false,message:err.message});const room=getRoom(b.room);if(!room)return json(res,404,{ok:false,message:'Grup sync tidak ditemukan.'});const deviceId=String(b.deviceId||'').slice(0,160);deviceMeta(room,deviceId,b.deviceName,deviceId===room.data.creatorDevice?'primary':'member');const op=b.operation&&typeof b.operation==='object'?b.operation:{};const key=String(op.key||'');room.data.state=room.data.state||{};
   if(op.action==='arrayPatch'&&ARRAY_KEYS.has(key)){room.data.state[key]=applyArrayPatch(key,room.data.state[key]||'[]',op.upserts,op.deletes);const rev=touchRevision(room);broadcast(room,{type:'updateKey',key,value:room.data.state[key],revision:rev,sourceDeviceId:deviceId});return json(res,200,{ok:true,revision:rev})}
   if(op.action==='replace'&&SYNC_KEYS.has(key)){room.data.state[key]=op.value==null?'':String(op.value);const rev=touchRevision(room);broadcast(room,{type:'updateKey',key,value:room.data.state[key],revision:rev,sourceDeviceId:deviceId});return json(res,200,{ok:true,revision:rev})}
   if(op.action==='deleteKey'&&SYNC_KEYS.has(key)){delete room.data.state[key];const rev=touchRevision(room);broadcast(room,{type:'deleteKey',key,revision:rev,sourceDeviceId:deviceId});return json(res,200,{ok:true,revision:rev})}
   return json(res,400,{ok:false,message:'Operasi sync tidak dikenal atau key tidak diizinkan.'})
  })
 }

 let pathname=decodeURIComponent(url.pathname||'/');if(pathname==='/')pathname='/index.html';if(pathname==='/sync-store.json'||pathname.endsWith('/sync-store.json')){res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Forbidden')}
 const rel=path.normalize(pathname).replace(/^([/\\]*\.\.[/\\])+/,'').replace(/^[/\\]+/,'');const file=path.resolve(ROOT,rel),root=path.resolve(ROOT)+path.sep;if(file!==path.resolve(ROOT)&&!file.startsWith(root)){res.writeHead(403);return res.end('Forbidden')}
 fs.stat(file,(err,st)=>{if(err||!st.isFile()){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found')}res.writeHead(200,{'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});fs.createReadStream(file).pipe(res)})
});

server.listen(PORT,'0.0.0.0',()=>{
 console.log('\nLocDailyMar Multi-Device Sync Server v'+VERSION);
 console.log('================================================');
 console.log('Komputer server : http://localhost:'+PORT);
 const nets=os.networkInterfaces();for(const list of Object.values(nets))for(const net of list||[])if(net.family==='IPv4'&&!net.internal)console.log('Device lain    : http://'+net.address+':'+PORT);
 console.log('================================================');
 console.log('Satu grup mendukung sampai '+MAX_ONLINE_DEVICES+' device online unik.\n');
});
