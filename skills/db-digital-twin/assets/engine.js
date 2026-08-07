'use strict';
/* db-digital-twin engine — renders a WORLD spec (see references/world-spec.md)
   as a daylight sim-city scene. WORLD is injected by scripts/build.py. */
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const {Engine, Scene, ArcRotateCamera, Vector3, Matrix, Color3, Color4,
       HemisphericLight, DirectionalLight, ShadowGenerator, MeshBuilder,
       StandardMaterial, DynamicTexture, GlowLayer, PointerEventTypes} = window.BB;

const W = window.WORLD;
const SEVC = {red:'#D6453D', amber:'#E8940A', info:'#12A47B'};
const rnd = i => { const s=Math.sin(i*127.1)*43758.5453; return s-Math.floor(s); };

/* ---------- layout ---------- */
const TOWER_COLS = ['#66A9DC','#7FC0CE','#5E9AD3','#8FB8E6','#74B3C9'];
const BLOCK_COLS = ['#D89055','#C97B52','#CE8A5B','#BE6E4F'];
const KIND = {
  tower:{w:2.0,  d:2.0,  roof:'#F2F5F7', h:s=>0.7+s*6.0},
  block:{w:2.4,  d:2.4,  roof:'#9AA1A7', h:s=>1.2+s*2.6},
  tank: {w:1.8,  d:1.8,  roof:'#E4E8EB', h:s=>1.4+s*2.4},
  flat: {w:3.4,  d:3.0,  roof:'#F2F5F7', h:s=>1.35},
  gate: {w:2.4,  d:2.6,  roof:'#F2F5F7', h:s=>1.0},
};
const buildings = [];               // enriched building records
const byId = {};
const backDistricts  = (W.districts||[]).filter(d=>d.band!=='front');
const frontDistricts = (W.districts||[]).filter(d=>d.band==='front');
const mainZ = 16.2, backRoadZ = 14.6, frontZ = 18;

let bi = 0;
function place(b, district, gx, gy){
  const k = KIND[b.kind] || KIND.block;
  const rec = Object.assign({}, b, {
    district: district.id,
    w: b.kind==='tower' ? 1.9 + rnd(bi+3)*0.5 : k.w,
    d: b.kind==='tower' ? 1.9 + rnd(bi+21)*0.4 : k.d,
    h: k.h(Math.max(0, Math.min(1, b.size==null ? 0.5 : b.size))),
    roof: k.roof, gx, gy,
    tiered: b.kind==='tower' && (b.size||0) > 0.55,
    color: b.color || (b.kind==='tower' ? TOWER_COLS[bi%TOWER_COLS.length]
          : b.kind==='block' ? BLOCK_COLS[bi%BLOCK_COLS.length]
          : b.kind==='tank' ? '#C4CDD3' : b.kind==='gate' ? '#83AC6C' : '#8AA4B5'),
  });
  rec.cx = gx + rec.w/2; rec.cz = gy + rec.d/2;
  buildings.push(rec); byId[rec.id] = rec; bi++;
  return rec;
}

/* back band: grid districts side by side */
let backX = 12, backRight = 12, backPads = [];
backDistricts.forEach(d=>{
  const cols = Math.min(d.cols || 5, d.buildings.length);
  let maxX = backX;
  d.buildings.forEach((b,i)=>{
    const col = i%cols, row = (i/cols)|0;
    const gx = backX + col*3.4 + (rnd(bi+7)-0.5)*0.7;
    const gy = 3 + row*4.2 + (rnd(bi+13)-0.5)*0.6;
    const r = place(Object.assign({kind:'tower'}, b), d, gx, gy);
    maxX = Math.max(maxX, gx + r.w);
  });
  const rows = Math.ceil(d.buildings.length/cols);
  d._pad = [backX-1.2, 1.8, maxX+1.2, Math.max(13.8, 3+rows*4.2+1.2)];
  d._labelAt = [backX-3.5, 0.1, 10.6];
  backPads.push(d._pad);
  backX = maxX + 4; backRight = maxX;
});

/* front band: row districts sequential */
let frontX = 7, frontRight = 7;
frontDistricts.forEach(d=>{
  d._start = frontX;
  d.buildings.forEach(b=>{
    const k = KIND[b.kind] || KIND.block;
    const r = place(Object.assign({kind:'block'}, b), d, frontX, frontZ + (k.d<2.6?0.2:0));
    frontX += r.w + 0.8;
  });
  d._labelAt = [(d._start + frontX - 0.8)/2 - 2, 0.1, 21.8];
  frontRight = frontX - 0.8;
  frontX += 2.6;
});

const xMin = Math.min(4.5, ...buildings.map(b=>b.gx)) - 0;
const xMax = Math.max(backRight, frontRight, 20);
const joinX = backDistricts.length ? Math.max(backRight, 30) + 2.2 : null;
const offL = xMin - 8, offR = Math.max(xMax, joinX||0) + 5;
const center = (xMin + Math.max(xMax, joinX||0)) / 2;

/* ---------- engine & scene ---------- */
const canvas = document.getElementById('cv');
const engine = new Engine(canvas, true, {adaptToDeviceRatio:true});
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
scene.clearColor = Color4.FromHexString('#9CC8EAFF');
scene.fogMode = Scene.FOGMODE_EXP2;
scene.fogDensity = 0.0028;
scene.fogColor = Color3.FromHexString('#BFD9EC');

const spanX = Math.max(xMax, joinX||0) - xMin;
const cam = new ArcRotateCamera('cam', 1.78, 1.0,
  Math.max(30, spanX*1.05), new Vector3(center, 1.0, 11), scene);
cam.attachControl(canvas, true);
cam.lowerRadiusLimit = 10; cam.upperRadiusLimit = Math.max(70, spanX*1.8);
cam.lowerBetaLimit = 0.35; cam.upperBetaLimit = 1.38;
cam.wheelPrecision = 18; cam.panningSensibility = 90; cam.minZ = 0.1;

const hemi = new HemisphericLight('h', new Vector3(0,1,0), scene);
hemi.intensity = 0.75;
hemi.diffuse = Color3.FromHexString('#EAF4FF');
hemi.groundColor = Color3.FromHexString('#7FA968');
const sun = new DirectionalLight('sun', new Vector3(-0.5,-1.2,0.45), scene);
sun.position = new Vector3(center+18, 46, -10);
sun.intensity = 0.95;
sun.diffuse = Color3.FromHexString('#FFF2D9');
const sg = new ShadowGenerator(2048, sun);
sg.usePercentageCloserFiltering = true; sg.darkness = 0.42; sg.bias = 0.0012;
const glow = new GlowLayer('g', scene, {blurKernelSize:48});
glow.intensity = 0.35;

function mat(hex, opts={}){
  const m = new StandardMaterial('m'+hex+Math.random(), scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = new Color3(.03,.03,.03);
  if(opts.emissive) m.emissiveColor = Color3.FromHexString(opts.emissive);
  if(opts.alpha !== undefined) m.alpha = opts.alpha;
  return m;
}

/* ---------- ground + pads ---------- */
const ground = MeshBuilder.CreateGround('gr', {width:spanX+90, height:80}, scene);
ground.position.set(center, 0, 12);
{
  const tex = new DynamicTexture('gt', {width:1680, height:1120}, scene, false);
  const c = tex.getContext();
  c.fillStyle = '#82B45F'; c.fillRect(0,0,1680,1120);
  c.strokeStyle = 'rgba(255,255,255,0.045)'; c.lineWidth = 1;
  for(let x=0; x<=1680; x+=40){ c.beginPath(); c.moveTo(x,0); c.lineTo(x,1120); c.stroke(); }
  for(let y=0; y<=1120; y+=40){ c.beginPath(); c.moveTo(0,y); c.lineTo(1680,y); c.stroke(); }
  tex.update();
  const gm = new StandardMaterial('gm', scene);
  gm.diffuseTexture = tex; gm.specularColor = new Color3(0,0,0);
  ground.material = gm;
}
ground.receiveShadows = true;

function pad(x0,z0,x1,z1,hex){
  const p = MeshBuilder.CreateBox('pad', {width:x1-x0, depth:z1-z0, height:0.04}, scene);
  p.position.set((x0+x1)/2, 0.02, (z0+z1)/2);
  p.material = mat(hex); p.receiveShadows = true; p.isPickable = false;
  return [x0,z0,x1,z1];
}
const padRects = [];
backPads.forEach(r=>padRects.push(pad(r[0],r[1],r[2],r[3],'#C2BAA6')));
if(frontDistricts.length)
  padRects.push(pad(Math.min(4.5,xMin-1), 14.9, Math.max(frontRight, joinX||0)+2.5, 22.3, '#B5AC96'));

/* ---------- roads ---------- */
const roadMat = mat('#54585D'), stripMat = mat('#F4F6F8');
function roadBox(x0,z0,x1,z1,w){
  const len = Math.hypot(x1-x0, z1-z0);
  const r = MeshBuilder.CreateBox('rd', {width:len, depth:w, height:0.06}, scene);
  r.position.set((x0+x1)/2, 0.03, (z0+z1)/2);
  r.rotation.y = -Math.atan2(z1-z0, x1-x0);
  r.material = roadMat; r.receiveShadows = true; r.isPickable = false;
  const s = MeshBuilder.CreateBox('st', {width:len, depth:0.07, height:0.015}, scene);
  s.position.set((x0+x1)/2, 0.068, (z0+z1)/2); s.rotation.y = r.rotation.y;
  s.material = stripMat; s.isPickable = false;
}
roadBox(offL, mainZ, offR, mainZ, 1.5);
const feederXs = [];
if(backDistricts.length){
  roadBox(Math.min(...buildings.filter(b=>isBack(b)).map(b=>b.cx))-1, backRoadZ, joinX, backRoadZ, 1.2);
  roadBox(joinX, backRoadZ, joinX, mainZ, 1.2);
  buildings.filter(isBack).forEach(b=>{
    roadBox(b.cx, b.gy+b.d, b.cx, backRoadZ, .5);
    feederXs.push(b.cx);
  });
}
function isBack(b){ return backDistricts.some(d=>d.id===b.district); }

/* ---------- windows ---------- */
const winMat = mat('#33506B');
winMat.specularColor = new Color3(.35,.4,.45);
const winMaster = MeshBuilder.CreatePlane('win', {width:0.34, height:0.2, sideOrientation:2}, scene);
winMaster.material = winMat; winMaster.isVisible = false; winMaster.isPickable = false;
function addWindows(b, hLimit){
  const rows = Math.max(1, Math.floor((hLimit||b.h)/0.55));
  const seed = b.gx*31 + b.gy*7;
  const faces = [
    {dx:0.5, dz:1.001, rot:0, ax:'x'}, {dx:0.5, dz:-0.001, rot:Math.PI, ax:'x'},
    {dx:1.001, dz:0.5, rot:Math.PI/2, ax:'z'}, {dx:-0.001, dz:0.5, rot:-Math.PI/2, ax:'z'},
  ];
  faces.forEach((f,fi)=>{
    for(let r=0;r<rows;r++) for(let c=0;c<3;c++){
      const k = seed + fi*97 + r*3 + c;
      if(rnd(k) < .3) continue;
      const inst = winMaster.createInstance('wi');
      const t = (c+0.5)/3, y = 0.35 + r*0.55;
      if(f.ax==='x') inst.position.set(b.gx + b.w*t, y, b.gy + b.d*f.dz);
      else inst.position.set(b.gx + b.w*f.dx, y, b.gy + b.d*t);
      inst.rotation.y = f.rot; inst.isPickable = false;
    }
  });
}

/* ---------- buildings ---------- */
const meshById = {};
function cap(x,y,z,w,d,hex){
  const r = MeshBuilder.CreateBox('roof', {width:w, depth:d, height:0.1}, scene);
  r.position.set(x,y,z); r.material = mat(hex); r.isPickable = false;
  sg.addShadowCaster(r);
}
buildings.forEach(b=>{
  let m;
  if(b.kind==='tank'){
    m = MeshBuilder.CreateCylinder('b'+b.id, {diameter:b.w*1.15, height:b.h, tessellation:28}, scene);
    m.position.set(b.cx, b.h/2, b.cz);
    const c = MeshBuilder.CreateCylinder('cap', {diameter:b.w*1.15+0.12, height:0.09, tessellation:28}, scene);
    c.position.set(b.cx, b.h+0.045, b.cz);
    c.material = mat(b.roof); c.isPickable = false; sg.addShadowCaster(c);
  }else if(b.tiered){
    const h1 = b.h*0.7, h2 = b.h*0.3, w2 = b.w*0.68, d2 = b.d*0.68;
    m = MeshBuilder.CreateBox('b'+b.id, {width:b.w, depth:b.d, height:h1}, scene);
    m.position.set(b.cx, h1/2, b.cz);
    const top = MeshBuilder.CreateBox('t'+b.id, {width:w2, depth:d2, height:h2}, scene);
    top.position.set(b.cx, h1+h2/2, b.cz);
    top.material = mat(b.color); top.metadata = {bid:b.id};
    top.receiveShadows = true; sg.addShadowCaster(top);
    cap(b.cx, h1+0.02, b.cz, b.w+0.1, b.d+0.1, b.roof);
    cap(b.cx, b.h+0.05, b.cz, w2+0.12, d2+0.12, b.roof);
    addWindows(b, h1);
  }else{
    m = MeshBuilder.CreateBox('b'+b.id, {width:b.w, depth:b.d, height:b.h}, scene);
    m.position.set(b.cx, b.h/2, b.cz);
    cap(b.cx, b.h+0.05, b.cz, b.w+0.14, b.d+0.14, b.roof);
    if(b.kind!=='flat' && b.kind!=='gate') addWindows(b);
  }
  m.material = mat(b.color);
  m.metadata = {bid:b.id};
  m.receiveShadows = true;
  sg.addShadowCaster(m);
  meshById[b.id] = m;
});

/* ---------- trees (auto, along pad edges) ---------- */
const trunkMaster = MeshBuilder.CreateCylinder('trunk', {diameter:0.14, height:0.35, tessellation:8}, scene);
trunkMaster.material = mat('#8A6239'); trunkMaster.isVisible = false; trunkMaster.isPickable = false;
const leafMasters = ['#4E8C46','#5E9C4E','#6FAE57'].map((h,i)=>{
  const s = MeshBuilder.CreateSphere('leaf'+i, {diameter:0.68, segments:8}, scene);
  s.scaling.y = 1.25; s.material = mat(h); s.isVisible = false; s.isPickable = false;
  sg.addShadowCaster(s);
  return s;
});
sg.addShadowCaster(trunkMaster);
let treeN = 0;
function tree(x,z){
  const clear = buildings.every(b => Math.hypot(b.cx-x, b.cz-z) > 1.9)
    && feederXs.every(fx => Math.abs(fx-x) > 0.9 || z < 13.9)
    && Math.abs(z-mainZ) > 1.1 && Math.abs(z-backRoadZ) > 0.8;
  if(!clear) return;
  const jx=(rnd(treeN)-.5)*.5, jz=(rnd(treeN+50)-.5)*.5, s=.8+rnd(treeN+100)*.55;
  const t = trunkMaster.createInstance('tr');
  t.position.set(x+jx, 0.175*s, z+jz); t.scaling.setAll(s);
  const l = leafMasters[treeN%3].createInstance('lf');
  l.position.set(x+jx, 0.65*s, z+jz); l.scaling.setAll(s);
  treeN++;
}
padRects.forEach(([x0,z0,x1,z1])=>{
  for(let x=x0+1; x<x1; x+=3.2){ tree(x, z0-0.25); tree(x+1.1, z1+(z1>15?-0.35:0.35)); }
});

/* ---------- clouds ---------- */
const cloudMat = mat('#FFFFFF'); cloudMat.alpha = 0.92;
const cloudMaster = MeshBuilder.CreateSphere('cloud', {diameter:3, segments:8}, scene);
cloudMaster.material = cloudMat; cloudMaster.isVisible = false; cloudMaster.isPickable = false;
const clouds = [];
for(let i=0;i<9;i++){
  const c = cloudMaster.createInstance('cl');
  c.position.set(offL + rnd(i+200)*(offR-offL), 12 + rnd(i+210)*5, -6 + rnd(i+220)*30);
  c.scaling.set(1.1 + rnd(i+230)*1.6, 0.38 + rnd(i+240)*0.18, 0.8 + rnd(i+250)*0.8);
  clouds.push(c);
}

/* ---------- findings: rings, badges, stuck clusters (dynamic) ---------- */
const findings = [];
const rings = [];
function makeRing(f){
  const b = byId[f.target]; if(!b) return;
  const t = MeshBuilder.CreateTorus('ring', {diameter:b.w+2.2, thickness:0.09, tessellation:48}, scene);
  t.position.set(b.cx, 0.12, b.cz);
  t.material = mat('#000000', {emissive:SEVC[f.severity]||SEVC.info, alpha:0.85});
  t.material.disableLighting = true; t.isPickable = false;
  rings.push({mesh:t, f, phase:b.gx});
}
function removeRing(f){
  const i = rings.findIndex(r=>r.f===f); if(i<0) return;
  rings[i].mesh.dispose(); rings.splice(i,1);
}

/* ---------- vehicles ---------- */
function vehicleMaster(hex, len, wid, hgt){
  const s = MeshBuilder.CreateBox('vm', {width:len, height:hgt, depth:wid}, scene);
  s.material = mat(hex); s.isVisible = false; s.isPickable = false;
  sg.addShadowCaster(s);
  return s;
}
const VKIND = {
  van:  h=>vehicleMaster(h, .42, .22, .2),
  truck:h=>vehicleMaster(h, .72, .28, .28),
  cart: h=>vehicleMaster(h, .34, .2, .16),
};
const clusterPools = {};
function setClusterCount(f, n){
  const b = byId[f.target]; if(!b) return;
  n = Math.min(n||0, 12);
  let pool = clusterPools[f.id];
  if(!pool && n>0) pool = clusterPools[f.id] =
    {master: vehicleMaster(SEVC[f.severity]||SEVC.amber, .42, .22, .2), insts: []};
  if(!pool) return;
  while(pool.insts.length < n){
    const i = pool.insts.length;
    const inst = pool.master.createInstance('stuck');
    inst.position.set(b.cx-1.4+(i%4)*.62, 0.13, b.gy+b.d+0.6+((i/4)|0)*.6);
    inst.rotation.y = (rnd(i+300)-.5)*.9;
    pool.insts.push(inst);
  }
  while(pool.insts.length > n) pool.insts.pop().dispose();
}

/* route builder: any source/target → waypoint list via roads */
function routeOut(b){        /* building → point on main road */
  if(isBack(b)) return [[b.cx, b.gy+b.d+0.2],[b.cx, backRoadZ],[joinX, backRoadZ],[joinX, mainZ]];
  return [[b.cx, b.gy-0.4],[b.cx, mainZ]];
}
function routeIn(b){ return routeOut(b).slice().reverse(); }
function endpointPos(spec){
  if(spec==='offmap-left')  return [[offL, mainZ]];
  if(spec==='offmap-right') return [[offR, mainZ]];
  return null;
}
function buildRoute(fromB, toSpec){
  const start = fromB ? routeOut(fromB) : endpointPos('offmap-left');
  let endPts;
  if(typeof toSpec==='string' && toSpec.startsWith('offmap')) endPts = endpointPos(toSpec);
  else{
    const tb = byId[toSpec] || (W.districts.find(d=>d.id===toSpec) && byId[W.districts.find(d=>d.id===toSpec).buildings[0].id]);
    endPts = tb ? routeIn(tb) : endpointPos('offmap-right');
  }
  const sEnd = start[start.length-1], eStart = endPts[0];
  const mid = [];
  if(Math.abs(sEnd[1]-mainZ)<0.01 && Math.abs(eStart[1]-mainZ)<0.01){} /* both on main */
  else mid.push([sEnd[0], mainZ], [eStart[0], mainZ]);
  if(mid.length===0 && Math.abs(sEnd[0]-eStart[0])>0.01) mid.push([eStart[0], mainZ]);
  return start.concat(mid, endPts);
}

const agents = [];
const routeLen = rt => { let L=0; for(let i=1;i<rt.length;i++) L+=Math.hypot(rt[i][0]-rt[i-1][0], rt[i][1]-rt[i-1][1]); return L; };
function posOn(rt, d){
  for(let i=1;i<rt.length;i++){
    const seg = Math.hypot(rt[i][0]-rt[i-1][0], rt[i][1]-rt[i-1][1]);
    if(seg>0.001 && d<=seg){ const t=d/seg;
      return [rt[i-1][0]+(rt[i][0]-rt[i-1][0])*t, rt[i-1][1]+(rt[i][1]-rt[i-1][1])*t,
              rt[i][0]-rt[i-1][0], rt[i][1]-rt[i-1][1]]; }
    d-=seg;
  }
  const n = rt.length-1;
  return [rt[n][0], rt[n][1], rt[n][0]-rt[Math.max(0,n-1)][0], rt[n][1]-rt[Math.max(0,n-1)][1]];
}
function placeAgent(a){
  const [x,z,dx,dz] = posOn(a.route, a.d);
  a.inst.position.set(x, a.y, z);
  if(dx||dz) a.inst.rotation.y = Math.atan2(-dz, dx);
}
const flows = (W.flows||[]).map((f,i)=>{
  const master = (VKIND[f.kind]||VKIND.van)(f.color||'#2F6FED');
  const y = f.kind==='truck' ? 0.17 : f.kind==='cart' ? 0.11 : 0.13;
  const speed = f.kind==='truck' ? 2.2 : f.kind==='cart' ? 1.6 : 3.1;
  const srcDistrict = W.districts.find(d=>d.id===f.from);
  return Object.assign({}, f, {master, y, speed, srcDistrict, t:0, every:f.every||1.2});
});
function spawnFlow(f, prefill){
  let fromB = null;
  if(f.srcDistrict){
    const bs = f.srcDistrict.buildings;
    const tot = bs.reduce((s,b)=>s+(b.weight||1), 0);
    let r = Math.random()*tot;
    for(const b of bs){ r -= (b.weight||1); if(r<=0){ fromB = byId[b.id]; break; } }
    fromB = fromB || byId[bs[0].id];
  }else if(f.from && f.from!=='offmap-left') fromB = byId[f.from];
  const route = buildRoute(fromB, f.to);
  const inst = f.master.createInstance('a');
  const a = {inst, route, len:routeLen(route), d:prefill?Math.random()*routeLen(route):0, v:f.speed, y:f.y};
  agents.push(a); placeAgent(a);
  if(!prefill && f.countKpi!=null) bumpKpi(f.countKpi);
}
flows.forEach(f=>{ const n = Math.max(2, Math.round(8/Math.max(f.every,0.3))); for(let i=0;i<n;i++) spawnFlow(f, true); });

/* ---------- HUD ---------- */
const kpiVals = (W.kpis||[]).map(k=>k.value);
function renderKpis(){
  document.getElementById('chips').innerHTML = (W.kpis||[]).map((k,i)=>
    `<div class="chip ${k.tone||''}">${k.label} <b id="kpi-${i}">${kpiVals[i]}</b></div>`).join('');
}
function bumpKpi(i){
  const n = parseInt(String(kpiVals[i]).replace(/\D/g,''),10);
  if(!isNaN(n)){ kpiVals[i] = String(n+1); const el=document.getElementById('kpi-'+i); if(el) el.textContent = kpiVals[i]; }
}
renderKpis();
document.getElementById('legend').innerHTML = (W.legend||[]).map(l=>
  `<span><i style="background:${l.color}"></i>${l.label}</span>`).join('');

/* ---------- overlay labels + badges ---------- */
const overlay = document.getElementById('overlay');
const tracked = [];
function track(el, x, y, z, clickTarget){
  overlay.appendChild(el);
  if(clickTarget){ el.style.pointerEvents='auto'; el.addEventListener('click', ()=>select(clickTarget)); }
  tracked.push({el, v:new Vector3(x,y,z)});
}
buildings.forEach(b=>{
  const el = document.createElement('div');
  el.className = 'lbl'; el.textContent = b.label || b.name;
  track(el, b.cx, b.h+0.55, b.cz, b.id);
});
(W.districts||[]).forEach(d=>{
  if(!d._labelAt || !d.label) return;
  const el = document.createElement('div');
  el.className = 'lbl big'; el.textContent = d.label.toUpperCase();
  track(el, ...d._labelAt);
});
const badgeEls = {};
function makeBadge(f){
  const b = byId[f.target]; if(!b) return;
  const el = document.createElement('div');
  el.className = 'badge '+(f.severity||'info'); el.textContent = '!';
  badgeEls[f.id] = el;
  track(el, b.cx, b.h+1.35, b.cz, b.id);
}
function removeBadge(f){
  const el = badgeEls[f.id]; if(!el) return;
  const i = tracked.findIndex(t=>t.el===el);
  if(i>=0) tracked.splice(i,1);
  el.remove(); delete badgeEls[f.id];
}
function addFinding(f){
  if(!byId[f.target]) return;
  findings.push(f); makeRing(f); makeBadge(f);
  if(f.cluster) setClusterCount(f, f.cluster);
  renderFindings();
}
function removeFindingById(id){
  const i = findings.findIndex(f=>f.id===id); if(i<0) return;
  const f = findings[i];
  removeRing(f); removeBadge(f); setClusterCount(f, 0);
  findings.splice(i,1); renderFindings();
}
(W.findings||[]).forEach(f=>addFinding(Object.assign({}, f)));
function updateOverlay(){
  const w = engine.getRenderWidth(), h = engine.getRenderHeight();
  const dpr = engine.getHardwareScalingLevel();
  tracked.forEach(t=>{
    const p = Vector3.Project(t.v, Matrix.Identity(), scene.getTransformMatrix(),
      cam.viewport.toGlobal(w, h));
    if(p.z > 1 || p.z < 0){ t.el.style.display='none'; return; }
    t.el.style.display='';
    t.el.style.transform = `translate(-50%,-100%) translate(${p.x*dpr}px,${p.y*dpr}px)`;
  });
}

/* ---------- clock + day cycle ---------- */
const CK = Object.assign({dayLabel:'TUE', start:'09:00', loopStart:'08:00', loopEnd:'18:00', speed:60}, W.clock||{});
const toMin = s => { const [h,m]=s.split(':').map(Number); return h*60+m; };
let simMin = toMin(CK.start);
const loopA = toMin(CK.loopStart), loopB = toMin(CK.loopEnd);
const fmt = m => CK.dayLabel+' '+String((m/60|0)%24).padStart(2,'0')+':'+String(m%60|0).padStart(2,'0');
const clockEl = document.getElementById('simtime');
document.getElementById('speed').textContent = 'replay ×'+CK.speed;
clockEl.textContent = fmt(simMin);
const sunWarm = Color3.FromHexString('#FFE3B8'), sunNoon = Color3.FromHexString('#FFF7EC');
let tAcc = 0;
scene.onBeforeRenderObservable.add(()=>{
  const dt = REDUCED ? 0 : Math.min(0.05, engine.getDeltaTime()/1000);
  tAcc += dt;
  if(dt>0){
    simMin += dt*CK.speed;
    if(simMin >= loopB) simMin = loopA;
    clockEl.textContent = fmt(simMin);
    const f = Math.min(1, Math.max(0, (simMin-loopA)/(loopB-loopA)));
    sun.direction.set(-0.7*Math.cos(Math.PI*f), -1.1, 0.35);
    const arc = Math.sin(Math.PI*f);
    sun.intensity = 0.72 + 0.3*arc;
    Color3.LerpToRef(sunWarm, sunNoon, arc, sun.diffuse);
    flows.forEach(fl=>{ fl.t += dt; if(fl.t >= fl.every){ fl.t = 0; spawnFlow(fl); } });
    for(let i=agents.length-1;i>=0;i--){
      const a=agents[i]; a.d+=a.v*dt;
      if(a.d>=a.len){ a.inst.dispose(); agents.splice(i,1); continue; }
      placeAgent(a);
    }
    clouds.forEach(c=>{ c.position.x += dt*0.25; if(c.position.x > offR+14) c.position.x = offL-14; });
    buildings.forEach(b=>{
      const m = meshById[b.id];
      if(m && m._targetSy!=null && Math.abs(m.scaling.y-m._targetSy)>0.001){
        m.scaling.y += (m._targetSy-m.scaling.y)*Math.min(1, dt*3);
        m.position.y = b.h*m.scaling.y/2;
      }
    });
  }
  rings.forEach(r=>{
    if(r.f.queued || findings.indexOf(r.f)<0){ r.mesh.setEnabled(false); return; }
    const pulse = REDUCED ? .5 : (Math.sin(tAcc*3+r.phase)+1)/2;
    const s = 1 + pulse*.18;
    r.mesh.scaling.set(s,1,s);
    r.mesh.material.alpha = .9 - pulse*.5;
  });
  updateOverlay();
});

/* ---------- picking, inspector, findings rail ---------- */
let selectedId = null, outlined = null;
function setOutline(mesh, on){
  if(!mesh) return;
  mesh.renderOutline = on;
  if(on){ mesh.outlineColor = Color3.FromHexString('#F0A500'); mesh.outlineWidth = 0.05; }
}
scene.onPointerObservable.add(pi=>{
  if(pi.type === PointerEventTypes.POINTERTAP){
    const pick = scene.pick(scene.pointerX, scene.pointerY, m=>m.metadata && m.metadata.bid);
    if(pick && pick.hit) select(pick.pickedMesh.metadata.bid);
    else closeInspector();
  }
  if(pi.type === PointerEventTypes.POINTERMOVE){
    const pick = scene.pick(scene.pointerX, scene.pointerY, m=>m.metadata && m.metadata.bid);
    canvas.style.cursor = (pick && pick.hit) ? 'pointer' : 'grab';
  }
});
const insp = document.getElementById('inspector');
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function select(id){
  const b = byId[id]; if(!b) return;
  if(outlined && outlined !== meshById[id]) setOutline(outlined, false);
  outlined = meshById[id]; setOutline(outlined, true);
  selectedId = id;
  document.getElementById('hint').classList.add('gone');
  document.getElementById('i-kind').textContent = b.kindLabel || '';
  document.getElementById('i-name').textContent = b.name;
  document.getElementById('i-stats').innerHTML = (b.stats||[]).map(([k,v])=>{
    const [val,cls] = Array.isArray(v)?v:[v,null];
    return `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls||''}">${esc(val)}</div></div>`;
  }).join('');
  const f = findings.find(x=>x.target===id);
  document.getElementById('i-finding').innerHTML = f ? `
    <div class="fcard ${f.severity}"><div class="bar"></div>
      <div class="in">
        <div class="fk">Finding · ${esc(f.source||'')}</div>
        <div class="ft">${esc(f.title)}</div>
      </div>
      <div class="action">
        <div class="ak">Drafted action — awaiting approval</div>
        <div class="at">${esc(f.action||'')}</div>
        ${f.queued
          ? '<div class="queued">✓ Queued to the approval run</div>'
          : `<div class="abtns">
               <button class="abtn go" data-approve="${f.id}">Approve</button>
               <button class="abtn" data-dismiss="${f.id}">Dismiss</button>
             </div>`}
      </div>
    </div>` : '';
  document.getElementById('i-query').textContent = b.query || '';
  insp.classList.add('open');
  renderFindings();
}
function closeInspector(){
  selectedId = null; insp.classList.remove('open');
  if(outlined){ setOutline(outlined, false); outlined = null; }
}
document.getElementById('i-close').addEventListener('click', closeInspector);
insp.addEventListener('click', e=>{
  const ap = e.target.dataset && e.target.dataset.approve;
  const dm = e.target.dataset && e.target.dataset.dismiss;
  if(ap||dm){
    const f = findings.find(x=>x.id===(ap||dm));
    if(dm){ removeFindingById(f.id); }
    else{
      f.queued = true;
      if(badgeEls[f.id]) badgeEls[f.id].style.display='none';
    }
    select(selectedId); renderFindings();
  }
});
function renderFindings(){
  const el = document.getElementById('flist');
  el.innerHTML = findings.map(f=>`
    <button class="frow" data-go="${f.target}">
      <span class="sev ${f.severity}"></span>
      <span><span class="t">${esc(f.title)}</span><br>
        ${f.queued?'<span class="done">✓ action queued</span>':`<span class="w">${esc(f.source||'')}</span>`}
      </span>
    </button>`).join('');
  document.getElementById('fcount').textContent =
    findings.filter(f=>!f.queued).length+' open';
  el.querySelectorAll('[data-go]').forEach(r=>
    r.addEventListener('click', ()=>select(r.dataset.go)));
}
renderFindings();

/* ---------- live mode: poll a GraphQL endpoint, patch the world ----------
   WORLD.live = {endpoint, pollMs, bindings:[...]} — two binding shapes:
   row-matched: {query, root, matchPrefix, rowKey, size:{field,max},
                 stat:{label,field,format}, weightField}
   scalar:      {query, root, field, target?, stat?, kpi?, format?,
                 finding:{id,severity,target,titleTpl,source,action,
                          min?|below?, cluster?}}
   {{daysAgo:N}} in queries resolves to an ISO date at fetch time. */
const LIVE = W.live;
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function fmtVal(v, f){
  v = v==null ? 0 : v;
  if(f==='$M') return '$'+(v/1e6).toFixed(2)+'M';
  if(f==='$k') return '$'+(v/1e3).toFixed(1)+'k';
  if(f==='int') return String(Math.round(v));
  return String(v);
}
function setKpi(i, str){
  kpiVals[i] = str;
  const el = document.getElementById('kpi-'+i); if(el) el.textContent = str;
}
function setStat(b, label, val){
  b.stats = b.stats || [];
  const row = b.stats.find(r=>r[0]===label);
  if(row){ if(Array.isArray(row[1])) row[1][0] = val; else row[1] = val; }
  else b.stats.push([label, val]);
  if(selectedId===b.id) select(b.id);
}
function setBuildingSize(b, sizeNorm){
  if(b.tiered) return;
  const k = KIND[b.kind]||KIND.block;
  const m = meshById[b.id]; if(!m) return;
  m._targetSy = k.h(Math.max(0, Math.min(1, sizeNorm)))/b.h;
}
function upsertLiveFinding(bd, v){
  const spec = bd.finding;
  const fire = spec.below!=null ? v < spec.below : v >= (spec.min==null ? 1 : spec.min);
  const cur = findings.find(f=>f.id===spec.id);
  if(fire){
    const title = (spec.titleTpl||'{n}').replace('{n}', Math.round(v));
    if(cur){
      if(cur.title!==title){ cur.title = title; renderFindings(); }
      if(spec.cluster) setClusterCount(cur, v);
      if(selectedId===spec.target) select(selectedId);
    }else{
      addFinding({id:spec.id, severity:spec.severity||'amber', target:spec.target,
        title, source:spec.source||'live watcher', action:spec.action||'',
        cluster: spec.cluster ? v : 0});
    }
  }else if(cur && !cur.queued){
    removeFindingById(spec.id);
  }
}
const gqlDates = s => s.replace(/\{\{daysAgo:(\d+)\}\}/g,
  (_,d)=> new Date(Date.now()-(+d)*864e5).toISOString().slice(0,10));
async function runBinding(bd){
  const r = await fetch(LIVE.endpoint, {method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({query: gqlDates(bd.query)})});
  const j = await r.json();
  if(j.errors) throw new Error(j.errors[0].message);
  const rows = (j.data && j.data[bd.root]) || [];
  if(bd.matchPrefix){
    rows.forEach(row=>{
      const b = byId[bd.matchPrefix + slug(row[bd.rowKey])]; if(!b) return;
      if(bd.size) setBuildingSize(b, (row[bd.size.field]||0)/bd.size.max);
      if(bd.stat) setStat(b, bd.stat.label, fmtVal(row[bd.stat.field], bd.stat.format));
      if(bd.weightField){
        const d = W.districts.find(x=>x.id===b.district);
        const sb = d && d.buildings.find(x=>x.id===b.id);
        if(sb) sb.weight = row[bd.weightField]||1;
      }
    });
  }else{
    const v = rows.length ? (rows[0][bd.field]||0) : 0;
    if(bd.target && bd.stat && byId[bd.target]) setStat(byId[bd.target], bd.stat.label, fmtVal(v, bd.stat.format));
    if(bd.kpi!=null) setKpi(bd.kpi, fmtVal(v, bd.format||'int'));
    if(bd.finding) upsertLiveFinding(bd, v);
  }
}
let liveChip;
function liveStatus(ok, msg){
  if(!liveChip){
    liveChip = document.createElement('div');
    liveChip.className = 'chip'; liveChip.id = 'live-chip';
    document.getElementById('chips').prepend(liveChip);
  }
  liveChip.innerHTML = ok
    ? '<b style="color:#12A47B">● LIVE</b>'
    : '<b style="color:#D6453D">● OFFLINE</b>';
  liveChip.title = msg||'';
}
async function pollLive(){
  try{
    for(const bd of LIVE.bindings) await runBinding(bd);
    liveStatus(true);
  }catch(e){ liveStatus(false, String(e.message||e)); }
  setTimeout(pollLive, LIVE.pollMs||5000);
}
if(LIVE) pollLive();

engine.runRenderLoop(()=>scene.render());
addEventListener('resize', ()=>engine.resize());
