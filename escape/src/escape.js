/* =====================================================================
   大坂城脱出 ― 夏の陣・落城の夜（協力脱出ゲーム層）
   大阪城さんぽの3Dマップ（落城の場面）の上で動く。最大4人、PeerJS（P2P）で同期。
   ホスト（部屋を作った人）が進行・追手・当たり判定をまとめて計算し、10回/秒で全員に配る。
   ===================================================================== */
const ESC=(()=>{
  const VER='0.2';
  const MAXP=4, TIME_LIMIT=15*60, NET_HZ=10;
  const PEER_PREFIX='osaka-escape-32miya-';
  const COLS=['#e0412f','#e8b13a','#3fa7d6','#7bc96f'];
  const SPRS=['sanada','onna_musha','kimura','t_ninja'];
  const qs=new URLSearchParams(location.search);

  /* ---------- 舞台（座標は大阪城さんぽの豊臣期マップ） ---------- */
  const OKU=ROOMS.find(R=>R.era==='toyo'&&R.name==='奥御殿');
  const ezuPos=(()=>{ if(!OKU) return [0,-30,9]; const [sx,sz,yaw]=OKU.spawn; for(const d of [4,3.2,2.4,1.6]){ const x=sx-Math.sin(yaw)*d,z=sz-Math.cos(yaw)*d; if(roomOK(OKU,x,z)) return [x,z,OKU.y]; } return [sx,sz,OKU.y]; })();
  const SPOT={
    spawn:[[0,-24],[3,-24],[-3,-24],[0,-21]],
    ezu:ezuPos,                                  /* 奥御殿の中 */
    swW:[-64,-76.5], swE:[72.5,-76.5],           /* 山里丸へ通じる西と東の閂 */
    well:[2,-91], fire:[-24,-103.5],             /* 山里丸の井戸／極楽橋の南詰 */
    boat:[-54,-304]                              /* 大川の岸の小舟 */
  };
  const GATES={W:{x0:-76.5,x1:-53.5,z0:-80.2,z1:-78.8},E:{x0:69.5,x1:76.5,z0:-80.2,z1:-78.8}};
  const FIREBOX={x0:-30,x1:-18,z0:-108,z1:-100};
  const CHECK=[[[0,-24],[3,-24],[-3,-24],[0,-21]],[[-64,-30],[-61,-30],[-67,-30],[-64,-27]],[[-62,-90],[-59,-90],[-65,-90],[-62,-87]],[[-24,-136],[-21,-136],[-27,-136],[-24,-139]]];
  const STAGES=[
    {t:'其の一　詰ノ丸',o:'侍女の言葉を手がかりに、奥御殿で「抜け道の絵図」を探せ'},
    {t:'其の二　山里丸の錠前',o:'本丸に立つ三本の幟の家紋を集め、山里丸への門の錠前を開けろ'},
    {t:'其の三　極楽橋の火',o:'井戸で水をくみ、極楽橋の火を消せ'},
    {t:'其の四　大川へ',o:'二の丸の追手をかわし、大川の小舟へ全員で乗り込め'}];
  /* ---------- 謎解き ---------- */
  const MON=[['桐','ki_kiri'],['菊','mon_kiku'],['瓢箪','ki_hyotan'],['巴','mon_tomoe'],['梅鉢','ki_umebachi'],['桜','mon_sakura']];
  const ORD=['壱','弐','参'];
  const CLUE_CAND=[[-66,32],[-34,76],[44,76],[68,26],[70,-52],[-66,-62],[-40,44]];   /* 幟が立ちうる場所（毎回3か所を選ぶ） */
  const NPC0=[7,-19], NPC1=[-63,-44], LOCK=[-58,-78.3];
  const HIDES=[{n:'虎の屏風',spr:'by_tiger',s:1,r:'寅が見張っておる、その背の陰に'},{n:'掛け軸',spr:'kakejiku',s:1,r:'山と水が垂れ下がる、その裏に'},{n:'長持',spr:'chest_m',s:1,r:'衣が眠る箱の、そのまた底に'},{n:'違い棚',spr:'shelf',s:1,r:'高さの違う段の、いちばん上に'}];
  const CHA=ROOMS.find(R=>R.era==='toyo'&&R.name==='山里丸の茶室');
  /* 追手（徳川方の兵）の巡回路 */
  const PATROLS=[
    {p:[[-66,-6],[-66,-66]],s:1.5},
    {p:[[-44,14],[54,14]],s:1.6},
    {p:[[72,-6],[72,-66]],s:1.4},
    {p:[[-44,-86],[46,-86]],s:1.15},
    {p:[[-120,-150],[40,-150]],s:1.9},
    {p:[[-80,-205],[-80,-158],[-30,-158],[-30,-205]],s:1.6},
    {p:[[60,-210],[60,-160]],s:1.5},
    {p:[[-110,-268],[10,-268]],s:1.8},
    {p:[[-140,-235],[-140,-290]],s:1.4}];

  /* ---------- 状態 ---------- */
  const net={mode:null,peer:null,conns:new Map(),host:null,myId:0,code:'',sendT:0};
  const me={name:'',cr:false,use:false,inGame:false,lastTp:0};
  let G=null;              /* ホストの正式な状態 */
  let V=null;              /* 各自が受け取った最新の状態（表示用） */
  let lobby=[];            /* {id,n} */

  const dist=(a,b,x,z)=>Math.hypot(a-x,b-z);
  const fmt=t=>{ t=Math.max(0,Math.ceil(t)); return (t/60|0)+':'+String(t%60).padStart(2,'0'); };
  const el=id=>document.getElementById(id);
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  /* ---------- 3Dの小道具 ---------- */
  const PROP=new THREE.Group(); scene.add(PROP);
  const crowd=new Crowd(PROP,400);
  const beamGeo=new THREE.CylinderGeometry(.55,.55,36,12,1,true); beamGeo.translate(0,18,0);
  function beam(col){ const m=new THREE.Mesh(beamGeo,new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.28,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide})); m.renderOrder=5; PROP.add(m); return m; }
  const ringGeo=new THREE.RingGeometry(1.5,1.9,40); ringGeo.rotateX(-Math.PI/2);
  function ring(col){ const m=new THREE.Mesh(ringGeo,new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.75,depthWrite:false})); m.renderOrder=5; PROP.add(m); return m; }
  const B_EZU=beam(0xffd36a), B_W=beam(0xffd36a), B_E=beam(0xffd36a), B_WELL=beam(0x7cc8ff), B_FIRE=beam(0xff8a3a), B_BOAT=beam(0x9effa8);
  const R_W=ring(0xffd36a), R_E=ring(0xffd36a), R_BOAT=ring(0x9effa8);
  /* 門（閂のかかった板戸） */
  const gateMesh={};
  for(const k in GATES){ const g=GATES[k],w=g.x1-g.x0,d=g.z1-g.z0,grp=new THREE.Group();
    const door=mesh(new THREE.BoxGeometry(w,3.4,d),M.darkwood); door.position.set(0,1.7,0); grp.add(door);
    for(let i=0;i<Math.floor(w/1.6);i++){ const s=mesh(new THREE.BoxGeometry(.12,3.5,d+.14),M.black||M.darkwood); s.position.set(-w/2+.8+i*1.6,1.75,0); grp.add(s); }
    const bar=mesh(new THREE.BoxGeometry(w+.4,.32,d+.5),M.wood||M.darkwood); bar.position.set(0,1.9,0); grp.add(bar);
    grp.position.set((g.x0+g.x1)/2,groundH((g.x0+g.x1)/2,(g.z0+g.z1)/2),(g.z0+g.z1)/2); grp.userData.by=grp.position.y; PROP.add(grp); gateMesh[k]=grp; }
  /* 井戸 */
  { const y=0, w=mesh(new THREE.CylinderGeometry(1.1,1.2,.9,16,1,true),M.stone); w.position.set(SPOT.well[0],y+.45,SPOT.well[1]); PROP.add(w);
    const lid=mesh(new THREE.CylinderGeometry(1.05,1.05,.06,16),new THREE.MeshBasicMaterial({color:0x0a1420})); lid.position.set(SPOT.well[0],y+.7,SPOT.well[1]); PROP.add(lid);
    for(const s of [-1,1]){ const p=mesh(new THREE.BoxGeometry(.16,2.4,.16),M.darkwood); p.position.set(SPOT.well[0]+s*1.15,y+1.2,SPOT.well[1]); PROP.add(p); }
    const top=mesh(new THREE.BoxGeometry(2.8,.18,.3),M.darkwood); top.position.set(SPOT.well[0],y+2.4,SPOT.well[1]); PROP.add(top);
    crowd.add('bucket',SPOT.well[0]+1.6,y,SPOT.well[1]+.6,{s:1}); }
  /* 小舟 */
  const boat=(()=>{ try{ const g=makeBoat(PROP,'river'); if(g&&g.position){ g.position.set(SPOT.boat[0],WATER_Y+.3,SPOT.boat[1]-12); g.rotation.y=Math.PI/2; return g; } }catch(e){} return null; })();
  /* 船着き場の板 */
  { const d=mesh(new THREE.BoxGeometry(6,.3,12),M.wood||M.darkwood); d.position.set(SPOT.boat[0],-.1,SPOT.boat[1]-4); PROP.add(d); }
  /* ---------- 謎解きの小道具 ---------- */
  const W={hide:[],clue:[],cand:[],rope:null,npc0:NPC0,npc1:NPC1,lock:LOCK};
  function roomSpots(Rm,n,avoid,ad){ const pts=[]; for(const r of Rm.rects) for(let x=r.x0+.5;x<r.x1-.5;x+=.5) for(let z=r.z0+.5;z<r.z1-.5;z+=.5){ if(!roomOK(Rm,x,z)) continue;
      const edge=!roomOK(Rm,x+1.1,z)||!roomOK(Rm,x-1.1,z)||!roomOK(Rm,x,z+1.1)||!roomOK(Rm,x,z-1.1); if(edge&&Math.hypot(x-avoid[0],z-avoid[1])>ad) pts.push([x,z]); }
    const out=[]; if(!pts.length) return out; out.push(pts[Math.floor(pts.length/2)]);
    while(out.length<n){ let best=null,bd=-1; for(const q of pts){ let d=1e9; for(const o of out) d=Math.min(d,Math.hypot(o[0]-q[0],o[1]-q[1])); if(d>bd){ bd=d; best=q; } } if(!best||bd<.5) break; out.push(best); } return out; }
  function nudge(x,z){ const ok=(a,b)=>_walkable(a,b)&&!hitBlock(a,b,.9); if(ok(x,z)) return [x,z]; for(let r=1;r<=16;r++) for(let a=0;a<6.283;a+=.35){ const xx=x+Math.cos(a)*r,zz=z+Math.sin(a)*r; if(ok(xx,zz)) return [xx,zz]; } return [x,z]; }
  function textSprite(txt,bg,fg,size){ const c=makeCanvas(128,128),g=c.getContext('2d'); if(bg){ g.fillStyle=bg; g.beginPath(); g.arc(64,64,58,0,6.283); g.fill(); } g.fillStyle=fg; g.font='bold 78px "Hiragino Mincho ProN","Noto Serif JP",serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(txt,64,70);
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthTest:false,transparent:true})); sp.scale.setScalar(size||1); sp.renderOrder=9; PROP.add(sp); return sp; }
  const sparkTex=(()=>{ const c=makeCanvas(64,64),g=c.getContext('2d'),gr=g.createRadialGradient(32,32,0,32,32,30); gr.addColorStop(0,'rgba(255,250,220,1)'); gr.addColorStop(.25,'rgba(255,220,120,.7)'); gr.addColorStop(1,'rgba(255,200,80,0)'); g.fillStyle=gr; g.fillRect(0,0,64,64); g.fillStyle='rgba(255,255,240,.95)'; g.fillRect(30,4,4,56); g.fillRect(4,30,56,4); return new THREE.CanvasTexture(c); })();
  const glints=[...Array(9)].map(()=>{ const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:sparkTex,depthTest:false,transparent:true,blending:THREE.AdditiveBlending})); sp.renderOrder=9; sp.visible=false; PROP.add(sp); return sp; });
  let built=false,q0=null,q1=null,clueItems=[],clueTags=[],curSet=null;
  function buildStatic(){ if(built) return; built=true;
    if(OKU) roomSpots(OKU,4,OKU.spawn,2.2).forEach((q,i)=>{ W.hide.push([q[0],q[1],OKU.y]); crowd.add(HIDES[i].spr,q[0],OKU.y,q[1],{s:HIDES[i].s}); });
    if(CHA){ const q=roomSpots(CHA,1,CHA.spawn,.6)[0]||[CHA.spawn[0],CHA.spawn[1]]; W.rope=[q[0],q[1],CHA.y]; crowd.add('shelf',q[0],CHA.y,q[1],{s:.8}); }
    W.npc0=nudge(...NPC0); W.npc1=nudge(...NPC1); W.cand=CLUE_CAND.map(c=>nudge(c[0],c[1]));
    const y0=groundH(...W.npc0),y1=groundH(...W.npc1);
    crowd.add('jijo',W.npc0[0],y0,W.npc0[1],{}); crowd.add('taore',W.npc1[0],y1,W.npc1[1],{});
    nameTag('侍女','#e8b13a').position.set(W.npc0[0],y0+2.5,W.npc0[1]); nameTag('傷ついた兵','#e8b13a').position.set(W.npc1[0],y1+1.9,W.npc1[1]);
    q0=textSprite('？','#e8b13a','#111',.8); q0.position.set(W.npc0[0],y0+3.2,W.npc0[1]); q1=textSprite('？','#e8b13a','#111',.8); q1.position.set(W.npc1[0],y1+2.6,W.npc1[1]);
    const g=gateMesh.W; if(g){ const lk=mesh(new THREE.BoxGeometry(.7,.9,.45),M.gold||M.darkwood); lk.position.set(LOCK[0]-g.position.x,1.75,.85); g.add(lk); const ring=mesh(new THREE.TorusGeometry(.22,.06,8,16),M.gold||M.darkwood); ring.position.set(LOCK[0]-g.position.x,2.35,.85); g.add(ring); } }
  function buildClues(set){ for(const it of clueItems) crowd.hide(it); for(const sp of clueTags) PROP.remove(sp); clueItems=[]; clueTags=[];
    W.clue=set.clue.map(ci=>W.cand[ci]);
    W.clue.forEach((c,j)=>{ const y=groundH(c[0],c[1]); clueItems.push(crowd.add('t_nobori',c[0],y,c[1],{}),crowd.add('kagaribi',c[0]+1.4,y,c[1]+.8,{}),crowd.add(MON[set.code[j]][1],c[0]-.9,y+.15,c[1]+.5,{s:1.1})); const tg=textSprite(ORD[j],'#b32a1c','#fff',.9); tg.position.set(c[0],y+4.6,c[1]); clueTags.push(tg); }); }
  /* 極楽橋の炎 */
  const fireFX={type:'blaze',x:SPOT.fire[0],y:.4,z:SPOT.fire[1],r:3.2,h:3.5,rate:34,ring:false,esc:true};
  const smokeFX={type:'column',x:SPOT.fire[0],y:3,z:SPOT.fire[1],r:4,rate:3,esc:true};
  function setFireFX(level){ for(let i=FXS.length-1;i>=0;i--) if(FXS[i].esc) FXS.splice(i,1); if(level>0){ fireFX.rate=34*level; fireFX.r=1.5+1.7*level; FXS.push(fireFX,smokeFX); } }

  /* 人物の絵（前後2枚を切り替え） */
  function figure(spr,s){ const f=crowd.add(spr,0,-999,0,{s:s||1}),b=sprInfo(spr+'_b')?crowd.add(spr+'_b',0,-999,0,{s:s||1}):null; if(b) crowd.setOn(b,false); return {f,b,x:0,y:-999,z:0,yaw:0,front:true}; }
  function placeFig(F,x,y,z,yaw){ F.x=x; F.y=y; F.z=z; F.yaw=yaw; const fx=-Math.sin(yaw),fz=-Math.cos(yaw),cx=camera.position.x-x,cz=camera.position.z-z,front=!F.b||fx*cx+fz*cz>=0,flip=(fx*cz-fz*cx)>0;
    if(F.b&&front!==F.front){ crowd.setOn(F.f,front); crowd.setOn(F.b,!front); F.front=front; } crowd.move(front?F.f:F.b,x,y,z,front?flip:!flip); }
  function hideFig(F){ crowd.move(F.f,0,-999,0); if(F.b) crowd.move(F.b,0,-999,0); }

  /* 名札 */
  function nameTag(text,col){ const c=makeCanvas(256,64),g=c.getContext('2d'); g.font='bold 30px "Hiragino Sans","Noto Sans JP",sans-serif'; g.textAlign='center'; g.textBaseline='middle';
    g.fillStyle='rgba(10,10,12,.72)'; const w=Math.min(250,g.measureText(text).width+30); g.beginPath(); g.roundRect?g.roundRect(128-w/2,8,w,48,22):g.rect(128-w/2,8,w,48); g.fill(); g.fillStyle=col; g.fillRect(128-w/2+12,28,8,8); g.fillStyle='#fff'; g.fillText(text,136,33);
    const t=new THREE.CanvasTexture(c),s=new THREE.Sprite(new THREE.SpriteMaterial({map:t,depthTest:false,transparent:true})); s.scale.set(2.4,.6,1); s.renderOrder=9; PROP.add(s); return s; }
  const others=new Map();  /* id → {F,tag,col,n,carry} */
  function otherOf(p){ let o=others.get(p.id); if(!o){ o={F:figure(SPRS[p.c%4]),tag:nameTag(p.n,COLS[p.c%4]),n:p.n,bk:crowd.add('bucket',0,-999,0,{s:.7})}; others.set(p.id,o); } return o; }
  function clearOthers(){ for(const o of others.values()){ hideFig(o.F); PROP.remove(o.tag); if(o.bk) crowd.move(o.bk,0,-999,0); } others.clear(); }

  /* 追手 */
  const enemyFigs=PATROLS.map((_,i)=>figure(i%3===2?'k_teppo':'k_yari',1.1));
  const SIGHT=13, SIGHT_HALF=0.99;   /* 追手の視界：13m・左右およそ57度 */
  const fanGeo=new THREE.CircleGeometry(SIGHT,28,Math.PI/2-SIGHT_HALF,SIGHT_HALF*2); fanGeo.rotateX(-Math.PI/2);
  const fanEdgeGeo=new THREE.RingGeometry(SIGHT-.35,SIGHT,28,1,Math.PI/2-SIGHT_HALF,SIGHT_HALF*2); fanEdgeGeo.rotateX(-Math.PI/2);
  const fans=PATROLS.map(()=>{ const g=new THREE.Group(); const f=new THREE.Mesh(fanGeo,new THREE.MeshBasicMaterial({color:0xffb030,transparent:true,opacity:.26,depthWrite:false,toneMapped:false,polygonOffset:true,polygonOffsetFactor:-2}));
    const e=new THREE.Mesh(fanEdgeGeo,new THREE.MeshBasicMaterial({color:0xffb030,transparent:true,opacity:.9,depthWrite:false,toneMapped:false,polygonOffset:true,polygonOffsetFactor:-2})); f.renderOrder=e.renderOrder=4; g.add(f,e); g.userData={f,e}; PROP.add(g); return g; });
  const glowTex=(()=>{ const c=makeCanvas(64,64),g=c.getContext('2d'),gr=g.createRadialGradient(32,32,0,32,32,32); gr.addColorStop(0,'rgba(255,220,140,1)'); gr.addColorStop(.3,'rgba(255,150,50,.6)'); gr.addColorStop(1,'rgba(255,120,30,0)'); g.fillStyle=gr; g.fillRect(0,0,64,64); return new THREE.CanvasTexture(c); })();
  const lanterns=PATROLS.map(()=>{ const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false})); sp.scale.setScalar(1.6); sp.renderOrder=5; PROP.add(sp); return sp; });
  const foeTags=PATROLS.map(()=>{ const c=makeCanvas(256,64),g=c.getContext('2d'); g.fillStyle='rgba(150,20,10,.85)'; g.beginPath(); g.roundRect?g.roundRect(68,8,120,48,22):g.rect(68,8,120,48); g.fill(); g.fillStyle='#fff'; g.font='bold 30px "Hiragino Sans","Noto Sans JP",sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('追手',128,33);
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthTest:false,transparent:true})); sp.scale.set(2,.5,1); sp.renderOrder=9; PROP.add(sp); return sp; });
  const markTex=t=>{ const c=makeCanvas(64,64),g=c.getContext('2d'); g.font='bold 54px sans-serif'; g.textAlign='center'; g.fillStyle=t==='！'?'#ff3b2f':'#ffd36a'; g.strokeStyle='#000'; g.lineWidth=5; g.strokeText(t,32,54); g.fillText(t,32,54); return new THREE.CanvasTexture(c); };
  const TEX_Q=markTex('？'),TEX_X=markTex('！');
  const alertTags=PATROLS.map(()=>{ const s=new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_Q,depthTest:false,transparent:true})); s.scale.set(1.1,1.1,1); s.renderOrder=9; s.visible=false; PROP.add(s); return s; });

  /* ---------- 進行（ホストだけが計算） ---------- */
  function newGame(players,set){
    G={set,talk0:false,talk1:false,srch:[0,0,0,0],clu:[0,0,0],lock:false,rope:0,notes:[],stage:0,t:TIME_LIMIT,ezu:false,gate:false,water:0,need:players.length>=2?4:3,fire:true,sw:[0,0],gHold:0,over:null,winT:0,allCapT:0,rescues:0,caught:0,t0:performance.now(),
      pl:players.map((p,i)=>({id:p.id,n:p.n,c:i,x:SPOT.spawn[i][0],y:9+1.6,z:SPOT.spawn[i][1],yaw:0,cr:false,run:false,use:false,room:false,cap:false,grace:3,carry:false,hk:null,hp:0,rel:false})),
      en:PATROLS.map(P0=>({p:P0.p,s:P0.s,i:1,x:P0.p[0][0],z:P0.p[0][1],yaw:0,pause:0,al:{},look:0}))};
  }
  const nPl=()=>G.pl.length;
  const inY=(p,y)=>Math.abs(p.y-1.6-y)<3;
  function targetFor(st,p){
    if(p.cap) return null;
    for(const q of st.pl) if(q!==p&&q.cap&&dist(p.x,p.z,q.x,q.z)<2.6) return {k:'res:'+q.id,l:q.n+'の縄を解く',d:1.8};
    if(st.stage===0){
      if(dist(p.x,p.z,...W.npc0)<3&&inY(p,groundH(...W.npc0))) return {k:'talk0',l:'侍女に話を聞く',d:.15};
      for(let i=0;i<W.hide.length;i++){ const h=W.hide[i]; if(!st.srch[i]&&dist(p.x,p.z,h[0],h[1])<2&&inY(p,h[2])) return {k:'srch'+i,l:HIDES[i].n+'を調べる',d:.7}; } }
    if(st.stage===1){
      if(dist(p.x,p.z,...W.npc1)<3) return {k:'talk1',l:'傷ついた兵に話を聞く',d:.15};
      for(let j=0;j<W.clue.length;j++){ const c=W.clue[j]; if(!st.clu[j]&&dist(p.x,p.z,c[0],c[1])<3.2) return {k:'clue'+j,l:ORD[j]+'の幟を調べる',d:.3}; }
      if(!st.lock&&dist(p.x,p.z,...W.lock)<3) return {k:'lock',l:'錠前を開ける',d:.05};
      if(st.lock){ if(dist(p.x,p.z,...SPOT.swW)<2.6) return {k:'swW',l:'西の閂を押さえる',d:0}; if(dist(p.x,p.z,...SPOT.swE)<2.6) return {k:'swE',l:'東の閂を押さえる',d:0}; } }
    if(st.stage===2){
      if(W.rope&&st.rope<2&&dist(p.x,p.z,W.rope[0],W.rope[1])<1.9&&inY(p,W.rope[2])) return {k:'rope',l:'茶道具の棚を調べる',d:.6};
      if(!p.carry&&dist(p.x,p.z,...SPOT.well)<3) return st.rope<2?{k:'well',l:'井戸を調べる',d:.2}:{k:'fill',l:'水をくむ',d:.9};
      if(p.carry&&dist(p.x,p.z,...SPOT.fire)<6.5) return {k:'pour',l:'火に水をかける',d:.6}; }
    return null;
  }
  function event(m,to){ if(net.mode==='host') broadcast({t:'ev',m}); onEvent(m); }
  function setStage(s,m){ G.stage=s; for(const p of G.pl){ p.hk=null; p.hp=0; } event(m); }
  function note(m){ G.notes.push(m); if(G.notes.length>14) G.notes.shift(); }
  function complete(p,k){
    if(k==='talk0'){ const r=HIDES[G.set.hide].r; if(!G.talk0) note('侍女「絵図は奥御殿に。'+r+'」'); G.talk0=true; event('侍女「抜け道の絵図は、奥御殿に隠してございます。'+r+'……」'); }
    else if(k.startsWith('srch')){ const i=+k.slice(4); G.srch[i]=1;
      if(i===G.set.hide){ G.ezu=true; note('絵図：山里丸から極楽橋を渡り、二の丸を抜けて大川へ'); setStage(1,p.n+'が'+HIDES[i].n+'から抜け道の絵図を見つけた！ だが山里丸への門には錠前が……'); }
      else { G.t-=10; event(HIDES[i].n+'を調べたが、何もなかった……（−10秒）'); } }
    else if(k==='talk1'){ const m='兵「山里丸の門の錠前は、家紋を三つ合わせねば開かぬ。本丸のどこかに壱・弐・参と記した幟が立っておる……その順に合わせよ」'+(nPl()>=2?'「錠が外れても、閂は西と東に二つ。同時に押さえねば動かぬ」':''); if(!G.talk1) note(m); G.talk1=true; event(m); }
    else if(k.startsWith('clue')){ const j=+k.slice(4); if(!G.clu[j]){ G.clu[j]=1; const mn=MON[G.set.code[j]][0]; note(ORD[j]+'の幟の家紋は「'+mn+'」'); event(p.n+'が'+ORD[j]+'の幟を見つけた。家紋は「'+mn+'」'); } }
    else if(k==='lock'){ sendTo(p.id,{t:'lockui'}); }
    else if(k==='well'){ if(G.rope<1){ G.rope=1; note('井戸の釣瓶の縄が切れている。山里丸の茶室に替えがあるかもしれない'); } event('釣瓶の縄が切れている……。山里丸の茶室に替えの縄はないか？'); }
    else if(k==='rope'){ G.rope=2; note('茶室で替えの縄を見つけ、井戸に付けた'); event(p.n+'が茶室で替えの縄を見つけた！ これで井戸の水がくめる'); }
    else if(k==='fill'){ p.carry=true; }
    else if(k==='pour'){ p.carry=false; G.water++; if(G.water>=G.need){ G.fire=false; setStage(3,'極楽橋の火が消えた！ 二の丸を抜けて大川の舟をめざせ'); } else event('火が弱まった（あと'+(G.need-G.water)+'杯）'); }
    else if(k.startsWith('res:')){ const q=G.pl.find(x=>'res:'+x.id===k); if(q&&q.cap){ q.cap=false; q.grace=4; G.rescues++; event(p.n+'が'+q.n+'の縄を解いた！'); } }
  }
  function onCode(v){ if(!G||G.lock||G.stage!==1) return; const ok=Array.isArray(v)&&v.length===3&&v.every((x,i)=>x===G.set.code[i]);
    if(ok){ G.lock=true; event('カチリ――錠前が外れた！ '+(nPl()>=2?'西と東の閂を同時に押さえろ':'閂を押さえて門を開けろ')); }
    else { G.t-=15; event('錠前はびくともしない……家紋の組み合わせが違うようだ（−15秒）'); } }
  function seen(e,p){
    if(p.cap||p.grace>0||p.room) return 0;
    const d=dist(e.x,e.z,p.x,p.z),rng=p.cr?6.5:(p.run?17:SIGHT); if(d>rng) return 0;
    if(Math.abs(p.y-1.6-groundH(e.x,e.z))>4.2) return 0;    /* 段差の上下は見えにくい */
    const fx=-Math.sin(e.yaw),fz=-Math.cos(e.yaw),dot=(fx*(p.x-e.x)+fz*(p.z-e.z))/Math.max(.01,d);
    if(d>2&&dot<Math.cos(SIGHT_HALF)) return 0;
    for(let s=1.2;s<d-.6;s+=1.2){ const x=e.x+(p.x-e.x)*s/d,z=e.z+(p.z-e.z)*s/d; if(hitBlock(x,z,0)) return 0; }
    return d<4?1.5:.6;    /* 満タン（捕縛）まで：遠くで約1.7秒、近くで約0.7秒 */
  }
  function hostStep(dt){
    if(!G||G.over) return;
    G.t-=dt; if(G.t<=0){ G.t=0; return finish(false,'天守も御殿も焼け落ちた……。脱出はかなわなかった'); }
    /* ホスト自身の位置 */
    const h=G.pl.find(p=>p.id===0); if(h) readMe(h);
    for(const p of G.pl){ p.grace=Math.max(0,p.grace-dt); }
    /* 調べる（長押し） */
    G.sw=[0,0];
    for(const p of G.pl){ const tg=targetFor(G,p);
      if(!p.use) p.rel=false;
      if(!tg||!p.use||p.rel){ p.hk=tg?tg.k:null; p.hp=0; continue; }
      if(tg.k==='swW'||tg.k==='swE'){ G.sw[tg.k==='swW'?0:1]=1; p.hk=tg.k; continue; }
      if(p.hk!==tg.k){ p.hk=tg.k; p.hp=0; }
      p.hp+=dt/tg.d; if(p.hp>=1){ p.hp=0; p.rel=true; complete(p,tg.k); } }
    if(G.stage===1&&G.lock){ const need=Math.min(2,nPl()),held=G.sw[0]+G.sw[1];
      if(held>=need){ G.gHold+=dt; if(G.gHold>=1.2){ G.gate=true; setStage(2,'閂が外れた！ 山里丸へ。極楽橋が燃えている――井戸の水で消せ'); } } else G.gHold=Math.max(0,G.gHold-dt*2); }
    /* 追手 */
    for(const e of G.en){
      let maxA=0,tgt=null; for(const p of G.pl){ const s=seen(e,p),a=e.al[p.id]||0,na=s>0?Math.min(1.2,a+dt*s):Math.max(0,a-dt*.7); e.al[p.id]=na; if(na>maxA){ maxA=na; tgt=p; } if(na>=1&&!p.cap){ p.cap=true; p.carry=false; e.al[p.id]=0; e.pause=3; G.caught++; event(p.n+'が徳川方の追手に見つかり、捕まった！ 近づいて「縄を解く」で助けよう'); } }
      e.look=maxA;
      if(tgt&&maxA>.25){ e.yaw=Math.atan2(-(tgt.x-e.x),-(tgt.z-e.z)); if(maxA>.5&&dist(e.x,e.z,tgt.x,tgt.z)>1.6){ const d=dist(e.x,e.z,tgt.x,tgt.z); e.x+=(tgt.x-e.x)/d*dt*1.1; e.z+=(tgt.z-e.z)/d*dt*1.1; } continue; }
      if(e.pause>0){ e.pause-=dt; e.yaw+=Math.sin(performance.now()/700+e.x)*dt*.8; continue; }
      const w=e.p[e.i],d=dist(e.x,e.z,w[0],w[1]);
      if(d<.4){ e.i=(e.i+1)%e.p.length; e.pause=1.6; continue; }
      e.yaw=Math.atan2(-(w[0]-e.x),-(w[1]-e.z)); const st=Math.min(d,e.s*dt); e.x+=(w[0]-e.x)/d*st; e.z+=(w[1]-e.z)/d*st; }
    /* 全員捕まった → 少し前の場所からやり直し */
    if(G.pl.every(p=>p.cap)){ G.allCapT+=dt; if(G.allCapT>2.6){ G.allCapT=0; G.t-=45; resetToCheck('全員捕まってしまった……（−45秒）。少し前からやり直し'); } } else G.allCapT=0;
    /* 舟 */
    if(G.stage===3){ const all=G.pl.every(p=>!p.cap&&dist(p.x,p.z,...SPOT.boat)<7); if(all){ G.winT+=dt; if(G.winT>2) return finish(true,'全員が小舟に乗り込み、燃える大坂城をあとにした――'); } else G.winT=0; }
  }
  function resetToCheck(m){ const C=CHECK[G.stage]; G.pl.forEach((p,i)=>{ p.cap=false; p.grace=5; p.carry=false; p.x=C[i][0]; p.z=C[i][1]; sendTo(p.id,{t:'tp',x:p.x,z:p.z}); }); for(const e of G.en){ e.al={}; } event(m); }
  function finish(win,msg){ const used=TIME_LIMIT-G.t; G.over={win,msg,used,res:G.rescues,cau:G.caught}; broadcast({t:'end',...G.over}); onEnd(G.over); }

  /* 状態を配る形 */
  function snap(){ return {t:'g',talk0:G.talk0,talk1:G.talk1,srch:G.srch,clu:G.clu,lock:G.lock,rope:G.rope,notes:G.notes,st:G.stage,tm:Math.round(G.t*10)/10,need:G.need,w:G.water,fire:G.fire,gate:G.gate,ezu:G.ezu,sw:G.sw,gh:G.gHold,win:G.winT,
    pl:G.pl.map(p=>({id:p.id,n:p.n,c:p.c,x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2),yaw:+p.yaw.toFixed(2),cr:p.cr,cap:p.cap,carry:p.carry,hk:p.hk,hp:+p.hp.toFixed(2),room:p.room})),
    en:G.en.map(e=>[+e.x.toFixed(2),+e.z.toFixed(2),+e.yaw.toFixed(2),+e.look.toFixed(2)])}; }

  /* ---------- 自分 ---------- */
  function readMe(p){ p.x=P.x; p.y=P.y; p.z=P.z; p.yaw=P.yaw; p.cr=me.cr; p.use=useNow(); p.room=!!P.room||P.level>=0; p.run=me.run; }
  let lastX=0,lastZ=0;
  function myState(){ return {t:'s',x:+P.x.toFixed(2),y:+P.y.toFixed(2),z:+P.z.toFixed(2),yaw:+P.yaw.toFixed(2),cr:me.cr,use:useNow(),run:me.run,room:!!P.room||P.level>=0}; }

  /* ---------- 通信 ---------- */
  function peerOpts(){ const s=qs.get('peer'); if(!s) return {debug:1}; const [host,port]=s.split(':'); return {host,port:+port||9000,path:'/',secure:false,debug:1}; }
  function loadPeer(){ return new Promise((res,rej)=>{ if(window.Peer) return res(); const sc=document.createElement('script'); sc.src='https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js'; sc.onload=()=>res(); sc.onerror=()=>rej(new Error('通信ライブラリを読み込めませんでした')); document.head.appendChild(sc); }); }
  function sendTo(id,m){ if(id===0){ if(net.mode==='host') onMsg(m); return; } const c=net.conns.get(id); if(c&&c.open) c.send(m); }
  function broadcast(m){ for(const c of net.conns.values()) if(c.open) c.send(m); }
  async function host(){
    net.mode='host'; net.myId=0; lobby=[{id:0,n:me.name}];
    if(net.solo){ return showLobby(); }
    lobbyStatus('部屋をつくっています…');
    try{ await loadPeer(); }catch(e){ return lobbyErr(e.message); }
    const tryOpen=n=>{ net.code=String(1000+Math.floor(Math.random()*9000)); const pr=new Peer(PEER_PREFIX+net.code,peerOpts());
      pr.on('open',()=>{ net.peer=pr; showLobby(); });
      pr.on('error',e=>{ if(e.type==='unavailable-id'&&n<5){ pr.destroy(); tryOpen(n+1); } else lobbyErr('通信エラー：'+(e.type||e.message)); });
      pr.on('connection',c=>{ let id=0;
        c.on('data',m=>{ if(m.t==='hello'){ if(me.inGame||lobby.length>=MAXP){ c.send({t:'full',m:me.inGame?'もう出陣しています':'満員です（4人まで）'}); setTimeout(()=>c.close(),400); return; }
            id=Math.max(0,...lobby.map(p=>p.id))+1; net.conns.set(id,c); lobby.push({id,n:String(m.n||'名無し').slice(0,10)}); c.send({t:'welcome',id,code:net.code}); syncLobby(); return; }
          if(m.t==='code'&&G){ onCode(m.v); return; }
          if(m.t==='s'&&G){ const p=G.pl.find(q=>q.id===id); if(p&&!p.cap){ Object.assign(p,{x:m.x,y:m.y,z:m.z,yaw:m.yaw,cr:!!m.cr,use:!!m.use,run:!!m.run,room:!!m.room}); } else if(p){ p.use=!!m.use; } } });
        c.on('close',()=>{ if(!id) return; net.conns.delete(id); const p=lobby.find(q=>q.id===id); lobby=lobby.filter(q=>q.id!==id); if(G){ G.pl=G.pl.filter(q=>q.id!==id); if(p) event(p.n+'が抜けました'); } syncLobby(); }); }); };
    tryOpen(0);
  }
  async function join(code){
    net.mode='client'; lobbyStatus('部屋をさがしています…');
    try{ await loadPeer(); }catch(e){ return lobbyErr(e.message); }
    const pr=new Peer(peerOpts()); net.peer=pr;
    pr.on('error',e=>lobbyErr(e.type==='peer-unavailable'?'部屋が見つかりません（番号を確認してください）':'通信エラー：'+(e.type||e.message)));
    pr.on('open',()=>{ const c=pr.connect(PEER_PREFIX+code,{reliable:true,serialization:'json'}); net.host=c; net.code=code;
      const to=setTimeout(()=>{ if(!c.open) lobbyErr('つながりませんでした。回線（モバイル回線どうし等）によっては接続できないことがあります'); },15000);
      c.on('open',()=>{ clearTimeout(to); c.send({t:'hello',n:me.name}); });
      c.on('data',onMsg);
      c.on('close',()=>{ if(!G||!G.over) lobbyErr('部屋との接続が切れました'); }); });
  }
  function onMsg(m){
    if(m.t==='welcome'){ net.myId=m.id; showLobby(); }
    else if(m.t==='full'){ lobbyErr(m.m); }
    else if(m.t==='lobby'){ lobby=m.l; showLobby(); }
    else if(m.t==='start'){ startWorld(m.i,m.set); }
    else if(m.t==='lockui'){ openLock(); }
    else if(m.t==='g'){ V=m; }
    else if(m.t==='ev'){ onEvent(m.m); }
    else if(m.t==='tp'){ P.room=null; P.level=-1; P.x=m.x; P.z=m.z; P.y=groundH(m.x,m.z)+1.6; me.lastTp=performance.now(); }
    else if(m.t==='end'){ onEnd(m); }
  }
  function syncLobby(){ broadcast({t:'lobby',l:lobby}); showLobby(); }

  /* ---------- 画面 ---------- */
  function ui(){
    const css=document.createElement('style'); css.textContent=`
.topbtns,#poi,#pjChip,#scen,#ticker,#card,#spots,#eraSheet,#start,#tourEnd,#levelBtn{display:none!important}
#mini{pointer-events:none} #mini .tap{display:none}
#escL{position:fixed;inset:0;z-index:40;display:flex;touch-action:pan-y;-webkit-overflow-scrolling:touch;background:radial-gradient(120% 90% at 50% 100%,rgba(120,30,10,.55),rgba(10,10,12,.92) 60%);padding:20px;overflow:auto}
#escL .box{width:min(420px,100%);text-align:center;margin:auto;padding:calc(env(safe-area-inset-top,0px) + 8px) 0 calc(env(safe-area-inset-bottom,0px) + 8px)}
#escL *{touch-action:manipulation}
@media (max-height:520px){#escL h1{font-size:26px}#escL .lead{display:none}#escL .how{display:none}#escL .code{font-size:34px}#escL button.b{height:44px;margin-bottom:8px}#escL input{height:42px}#escL .pls{grid-template-columns:1fr 1fr}}
#escL h1{font-family:var(--f-disp);font-weight:800;font-size:34px;letter-spacing:.12em;margin:0;line-height:1.25}
#escL h1 small{display:block;font-size:14px;letter-spacing:.3em;color:#e8b13a;margin-bottom:6px}
#escL .lead{color:var(--mute);font-size:13px;line-height:1.75;margin:14px 0 18px;text-align:left}
#escL input{-webkit-user-select:text;user-select:text;width:100%;box-sizing:border-box;height:46px;border-radius:12px;border:1px solid var(--line);background:#1d1e22;color:#fff;font:inherit;font-size:16px;padding:0 14px;margin-bottom:10px}
#escL button.b{width:100%;height:50px;border-radius:12px;border:0;font:inherit;font-weight:700;font-size:16px;margin-bottom:10px;cursor:pointer;background:#2a2b30;color:#fff}
#escL button.p{background:var(--shu)}
#escL button:disabled{opacity:.45}
#escL .row{display:flex;gap:8px} #escL .row>*{flex:1}
#escL .code{font-family:var(--f-disp);font-size:46px;letter-spacing:.3em;margin:4px 0 2px;color:#ffd36a}
#escL .pls{display:grid;gap:6px;margin:14px 0}
#escL .pl{display:flex;align-items:center;gap:10px;background:#1d1e22;border-radius:10px;padding:10px 12px;font-weight:700}
#escL .pl i{width:12px;height:12px;border-radius:3px}
#escL .st{min-height:20px;font-size:13px;color:var(--mute);margin:8px 0}
#escL .er{color:#ff8f7e}
#escL .how{text-align:left;font-size:12.5px;color:var(--mute);line-height:1.7;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px;margin-top:6px}
.place{display:none!important}
#escHud{position:fixed;left:calc(env(safe-area-inset-left,0px) + 14px);right:calc(env(safe-area-inset-right,0px) + 134px);top:calc(env(safe-area-inset-top,0px) + 10px);z-index:7;pointer-events:none}
#escHud .tm{font-family:var(--f-disp);font-weight:800;font-size:26px;letter-spacing:.06em;text-shadow:0 1px 8px #000}
#escHud .tm.low{color:#ff6b55}
#escHud .stg{font-size:11px;letter-spacing:.2em;color:#e8b13a;text-shadow:0 1px 6px #000}
#escHud .obj{font-size:13px;font-weight:700;margin-top:2px;text-shadow:0 1px 6px #000,0 0 2px #000;line-height:1.4}
#escArrow{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 12px);z-index:7;pointer-events:none;display:flex;align-items:center;gap:6px;background:rgba(17,18,20,.55);border-radius:999px;padding:3px 12px 3px 6px}
#escArrow svg{width:30px;height:30px;filter:drop-shadow(0 1px 4px #000)}
#escArrow span{font-size:12px;white-space:nowrap;font-weight:700;text-shadow:0 1px 4px #000}
#escUse,#escCr{position:fixed;z-index:8;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:#fff;font:inherit;font-weight:700;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);touch-action:none}
#escUse{right:calc(env(safe-area-inset-right,0px) + 18px);bottom:calc(env(safe-area-inset-bottom,0px) + 200px);width:96px;height:96px;font-size:14px;line-height:1.25;padding:6px;overflow:hidden}
#escUse.on{background:rgba(232,177,58,.92);color:#111;border-color:#ffd36a;animation:escP 1.2s infinite}
#escUse.hold{background:#9effa8;border-color:#9effa8}
#escUse .pg{position:absolute;left:0;bottom:0;height:6px;background:#fff;width:0}
@keyframes escP{50%{box-shadow:0 0 0 8px rgba(232,177,58,.25)}}
#escCr{padding:0;right:calc(env(safe-area-inset-right,0px) + 124px);bottom:calc(env(safe-area-inset-bottom,0px) + 214px);width:68px;height:68px;font-size:12.5px}
#escCr[aria-pressed=true]{background:#3fa7d6;color:#111}
@media (max-height:500px){#escUse{width:78px;height:78px;font-size:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 132px)}#escCr{width:56px;height:56px;font-size:11px;right:calc(env(safe-area-inset-right,0px) + 104px);bottom:calc(env(safe-area-inset-bottom,0px) + 140px)}#escHud .obj{font-size:12px}#escLog{top:calc(env(safe-area-inset-top,0px) + 118px)}#escPl{top:calc(env(safe-area-inset-top,0px) + 90px)}}
#escVig{position:fixed;inset:0;z-index:5;pointer-events:none;box-shadow:inset 0 0 0 0 rgba(255,40,20,0);transition:box-shadow .15s}
#escWarn{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 58px);z-index:8;pointer-events:none;background:rgba(150,20,10,.88);color:#fff;font-weight:800;font-size:14px;padding:7px 14px;border-radius:10px;white-space:nowrap;animation:escP 1s infinite}
#escIntro{position:fixed;inset:0;z-index:43;display:flex;overflow:auto;background:rgba(8,8,10,.8);padding:16px;touch-action:pan-y}
#escIntro .box{margin:auto;width:min(460px,100%);background:#17181b;border:1px solid var(--line);border-radius:16px;padding:18px 18px 14px}
#escIntro h3{font-family:var(--f-disp);margin:0 0 10px;font-size:20px;letter-spacing:.1em}
#escIntro .row{display:flex;gap:12px;align-items:center;margin:0 0 12px;font-size:14px;line-height:1.6}
#escIntro svg{flex:0 0 64px}
#escIntro button{width:100%;height:48px;border-radius:12px;border:0;font:inherit;font-weight:700;font-size:16px;margin-top:4px;background:var(--shu);color:#fff}
#escCap{position:fixed;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;pointer-events:none;background:rgba(60,0,0,.45);font-family:var(--f-disp);font-weight:800;font-size:24px;text-align:center;line-height:1.6;text-shadow:0 2px 10px #000}
#escLog{position:fixed;left:calc(env(safe-area-inset-left,0px) + 12px);top:calc(env(safe-area-inset-top,0px) + 130px);z-index:7;pointer-events:none;display:grid;gap:4px;max-width:min(300px,45vw)}
#escLog div{font-size:12px;background:rgba(17,18,20,.72);border-left:3px solid #e8b13a;padding:5px 8px;border-radius:4px;line-height:1.45;transition:opacity .6s}
#escPl{position:fixed;left:calc(env(safe-area-inset-left,0px) + 12px);top:calc(env(safe-area-inset-top,0px) + 100px);z-index:7;pointer-events:none;display:flex;gap:6px;flex-wrap:wrap;max-width:60vw}
#escPl div{font-size:11px;font-weight:700;background:rgba(17,18,20,.72);padding:4px 8px;border-radius:999px;display:flex;gap:5px;align-items:center}
#escPl i{width:9px;height:9px;border-radius:2px}
#escNB{position:fixed;z-index:8;right:calc(env(safe-area-inset-right,0px) + 12px);top:calc(env(safe-area-inset-top,0px) + 126px);height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:#ffd36a;font:inherit;font-size:12px;font-weight:700}
#escNotes,#escLock{position:fixed;inset:0;z-index:42;display:flex;overflow:auto;background:rgba(8,8,10,.78);padding:16px;touch-action:pan-y}
#escNotes .box,#escLock .box{margin:auto;width:min(440px,100%);background:#17181b;border:1px solid var(--line);border-radius:16px;padding:16px 16px 12px}
#escNotes h3,#escLock h3{font-family:var(--f-disp);margin:0 0 8px;font-size:20px;letter-spacing:.1em}
#escNotes ol{margin:0 0 12px;padding-left:20px;line-height:1.7;font-size:14px}
#escNotes li{margin-bottom:6px}
#escNotes .none,#escLock .sub{color:var(--mute);font-size:13px;margin:0 0 10px}
#escNotes button,#escLock button.b{width:100%;height:46px;border-radius:12px;border:0;font:inherit;font-weight:700;font-size:15px;margin-top:6px;background:#2a2b30;color:#fff}
#escLock button.p{background:var(--shu)}
#escLock .dials{display:flex;gap:10px;justify-content:center;margin:6px 0 12px}
#escLock .dial{flex:1;text-align:center}
#escLock .dial span{display:block;font-family:var(--f-disp);font-size:16px;color:#ffd36a;margin-bottom:6px}
#escLock .dial button{width:100%;height:76px;border-radius:14px;border:2px solid #c99a35;background:#0d0d10;color:#fff;font-family:var(--f-disp);font-size:24px;font-weight:800}
#escLock .dial small{display:block;font-size:10px;color:var(--mute);margin-top:4px}
#escLock .clues{font-size:13px;color:var(--mute);margin:0 0 6px;text-align:center}
#escEnd{position:fixed;inset:0;z-index:41;display:flex;overflow:auto;touch-action:pan-y;background:rgba(8,8,10,.82);padding:20px}
#escEnd .box{width:min(400px,100%);text-align:center;margin:auto}
@media (max-height:520px){#escEnd h2{font-size:26px;margin-bottom:4px}#escEnd dl{margin:6px 0 10px}#escEnd button{height:42px;margin-bottom:6px}}
#escEnd h2{font-family:var(--f-disp);font-size:34px;letter-spacing:.14em;margin:0 0 10px}
#escEnd p{color:var(--mute);line-height:1.8;font-size:14px}
#escEnd dl{display:grid;grid-template-columns:auto auto;gap:4px 16px;justify-content:center;margin:14px 0 20px;font-size:14px}
#escEnd dt{color:var(--mute)} #escEnd dd{margin:0;font-weight:700;text-align:left}
#escEnd button{width:100%;height:50px;border-radius:12px;border:0;font:inherit;font-weight:700;font-size:16px;margin-bottom:10px;background:#2a2b30;color:#fff}
#escEnd button.p{background:var(--shu)}
`; document.head.appendChild(css);
    const L=document.createElement('section'); L.id='escL'; document.body.appendChild(L);
    const hud=document.createElement('div'); hud.innerHTML=`<div id="escHud" hidden><div class="stg" id="escStg"></div><div class="tm" id="escTm"></div><div class="obj" id="escObj"></div></div>
<div id="escArrow" hidden><svg viewBox="0 0 34 34"><path d="M17 3 L29 29 L17 22 L5 29 Z" fill="#ffd36a" stroke="#111" stroke-width="1.5"/></svg><span id="escDist"></span></div>
<button id="escUse" hidden><span id="escUseL">調べる</span><span class="pg" id="escPg"></span></button><button id="escCr" hidden aria-pressed="false">しゃがむ</button>
<button id="escNB" hidden>手控え 0</button><section id="escNotes" hidden></section><section id="escLock" hidden></section><div id="escVig"></div><div id="escWarn" hidden></div><section id="escIntro" hidden></section><div id="escCap" hidden></div><div id="escLog"></div><div id="escPl"></div><section id="escEnd" hidden></section>`; document.body.append(...hud.children);
    const U=el('escUse'); const down=e=>{ e.preventDefault(); e.stopPropagation(); me.use=true; latch(); }, up=e=>{ e.preventDefault(); e.stopPropagation(); me.use=false; };
    U.addEventListener('pointerdown',down); U.addEventListener('pointerup',up); U.addEventListener('pointercancel',up); U.addEventListener('pointerleave',up);
    el('escNB').addEventListener('click',e=>{ e.stopPropagation(); openNotes(); });
    el('escCr').addEventListener('pointerdown',e=>{ e.preventDefault(); e.stopPropagation(); me.cr=!me.cr; el('escCr').setAttribute('aria-pressed',me.cr); });
    addEventListener('keydown',e=>{ if(e.target&&e.target.tagName==='INPUT') return; if((e.code==='KeyE'||e.code==='Space')&&!e.repeat){ me.use=true; latch(); } if(e.code==='KeyC'&&!e.repeat){ me.cr=!me.cr; el('escCr').setAttribute('aria-pressed',me.cr); } });
    addEventListener('keyup',e=>{ if(e.code==='KeyE'||e.code==='Space') me.use=false; });
    titleScreen();
    addEventListener('error',e=>{ const s=el('escSt'); if(s&&!me.inGame){ s.className='st er'; s.textContent='エラー：'+(e.message||e.error); } });
  }
  /* 調べるボタンは軽く押すだけでもよい（終わるまで押さえ続けた扱い。動くか対象が変わると離す） */
  let tgKey=null;
  function latch(){ if(!tgKey) return; me.latch=true; me.latchKey=tgKey; me.latchX=P.x; me.latchZ=P.z; me.latchT=performance.now(); }
  function useNow(){ return me.use||!!me.latch; }
  function titleScreen(){ const L=el('escL'); L.hidden=false; let nm=''; try{ nm=localStorage.getItem('escName')||''; }catch(e){}
    L.innerHTML=`<div class="box"><h1><small>大坂夏の陣 ・ 落城の夜</small>大坂城脱出</h1>
<p class="lead">慶長二十年五月七日、夜。徳川方がなだれ込み、天守は炎に包まれた。<br>城に残されたあなたたちは、焼け落ちる前に大川の小舟までたどり着けるか――。最大4人で力を合わせる脱出ゲームです。</p>
<input id="escName" maxlength="10" placeholder="名前（例：才蔵）" value="${esc(nm)}" autocomplete="off">
<button class="b p" id="escSolo" disabled>読み込み中…</button>
<div class="row"><button class="b" id="escHost" disabled>部屋をつくる</button><button class="b" id="escJoinB" disabled>部屋に入る</button></div>
<div id="escJoinF" hidden><input id="escCode" inputmode="numeric" maxlength="4" placeholder="部屋番号（4桁）"><button class="b p" id="escJoin">入る</button></div>
<div class="st" id="escSt"></div>
<div class="how"><b>操作</b>　左のパッドで移動、右側で見回し。<b>調べる</b>は長押し、<b>しゃがむ</b>で追手に見つかりにくくなります（PCは WASD・E・C・Shiftで走る）。<br><b>追手</b>に見つかると「！」がたまり、満タンで捕まります。仲間は近づいて縄を解けます。</div></div>`;
    const name=()=>{ const v=(el('escName').value||'').trim()||'名無し'; me.name=v.slice(0,10); try{ localStorage.setItem('escName',me.name); }catch(e){} };
    el('escSolo').onclick=()=>{ name(); net.solo=true; host(); };
    el('escHost').onclick=()=>{ name(); net.solo=false; host(); };
    el('escJoinB').onclick=()=>{ el('escJoinF').hidden=false; el('escCode').focus(); };
    el('escJoin').onclick=()=>{ const c=(el('escCode').value||'').replace(/\D/g,''); if(c.length!==4) return lobbyErr('4桁の部屋番号を入れてください'); name(); join(c); };
    const pc=qs.get('room'); if(pc){ el('escJoinF').hidden=false; el('escCode').value=pc; }
    waitReady(); }
  function waitReady(){ if(!ready){ setTimeout(waitReady,200); return; } const s=el('escSolo'); if(!s) return; s.disabled=false; s.textContent='ひとりで遊ぶ'; el('escHost').disabled=false; el('escJoinB').disabled=false; }
  function lobbyStatus(t){ const s=el('escSt'); if(s){ s.className='st'; s.textContent=t; } }
  function lobbyErr(t){ const s=el('escSt'); if(s){ s.className='st er'; s.textContent=t; } if(!el('escSt')) onEvent(t); }
  function showLobby(){ if(me.inGame) return; const L=el('escL'); L.hidden=false; const isHost=net.mode==='host';
    const url=location.origin+location.pathname+'?room='+net.code+(qs.get('peer')?'&peer='+qs.get('peer'):'');
    L.innerHTML=`<div class="box"><h1 style="font-size:24px"><small>${net.solo?'ひとりで':'部屋番号'}</small></h1>${net.solo?'':`<div class="code">${net.code}</div><div class="st">この番号を仲間に伝えてください（最大4人）</div>${isHost&&navigator.share?'<button class="b" id="escShare">招待リンクを送る</button>':''}`}
<div class="pls">${lobby.map((p,i)=>`<div class="pl"><i style="background:${COLS[i%4]}"></i>${esc(p.n)}${p.id===0?'（主）':''}${p.id===net.myId?' ← あなた':''}</div>`).join('')}</div>
${isHost?`<button class="b p" id="escGo">出陣する（${lobby.length}人）</button>`:'<div class="st">主が出陣するのを待っています…</div>'}
<button class="b" id="escBack">もどる</button><div class="st" id="escSt"></div></div>`;
    if(el('escShare')) el('escShare').onclick=()=>navigator.share({title:'大坂城脱出',text:'部屋番号 '+net.code+' で一緒に脱出しよう',url}).catch(()=>{});
    if(el('escGo')) el('escGo').onclick=()=>hostStart();
    el('escBack').onclick=()=>location.reload(); }
  function randSetup(){ const a=[...CLUE_CAND.keys()]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    return {code:[0,1,2].map(()=>Math.floor(Math.random()*MON.length)),clue:a.slice(0,3),hide:Math.floor(Math.random()*HIDES.length)}; }
  function hostStart(){ const set=randSetup(); newGame(lobby,set); G.pl.forEach((p,i)=>{ if(p.id) sendTo(p.id,{t:'start',i,set}); }); startWorld(0,set); }

  /* ---------- 手控え（集めた手がかり）と錠前 ---------- */
  const notesSeen={n:0};
  function renderNotes(){ const N=(V&&V.notes)||[]; el('escNotes').innerHTML=`<div class="box"><h3>手控え</h3>${N.length?`<ol>${N.map(t=>`<li>${esc(t)}</li>`).join('')}</ol>`:'<p class="none">まだ手がかりはない。人に話を聞いたり、あやしい所を調べたりしよう。</p>'}<button id="escNX">閉じる</button></div>`; el('escNX').onclick=closeNotes; }
  function openNotes(){ resetPad(); renderNotes(); el('escNotes').hidden=false; }
  function closeNotes(){ const n=el('escNotes'); if(n) n.hidden=true; }
  let lockVal=[0,0,0];
  function openLock(){ if(!curSet||!V) return; const L=el('escLock'); L.hidden=false; resetPad(); me.latch=false;
    const draw=()=>{ const clu=V.clu||[0,0,0]; L.innerHTML=`<div class="box"><h3>山里丸の門の錠前</h3><p class="sub">家紋の輪を回して、三つ合わせよ。</p>
<p class="clues">わかっている家紋：${ORD.map((o,j)=>o+'＝'+(clu[j]?MON[curSet.code[j]][0]:'？')).join('　')}</p>
<div class="dials">${ORD.map((o,i)=>`<div class="dial"><span>${o}</span><button data-i="${i}">${MON[lockVal[i]][0]}</button><small>押すと変わる</small></div>`).join('')}</div>
<button class="b p" id="escLockGo">合わせる</button><button class="b" id="escLockX">やめる</button></div>`;
      L.querySelectorAll('.dial button').forEach(b=>b.onclick=()=>{ const i=+b.dataset.i; lockVal[i]=(lockVal[i]+1)%MON.length; draw(); });
      el('escLockGo').onclick=()=>{ const v=lockVal.slice(); if(net.mode==='host') onCode(v); else if(net.host&&net.host.open) net.host.send({t:'code',v}); closeLock(); };
      el('escLockX').onclick=closeLock; };
    draw(); }
  function closeLock(){ const L=el('escLock'); if(L) L.hidden=true; }

  function showIntro(){ const I=el('escIntro'); I.hidden=false;
    I.innerHTML=`<div class="box"><h3>追手に気をつけろ</h3>
<div class="row"><svg viewBox="0 0 64 64"><path d="M32 54 L8 14 A46 46 0 0 1 56 14 Z" fill="rgba(255,176,48,.35)" stroke="#ffb030" stroke-width="2"/><circle cx="32" cy="54" r="6" fill="#c33"/></svg><div><b>徳川方の追手</b>（赤い「追手」の札、提灯の明かり）が城内を見回っている。<b>地面のオレンジの扇形</b>が追手の視界だ。</div></div>
<div class="row"><svg viewBox="0 0 64 64"><text x="16" y="46" font-size="40" font-weight="bold" fill="#ffd36a" stroke="#000" stroke-width="2">？</text></svg><div>扇形に入ると頭上に「？」、さらに「！」が出て、扇形が赤くなる。そのままだと<b>捕まる</b>。すぐ扇形の外へ。</div></div>
<div class="row"><svg viewBox="0 0 64 64"><rect x="10" y="22" width="44" height="26" rx="13" fill="#3fa7d6"/><text x="32" y="40" font-size="12" text-anchor="middle" fill="#111" font-weight="bold">しゃがむ</text></svg><div><b>しゃがむ</b>と、扇形の奥のほうでは見つからない（近くは別）。<b>走る</b>と見つかりやすい。建物の中にいれば見つからない。</div></div>
<button id="escIntroGo">わかった</button></div>`; el('escIntroGo').onclick=()=>{ I.hidden=true; }; }

  /* ---------- 落城の夜の舞台に入る ---------- */
  function startWorld(i,set){
    me.inGame=true; V=null; clearOthers(); el('escL').hidden=true; el('escEnd').hidden=true; el('escLog').innerHTML='';
    chooseEra('natsu'); setPhase(3); { const keep=FXS.filter(f=>f.type==='blaze'||f.type==='column'); clearUnits(); for(const f of keep) FXS.push(f); }   /* 場面の兵は消し、炎だけ残す（追手と見分けやすく） */
    tourStop(); powerMode(); auto=false; $('scen').hidden=true; $('ticker').hidden=true; setFov(1);
    $('eyebrow').textContent='大坂城脱出 · 落城の夜';
    started=true; if(isTouch) document.body.classList.add('touchui'); syncPad();
    const s=SPOT.spawn[i||0]; P.room=null; P.level=-1; P.mode='walk'; P.x=s[0]; P.z=s[1]; P.y=groundH(P.x,P.z)+1.6; P.yaw=Math.PI*.98; P.pitch=-.05; lastArea='';
    curSet=set; buildStatic(); buildClues(set); closeLock(); closeNotes(); setFireFX(1); for(const k in gateMesh){ gateMesh[k].visible=true; gateMesh[k].position.y=gateMesh[k].userData.by; } fireLvl=1;
    for(const id of ['escHud','escArrow','escUse','escCr','escNB']) el(id).hidden=false; me.cr=false; el('escCr').setAttribute('aria-pressed','false');
    showIntro(); onEvent('天守が燃えている！ '+STAGES[0].o); showHint(net.solo?'ひとりで脱出だ。追手に見つからないように':'仲間と力を合わせて脱出だ');
  }

  /* 門・火の当たり判定（閉じている間は通れない） */
  const _walkable=walkable;
  walkable=function(x,z){ if(me.inGame){ const st=view(); if(st){ if(!st.gate&&(inR(GATES.W,x,z,.3)||inR(GATES.E,x,z,.3))) return false; if(st.fire&&inR(FIREBOX,x,z,.2)) return false; } } return _walkable(x,z); };
  function view(){ if(net.mode==='host'&&G) return {st:G.stage,gate:G.gate,fire:G.fire,ezu:G.ezu}; if(V) return {st:V.st,gate:V.gate,fire:V.fire,ezu:V.ezu}; return null; }

  /* ---------- 毎フレーム ---------- */
  let logN=0;
  function onEvent(m){ const lg=el('escLog'); if(!lg) return; const d=document.createElement('div'); d.textContent=m; lg.prepend(d); while(lg.children.length>3) lg.lastChild.remove(); const id=++logN; setTimeout(()=>{ d.style.opacity='0'; setTimeout(()=>d.remove(),700); },7000); }
  function update(dt){
    if(!me.inGame) return;
    /* 走っているか（移動速度で判定） */
    const sp=Math.hypot(P.x-lastX,P.z-lastZ)/Math.max(dt,1e-3); lastX=P.x; lastZ=P.z; me.run=sp>3.2;
    if(net.mode==='host'&&G&&!G.over){ hostStep(dt); net.sendT+=dt; if(net.sendT>=1/NET_HZ||!V){ net.sendT=0; V=snap(); broadcast(V); } }
    else if(net.mode==='client'){ net.sendT+=dt; if(net.sendT>=1/NET_HZ&&net.host&&net.host.open){ net.sendT=0; net.host.send(myState()); } }
    if(!V) return;
    const mine=V.pl.find(p=>p.id===net.myId);
    ESCF.lock=!el('escIntro').hidden||!!(mine&&mine.cap)||!!(G&&G.over)||!el('escEnd').hidden||!el('escLock').hidden;
    ESCF.cr=me.cr;
    /* 他の人 */
    const seenIds=new Set();
    for(const p of V.pl){ if(p.id===net.myId) continue; seenIds.add(p.id); const o=otherOf(p);
      const t=o.t||(o.t={x:p.x,y:p.y,z:p.z,yaw:p.yaw}); const k=Math.min(1,dt*10); t.x+=(p.x-t.x)*k; t.y+=(p.y-t.y)*k; t.z+=(p.z-t.z)*k; t.yaw=p.yaw;
      if(Math.hypot(p.x-t.x,p.z-t.z)>8){ t.x=p.x; t.z=p.z; t.y=p.y; }
      const gy=t.y-(p.cr?1:1.6); if(p.room&&!(P.room||P.level>=0)) hideFig(o.F); else placeFig(o.F,t.x,gy-(p.cap?.5:0),t.z,t.yaw);
      o.tag.position.set(t.x,gy+3.1,t.z); o.tag.visible=!(p.room&&!(P.room||P.level>=0)); o.tag.material.opacity=p.cap?.55:1;
      if(o.bk) crowd.move(o.bk,p.carry?t.x:0,p.carry?gy+1.9:-999,t.z); }
    for(const [id,o] of others) if(!seenIds.has(id)){ hideFig(o.F); PROP.remove(o.tag); if(o.bk) crowd.move(o.bk,0,-999,0); others.delete(id); }
    /* 追手 */
    V.en.forEach((e,i)=>{ const F=enemyFigs[i],y=groundH(e[0],e[1]),near=Math.hypot(e[0]-P.x,e[1]-P.z)<70&&!(P.room||P.level>=0); placeFig(F,e[0],y,e[1],e[2]);
      const fn=fans[i]; fn.visible=near; if(near){ fn.position.set(e[0],y+.12,e[1]); fn.rotation.y=e[2]; const hot=Math.min(1,e[3]*1.4),c=new THREE.Color(0xffb030).lerp(new THREE.Color(0xff2a10),hot); fn.userData.f.material.color.copy(c); fn.userData.e.material.color.copy(c); fn.userData.f.material.opacity=.24+hot*.24; }
      const lt=lanterns[i]; lt.visible=near; if(near) lt.position.set(e[0]-Math.sin(e[2])*.5,y+1.5,e[1]-Math.cos(e[2])*.5);
      const ft=foeTags[i]; ft.visible=near&&Math.hypot(e[0]-P.x,e[1]-P.z)<45; if(ft.visible) ft.position.set(e[0],y+3.1,e[1]);
      const a=alertTags[i]; a.visible=e[3]>.08; if(a.visible){ a.material.map=e[3]>.5?TEX_X:TEX_Q; a.position.set(e[0],y+4.1+Math.sin(performance.now()/90)*.06*e[3],e[1]); a.material.opacity=Math.min(1,.4+e[3]); a.scale.setScalar(.9+e[3]*.7); } });
    /* 自分への視線（画面の縁が赤くなる） */
    let danger=0; if(G&&net.mode==='host'){ for(const e of G.en) danger=Math.max(danger,e.al[net.myId]||0); } else { for(const e of V.en){ if(Math.hypot(e[0]-P.x,e[1]-P.z)<20) danger=Math.max(danger,e[3]*(Math.hypot(e[0]-P.x,e[1]-P.z)<14?1:.4)); } }
    { const w=el('escWarn'),mineCap=mine&&mine.cap; w.hidden=!(danger>.08)||mineCap; if(!w.hidden) w.textContent=danger>.5?'見つかる！ 追手の視界（扇形）から出ろ！':'追手に気づかれかけている……しゃがむか、離れろ'; }
    el('escVig').style.boxShadow=danger>.05?`inset 0 0 ${60+danger*90}px ${10+danger*40}px rgba(255,40,20,${Math.min(.75,danger*.8)})`:'none';
    /* 捕まった */
    const cap=el('escCap'); if(mine&&mine.cap){ cap.hidden=false; cap.innerHTML='徳川方の追手に捕まった！<br><span style="font-size:15px">'+(V.pl.length>1?'仲間が来て縄を解くのを待て':'まもなく少し前からやり直し（−45秒）')+'</span><br><span style="font-size:13px;font-weight:400">地面のオレンジの扇形が追手の視界。入らないように</span>'; P.pitch+=(-.5-P.pitch)*Math.min(1,dt*3); } else cap.hidden=true;
    /* 小道具 */
    const st=V.st,t=performance.now()/1000;
    const show=(m,on,x,z,y)=>{ m.visible=on; if(on) m.position.set(x,y!==undefined?y:groundH(x,z),z); };
    const inside=!!P.room||P.level>=0;
    B_EZU.visible=false; updateProps(st,t);
    const sw=st===1&&!!V.lock; show(B_W,sw,...SPOT.swW); show(B_E,sw,...SPOT.swE); show(R_W,sw,SPOT.swW[0],SPOT.swW[1],groundH(...SPOT.swW)+.05); show(R_E,sw,SPOT.swE[0],SPOT.swE[1],groundH(...SPOT.swE)+.05);
    R_W.material.color.set(V.sw[0]?0x9effa8:0xffd36a); R_E.material.color.set(V.sw[1]?0x9effa8:0xffd36a);
    show(B_WELL,st===2,...SPOT.well); show(B_FIRE,st===2&&V.fire,...SPOT.fire); show(B_BOAT,st===3,...SPOT.boat); show(R_BOAT,st===3,SPOT.boat[0],SPOT.boat[1],groundH(...SPOT.boat)+.05);
    for(const k in gateMesh){ const g=gateMesh[k]; if(V.gate&&g.visible){ g.position.y-=dt*1.4; if(g.position.y<-3.6) g.visible=false; } }
    const lvl=V.fire?Math.max(.25,1-V.w/V.need):0; if(lvl!==fireLvl){ fireLvl=lvl; setFireFX(lvl); }
    if(boat) boat.position.y=WATER_Y+.3+Math.sin(t*1.3)*.08;
    hudUpdate(mine);
  }
  let fireLvl=-1;
  function updateProps(st,t){ const ph=.75+Math.sin(t*4)*.25;
    const g=(i,on,x,y,z)=>{ const sp=glints[i]; sp.visible=!!on; if(on){ sp.position.set(x,y,z); sp.scale.setScalar(ph); } };
    for(let i=0;i<4;i++){ const h=W.hide[i]; g(i,h&&st===0&&!V.srch[i],h&&h[0],h&&h[2]+1.3,h&&h[1]); }
    g(4,W.rope&&st===2&&V.rope<2,W.rope&&W.rope[0],W.rope&&W.rope[2]+1.1,W.rope&&W.rope[1]);
    g(5,st===1&&!V.lock,W.lock[0],groundH(...W.lock)+1.9,W.lock[1]+1);
    for(let j=0;j<3;j++){ const c=W.clue[j]; g(6+j,c&&st===1&&!V.clu[j],c&&c[0],c&&groundH(c[0],c[1])+3.4,c&&c[1]); }
    for(let j=0;j<clueTags.length;j++) clueTags[j].material.opacity=V.clu[j]?.45:1;
    if(q0){ q0.visible=st===0&&!V.talk0; q0.position.y=groundH(...W.npc0)+3.2+Math.sin(t*3)*.1; }
    if(q1){ q1.visible=st===1&&!V.talk1; q1.position.y=groundH(...W.npc1)+2.6+Math.sin(t*3)*.1; } }
  function objTarget(){ const st=V.st,mine=V.pl.find(p=>p.id===net.myId);
    const cap=V.pl.find(p=>p.cap&&p.id!==net.myId); if(cap&&mine&&!mine.cap) return {x:cap.x,z:cap.z,n:cap.n+'を助ける'};
    if(st===0){ if(!V.talk0) return {x:W.npc0[0],z:W.npc0[1],n:'侍女'}; if(OKU&&P.room!==OKU){ const ex=OKU.exitPos; return {x:ex[0],z:ex[1]-1.5,n:'奥御殿'}; } return {n:'侍女の言葉をたよりに、部屋を調べよう'}; }
    if(st===1){ if(!V.lock){ if(!V.talk1) return {x:W.npc1[0],z:W.npc1[1],n:'傷ついた兵'}; const f=V.clu.filter(Boolean).length; if(f<3) return {n:`本丸のどこかに立つ幟を探せ（${f} / 3）`}; return {x:W.lock[0],z:W.lock[1],n:'山里丸の門の錠前'}; }
      const dw=Math.hypot(P.x-SPOT.swW[0],P.z-SPOT.swW[1]),de=Math.hypot(P.x-SPOT.swE[0],P.z-SPOT.swE[1]); const others=V.pl.filter(p=>p.id!==net.myId&&!p.cap);
      let w=dw<=de; if(others.length){ const o=others[0],ow=Math.hypot(o.x-SPOT.swW[0],o.z-SPOT.swW[1]),oe=Math.hypot(o.x-SPOT.swE[0],o.z-SPOT.swE[1]); w=ow>oe; } return w?{x:SPOT.swW[0],z:SPOT.swW[1],n:'西の閂'}:{x:SPOT.swE[0],z:SPOT.swE[1],n:'東の閂'}; }
    if(st===2){ if(mine&&mine.carry) return {x:SPOT.fire[0],z:SPOT.fire[1],n:'極楽橋の火'};
      if(V.rope===1&&CHA){ if(P.room!==CHA){ const ex=CHA.exitPos; return {x:ex[0],z:ex[1]-1.2,n:'山里丸の茶室'}; } return {n:'茶室の中を調べよう'}; }
      return {x:SPOT.well[0],z:SPOT.well[1],n:'井戸'}; }
    return {x:SPOT.boat[0],z:SPOT.boat[1],n:'大川の小舟'}; }
  function hudUpdate(mine){
    const st=V.st,S=STAGES[st]; el('escStg').textContent=S.t;
    let o=S.o; if(st===1&&V.lock) o=V.pl.length<2?'閂を押さえて、山里丸への門を開けろ':'西と東の閂を同時に押さえて、門を開けろ'; if(st===2) o+=`（${V.w} / ${V.need}杯）${mine&&mine.carry?'　― 水を運んでいる':''}`; if(st===1&&V.gh>0) o+='　開いていく…';
    if(st===3){ const n=V.pl.filter(p=>!p.cap&&Math.hypot(p.x-SPOT.boat[0],p.z-SPOT.boat[1])<7).length; if(n) o+=`（舟に ${n} / ${V.pl.length}人）`; }
    el('escObj').textContent=o; const tm=el('escTm'); tm.textContent=fmt(V.tm); tm.classList.toggle('low',V.tm<60);
    /* 方向の矢印 */
    const T=objTarget(),svg=el('escArrow').querySelector('svg');
    if(T.x===undefined){ svg.style.display='none'; el('escDist').textContent=T.n; }
    else { const dx=T.x-P.x,dz=T.z-P.z,d=Math.hypot(dx,dz),ang=Math.atan2(-dx,-dz)-P.yaw; svg.style.display=''; svg.style.transform=`rotate(${-ang}rad)`; el('escDist').textContent=T.n+' '+Math.round(d)+'m'; }
    { const n=(V.notes||[]).length; if(n!==notesSeen.n){ notesSeen.n=n; el('escNB').textContent='手控え '+n; if(!el('escNotes').hidden) renderNotes(); } }
    /* 調べるボタン */
    const me2=mine&&{...mine,x:P.x,z:P.z,y:P.y}; const tg=me2?targetFor({stage:st,ezu:V.ezu,srch:V.srch,clu:V.clu,lock:V.lock,rope:V.rope,pl:V.pl.map(p=>p.id===net.myId?me2:p)},me2):null;
    tgKey=tg?tg.k:null;
    if(me.latch&&(tgKey!==me.latchKey||Math.hypot(P.x-me.latchX,P.z-me.latchZ)>1.5||(!/^sw/.test(me.latchKey||'')&&performance.now()-me.latchT>4000))) me.latch=false;
    const U=el('escUse'); U.classList.toggle('on',!!tg); U.classList.toggle('hold',!!me.latch); el('escUseL').textContent=tg?tg.l:'調べる';
    el('escPg').style.width=(mine&&tg&&mine.hk===tg.k?(tg.d?mine.hp*100:(V.gh/1.2*100)):0)+'%';
    el('escPl').innerHTML=V.pl.map(p=>`<div><i style="background:${COLS[p.c%4]}"></i>${esc(p.n)}${p.cap?' 捕縛':''}${p.carry?' 水':''}</div>`).join('');
  }
  function onEnd(r){ me.inGame=false; me.use=false; const E=el('escEnd'); E.hidden=false; for(const id of ['escHud','escArrow','escUse','escCr','escCap','escNB','escWarn','escIntro']) el(id).hidden=true; closeLock(); closeNotes();
    E.innerHTML=`<div class="box"><h2 style="color:${r.win?'#9effa8':'#ff8f7e'}">${r.win?'脱出成功':'落城'}</h2><p>${esc(r.msg)}</p>
<dl><dt>かかった時間</dt><dd>${fmt(r.used)}</dd><dt>捕まった回数</dt><dd>${r.cau}回</dd><dt>仲間を助けた</dt><dd>${r.res}回</dd></dl>
${net.mode==='host'?'<button class="p" id="escAgain">もう一度（同じ仲間で）</button>':'<p>主の「もう一度」を待っています</p>'}<button id="escTitle">タイトルへ</button></div>`;
    if(el('escAgain')) el('escAgain').onclick=()=>{ lobby=lobby.filter(p=>p.id===0||net.conns.has(p.id)); hostStart(); };
    el('escTitle').onclick=()=>location.reload(); }

  /* ---------- 仮想パッドが押しっぱなしで固まらないように ---------- */
  function resetPad(){ if(joy.id!==null){ joy.id=null; joy.x=joy.y=0; padRest(stickB,stickK); } if(lookId!==null){ lookId=null; padRest(lookB,lookK); } looks.clear(); me.use=false; }
  addEventListener('pointerup',e=>endPtr(e),true); addEventListener('pointercancel',e=>endPtr(e),true);
  for(const ev of ['touchend','touchcancel']) addEventListener(ev,e=>{ if(!e.touches||e.touches.length===0) resetPad(); },true);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) resetPad(); }); addEventListener('blur',resetPad); addEventListener('pagehide',resetPad);
  /* ---------- スマホの発熱をおさえる（画質「軽」・毎秒30コマ） ---------- */
  const SAVE=isTouch;
  if(SAVE){ const _raf=window.requestAnimationFrame.bind(window); let lastT=0;
    window.requestAnimationFrame=cb=>_raf(function tick(t){ if(t-lastT<31){ _raf(tick); return; } lastT=t; cb(t); }); }
  function powerMode(){ if(!SAVE) return; if(quality==='high'){ try{ $('tQual').click(); }catch(e){} } for(const f of FXS) if(f.rate&&!f.esc) f.rate*=.5; }

  ui();
  const _uc=updateChars; updateChars=function(dt){ _uc(dt); try{ update(dt); }catch(e){ console.error('[T] esc',e); } };
  return {get G(){ return G; },get V(){ return V; },net,me,SPOT,STAGES,host,join,hostStart,update,targetFor,OKU,
    W,onCode,openLock,debug:{walk:(x,z)=>walkable(x,z),step:(n,dt)=>{ for(let i=0;i<n;i++) update(dt||.05); },tp:(x,z)=>{ P.room=null; P.level=-1; P.x=x; P.z=z; P.y=groundH(x,z)+1.6; },enterOku:()=>enterRoom(OKU),setStage:s=>{ if(G){ G.stage=s; if(s>=1) G.ezu=true; if(s>=2) G.gate=true; if(s>=3){ G.fire=false; } } }}};
})();
window.__esc=ESC;
