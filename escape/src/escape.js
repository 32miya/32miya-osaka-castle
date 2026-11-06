/* =====================================================================
   大坂城脱出 ― 大坂の陣 十の夜明け（協力脱出ゲーム層）
   大阪城さんぽの3Dマップの上で動く。最大4人、PeerJS（P2P）で同期。
   ホスト（部屋を作った人）が進行・追手・当たり判定をまとめて計算し、10回/秒で全員に配る。
   面（ステージ）はすべて LEVELS のデータと小さな関数で書く。
   ===================================================================== */
const ESC=(()=>{
  const VER='0.6';
  const MAXP=4, NET_HZ=10;
  const PEER_PREFIX='osaka-escape-32miya-';
  const COLS=['#e0412f','#e8b13a','#3fa7d6','#7bc96f'];
  /* 仲間の姿：豊臣方の武将（立ち姿は地図の画像、しゃがみ姿は crouch.webp） */
  const SPRS=['t_bs_mori','t_bs_akashi','t_bs_chosokabe','t_bs_ono'], CRS=['cr_mori','cr_akashi','cr_chosokabe','cr_ono'];
  const CROUCH_META={"cr_mori":[4,4,4,279,287,1.77],"cr_mori_b":[4,344,4,288,322,1.77],"cr_chosokabe":[4,684,4,258,309,1.77],"cr_chosokabe_b":[4,1024,4,255,322,1.77],"cr_akashi":[4,1364,4,259,292,1.77],"cr_akashi_b":[4,1704,4,244,311,1.77],"cr_ono":[4,4,404,297,306,1.77],"cr_ono_b":[4,344,404,271,306,1.77],"cr_ii":[4,684,404,253,330,1.77],"cr_ii_b":[4,1024,404,247,300,1.77],"cr_maeda":[4,1364,404,262,292,1.77],"cr_maeda_b":[4,1704,404,240,296,1.77],"cr_date":[4,4,804,319,302,1.77],"cr_date_b":[4,344,804,284,293,1.77],"cr_matsudaira":[4,684,804,262,295,1.77],"cr_matsudaira_b":[4,1024,804,252,303,1.77],"cr_todo":[4,1364,804,256,345,1.77],"cr_todo_b":[4,1704,804,253,304,1.77],"cr_uesugi":[4,4,1204,265,342,1.77],"cr_uesugi_b":[4,344,1204,246,299,1.77],"cr_satake":[4,684,1204,288,340,1.77],"cr_satake_b":[4,1024,1204,240,268,1.77],"cr_honda":[4,1364,1204,282,369,1.77],"cr_honda_b":[4,1704,1204,234,305,1.77],"cr_kimura2":[4,4,1604,261,348,1.77],"cr_kimura2_b":[4,344,1604,259,304,1.77]};
  { const pg=ATLAS_META.pages; for(const k in CROUCH_META){ const m=CROUCH_META[k].slice(); m[0]=pg; ATLAS_META.s[k]=m; } ATLAS_META.pages=pg+1;
    const t=new THREE.TextureLoader().load('crouch.webp'); t.encoding=THREE.sRGBEncoding; t.anisotropy=4; ATL.tex.push(t); }
  const qs=new URLSearchParams(location.search);

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

  /* ---------- 3Dの小道具（共通） ---------- */
  const PROP=new THREE.Group(); scene.add(PROP);
  const crowd=new Crowd(PROP,1600);
  const beamGeo=new THREE.CylinderGeometry(.55,.55,36,12,1,true); beamGeo.translate(0,18,0);
  function beam(col){ const m=new THREE.Mesh(beamGeo,new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.28,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide})); m.renderOrder=5; m.visible=false; PROP.add(m); return m; }
  const ringGeo=new THREE.RingGeometry(1.5,1.9,40); ringGeo.rotateX(-Math.PI/2);
  function ring(col){ const m=new THREE.Mesh(ringGeo,new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.75,depthWrite:false})); m.renderOrder=5; m.visible=false; PROP.add(m); return m; }
  function roomSpots(Rm,n,avoid,ad){ const pts=[]; for(const r of Rm.rects) for(let x=r.x0+.5;x<r.x1-.5;x+=.5) for(let z=r.z0+.5;z<r.z1-.5;z+=.5){ if(!roomOK(Rm,x,z)) continue;
      const edge=!roomOK(Rm,x+1.1,z)||!roomOK(Rm,x-1.1,z)||!roomOK(Rm,x,z+1.1)||!roomOK(Rm,x,z-1.1); if(edge&&Math.hypot(x-avoid[0],z-avoid[1])>ad) pts.push([x,z]); }
    const out=[]; if(!pts.length) return out; out.push(pts[Math.floor(pts.length/2)]);
    while(out.length<n){ let best=null,bd=-1; for(const q of pts){ let d=1e9; for(const o of out) d=Math.min(d,Math.hypot(o[0]-q[0],o[1]-q[1])); if(d>bd){ bd=d; best=q; } } if(!best||bd<.5) break; out.push(best); } return out; }
  function nudge(x,z){ const ok=(a,b)=>_walkable(a,b)&&!hitBlock(a,b,.9); if(ok(x,z)) return [x,z]; for(let r=1;r<=16;r++) for(let a=0;a<6.283;a+=.35){ const xx=x+Math.cos(a)*r,zz=z+Math.sin(a)*r; if(ok(xx,zz)) return [xx,zz]; } return [x,z]; }
  function textSprite(txt,bg,fg,size){ const c=makeCanvas(128,128),g=c.getContext('2d'); if(bg){ g.fillStyle=bg; g.beginPath(); g.arc(64,64,58,0,6.283); g.fill(); } g.fillStyle=fg; g.font='bold 78px "Hiragino Mincho ProN","Noto Serif JP",serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(txt,64,70);
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthTest:false,transparent:true})); sp.scale.setScalar(size||1); sp.renderOrder=9; PROP.add(sp); return sp; }
  const sparkTex=(()=>{ const c=makeCanvas(64,64),g=c.getContext('2d'),gr=g.createRadialGradient(32,32,0,32,32,30); gr.addColorStop(0,'rgba(255,250,220,1)'); gr.addColorStop(.25,'rgba(255,220,120,.7)'); gr.addColorStop(1,'rgba(255,200,80,0)'); g.fillStyle=gr; g.fillRect(0,0,64,64); g.fillStyle='rgba(255,255,240,.95)'; g.fillRect(30,4,4,56); g.fillRect(4,30,56,4); return new THREE.CanvasTexture(c); })();
  const glints=[...Array(16)].map(()=>{ const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:sparkTex,depthTest:false,transparent:true,blending:THREE.AdditiveBlending})); sp.renderOrder=9; sp.visible=false; PROP.add(sp); return sp; });
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
  function otherOf(p){ let o=others.get(p.id); if(!o){ o={F:figure(SPRS[p.c%4]),C:figure(CRS[p.c%4]),tag:nameTag(p.n,COLS[p.c%4]),n:p.n,bk:crowd.add('bucket',0,-999,0,{s:.7})}; others.set(p.id,o); } return o; }
  function clearOthers(){ for(const o of others.values()){ hideFig(o.F); hideFig(o.C); PROP.remove(o.tag); if(o.bk) crowd.move(o.bk,0,-999,0); if(o.cs) crowd.move(o.cs,0,-999,0); } others.clear(); }

  /* 追手 */
  const MAXE=12;
  const SIGHT=13, SIGHT_HALF=0.99;   /* 追手の視界：13m・左右およそ57度 */
  const efig=[...Array(MAXE)].map(()=>({}));
  function enemyFig(i,spr){ const c=efig[i]; if(!c[spr]) c[spr]=figure(spr,1.1); for(const k in c) if(k!==spr) hideFig(c[k]); return c[spr]; }
  function hideEnemy(i){ const c=efig[i]; for(const k in c) hideFig(c[k]); fans[i].visible=false; lanterns[i].visible=false; foeTags[i].visible=false; alertTags[i].visible=false; }
  const fanGeo=new THREE.CircleGeometry(SIGHT,28,Math.PI/2-SIGHT_HALF,SIGHT_HALF*2); fanGeo.rotateX(-Math.PI/2);
  const fanEdgeGeo=new THREE.RingGeometry(SIGHT-.35,SIGHT,28,1,Math.PI/2-SIGHT_HALF,SIGHT_HALF*2); fanEdgeGeo.rotateX(-Math.PI/2);
  const fans=[...Array(MAXE)].map(()=>{ const g=new THREE.Group(); const f=new THREE.Mesh(fanGeo,new THREE.MeshBasicMaterial({color:0xffb030,transparent:true,opacity:.26,depthWrite:false,toneMapped:false,polygonOffset:true,polygonOffsetFactor:-2}));
    const e=new THREE.Mesh(fanEdgeGeo,new THREE.MeshBasicMaterial({color:0xffb030,transparent:true,opacity:.9,depthWrite:false,toneMapped:false,polygonOffset:true,polygonOffsetFactor:-2})); f.renderOrder=e.renderOrder=4; g.add(f,e); g.userData={f,e}; g.visible=false; PROP.add(g); return g; });
  const glowTex=(()=>{ const c=makeCanvas(64,64),g=c.getContext('2d'),gr=g.createRadialGradient(32,32,0,32,32,32); gr.addColorStop(0,'rgba(255,220,140,1)'); gr.addColorStop(.3,'rgba(255,150,50,.6)'); gr.addColorStop(1,'rgba(255,120,30,0)'); g.fillStyle=gr; g.fillRect(0,0,64,64); return new THREE.CanvasTexture(c); })();
  const lanterns=[...Array(MAXE)].map(()=>{ const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false})); sp.scale.setScalar(1.6); sp.renderOrder=5; sp.visible=false; PROP.add(sp); return sp; });
  const foeTags=[...Array(MAXE)].map(()=>{ const c=makeCanvas(256,64),g=c.getContext('2d'); g.fillStyle='rgba(150,20,10,.85)'; g.beginPath(); g.roundRect?g.roundRect(68,8,120,48,22):g.rect(68,8,120,48); g.fill(); g.fillStyle='#fff'; g.font='bold 30px "Hiragino Sans","Noto Sans JP",sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('追手',128,33);
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthTest:false,transparent:true})); sp.scale.set(2,.5,1); sp.renderOrder=9; sp.visible=false; PROP.add(sp); return sp; });
  const markTex=t=>{ const c=makeCanvas(64,64),g=c.getContext('2d'); g.font='bold 54px sans-serif'; g.textAlign='center'; g.fillStyle=t==='！'?'#ff3b2f':'#ffd36a'; g.strokeStyle='#000'; g.lineWidth=5; g.strokeText(t,32,54); g.fillText(t,32,54); return new THREE.CanvasTexture(c); };
  const TEX_Q=markTex('？'),TEX_X=markTex('！');
  const alertTags=[...Array(MAXE)].map(()=>{ const s=new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_Q,depthTest:false,transparent:true})); s.scale.set(1.1,1.1,1); s.renderOrder=9; s.visible=false; PROP.add(s); return s; });

  /* ---------- 面ごとの小道具（面が変わると片付ける） ---------- */
  const LIT={items:[],objs:[]};
  function aSpr(n,x,y,z,o){ const it=crowd.add(n,x,y,z,o||{}); if(it) LIT.items.push(it); return it; }
  function aObj(o){ if(!o.parent) PROP.add(o); LIT.objs.push(o); return o; }
  const fxMap=new Map();
  function fxSet(key,f){ const old=fxMap.get(key); if(old){ const i=FXS.indexOf(old); if(i>=0) FXS.splice(i,1); fxMap.delete(key); } if(f){ f.esc=true; FXS.push(f); fxMap.set(key,f); } }
  function clearLv(){ for(const it of LIT.items) crowd.hide(it); for(const o of LIT.objs){ if(o.parent) o.parent.remove(o); o.traverse(c=>{ if(c.isMesh&&c.geometry&&c.geometry!==beamGeo&&c.geometry!==ringGeo) c.geometry.dispose(); if(c.isSprite&&c.material){ if(c.material.map&&c.material.map.isCanvasTexture&&c.material.map!==sparkTex&&c.material.map!==glowTex) c.material.map.dispose(); c.material.dispose(); } }); } LIT.items=[]; LIT.objs=[]; for(const k of [...fxMap.keys()]) fxSet(k,null); fxMap.clear(); }
  const room=n=>ROOMS.find(R=>R.era==='toyo'&&R.name===n);
  function doorsOf(R){ const d=[R.door]; for(const e of R.extra||[]) if(e.zone) d.push([(e.zone.x0+e.zone.x1)/2,(e.zone.z0+e.zone.z1)/2]); return d; }
  function nearestDoor(R){ let best=null,bd=1e9; for(const d of doorsOf(R)){ if(LV&&LV.bounds&&!inR(LV.bounds,d[0],d[1],-2)) continue; const q=Math.hypot(d[0]-P.x,d[1]-P.z); if(q<bd){ bd=q; best=d; } } return best; }
  function roomProps(R,defs){ if(!R) return defs.map(()=>null); const pts=roomSpots(R,defs.length,R.spawn,2); return defs.map((d,i)=>{ const q=pts[i]||[R.spawn[0]+(i-1)*1.5,R.spawn[1]-2]; aSpr(d.spr,q[0],R.y,q[1],{s:d.s||1}); return {x:q[0],z:q[1],y:R.y,n:d.n,R}; }); }
  function npc(spr,x,z,label,o){ o=o||{}; const [nx,nz]=o.fixed?[x,z]:nudge(x,z),y=groundH(nx,nz),th=o.th||2.6; aSpr(spr,nx,y,nz,{s:o.s||1});
    const tg=aObj(nameTag(label,'#e8b13a')); tg.position.set(nx,y+th,nz); const q=aObj(textSprite('？','#e8b13a','#111',.8)); q.position.set(nx,y+th+.75,nz); q.userData.by=y+th+.75; return {x:nx,z:nz,y,q,n:label}; }
  function spot(x,z,o){ o=o||{}; const [nx,nz]=o.fixed?[x,z]:nudge(x,z); return {x:nx,z:nz,y:groundH(nx,nz)}; }
  const near=(p,o,r)=>!!o&&Math.hypot(p.x-o.x,p.z-o.z)<(r||2.8)&&Math.abs(p.y-1.6-o.y)<3;
  const shuffle=a=>{ a=a.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
  const rint=n=>Math.floor(Math.random()*n);
  const bob=(q,on,t)=>{ if(q){ q.visible=!!on; q.position.y=q.userData.by+Math.sin(t*3)*.1; } };
  const KAN=['一','二','三','四','五','六','七','八','九','十'];

  /* ---------- ホストが使う道具 ---------- */
  function event(m){ if(net.mode==='host') broadcast({t:'ev',m}); onEvent(m); }
  function note(m){ if(!G.notes.includes(m)){ G.notes.push(m); if(G.notes.length>16) G.notes.shift(); } }
  function penalty(s,m){ G.t-=s; event(m+'（−'+s+'秒）'); }
  const nPl=()=>G.pl.length;
  const onl=()=>G.pl.filter(p=>!p.off);
  const nOn=()=>Math.max(1,onl().length);
  const nOnV=()=>V?Math.max(1,V.pl.filter(p=>!p.off).length):1;
  const allIn=(o,r)=>onl().length>0&&onl().every(p=>!p.cap&&!p.room&&Math.hypot(p.x-o.x,p.z-o.z)<(r||8));
  const inCount=(o,r)=>onl().filter(p=>!p.cap&&!p.room&&Math.hypot(p.x-o.x,p.z-o.z)<(r||8)).length;

  /* =====================================================================
     面（ステージ）
     ===================================================================== */
  let LV=null, LVI=0, SET=null, W={};

  /* 2人いれば2人で同時に、ひとりなら1か所で押さえれば進む（閂・太鼓・荷車の轅など） */
  function swTick(keys,dt,done){ const need=Math.min(keys.length,Math.max(1,Math.min(2,nOn()))),held=keys.filter(k=>G.sw[k]).length; if(held>=need){ G.gh+=dt; if(G.gh>=1.2){ G.gh=0; done(); } } else G.gh=Math.max(0,G.gh-dt*2); }
  /* 外に置く「調べる」場所（俵・灯籠など） */
  function outSpots(list){ return list.map(d=>{ const o=spot(d.x,d.z); aSpr(d.spr,o.x,o.y,o.z,{s:d.s||1}); o.n=d.n; return o; }); }
  /* 任務の1行： t=文 d=済 h=手がかり（必須でない） at=目的地 {x,z,n} */
  const tk=(t,d,at,h)=>({t,d:!!d,at:at||null,h:!!h});
  const doorAt=(R,n)=>{ if(!R) return null; if(P.room===R) return null; const d=nearestDoor(R); return d?{x:d[0],z:d[1],n:n||R.name}:null; };

  /* ---------- 其の一　城下の密書（朝・上町の城下町と寺町） ---------- */
  const SHOPS=[['町家（上町の商家）','商家'],['町家（酒屋）','酒屋'],['町家（薬種屋）','薬種屋']];
  const SHOP_ELIM={商家:'反物や小間物には目もくれなかったよ',酒屋:'酒の匂いなんぞ、しなかったねえ',薬種屋:'薬臭くはなかったぞ'};
  const SHOP_SPOTS=[{n:'帳場の箪笥',spr:'cabinet'},{n:'奥の棚',spr:'shelf'},{n:'土間の甕',spr:'jar'}];
  const SPOT_HINT=['帳場で銭勘定をするふりをしておった','奥の棚に手を伸ばしておった','土間の甕をのぞきこんでおった'];
  const PW=[['山','川'],['月','花'],['松','鶴'],['雪','炭'],['風','林']];
  const RUM_POS=[[-160,710],[-360,630],[-60,590],[140,670],[-160,510],[140,510],[-260,750]];
  const RUM_WHO=[['musume_r','町娘'],['shonin','商人'],['w_red','女房']];
  const L1={ name:'城下の密書', sub:'慶長十九年 十月 ・ 朝 ・ 上町の城下町', time:0, scen:null, limit:600, phases:4,
    story:'大坂の陣を前に、徳川の間者が大坂城の絵図を写した「密書」を城下の店に隠した。手分けして聞き込み、密書を取り返し、合言葉を手に入れて三の丸の門まで届けよ。',
    bounds:{x0:-600,x1:180,z0:428,z1:842}, spawn:[-72,800,-Math.PI/2],
    patrols:[{p:[[-340,590],[120,590]],s:1.7,spr:'k_ninja'},{p:[[120,710],[-340,710]],s:1.6,spr:'k_ninja'},{p:[[-160,480],[-160,800]],s:1.5,spr:'k_ninja'},{p:[[140,800],[140,480]],s:1.5,spr:'k_ninja'},{p:[[-340,510],[0,510]],s:1.6,spr:'k_ninja'},{p:[[-360,780],[-360,480]],s:1.4,spr:'k_ninja'},{p:[[-570,790],[-420,790]],s:1.5,spr:'k_ninja'}],
    setup(){ const sh=rint(3),wr=shuffle([0,1,2].filter(i=>i!==sh)); return {shop:sh,wrong:wr,spot:rint(3),rpos:shuffle([...RUM_POS.keys()]).slice(0,3),pw:rint(PW.length),pairs:shuffle([...PW.keys()]).slice(0,4)}; },
    build(s){ W.elder=npc('roujin',-50,798,'町年寄'); W.rum=s.rpos.map((ci,j)=>npc(RUM_WHO[j][0],RUM_POS[ci][0],RUM_POS[ci][1],RUM_WHO[j][1]));
      W.spots=SHOPS.map(sp=>roomProps(room(sp[0]),SHOP_SPOTS)); W.tera=room('寺の本堂'); W.monk=W.tera?roomProps(W.tera,[{n:'住職',spr:'p_monk'}])[0]:null;
      W.guard=npc('samurai_a',-50,468,'三の丸の門番'); W.goal=spot(-60,440,{fixed:true}); W.gateBlk={x0:-64.5,x1:-55.5,z0:451,z1:462}; },
    init(){ return {o:0,r:[0,0,0],monk:0,mitsu:0,srch:[[0,0,0],[0,0,0],[0,0,0]],pass:0}; },
    pairs(){ const s=SET; return s.pairs.includes(s.pw)?s.pairs:[s.pw,...s.pairs.slice(0,3)]; },
    rumor(j){ const s=SET; if(j<2) return RUM_WHO[j][1]+'「黒い身なりの男が店に入るのを見たよ。'+SHOP_ELIM[SHOPS[s.wrong[j]][1]]+'」'; return '女房「あの男、店の中で'+SPOT_HINT[s.spot]+'」'; },
    target(f,p){ if(near(p,W.elder)) return {k:'elder',l:'町年寄に話を聞く',d:.15};
      if(f.o>=1) for(let j=0;j<3;j++) if(near(p,W.rum[j])) return {k:'rum'+j,l:RUM_WHO[j][1]+'に話を聞く',d:.15};
      if(f.o===1){ if(near(p,W.monk,2.4)) return {k:'monk',l:'住職に話を聞く',d:.4};
        if(!f.mitsu) for(let s=0;s<3;s++) for(let i=0;i<3;i++){ const o=W.spots[s][i]; if(o&&!f.srch[s][i]&&near(p,o,2)) return {k:'s'+s+i,l:o.n+'を調べる',d:.7}; } }
      if(near(p,W.guard,3.2)) return f.o===2?{k:'lock',l:'門番に合言葉を答える',d:.1}:{k:'guard',l:'門番に話しかける',d:.15};
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='elder'){ const m='町年寄「間者は、商家・酒屋・薬種屋のどれかに密書を隠したらしい。町娘・商人・女房が何か見ておるはずじゃ。それと寺町の住職さまは、間者どもの合言葉の控えを預かっておられる」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k.startsWith('rum')){ const j=+k[3],m=L1.rumor(j); f.r[j]=1; note(m); event(m); }
      else if(k==='monk'){ const m='住職「間者どもの合言葉の控えじゃ。'+shuffle(L1.pairs()).map(ix=>`問い「${PW[ix][0]}」には「${PW[ix][1]}」`).join('、')+'。三の丸の門番は、このどれかを問うてくるはずじゃ」'; note(m); event(m); f.monk=1; }
      else if(k[0]==='s'){ const sh=+k[1],i=+k[2]; f.srch[sh][i]=1;
        if(sh===s.shop&&i===s.spot){ f.mitsu=1; event(p.n+'が'+SHOPS[sh][1]+'の'+SHOP_SPOTS[i].n+'から密書を見つけた！'); }
        else if(sh!==s.shop) penalty(10,SHOPS[sh][1]+'の'+SHOP_SPOTS[i].n+'には何もない。この店ではなさそうだ'); else penalty(10,SHOP_SPOTS[i].n+'には何もない'); }
      else if(k==='guard') event(f.pass?'門番「よし、通れ」':'門番「密書を持たぬ者は通せぬ。合言葉もな」');
      if(f.o===1&&f.mitsu&&f.monk){ f.o=2; event('密書と合言葉の控えがそろった！ 三の丸の門番に合言葉を答えよ'); } },
    lock(){ const s=SET; const opts=shuffle(L1.pairs()).map(i=>PW[i][1]); return {title:'三の丸の門番',sub:`「合言葉は？」――問いは「${PW[s.pw][0]}」`,slots:1,syms:opts,known:'住職の控えは「手控え」にある'}; },
    code(v,syms){ const f=G.f; if(f.o!==2) return; if(syms[v[0]]===PW[SET.pw][1]){ f.pass=1; f.o=3; event('門番「……よし、通れ。密書は城へ届けよ」'); } else penalty(15,'門番「違う！ 怪しい奴め」'); },
    tick(){ const f=G.f; if(f.o===3&&allIn(W.goal,7)) finish(true,'密書は無事に城へ届いた。間者のたくらみは潰えた――'); },
    block(x,z,f){ return !f.pass&&inR(W.gateBlk,x,z,.2); },
    tasks(f){ const sp=P.room&&SHOPS.some(q=>room(q[0])===P.room)?null:null; return [
      tk('町年寄の話を聞く',f.o>0,W.elder),
      ...RUM_WHO.map((w,j)=>Object.assign(tk(w[1]+'に聞き込む',f.r[j],{x:W.rum[j].x,z:W.rum[j].z,n:w[1]},true),{ph:1})),
      Object.assign(tk('寺町の住職から合言葉の控えをもらう',f.monk,P.room===W.tera?{x:W.monk.x,z:W.monk.z,n:'住職'}:doorAt(W.tera,'寺町の寺')),{ph:1}),
      Object.assign(tk('密書を隠した店を突き止めて探し出す',f.mitsu,sp),{ph:1}),
      Object.assign(tk('三の丸の門番に合言葉を答える',f.pass,W.guard),{ph:2}),
      Object.assign(tk('三の丸の門をくぐって城へ入る',false,{x:W.goal.x,z:W.goal.z,n:'三の丸の門'}),{ph:3})].map(t=>{ if(t.ph===undefined) t.ph=0; return t; }); },
    roomHint(f){ if(f.o===1&&!f.mitsu&&P.room&&SHOPS.some(q=>room(q[0])===P.room)) return '店の中を調べよう'; if(f.o===1&&!f.mitsu) return '町家の入口から店に入れる'; return ''; },
    glints(f){ const g=[]; if(f.o===1&&!f.mitsu) W.spots.forEach((S,s)=>S.forEach((o,i)=>{ if(o&&!f.srch[s][i]) g.push([o.x,o.y+1.3,o.z]); })); if(f.o===1&&!f.monk&&W.monk) g.push([W.monk.x,W.monk.y+2.2,W.monk.z]); return g; },
    render(f,t){ bob(W.elder.q,f.o===0,t); W.rum.forEach((r,j)=>bob(r.q,f.o===1&&!f.r[j],t)); bob(W.guard.q,f.o===2,t); },
    check(f){ return f.o>=2?[-60,560]:[-72,800]; } };

  /* ---------- 其の二　真田丸の狼煙（夕・惣構の南） ---------- */
  const SMOKE_C=[['赤','nb_red','夕日が燃え'],['白','nb_white','雪が舞い'],['黒','nb_black','夜が来る']];
  const SITE_POS=[[60,960],[160,1045],[250,905],[440,1035],[110,905],[210,1005],[400,915]];
  const CRATES=[{x:-12,z:916,n:'俵',spr:'tawara',s:1.2},{x:-84,z:932,n:'木箱',spr:'crates'},{x:-46,z:962,n:'樽',spr:'barrels'}];
  const BACHI=[{x:236,z:918,n:'矢箱',spr:'arrows'},{x:236,z:978,n:'具足櫃',spr:'box_l'},{x:212,z:948,n:'竹束の陰',spr:'taketaba'}];
  const L2={ name:'真田丸の狼煙', sub:'慶長十九年 十二月 ・ 夕 ・ 惣構の南', time:2, scen:'fuyu', phase:2, limit:600, phases:6,
    story:'徳川の大軍が真田丸に迫っている。火打ち石と陣太鼓の撥（ばち）を手分けして探し、三つの狼煙台に正しい順で火を入れて合図を送れ。最後は門前の陣太鼓で門を開けさせ、真田丸へ駆け込め。',
    bounds:{x0:-130,x1:520,z0:880,z1:1092}, spawn:[-60,896,Math.PI],
    patrols:[{p:[[30,1000],[210,1000]],s:1.6},{p:[[120,925],[120,1070]],s:1.5,spr:'k_teppo'},{p:[[300,1070],[480,1070]],s:1.7},{p:[[470,900],[470,1060]],s:1.4,spr:'k_teppo'},{p:[[-100,1060],[20,1060]],s:1.5},{p:[[200,940],[200,1070]],s:1.6},{p:[[230,1080],[230,990]],s:1.4,spr:'k_teppo'}],
    setup(){ return {sites:shuffle([...SITE_POS.keys()]).slice(0,3),col:shuffle([0,1,2]),order:shuffle([0,1,2]),flint:rint(3),bachi:rint(3)}; },
    build(s){ W.scout=npc('r_bushou',-40,904,'真田の物見'); W.fire=spot(-28,900); aSpr('kagaribi',W.fire.x,W.fire.y,W.fire.z,{s:1.2}); W.crates=outSpots(CRATES); W.bachi=outSpots(BACHI);
      W.sites=s.sites.map((ci,j)=>{ const o=spot(SITE_POS[ci][0],SITE_POS[ci][1]); aSpr('log',o.x+.6,o.y,o.z,{s:1.2}); aSpr(SMOKE_C[s.col[j]][1],o.x-.9,o.y,o.z+.3,{}); return o; });
      W.goal=spot(268,947); W.drA=spot(262,935); W.drB=spot(262,959); aSpr('taiko',W.drA.x,W.drA.y,W.drA.z,{}); aSpr('taiko',W.drB.x,W.drB.y,W.drB.z,{}); },
    init(){ return {o:0,cr:[0,0,0],bs:[0,0,0],flint:0,bachi:0,lit:0,on:[0,0,0]}; },
    target(f,p){ if(near(p,W.scout)) return {k:'scout',l:'真田の物見に話を聞く',d:.15};
      if(f.o===1){ if(!f.flint) for(let i=0;i<3;i++) if(!f.cr[i]&&near(p,W.crates[i],2.6)) return {k:'cr'+i,l:W.crates[i].n+'を調べる',d:.6};
        if(!f.bachi) for(let i=0;i<3;i++) if(!f.bs[i]&&near(p,W.bachi[i],2.6)) return {k:'bs'+i,l:W.bachi[i].n+'を調べる',d:.6}; }
      if(f.o===2&&near(p,W.fire,3)) return {k:'kindle',l:'火打ち石で篝火を起こす',d:1.2};
      if(f.o===3){ if(p.carry!=='火種'&&near(p,W.fire,3)) return {k:'take',l:'篝火から火種をとる',d:.5};
        if(p.carry==='火種') for(let j=0;j<3;j++) if(!f.on[j]&&near(p,W.sites[j],3.2)) return {k:'lite'+j,l:SMOKE_C[SET.col[j]][0]+'い旗の狼煙台に火を入れる',d:.6}; }
      if(f.o===4){ if(near(p,W.drA,2.4)) return {k:'swA',l:'陣太鼓を打つ',sw:1}; if(near(p,W.drB,2.4)) return {k:'swB',l:'陣太鼓を打つ',sw:1}; }
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='scout'){ const m='物見「徳川勢が真田丸に迫っておる。狼煙は三つ――'+s.order.map(c=>SMOKE_C[c][2]).join('、')+'――その順に上げよ。篝火が消えたゆえ、火打ち石が陣の荷（俵・木箱・樽）のどれかに要る。門前の陣太鼓の撥は、真田丸の手前の矢箱か具足櫃か竹束の陰じゃ」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k.startsWith('cr')){ const i=+k[2]; f.cr[i]=1; if(i===s.flint){ f.flint=1; event(p.n+'が'+CRATES[i].n+'の中から火打ち石を見つけた！'); } else penalty(5,CRATES[i].n+'には兵糧しか入っていない'); }
      else if(k.startsWith('bs')){ const i=+k[2]; f.bs[i]=1; if(i===s.bachi){ f.bachi=1; event(p.n+'が'+BACHI[i].n+'で陣太鼓の撥を見つけた！'); } else penalty(5,BACHI[i].n+'には撥はない'); }
      else if(k==='kindle'){ f.o=3; event('篝火が燃え上がった！ 火種を運び、狼煙台に火を入れよ'); note('物見の言葉：夕日＝赤、雪＝白、夜＝黒 と読み替えよ'); }
      else if(k==='take'){ p.carry='火種'; }
      else if(k.startsWith('lite')){ const j=+k[4]; p.carry=false;
        if(s.col[j]===s.order[f.lit]){ f.on[j]=1; f.lit++; event(p.n+'が'+SMOKE_C[s.col[j]][0]+'い旗の狼煙を上げた（'+f.lit+' / 3）'); if(f.lit>=3){ f.o=4; event('三つの狼煙が上がった！ 真田丸の門前で陣太鼓を打ち、門を開けさせよ'+(nOn()>=2?'（二つ同時に）':'')); } }
        else { f.on=[0,0,0]; f.lit=0; penalty(15,'順が違う！ 狼煙はかき消され、はじめからやり直しだ'); } }
      if(f.o===1&&f.flint&&f.bachi){ f.o=2; event('火打ち石と撥がそろった！ 篝火を起こせ'); } },
    drop(p){ p.carry=false; },
    tick(dt){ const f=G.f; if(f.o===4) swTick(['swA','swB'],dt,()=>{ f.o=5; event('太鼓に応えて、真田丸の門が開いた！ 全員で駆け込め'); }); if(f.o===5&&allIn(W.goal,9)) finish(true,'狼煙は上がり、真田丸から鬨の声が響いた。合図は城へ届いた――'); },
    tasks(f){ const near1=o=>({x:o.x,z:o.z,n:o.n}); const unC=W.crates.filter((o,i)=>!f.cr[i]),unB=W.bachi.filter((o,i)=>!f.bs[i]); return [
      Object.assign(tk('真田の物見の話を聞く',f.o>0,W.scout),{ph:0}),
      Object.assign(tk('陣の荷（俵・木箱・樽）から火打ち石を探す',f.flint,unC[0]?near1(unC[0]):null),{ph:1,many:unC.map(near1)}),
      Object.assign(tk('真田丸の手前で陣太鼓の撥（ばち）を探す',f.bachi,unB[0]?near1(unB[0]):null),{ph:1,many:unB.map(near1)}),
      Object.assign(tk('火打ち石で篝火を起こす',f.o>2,{x:W.fire.x,z:W.fire.z,n:'篝火'}),{ph:2}),
      Object.assign(tk(`火種を運び、狼煙台に正しい順で火を入れる（${f.lit} / 3）`,f.o>3,null),{ph:3,many:W.sites.filter((o,j)=>!f.on[j]).map(o=>({x:o.x,z:o.z,n:'狼煙台'}))}),
      Object.assign(tk(nOnV()>1?'門前の陣太鼓を二人で同時に打つ':'門前の陣太鼓を打つ',f.o>4,{x:W.drA.x,z:W.drA.z,n:'陣太鼓'}),{ph:4}),
      Object.assign(tk('真田丸の門まで全員で駆け込む',false,{x:W.goal.x,z:W.goal.z,n:'真田丸'}),{ph:5})]; },
    roomHint(f,mine){ if(f.o===3) return mine&&mine.carry==='火種'?'物見の言葉を思い出し、旗の色で狼煙台を選べ':'篝火で火種をとろう'; return ''; },
    arrowOverride(f,mine){ if(f.o===3&&(!mine||mine.carry!=='火種')) return {x:W.fire.x,z:W.fire.z,n:'篝火'}; if(f.o===3) return {n:'物見の言葉を思い出し、旗の色で狼煙台を選べ'}; return null; },
    glints(f){ const g=[]; if(f.o===1){ if(!f.flint) W.crates.forEach((o,i)=>{ if(!f.cr[i]) g.push([o.x,o.y+1.6,o.z]); }); if(!f.bachi) W.bachi.forEach((o,i)=>{ if(!f.bs[i]) g.push([o.x,o.y+1.6,o.z]); }); } if(f.o===2) g.push([W.fire.x,W.fire.y+2.4,W.fire.z]);
      if(f.o===3) W.sites.forEach((o,j)=>{ if(!f.on[j]) g.push([o.x,o.y+2.2,o.z]); }); if(f.o===4){ g.push([W.drA.x,W.drA.y+1.6,W.drA.z]); g.push([W.drB.x,W.drB.y+1.6,W.drB.z]); } return g; },
    render(f,t){ bob(W.scout.q,f.o===0,t); if(f.o>=3) fxSet('kg',{type:'blaze',x:W.fire.x,y:W.fire.y+.8,z:W.fire.z,r:.5,h:1.2,rate:12,ring:false}); else fxSet('kg',null);
      W.sites.forEach((o,j)=>{ const want=!!f.on[j],has=fxMap.has('sm'+j); if(want&&!has){ fxSet('sm'+j,{type:'column',x:o.x,y:o.y+1,z:o.z,r:1.4,rate:6}); fxSet('sf'+j,{type:'blaze',x:o.x,y:o.y+.5,z:o.z,r:.7,h:1.4,rate:16,ring:false}); } if(!want&&has){ fxSet('sm'+j,null); fxSet('sf'+j,null); } }); },
    check(f){ return f.o>=4?[230,947]:[-60,896]; } };

  /* ---------- 其の三　二の丸の導火線（夜・二の丸の大名屋敷） ---------- */
  const DROOMS=[['大名屋敷の広間（武具の間）','広間',[{n:'鎧櫃',spr:'armor'},{n:'槍掛け',spr:'spears'},{n:'陣太鼓',spr:'drumbox'}],['武者の抜け殻の中','長き得物の掛かる所','戦を告げる音の内']],
    ['大名屋敷の書院','書院',[{n:'文机',spr:'lowtable'},{n:'掛け軸',spr:'kakejiku'},{n:'違い棚',spr:'shelf'}],['筆と硯の眠る台','絵の垂れ下がる裏','段違いの棚の上']],
    ['大名屋敷の奥座敷','奥座敷',[{n:'屏風',spr:'by_crane'},{n:'行灯',spr:'andon'},{n:'長持',spr:'chest_k'}],['鶴の舞う衝立の陰','夜を照らす灯の傍ら','衣を納める箱の底']]];
  const KG_POS=[[-120,165],[40,120],[150,40],[-100,-100],[-190,-40]];
  const EXITS=[{n:'京橋口',d:'乾（いぬい）',x:-201,z:-214},{n:'青屋口',d:'子（ね）',x:-55,z:-214},{n:'玉造口',d:'巽（たつみ）',x:155,z:204},{n:'大手口',d:'酉（とり）',x:-226,z:107}];
  const L3={ name:'二の丸の導火線', sub:'慶長二十年 四月 ・ 夜 ・ 二の丸', time:3, scen:null, limit:600, phases:5,
    story:'夏の陣を前に、城内の内通者が二の丸の大名屋敷に火薬の導火線を仕掛けた。書付を手がかりに三つの屋敷の導火線を切り、火薬樽を湿らせよ。手分けすれば早い。最後は逃げた内通者の行き先を突き止めて捕らえよ。',
    bounds:{x0:-238,x1:208,z0:-232,z1:212}, spawn:[-195,190,0],
    patrols:[{p:[[-120,-150],[40,-150]],s:1.8},{p:[[-80,-205],[-80,-158],[-30,-158],[-30,-205]],s:1.6,spr:'k_teppo'},{p:[[60,-210],[60,-160]],s:1.5},{p:[[-205,60],[-205,-120]],s:1.6},{p:[[0,150],[150,150]],s:1.7,spr:'k_teppo'},{p:[[100,40],[100,-100]],s:1.5},{p:[[-150,120],[-40,120]],s:1.6},{p:[[180,-120],[180,100]],s:1.5}],
    setup(){ return {kg:rint(KG_POS.length),corr:[rint(3),rint(3),rint(3)],exit:rint(EXITS.length)}; },
    build(s){ W.boss=npc('samurai_a',-200,182,'番頭'); W.kg=KG_POS.map(c=>{ const o=spot(c[0],c[1]); aSpr('kagaribi',o.x,o.y,o.z,{s:1.2}); return o; });
      W.rooms=DROOMS.map(d=>({R:room(d[0]),spots:roomProps(room(d[0]),d[2])}));
      W.well=spot(-150,-60); aSpr('bucket',W.well.x+1.2,W.well.y,W.well.z,{}); aSpr('w_bucket',W.well.x-1,W.well.y,W.well.z+.5,{}); W.powder=spot(120,-195); aSpr('barrels',W.powder.x,W.powder.y,W.powder.z,{s:1.3});
      W.exits=EXITS.map(e=>{ const o=spot(e.x,e.z); o.n=e.n; return o; }); },
    init(){ return {o:0,kg:KG_POS.map(()=>0),cut:[0,0,0],srch:[[0,0,0],[0,0,0],[0,0,0]],wet:0,need:nPl()>=2?2:1,wx:[0,0,0,0]}; },
    target(f,p){ if(near(p,W.boss)) return {k:'boss',l:'番頭に話を聞く',d:.15};
      if(f.o===1) for(let j=0;j<W.kg.length;j++) if(!f.kg[j]&&near(p,W.kg[j],3)) return {k:'kg'+j,l:'篝火のまわりを調べる',d:.5};
      if(f.o===2){ for(let r=0;r<3;r++){ if(f.cut[r]) continue; for(let i=0;i<3;i++){ const o=W.rooms[r].spots[i]; if(o&&!f.srch[r][i]&&near(p,o,2)) return {k:'s'+r+i,l:o.n+'を調べる',d:.7}; } }
        if(f.wet<f.need){ if(!p.carry&&near(p,W.well,3)) return {k:'fill',l:'井戸で水をくむ',d:.9}; if(p.carry==='水'&&near(p,W.powder,3.5)) return {k:'wet',l:'火薬樽に水をかける',d:.6}; } }
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='boss'){ if(f.o===3){ const e=EXITS[s.exit],m='番頭「見張りの話では、内通者は'+e.d+'の方角の口へ逃げたそうな」（子＝北、卯＝東、午＝南、酉＝西、乾＝北西、巽＝南東）'; note(m); event(m); f.o=4; return; }
        const m='番頭「内通者が二の丸の大名屋敷――広間・書院・奥座敷に導火線を仕掛けた。あやつは見回りの篝火のそばで、書付を落としていったらしい。火薬樽も井戸の水で湿らせておかねばならぬ」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k.startsWith('kg')){ const j=+k.slice(2); f.kg[j]=1; if(j===s.kg){ f.o=2; const m='内通者の書付「広間は'+DROOMS[0][3][s.corr[0]]+'、書院は'+DROOMS[1][3][s.corr[1]]+'、奥座敷は'+DROOMS[2][3][s.corr[2]]+'に仕掛けよ」'; note(m); event(p.n+'が篝火のそばで内通者の書付を拾った！ 手分けして導火線を切り、火薬樽を湿らせよ'); } else event('篝火のまわりには何もない'); }
      else if(k[0]==='s'){ const r=+k[1],i=+k[2]; f.srch[r][i]=1; if(i===s.corr[r]){ f.cut[r]=1; event(p.n+'が'+DROOMS[r][1]+'の'+DROOMS[r][2][i].n+'で導火線を切った！'); } else penalty(10,DROOMS[r][2][i].n+'には何もない'); }
      else if(k==='fill'){ p.carry='水'; }
      else if(k==='wet'){ p.carry=false; f.wet++; event('火薬樽を湿らせた（'+f.wet+' / '+f.need+'杯）'); }
      if(f.o===2&&f.cut.every(Boolean)&&f.wet>=f.need){ f.o=3; event('導火線も火薬樽も片付いた！ 番頭に知らせ、内通者の行き先を聞け'); } },
    drop(p){ p.carry=false; },
    tick(){ const f=G.f; if(f.o!==4) return; W.exits.forEach((o,i)=>{ if(i===SET.exit){ if(allIn(o,8)) finish(true,EXITS[i].n+'で内通者を取り押さえた。二の丸は火の海にならずにすんだ――'); } else if(!f.wx[i]&&inCount(o,6)>0){ f.wx[i]=1; penalty(15,EXITS[i].n+'には誰もいない……方角を考え直せ'); } }); },
    tasks(f,mine){ const rm=r=>{ const q=W.rooms[r]; if(P.room===q.R) return null; return doorAt(q.R,'大名屋敷（'+DROOMS[r][1]+'）'); }; return [
      Object.assign(tk('番頭の話を聞く',f.o>0,W.boss),{ph:0}),
      Object.assign(tk('見回りの篝火のそばで内通者の書付を探す',f.o>1,null),{ph:1,many:W.kg.filter((o,j)=>!f.kg[j]).map(o=>({x:o.x,z:o.z,n:'篝火'}))}),
      ...DROOMS.map((d,r)=>Object.assign(tk(d[1]+'の導火線を切る',f.cut[r],rm(r)),{ph:2})),
      Object.assign(tk(`井戸の水で火薬樽を湿らせる（${f.wet} / ${f.need}杯）`,f.wet>=f.need,mine&&mine.carry==='水'?{x:W.powder.x,z:W.powder.z,n:'火薬樽'}:{x:W.well.x,z:W.well.z,n:'井戸'}),{ph:2}),
      Object.assign(tk('番頭に知らせ、内通者の行き先を聞く',f.o>3,W.boss),{ph:3}),
      Object.assign(tk('方角を読み解き、内通者が逃げた口へ全員で向かう',false,null),{ph:4,many:W.exits.filter((o,i)=>!f.wx[i]).map(o=>({x:o.x,z:o.z,n:o.n}))})]; },
    roomHint(f){ if(f.o===2&&P.room&&W.rooms.some(q=>q.R===P.room)) return P.room.name.replace('大名屋敷の','')+'の中を調べよう'; if(f.o===4) return 'ミニマップは北が上。方角から口を選べ'; return ''; },
    arrowOverride(f){ if(f.o===4) return {n:'ミニマップは北が上。方角から口を選べ'}; return null; },
    glints(f){ const g=[]; if(f.o===1) W.kg.forEach((o,j)=>{ if(!f.kg[j]) g.push([o.x,o.y+2.6,o.z]); }); if(f.o===2){ W.rooms.forEach((q,r)=>{ if(!f.cut[r]) q.spots.forEach((o,i)=>{ if(o&&!f.srch[r][i]) g.push([o.x,o.y+1.3,o.z]); }); }); if(f.wet<f.need){ g.push([W.well.x,W.well.y+1.6,W.well.z]); g.push([W.powder.x,W.powder.y+2,W.powder.z]); } }
      if(f.o===4) W.exits.forEach((o,i)=>{ if(!f.wx[i]) g.push([o.x,o.y+3,o.z]); }); return g; },
    render(f,t){ bob(W.boss.q,f.o===0||f.o===3,t); },
    check(f){ return f.o>=2?[-150,-40]:[-195,190]; } };

  /* ---------- 其の四　裸城の宝（昼・本丸と二の丸） ---------- */
  const TREAS=[{n:'黄金の茶碗',spr:'ex_chawan_gold',d:'日の光を宿す器'},{n:'瓢箪',spr:'ex_hyotan',d:'太閤殿下の馬印と同じかたち'},{n:'松の茶壺',spr:'ex_tsubo_matsu',d:'常盤の木が描かれた壺'},{n:'伊万里の花瓶',spr:'ex_vase_imari',d:'海を渡ってきた染付'},{n:'太刀',spr:'ex_katana1',d:'鞘に眠る刃'},{n:'兜',spr:'ex_kabuto1',d:'戦場で頭を守るもの'}];
  const TORO=[{x:-120,z:182,n:'西の石灯籠',spr:'toro1'},{x:60,z:190,n:'南の石灯籠',spr:'toro2'},{x:150,z:120,n:'東の石灯籠',spr:'toro3'}];
  const L4={ name:'裸城の宝', sub:'慶長二十年 五月 ・ 昼 ・ 堀を埋められた本丸', time:1, scen:'natsu', phase:0, limit:600, phases:4,
    story:'堀を埋められた大坂城は、もはや裸城。長持の鍵を探す者と名物を選ぶ者に分かれ、本物の名物を長持に納めよ。荷車に積む者と半鐘で番兵の気をそらす者に分かれ、大手門から運び出せ。',
    bounds:{x0:-278,x1:208,z0:-100,z1:212}, spawn:[0,126,0],
    patrols:[{p:[[-200,150],[100,150]],s:1.8},{p:[[-44,14],[54,14]],s:1.5,spr:'k_ninja'},{p:[[-66,-6],[-66,66]],s:1.5,spr:'k_ninja'},{p:[[70,-40],[70,70]],s:1.4,spr:'k_ninja'},{p:[[-200,190],[-200,40]],s:1.6},{p:[[120,190],[120,40]],s:1.6,spr:'k_teppo'}],
    setup(){ return {order:shuffle([0,1,2,3,4,5]),real:shuffle([0,1,2,3,4,5]).slice(0,3),key:rint(3)}; },
    build(s){ W.mekiki=npc('shonin',14,124,'目利き'); W.box=spot(-8,128); aSpr('chest_k',W.box.x,W.box.y,W.box.z,{s:1.2}); W.toro=outSpots(TORO);
      const a=roomProps(room('千畳敷（表御殿の大広間）'),s.order.slice(0,3).map(i=>({n:TREAS[i].n,spr:TREAS[i].spr,s:1.3}))),b=roomProps(room('対面所（表御殿）'),s.order.slice(3).map(i=>({n:TREAS[i].n,spr:TREAS[i].spr,s:1.3})));
      W.items=[]; s.order.forEach((ti,k)=>{ W.items[ti]=(k<3?a[k]:b[k-3]); }); W.R1=room('千畳敷（表御殿の大広間）'); W.R2=room('対面所（表御殿）');
      W.cart=spot(-40,132); aSpr('cart',W.cart.x,W.cart.y,W.cart.z,{s:1.3}); W.hA=spot(W.cart.x-3.5,W.cart.z,{fixed:true}); W.hB=spot(W.cart.x+3.5,W.cart.z,{fixed:true});
      W.bell=spot(130,195); aSpr('bell',W.bell.x,W.bell.y,W.bell.z,{s:1.2}); W.ban=spot(-224,107); W.banIt=aSpr('k_yari',W.ban.x,W.ban.y,W.ban.z,{s:1.1}); W.banTag=aObj(nameTag('大手の番兵','#ff6b55')); W.banTag.position.set(W.ban.x,W.ban.y+3,W.ban.z);
      W.banBlk={x0:-240,x1:-220,z0:96,z1:118}; W.goal=spot(-252,107); },
    init(){ return {o:0,key:0,toro:[0,0,0],taken:[0,0,0,0,0,0],fake:[0,0,0,0,0,0],dl:0,cart:0,bell:0}; },
    target(f,p){ if(near(p,W.mekiki)) return {k:'mekiki',l:'目利きに話を聞く',d:.15};
      if(f.o===1){ if(!f.key) for(let i=0;i<3;i++) if(!f.toro[i]&&near(p,W.toro[i],2.8)) return {k:'toro'+i,l:W.toro[i].n+'の中を調べる',d:.6};
        if(!p.carry) for(let i=0;i<6;i++){ const o=W.items[i]; if(o&&!f.taken[i]&&!f.fake[i]&&near(p,o,2)) return {k:'it'+i,l:TREAS[i].n+'を手に取る',d:.5}; }
        if(p.carry==='宝物'&&near(p,W.box,3)) return f.key?{k:'put',l:'長持に納める',d:.5}:{k:'nokey',l:'長持には錠がかかっている',d:.2}; }
      if(f.o===2){ if(!f.cart){ if(near(p,W.hA,1.8)) return {k:'swA',l:'荷車の轅（ながえ）を持ち上げる',sw:1}; if(near(p,W.hB,1.8)) return {k:'swB',l:'荷車の轅（ながえ）を持ち上げる',sw:1}; } if(!f.bell&&near(p,W.bell,3)) return {k:'bell',l:'半鐘を打ち鳴らす',d:.8}; }
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='mekiki'){ const m='目利き「本物の名物は三つ――'+s.real.map(i=>TREAS[i].d).join('、')+'。それ以外は贋物じゃ。御殿の千畳敷と対面所にある。長持の鍵は、二の丸の石灯籠のどれかに隠しておいた」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k.startsWith('toro')){ const i=+k[4]; f.toro[i]=1; if(i===s.key){ f.key=1; event(p.n+'が'+TORO[i].n+'から長持の鍵を見つけた！ 長持の錠が開いた'); } else penalty(5,'この灯籠には何もない'); }
      else if(k.startsWith('it')){ const i=+k.slice(2); if(s.real.includes(i)){ f.taken[i]=1; p.carry='宝物'; p.ci=i; event(p.n+'が'+TREAS[i].n+'を手に取った。二の丸の長持へ運べ'); } else { f.fake[i]=1; penalty(10,TREAS[i].n+'は贋物だった'); } }
      else if(k==='nokey') event('長持には錠がかかっている。石灯籠の鍵が要る');
      else if(k==='put'){ p.carry=false; f.dl++; event('長持に名物を納めた（'+f.dl+' / 3）'); if(f.dl>=3){ f.o=2; event('名物はすべて納めた！ 荷車に積む者と、半鐘を鳴らす者に分かれよ'); } }
      else if(k==='bell'){ f.bell=1; event('半鐘が鳴り響く！ 大手の番兵が持ち場を離れた'); }
      if(f.o===2&&f.cart&&f.bell){ f.o=3; event('荷車の支度ができた！ 大手門から全員で城を出よ'); } },
    drop(p){ if(p.carry==='宝物'&&p.ci!==undefined){ G.f.taken[p.ci]=0; event('運んでいた名物は取り上げられ、御殿に戻された……'); } p.carry=false; },
    tick(dt){ const f=G.f; if(f.o===2&&!f.cart) swTick(['swA','swB'],dt,()=>{ f.cart=1; event('長持を荷車に積んだ！'); if(f.bell){ f.o=3; event('荷車の支度ができた！ 大手門から全員で城を出よ'); } }); if(f.o===3&&allIn(W.goal,9)) finish(true,'名物を積んだ荷車は、大手門から無事に運び出された――'); },
    block(x,z,f){ return !f.bell&&inR(W.banBlk,x,z,.2); },
    tasks(f,mine){ const dr=()=>{ if(P.room===W.R1||P.room===W.R2) return null; const c=[W.R1&&nearestDoor(W.R1),W.R2&&nearestDoor(W.R2)].filter(Boolean).sort((a,b)=>Math.hypot(a[0]-P.x,a[1]-P.z)-Math.hypot(b[0]-P.x,b[1]-P.z))[0]; return c?{x:c[0],z:c[1],n:'御殿の入口'}:null; }; return [
      Object.assign(tk('目利きの話を聞く',f.o>0,W.mekiki),{ph:0}),
      Object.assign(tk('二の丸の石灯籠から長持の鍵を探す',f.key,null),{ph:1,many:W.toro.filter((o,i)=>!f.toro[i]).map(o=>({x:o.x,z:o.z,n:o.n}))}),
      Object.assign(tk(`御殿から本物の名物を選び、長持へ納める（${f.dl} / 3）`,f.dl>=3,mine&&mine.carry==='宝物'?{x:W.box.x,z:W.box.z,n:'長持'}:dr()),{ph:1}),
      Object.assign(tk(nOnV()>1?'荷車の轅（ながえ）を二人で同時に持ち上げる':'荷車の轅を持ち上げる',f.cart,{x:W.cart.x,z:W.cart.z,n:'荷車'}),{ph:2}),
      Object.assign(tk('二の丸の東の半鐘を鳴らし、番兵の気をそらす',f.bell,{x:W.bell.x,z:W.bell.z,n:'半鐘'}),{ph:2}),
      Object.assign(tk('大手門から全員で城を出る',false,{x:W.goal.x,z:W.goal.z,n:'大手門'}),{ph:3})]; },
    roomHint(f){ if(f.o===1&&(P.room===W.R1||P.room===W.R2)) return '目利きの言葉で本物を見分けよう'; return ''; },
    glints(f){ const g=[]; if(f.o===1){ if(!f.key) W.toro.forEach((o,i)=>{ if(!f.toro[i]) g.push([o.x,o.y+2,o.z]); }); W.items.forEach((o,i)=>{ if(o&&!f.taken[i]&&!f.fake[i]) g.push([o.x,o.y+1.4,o.z]); }); g.push([W.box.x,W.box.y+1.6,W.box.z]); }
      if(f.o===2){ if(!f.cart){ g.push([W.hA.x,W.hA.y+1.2,W.hA.z]); g.push([W.hB.x,W.hB.y+1.2,W.hB.z]); } if(!f.bell) g.push([W.bell.x,W.bell.y+2.6,W.bell.z]); } return g; },
    render(f,t){ bob(W.mekiki.q,f.o===0,t); const gone=!!f.bell; if(W.banIt) crowd.move(W.banIt,gone?0:W.ban.x,gone?-999:W.ban.y,W.ban.z); W.banTag.visible=!gone; },
    check(f){ return f.o>=2?[-60,140]:[0,126]; } };

  /* ---------- 其の五　落城の夜（夜・本丸から大川へ） ---------- */
  const MON=[['桐','ki_kiri'],['菊','mon_kiku'],['瓢箪','ki_hyotan'],['巴','mon_tomoe'],['梅鉢','ki_umebachi'],['桜','mon_sakura']];
  const ORD=['壱','弐','参'];
  const CLUE_CAND=[[-66,32],[-34,76],[44,76],[68,26],[70,-52],[-66,-62],[-40,44]];
  const HIDES=[{n:'虎の屏風',spr:'by_tiger',r:'寅が見張っておる、その背の陰に'},{n:'掛け軸',spr:'kakejiku',r:'山と水が垂れ下がる、その裏に'},{n:'長持',spr:'chest_m',r:'衣が眠る箱の、そのまた底に'},{n:'違い棚',spr:'shelf',r:'高さの違う段の、いちばん上に'}];
  const GATES5={W:{x0:-76.5,x1:-53.5,z0:-80.2,z1:-78.8},E:{x0:69.5,x1:76.5,z0:-80.2,z1:-78.8}};
  const FIREBOX={x0:-30,x1:-18,z0:-108,z1:-100};
  const S5={swW:{x:-64,z:-76.5},swE:{x:72.5,z:-76.5},well:{x:2,z:-91},fire:{x:-24,z:-103.5},boat:{x:-54,z:-304},lock:{x:-58,z:-78.3}};
  const L5={ name:'落城の夜', sub:'慶長二十年 五月七日 ・ 夜 ・ 本丸から大川へ（侍女たちを落とす）', time:3, scen:'natsu', phase:3, keepFire:true, limit:900, phases:6,
    story:'徳川方が城内になだれ込み、天守は炎に包まれた。侍女たちを落ちのびさせよ。抜け道の絵図を探し、手分けして幟の家紋を集めて錠前を開け、閂を破り、極楽橋の火を消して、大川の小舟まで送り届けよ。',
    bounds:{x0:-160,x1:120,z0:-312,z1:100}, spawn:[0,-24,Math.PI*.98],
    patrols:[{p:[[-66,-6],[-66,-66]],s:1.5},{p:[[-44,14],[54,14]],s:1.6},{p:[[72,-6],[72,-66]],s:1.4,spr:'k_teppo'},{p:[[-44,-86],[46,-86]],s:1.15},{p:[[-120,-150],[40,-150]],s:1.9},{p:[[-80,-205],[-80,-158],[-30,-158],[-30,-205]],s:1.6,spr:'k_teppo'},{p:[[60,-210],[60,-160]],s:1.5},{p:[[-110,-268],[10,-268]],s:1.8},{p:[[-140,-235],[-140,-290]],s:1.4,spr:'k_teppo'}],
    setup(){ return {code:[rint(6),rint(6),rint(6)],clue:shuffle([...CLUE_CAND.keys()]).slice(0,3),hide:rint(4)}; },
    build(s){ const OKU=room('奥御殿'),CHA=room('山里丸の茶室'); W.OKU=OKU; W.CHA=CHA;
      W.hide=roomProps(OKU,HIDES.map(h=>({n:h.n,spr:h.spr}))); W.rope=CHA?roomProps(CHA,[{n:'茶道具の棚',spr:'shelf',s:.8}])[0]:null;
      W.npc0=npc('jijo',7,-19,'侍女'); W.npc1=npc('taore',-63,-44,'傷ついた兵',{th:1.9});
      W.clue=s.clue.map((ci,j)=>{ const o=spot(...CLUE_CAND[ci]); aSpr('t_nobori',o.x,o.y,o.z,{}); aSpr('kagaribi',o.x+1.4,o.y,o.z+.8,{}); aSpr(MON[s.code[j]][1],o.x-.9,o.y+.15,o.z+.5,{s:1.1}); const tg=aObj(textSprite(ORD[j],'#b32a1c','#fff',.9)); tg.position.set(o.x,o.y+4.6,o.z); o.tag=tg; return o; });
      W.gates={}; for(const k in GATES5){ const g=GATES5[k],w=g.x1-g.x0,d=g.z1-g.z0,grp=new THREE.Group(); const door=mesh(new THREE.BoxGeometry(w,3.4,d),M.darkwood); door.position.set(0,1.7,0); grp.add(door);
        for(let i=0;i<Math.floor(w/1.6);i++){ const st=mesh(new THREE.BoxGeometry(.12,3.5,d+.14),M.black||M.darkwood); st.position.set(-w/2+.8+i*1.6,1.75,0); grp.add(st); }
        const bar=mesh(new THREE.BoxGeometry(w+.4,.32,d+.5),M.wood||M.darkwood); bar.position.set(0,1.9,0); grp.add(bar);
        grp.position.set((g.x0+g.x1)/2,groundH((g.x0+g.x1)/2,(g.z0+g.z1)/2),(g.z0+g.z1)/2); grp.userData.by=grp.position.y; aObj(grp); W.gates[k]=grp; }
      { const g=W.gates.W,lk=mesh(new THREE.BoxGeometry(.7,.9,.45),M.gold||M.darkwood); lk.position.set(S5.lock.x-g.position.x,1.75,.85); g.add(lk); }
      { const wl=S5.well; const w=mesh(new THREE.CylinderGeometry(1.1,1.2,.9,16,1,true),M.stone); w.position.set(wl.x,.45,wl.z); aObj(w); const lid=mesh(new THREE.CylinderGeometry(1.05,1.05,.06,16),new THREE.MeshBasicMaterial({color:0x0a1420})); lid.position.set(wl.x,.7,wl.z); aObj(lid);
        for(const sg of [-1,1]){ const pp=mesh(new THREE.BoxGeometry(.16,2.4,.16),M.darkwood); pp.position.set(wl.x+sg*1.15,1.2,wl.z); aObj(pp); } const tp=mesh(new THREE.BoxGeometry(2.8,.18,.3),M.darkwood); tp.position.set(wl.x,2.4,wl.z); aObj(tp); aSpr('bucket',wl.x+1.6,0,wl.z+.6,{}); }
      W.boat=null; try{ const g=makeBoat(PROP,'river'); if(g&&g.position){ g.position.set(S5.boat.x,WATER_Y+.3,S5.boat.z-12); g.rotation.y=Math.PI/2; LIT.objs.push(g); W.boat=g; } }catch(e){}
      { const d=mesh(new THREE.BoxGeometry(6,.3,12),M.wood||M.darkwood); d.position.set(S5.boat.x,-.1,S5.boat.z-4); aObj(d); }
      W.bW=aObj(beam(0xffd36a)); W.bE=aObj(beam(0xffd36a)); W.bWell=aObj(beam(0x7cc8ff)); W.bFire=aObj(beam(0xff8a3a)); W.bBoat=aObj(beam(0x9effa8)); W.rW=aObj(ring(0xffd36a)); W.rE=aObj(ring(0xffd36a)); W.rBoat=aObj(ring(0x9effa8));
      for(const k of ['swW','swE','well','fire','boat','lock']) S5[k].y=groundH(S5[k].x,S5[k].z); W.fireLvl=-1; },
    init(){ return {o:0,talk0:0,talk1:0,srch:[0,0,0,0],clu:[0,0,0],lock:0,gate:0,rope:0,water:0,need:nPl()>=2?4:3,fire:1}; },
    target(f,p){
      if(f.o===0){ if(near(p,W.npc0,3)) return {k:'talk0',l:'侍女に話を聞く',d:.15}; for(let i=0;i<4;i++){ const h=W.hide[i]; if(h&&!f.srch[i]&&near(p,h,2)) return {k:'srch'+i,l:HIDES[i].n+'を調べる',d:.7}; } }
      if(f.o===1){ if(near(p,W.npc1,3)) return {k:'talk1',l:'傷ついた兵に話を聞く',d:.15}; for(let j=0;j<3;j++) if(!f.clu[j]&&near(p,W.clue[j],3.2)) return {k:'clue'+j,l:ORD[j]+'の幟を調べる',d:.3};
        if(near(p,S5.lock,3)) return {k:'lock',l:'錠前を開ける',d:.05}; }
      if(f.o===2){ if(near(p,S5.swW,2.6)) return {k:'swW',l:'西の閂を押さえる',sw:1}; if(near(p,S5.swE,2.6)) return {k:'swE',l:'東の閂を押さえる',sw:1}; }
      if(f.o===3){ if(W.rope&&near(p,W.rope,1.9)) return {k:'rope',l:'茶道具の棚を調べる',d:.6}; if(near(p,S5.well,3)) return {k:'well',l:'井戸を調べる',d:.2}; }
      if(f.o===4){ if(!p.carry&&near(p,S5.well,3)) return {k:'fill',l:'水をくむ',d:.9}; if(p.carry==='水'&&near(p,S5.fire,6.5)) return {k:'pour',l:'火に水をかける',d:.6}; }
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='talk0'){ const r=HIDES[s.hide].r; note('侍女「絵図は奥御殿に。'+r+'」'); f.talk0=1; event('侍女「抜け道の絵図は、奥御殿に隠してございます。'+r+'……」'); }
      else if(k.startsWith('srch')){ const i=+k.slice(4); f.srch[i]=1; if(i===s.hide){ f.o=1; note('絵図：山里丸から極楽橋を渡り、二の丸を抜けて大川へ'); event(p.n+'が'+HIDES[i].n+'から抜け道の絵図を見つけた！ だが山里丸への門には錠前が……'); } else penalty(10,HIDES[i].n+'を調べたが、何もなかった……'); }
      else if(k==='talk1'){ const m='兵「山里丸の門の錠前は、家紋を三つ合わせねば開かぬ。本丸のどこかに壱・弐・参と記した幟が立っておる……その順に合わせよ」'+(nOn()>=2?'「錠が外れても、閂は西と東に二つ。同時に押さえねば動かぬ」':''); note(m); f.talk1=1; event(m); }
      else if(k.startsWith('clue')){ const j=+k.slice(4); if(!f.clu[j]){ f.clu[j]=1; const mn=MON[s.code[j]][0]; note(ORD[j]+'の幟の家紋は「'+mn+'」'); event(p.n+'が'+ORD[j]+'の幟を見つけた。家紋は「'+mn+'」'); } }
      else if(k==='well'){ if(f.rope<1){ f.rope=1; note('井戸の釣瓶の縄が切れている。山里丸の茶室に替えがあるかもしれない'); } event('釣瓶の縄が切れている……。山里丸の茶室に替えの縄はないか？'); }
      else if(k==='rope'){ f.rope=2; f.o=4; note('茶室で替えの縄を見つけ、井戸に付けた'); event(p.n+'が茶室で替えの縄を見つけた！ 井戸で水をくみ、極楽橋の火を消せ'); }
      else if(k==='fill'){ p.carry='水'; }
      else if(k==='pour'){ p.carry=false; f.water++; if(f.water>=f.need){ f.fire=0; f.o=5; event('極楽橋の火が消えた！ 二の丸を抜けて大川の舟をめざせ'); } else event('火が弱まった（あと'+(f.need-f.water)+'杯）'); } },
    lock(){ const f=V.f; return {title:'山里丸の門の錠前',sub:'家紋の輪を回して、三つ合わせよ。',slots:3,syms:MON.map(m=>m[0]),known:'わかっている家紋：'+ORD.map((o,j)=>o+'＝'+(f.clu[j]?MON[SET.code[j]][0]:'？')).join('　')}; },
    code(v){ const f=G.f; if(f.o!==1) return; if(v.every((x,i)=>x===SET.code[i])){ f.lock=1; f.o=2; event('カチリ――錠前が外れた！ '+(nOn()>=2?'西と東の閂を同時に押さえろ':'閂を押さえて門を開けろ')); } else penalty(15,'錠前はびくともしない……家紋の組み合わせが違うようだ'); },
    drop(p){ p.carry=false; },
    tick(dt){ const f=G.f;
      if(f.o===2) swTick(['swW','swE'],dt,()=>{ f.gate=1; f.o=3; event('閂が外れた！ 山里丸へ。極楽橋が燃えている――井戸を調べよ'); });
      if(f.o===5){ const all=G.pl.filter(p=>!p.off).every(p=>!p.cap&&Math.hypot(p.x-S5.boat.x,p.z-S5.boat.z)<7); if(all){ G.winT=(G.winT||0)+dt; if(G.winT>2) finish(true,'侍女たちを乗せた小舟は、燃える大坂城をあとに大川を下っていった。だが舟は一艘きり――残る者は京橋口をめざす'); } else G.winT=0; } },
    block(x,z,f){ if(!f.gate&&(inR(GATES5.W,x,z,.3)||inR(GATES5.E,x,z,.3))) return true; if(f.fire&&inR(FIREBOX,x,z,.2)) return true; return false; },
    tasks(f,mine){ const OKU=W.OKU,CHA=W.CHA; const n=V.pl.filter(p=>!p.cap&&Math.hypot(p.x-S5.boat.x,p.z-S5.boat.z)<7).length;
      const dw=Math.hypot(P.x-S5.swW.x,P.z-S5.swW.z),de=Math.hypot(P.x-S5.swE.x,P.z-S5.swE.z);
      return [
      Object.assign(tk('侍女の謎かけを聞く',f.talk0,W.npc0,true),{ph:0}),
      Object.assign(tk('奥御殿で抜け道の絵図を探す',f.o>0,OKU&&P.room!==OKU?{x:OKU.exitPos[0],z:OKU.exitPos[1]-1.5,n:'奥御殿'}:null),{ph:0}),
      Object.assign(tk('傷ついた兵の話を聞く',f.talk1,W.npc1,true),{ph:1}),
      ...ORD.map((o,j)=>Object.assign(tk(o+'の幟の家紋を調べる',f.clu[j],null),{ph:1})),
      Object.assign(tk('山里丸の門の錠前を開ける',f.lock,f.clu.every(Boolean)?{x:S5.lock.x,z:S5.lock.z,n:'錠前'}:null),{ph:1}),
      Object.assign(tk(nOnV()>1?'西と東の閂を同時に押さえる':'閂を押さえて門を開ける',f.gate,dw<=de?{x:S5.swW.x,z:S5.swW.z,n:'西の閂'}:{x:S5.swE.x,z:S5.swE.z,n:'東の閂'}),{ph:2}),
      Object.assign(tk('井戸を調べる',f.rope>=1,{x:S5.well.x,z:S5.well.z,n:'井戸'},true),{ph:3}),
      Object.assign(tk('茶室で替えの縄を見つける',f.rope>=2,CHA&&P.room!==CHA?{x:CHA.exitPos[0],z:CHA.exitPos[1]-1.2,n:'山里丸の茶室'}:null),{ph:3}),
      Object.assign(tk(`井戸の水で極楽橋の火を消す（${f.water} / ${f.need}杯）`,!f.fire,mine&&mine.carry==='水'?{x:S5.fire.x,z:S5.fire.z,n:'極楽橋の火'}:{x:S5.well.x,z:S5.well.z,n:'井戸'}),{ph:4}),
      Object.assign(tk('侍女たちの小舟まで全員で送り届ける'+(n?`（舟に ${n} / ${V.pl.length}人）`:''),false,{x:S5.boat.x,z:S5.boat.z,n:'大川の小舟'}),{ph:5})]; },
    roomHint(f){ if(f.o===0&&P.room===W.OKU) return '侍女の言葉をたよりに、部屋を調べよう'; if(f.o===1&&f.clu.filter(Boolean).length<3) return '幟は本丸のどこかに立っている'; if(f.o===3&&P.room===W.CHA) return '茶室の中を調べよう'; return ''; },
    glints(f){ const g=[]; if(f.o===0) W.hide.forEach((h,i)=>{ if(h&&!f.srch[i]) g.push([h.x,h.y+1.3,h.z]); });
      if(f.o===1){ g.push([S5.lock.x,S5.lock.y+1.9,S5.lock.z+1]); W.clue.forEach((c,j)=>{ if(!f.clu[j]) g.push([c.x,c.y+3.4,c.z]); }); }
      if(f.o===3&&W.rope&&f.rope<2) g.push([W.rope.x,W.rope.y+1.1,W.rope.z]); return g; },
    render(f,t,dt){ bob(W.npc0.q,f.o===0&&!f.talk0,t); bob(W.npc1.q,f.o===1&&!f.talk1,t); W.clue.forEach((c,j)=>{ c.tag.material.opacity=f.clu[j]?.45:1; });
      const show=(m,on,o,y)=>{ m.visible=!!on; if(on) m.position.set(o.x,y!==undefined?y:o.y,o.z); };
      const sw=f.o===2; show(W.bW,sw,S5.swW); show(W.bE,sw,S5.swE); show(W.rW,sw,S5.swW,S5.swW.y+.05); show(W.rE,sw,S5.swE,S5.swE.y+.05);
      W.rW.material.color.set(V.sw&&V.sw.swW?0x9effa8:0xffd36a); W.rE.material.color.set(V.sw&&V.sw.swE?0x9effa8:0xffd36a);
      show(W.bWell,f.o===3||f.o===4,S5.well); show(W.bFire,f.o===4,S5.fire); show(W.bBoat,f.o===5,S5.boat); show(W.rBoat,f.o===5,S5.boat,S5.boat.y+.05);
      for(const k in W.gates){ const g=W.gates[k]; if(f.gate&&g.visible){ g.position.y-=dt*1.4; if(g.position.y<g.userData.by-3.6) g.visible=false; } }
      const lvl=f.fire?Math.max(.25,1-f.water/f.need):0; if(lvl!==W.fireLvl){ W.fireLvl=lvl; if(lvl>0){ fxSet('bf',{type:'blaze',x:S5.fire.x,y:.4,z:S5.fire.z,r:1.5+1.7*lvl,h:3.5,rate:34*lvl,ring:false}); fxSet('bs',{type:'column',x:S5.fire.x,y:3,z:S5.fire.z,r:4,rate:3}); } else { fxSet('bf',null); fxSet('bs',null); } }
      if(W.boat) W.boat.position.y=WATER_Y+.3+Math.sin(t*1.3)*.08; },
    check(f){ return [[0,-24],[-64,-30],[-64,-70],[-62,-90],[-62,-90],[-24,-136]][f.o]; } };

  /* =====================================================================
     後半の面の道具
     ===================================================================== */
  function makeWell(x,z){ const o=spot(x,z); const w=mesh(new THREE.CylinderGeometry(1.1,1.2,.9,16,1,true),M.stone); w.position.set(o.x,o.y+.45,o.z); aObj(w); const lid=mesh(new THREE.CylinderGeometry(1.05,1.05,.06,16),new THREE.MeshBasicMaterial({color:0x0a1420})); lid.position.set(o.x,o.y+.7,o.z); aObj(lid);
    for(const sg of [-1,1]){ const pp=mesh(new THREE.BoxGeometry(.16,2.4,.16),M.darkwood); pp.position.set(o.x+sg*1.15,o.y+1.2,o.z); aObj(pp); } const tp=mesh(new THREE.BoxGeometry(2.8,.18,.3),M.darkwood); tp.position.set(o.x,o.y+2.4,o.z); aObj(tp); aSpr('bucket',o.x+1.6,o.y,o.z+.6,{}); return o; }
  /* 柵（竹束など）を線の上に並べる。歩ける所にだけ置く */
  function fenceLine(x0,z0,x1,z1,spr,step,skip){ const L=Math.hypot(x1-x0,z1-z0),n=Math.ceil(L/step); for(let i=0;i<=n;i++){ const x=x0+(x1-x0)*i/n,z=z0+(z1-z0)*i/n; if(skip&&inR(skip,x,z,1)) continue; if(!_walkable(x,z)) continue; aSpr(spr,x,groundH(x,z),z,{s:1}); } }
  /* 開け閉めする門扉（rect の上に板戸を立てる） */
  function doorMesh(r){ const w=Math.max(.4,r.x1-r.x0),d=Math.max(.4,r.z1-r.z0),grp=new THREE.Group(); const door=mesh(new THREE.BoxGeometry(w,3.4,d),M.darkwood); door.position.set(0,1.7,0); grp.add(door);
    const long=Math.max(w,d); for(let i=0;i<Math.floor(long/1.6);i++){ const st=mesh(new THREE.BoxGeometry(w>d?.12:w+.14,3.5,w>d?d+.14:.12),M.black||M.darkwood); if(w>d) st.position.set(-w/2+.8+i*1.6,1.75,0); else st.position.set(0,1.75,-d/2+.8+i*1.6); grp.add(st); }
    const bar=mesh(new THREE.BoxGeometry(w>d?w+.4:w+.5,.32,w>d?d+.5:d+.4),M.wood||M.darkwood); bar.position.set(0,1.9,0); grp.add(bar);
    const cx=(r.x0+r.x1)/2,cz=(r.z0+r.z1)/2; grp.position.set(cx,groundH(cx,cz),cz); grp.userData.by=grp.position.y; aObj(grp); return grp; }
  function doorSet(g,open,dt){ if(!g) return; const ty=open?g.userData.by-3.6:g.userData.by; g.position.y+=(ty-g.position.y)*Math.min(1,dt*3); g.visible=g.position.y>g.userData.by-3.5; }
  /* 灯り・火・時間の門の見た目（どの面でも同じ） */
  function stdRender(f,t,dt){
    if(W.lamps&&f.lamp) W.lamps.forEach((L,i)=>{ const on=!!f.lamp[i]; if(L.on!==on){ L.on=on; fxSet('lamp'+i,on?{type:'blaze',x:L.x,y:L.y+(L.h||1.1),z:L.z,r:.35,h:1.1,rate:9,ring:false}:null); } });
    if(f.fires) f.fires.forEach((q,i)=>{ const r=q.r>.6?q.r:0,k=Math.round(r*3)/3; if(W['fz'+i]!==k){ W['fz'+i]=k; if(k>0){ const y=groundH(q.x,q.z); fxSet('fire'+i,{type:'blaze',x:q.x,y:y+.3,z:q.z,r:k*.8,h:3.2+k*.25,rate:Math.min(60,10+k*5),ring:false}); fxSet('smk'+i,{type:'column',x:q.x,y:y+3,z:q.z,r:2+k*.5,rate:2+k*.3}); } else { fxSet('fire'+i,null); fxSet('smk'+i,null); } } });
    if(LV.tgates&&W.tg){ const el=curEl(); LV.tgates.forEach((g,i)=>doorSet(W.tg[i],gateOpen(g,el).open,dt)); } }
  function lampOps(f,p){ if(!W.lamps) return null; for(let i=0;i<W.lamps.length;i++){ const L=W.lamps[i]; if(near(p,L,2.4)) return f.lamp[i]?{k:'lampoff'+i,l:(L.n||'灯り')+'を消す',d:.5}:{k:'lampon'+i,l:(L.n||'灯り')+'をつける',d:.5}; } return null; }
  function lampDo(k){ if(k.startsWith('lampoff')){ G.f.lamp[+k.slice(7)]=0; return true; } if(k.startsWith('lampon')){ G.f.lamp[+k.slice(6)]=1; return true; } return false; }
  function makeLamps(list,spr){ W.lamps=list.map(d=>{ const o=spot(d[0],d[1]); aSpr(spr||'kagaribi',o.x,o.y,o.z,{s:1}); o.n=d[2]||'篝火'; o.r=d[3]||11; o.h=spr==='andon'?1.0:1.5; return o; }); }
  /* 火に水をかける（共通） */
  function firePour(f,p){ if(!f.fires||p.carry!=='水') return null; for(let i=0;i<f.fires.length;i++){ const q=f.fires[i]; if(q.r>.6&&dist(p.x,p.z,q.x,q.z)<q.r+3.2) return {k:'pour'+i,l:'火に水をかける',d:.6}; } return null; }
  function fireDo(k,p){ if(!k.startsWith('pour')) return false; const q=G.f.fires[+k.slice(4)]; p.carry=false; q.r=Math.max(0,q.r-(q.cut||2.4)); if(q.r<1.2){ q.r=0; event(p.n+'が火を消し止めた！'); } else event('火が弱まった……もう一杯！'); return true; }
  const fireTask=(f,i,label,mine,src)=>{ const q=f.fires[i]; return tk(label+(q.r>0?`（火の大きさ ${Math.round(q.r)}）`:''),q.r<=0,mine&&mine.carry==='水'?{x:q.x,z:q.z,n:'火元'}:src); };

  /* ---------- 其の五　城下の火付け（夜・城下町の東） ---------- */
  const N5_SPOTS=[{x:142,z:600,n:'天水桶',spr:'jar'},{x:222,z:578,n:'薪の山',spr:'log'},{x:262,z:658,n:'荷車',spr:'cart2'},{x:142,z:738,n:'俵の山',spr:'tawara'},{x:420,z:622,n:'木箱',spr:'crates'},{x:482,z:702,n:'苫をかけた小舟',spr:'barrels'},{x:362,z:762,n:'地蔵堂の陰',spr:'kasa'}];
  const N5_TORCH=[[360,526],[522,600],[446,756]];
  const N5={ name:'城下の火付け', sub:'慶長二十年 五月五日 ・ 夜 ・ 上町の城下（東）', time:3, scen:null, limit:720, phases:5, img:'win1',
    noise:true, relight:true, heavy:['焙烙玉'], carrySpr:{'焙烙玉':'pot'}, searchT:9,
    story:'徳川方の忍びが、城下に焙烙玉（火薬の玉）を仕掛けた。走れば足音で気づかれ、篝火の明かりの下では見つかりやすい。灯りを消して闇にまぎれ、焙烙玉を井戸に沈めよ。重い焙烙玉を抱えている間は走れない。',
    bounds:{x0:120,x1:560,z0:440,z1:850}, spawn:[300,792,0],
    patrols:[{p:[[140,576],[290,576]],s:1.6,spr:'k_ninja'},{p:[[300,470],[300,770]],s:1.5},{p:[[140,656],[290,656]],s:1.5,spr:'k_ninja'},{p:[[140,736],[290,736]],s:1.6},{p:[[140,470],[140,780]],s:1.4,spr:'k_ninja'},{p:[[340,530],[540,530],[540,690],[340,690]],s:1.6,spr:'k_ninja'},{p:[[460,470],[460,780]],s:1.5},{p:[[330,616],[550,616]],s:1.7,spr:'k_ninja'}],
    setup(){ const sp=shuffle([0,1,2,3,4,5,6]); return {bomb:sp.slice(0,3),wit:[sp[0],sp[1]]}; },
    build(s){ W.boss=npc('touryou',306,782,'火消しの頭'); W.wA=npc('w_red',150,700,'町娘'); W.wB=npc('w_yoke',440,560,'棒手振り');
      W.sp=outSpots(N5_SPOTS); W.well=makeWell(300,618); W.kido=spot(492,546); aSpr('jin_gate',W.kido.x,W.kido.y,W.kido.z,{s:1.1}); W.kTag=aObj(nameTag('忍びの隠れ家の木戸','#ff6b55')); W.kTag.position.set(W.kido.x,W.kido.y+3.4,W.kido.z);
      W.torch=N5_TORCH.map(c=>{ const o=spot(...c); aSpr('torch_pole',o.x,o.y,o.z,{}); return o; }); W.goal=spot(300,454);
      makeLamps([[140,580,'辻の篝火'],[300,580,'番所の篝火'],[140,700,'辻の篝火'],[300,700,'辻の篝火'],[420,660,'畑の篝火'],[300,500,'木戸の篝火'],[500,600,'畑の篝火']]);
      W.bKido=aObj(beam(0xff8a3a)); W.bGoal=aObj(beam(0x9effa8)); },
    init(){ return {o:0,wa:0,wb:0,srch:[0,0,0,0,0,0,0],got:0,sunk:0,kido:0,torch:[0,0,0],lamp:[1,1,1,1,1,1,1]}; },
    target(f,p){ if(near(p,W.boss)) return {k:'boss',l:'火消しの頭に話を聞く',d:.15};
      const lo=lampOps(f,p); if(lo) return lo;
      if(f.o===1){ if(!f.wa&&near(p,W.wA)) return {k:'wa',l:'町娘に話を聞く',d:.15}; if(!f.wb&&near(p,W.wB)) return {k:'wb',l:'棒手振りに話を聞く',d:.15};
        if(p.carry==='焙烙玉'&&near(p,W.well,3)) return {k:'sink',l:'焙烙玉を井戸に沈める',d:.8};
        if(!p.carry) for(let i=0;i<W.sp.length;i++) if(!f.srch[i]&&near(p,W.sp[i],2.6)) return {k:'srch'+i,l:W.sp[i].n+'を調べる',d:.8}; }
      if(f.o===2&&near(p,W.kido,3)) return {k:'kido',l:'木戸の閂を外す（5秒・見つかるとやり直し）',d:5,hold:{key:'kido',int:'reset'}};
      if(f.o===3) for(let i=0;i<3;i++) if(!f.torch[i]&&near(p,W.torch[i],2.6)) return {k:'torch'+i,l:'合図の松明を消す',d:.8};
      return null; },
    complete(p,k){ const f=G.f,s=SET; if(lampDo(k)) return;
      if(k==='boss'){ const m='火消しの頭「忍びどもが焙烙玉を三つ仕掛けおった。見つけたら番所の脇の井戸に沈めてくれ。走ると足音で気づかれるぞ。篝火を消せば闇にまぎれられるが、見張りはまたつけに来る」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k==='wa'){ f.wa=1; const m='町娘「黒い影が「'+N5_SPOTS[s.wit[0]].n+'」のあたりで、何かを隠していたの」'; note(m); event(m); }
      else if(k==='wb'){ f.wb=1; const m='棒手振り「夜中に「'+N5_SPOTS[s.wit[1]].n+'」の陰でごそごそしとる奴がおった。それと、まだ他にもあるはずだ」'; note(m); event(m); }
      else if(k.startsWith('srch')){ const i=+k.slice(4); f.srch[i]=1; if(s.bomb.includes(i)){ p.carry='焙烙玉'; p.bi=i; event(p.n+'が'+N5_SPOTS[i].n+'から焙烙玉を見つけた！ 重いので走れない。井戸へ運べ'); } else { penalty(6,N5_SPOTS[i].n+'には何もなかった'); } }
      else if(k==='sink'){ p.carry=false; f.sunk++; event('焙烙玉を井戸に沈めた（'+f.sunk+' / 3）'); if(f.sunk>=3){ f.o=2; event('焙烙玉はすべて片付いた！ 東の畑の奥、忍びの隠れ家の木戸を開けよ'); note('忍びの隠れ家は東の畑の奥。木戸の閂は5秒かかる。見つかるとやり直し'); } }
      else if(k==='kido'){ f.kido=1; f.o=3; const m='隠れ家はもぬけの殻……だが帳面が残っていた。「三本の松明で城の南へ合図を送れ」――松明を消して合図を止めよ'; note(m); event(m); }
      else if(k.startsWith('torch')){ f.torch[+k.slice(5)]=1; const n=f.torch.filter(Boolean).length; event('合図の松明を消した（'+n+' / 3）'); if(n>=3){ f.o=4; event('合図は止まった！ 北の三の丸の虎口へ、全員で知らせに走れ'); } } },
    drop(p){ if(p.carry==='焙烙玉'&&p.bi!==undefined){ G.f.srch[p.bi]=0; event('焙烙玉を取り落とした……元の場所に戻された'); } p.carry=false; },
    tick(dt){ if(G.f.o===4&&allIn(W.goal,9)) finish(true,'焙烙玉の火付けは防がれた。城下は今夜も燃えずにすんだ――'); },
    tasks(f,mine){ const left=W.sp.map((o,i)=>i).filter(i=>!f.srch[i]); return [
      Object.assign(tk('火消しの頭の話を聞く',f.o>0,W.boss),{ph:0}),
      Object.assign(tk('町娘に話を聞く',f.wa,W.wA,true),{ph:1}), Object.assign(tk('棒手振りに話を聞く',f.wb,W.wB,true),{ph:1}),
      Object.assign(tk(`焙烙玉を探し、井戸に沈める（${f.sunk} / 3）`,f.sunk>=3,mine&&mine.carry==='焙烙玉'?{x:W.well.x,z:W.well.z,n:'井戸'}:null),{ph:1,many:mine&&mine.carry?[]:left.map(i=>({x:W.sp[i].x,z:W.sp[i].z,n:W.sp[i].n}))}),
      Object.assign(tk('忍びの隠れ家の木戸を開ける（5秒・見つかるとやり直し）',f.kido,{x:W.kido.x,z:W.kido.z,n:'木戸'}),{ph:2}),
      ...[0,1,2].map(i=>Object.assign(tk('合図の松明を消す',f.torch[i],{x:W.torch[i].x,z:W.torch[i].z,n:'松明'}),{ph:3})),
      Object.assign(tk('三の丸の虎口へ全員で知らせる',false,{x:W.goal.x,z:W.goal.z,n:'三の丸の虎口'}),{ph:4})]; },
    status(f){ return [lampDark(f,P.x,P.z)?'闇の中（見つかりにくい）':'']; },
    glints(f){ const g=[]; if(f.o===1){ W.sp.forEach((o,i)=>{ if(!f.srch[i]) g.push([o.x,o.y+1.6,o.z]); }); g.push([W.well.x,W.well.y+2,W.well.z]); } if(f.o===3) W.torch.forEach((o,i)=>{ if(!f.torch[i]) g.push([o.x,o.y+3,o.z]); }); return g; },
    render(f,t,dt){ bob(W.boss.q,f.o===0,t); bob(W.wA.q,f.o===1&&!f.wa,t); bob(W.wB.q,f.o===1&&!f.wb,t); stdRender(f,t,dt);
      W.bKido.visible=f.o===2; if(f.o===2) W.bKido.position.set(W.kido.x,W.kido.y,W.kido.z); W.bGoal.visible=f.o===4; if(f.o===4) W.bGoal.position.set(W.goal.x,W.goal.y,W.goal.z);
      W.torch.forEach((o,i)=>{ const on=!f.torch[i]; if(o.on!==on){ o.on=on; fxSet('tch'+i,on?{type:'blaze',x:o.x,y:o.y+3,z:o.z,r:.3,h:1,rate:10,ring:false}:null); } }); },
    check(f){ return [[300,792],[300,700],[440,600],[420,620],[300,520]][f.o]; } };

  /* ---------- 其の六　天王寺口の伝令（朝・惣構の南の野） ---------- */
  const N6_FENCE=1040, N6_DOOR={x0:-398,x1:-382,z0:1037,z1:1043};
  const N6_SASHI=[{x:-560,z:930,n:'陣小屋の長持',spr:'chest'},{x:-250,z:960,n:'陣幕の陰の具足櫃',spr:'box_l'},{x:-470,z:1000,n:'竹束の山',spr:'taketaba_a'}];
  const N6={ name:'天王寺口の伝令', sub:'慶長二十年 五月七日 ・ 朝 ・ 惣構の南の野', time:0, scen:'natsu', phase:2, limit:720, phases:5, img:'win2',
    noise:true, heavy:['玉薬箱'], carrySpr:{'玉薬箱':'box_s'}, searchT:9,
    shift:{every:45,dur:15,who:[5,6,7],post:{x:-170,z:1190}},
    tgates:[{rect:N6_DOOR,every:30,open:9,n:'竹束の柵の木戸',push:[0,-1]}],
    story:'決戦の朝。真田信繁（幸村）の軍令を、柵の外の茶臼山の陣へ届けよ。柵の木戸は徳川方の鉄砲の合間にしか開かない。狼煙台の見張りは、交代の刻だけ持ち場を離れる。',
    bounds:{x0:-640,x1:-140,z0:866,z1:1208}, spawn:[-380,884,Math.PI],
    patrols:[{p:[[-620,960],[-170,960]],s:1.7,spr:'k_ninja'},{p:[[-620,1018],[-170,1018]],s:1.5,spr:'k_ninja'},{p:[[-600,1070],[-170,1070]],s:1.7},{p:[[-600,1125],[-330,1125]],s:1.6,spr:'k_teppo'},{p:[[-450,1060],[-450,1200]],s:1.5},{p:[[-300,1120],[-200,1120],[-200,1196],[-300,1196]],s:1.5,spr:'k_teppo'},{p:[[-270,1100],[-180,1100]],s:1.4},{p:[[-320,1160],[-320,1080]],s:1.4,spr:'k_teppo'}],
    block(x,z,f){ return Math.abs(z-N6_FENCE)<1.6&&!inR(N6_DOOR,x,z,.3); },
    eblock(x,z,f){ return Math.abs(z-N6_FENCE)<2.2; },
    setup(){ return {sashi:rint(3)}; },
    build(s){ W.tsuka=npc('tsukaiban',-372,900,'真田の使番'); W.sp=outSpots(N6_SASHI); W.ammo=spot(-200,900); aSpr('crates',W.ammo.x,W.ammo.y,W.ammo.z,{s:1.2}); aSpr('box_s',W.ammo.x+1.5,W.ammo.y,W.ammo.z+.6,{});
      W.mori=npc('t_teppo',-560,1012,'毛利の鉄砲頭'); aSpr('teppo_line',-548,groundH(-548,1014),1014,{}); W.sanada=npc('sanada',-604,1180,'真田の陣（茶臼山）'); for(const [x,z] of [[-616,1166],[-590,1196],[-620,1196]]) aSpr('nb_rokumon',x,groundH(x,z),z,{});
      W.noroshi=spot(-250,1160); aSpr('yagura',W.noroshi.x,W.noroshi.y,W.noroshi.z,{s:1}); W.nTag=aObj(nameTag('狼煙台','#ff6b55')); W.nTag.position.set(W.noroshi.x,W.noroshi.y+6,W.noroshi.z);
      fenceLine(-640,N6_FENCE,-140,N6_FENCE,'taketaba',3.2,N6_DOOR); W.tg=[doorMesh(N6_DOOR)];
      for(const [x,z] of [[-200,1190],[-160,1150],[-180,1110]]) aSpr('k_nobori',x,groundH(x,z),z,{});
      for(const [x,z] of [[-380,1300],[-250,1320],[-520,1290]]) fxSet('bg'+x,{type:'column',x,y:2,z,r:14,rate:3});
      W.goal=spot(-380,880); W.bN=aObj(beam(0xff8a3a)); },
    init(){ return {o:0,sashi:0,srch:[0,0,0],ammo:0,sanada:0,smoke:0}; },
    target(f,p){ if(near(p,W.tsuka)) return {k:'tsuka',l:'真田の使番に話を聞く',d:.15};
      if(f.o===1){ if(!f.sashi) for(let i=0;i<3;i++) if(!f.srch[i]&&near(p,W.sp[i],2.6)) return {k:'srch'+i,l:N6_SASHI[i].n+'を調べる',d:.8};
        if(!p.carry&&f.ammo<2&&near(p,W.ammo,3)) return {k:'take',l:'玉薬箱を担ぐ',d:.6}; if(p.carry==='玉薬箱'&&near(p,W.mori,3.2)) return {k:'give',l:'毛利の鉄砲頭に玉薬箱を渡す',d:.5}; }
      if(f.o===2&&near(p,W.sanada,3.2)) return {k:'sanada',l:'真田の陣に軍令を届ける',d:.4};
      if(f.o===3&&near(p,W.noroshi,3.2)) return {k:'smoke',l:'狼煙を上げる（5秒・見つかるとやり直し）',d:5,hold:{key:'smoke',int:'reset'}};
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='tsuka'){ const m='使番「この軍令を茶臼山の真田の陣へ。だが使番の指物（はたじるし）なしでは味方に討たれる。指物は陣のどこかに置いた――長持か、具足櫃か、竹束の山か。それと、毛利の鉄砲隊が玉薬（たまぐすり）を待っておる。玉薬箱を二つ運んでやってくれ」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k.startsWith('srch')){ const i=+k.slice(4); f.srch[i]=1; if(i===s.sashi){ f.sashi=1; event(p.n+'が使番の指物を見つけた！'); } else penalty(6,N6_SASHI[i].n+'に指物はなかった'); }
      else if(k==='take'){ p.carry='玉薬箱'; event(p.n+'が玉薬箱を担いだ。重くて走れない'); }
      else if(k==='give'){ p.carry=false; f.ammo++; event('毛利の鉄砲隊に玉薬を届けた（'+f.ammo+' / 2）'); }
      else if(k==='sanada'){ f.sanada=1; f.o=3; const m='真田の陣「軍令、しかと受け取った。敵の目をそらすため、東の狼煙台に火を入れてくれ。見張りは交代の刻だけ持ち場を離れる」'; note(m); event(m); }
      else if(k==='smoke'){ f.smoke=1; f.o=4; event('狼煙が上がった！ 柵の木戸を抜けて、惣構まで全員で戻れ'); }
      if(f.o===1&&f.sashi&&f.ammo>=2){ f.o=2; event('支度はそろった！ 柵の木戸は鉄砲の合間にしか開かない。開いた隙に抜けて、茶臼山の真田の陣へ'); note('柵の木戸は30秒ごとに9秒だけ開く'); } },
    drop(p){ if(p.carry==='玉薬箱') event('玉薬箱を取り落とした……荷駄からもう一度運べ'); p.carry=false; },
    tick(dt){ if(G.f.o===4&&allIn(W.goal,10)) finish(true,'狼煙は上がり、軍令は届いた。真田の赤備えが、家康の本陣めがけて駆け出した――'); },
    tasks(f,mine){ return [
      Object.assign(tk('真田の使番に話を聞く',f.o>0,W.tsuka),{ph:0}),
      Object.assign(tk('陣のどこかから使番の指物を探す',f.sashi,null),{ph:1,many:f.sashi?[]:W.sp.filter((o,i)=>!f.srch[i]).map(o=>({x:o.x,z:o.z,n:o.n}))}),
      Object.assign(tk(`毛利の鉄砲隊へ玉薬箱を運ぶ（${f.ammo} / 2）`,f.ammo>=2,mine&&mine.carry==='玉薬箱'?{x:W.mori.x,z:W.mori.z,n:'毛利の鉄砲頭'}:{x:W.ammo.x,z:W.ammo.z,n:'荷駄の玉薬箱'}),{ph:1}),
      Object.assign(tk('柵の木戸が開いた隙に抜け、茶臼山の真田の陣へ軍令を届ける',f.sanada,P.z<N6_FENCE?{x:-390,z:N6_FENCE,n:'柵の木戸'}:W.sanada),{ph:2}),
      Object.assign(tk('見張りの交代の隙に狼煙台で狼煙を上げる（5秒）',f.smoke,W.noroshi),{ph:3}),
      Object.assign(tk('柵の木戸を抜け、惣構まで全員で戻る',false,P.z>N6_FENCE?{x:-390,z:N6_FENCE,n:'柵の木戸'}:{x:W.goal.x,z:W.goal.z,n:'惣構'}),{ph:4})]; },
    glints(f){ const g=[]; if(f.o===1){ if(!f.sashi) W.sp.forEach((o,i)=>{ if(!f.srch[i]) g.push([o.x,o.y+1.6,o.z]); }); if(f.ammo<2) g.push([W.ammo.x,W.ammo.y+2,W.ammo.z]); } return g; },
    render(f,t,dt){ bob(W.tsuka.q,f.o===0,t); bob(W.mori.q,f.o===1&&f.ammo<2,t); bob(W.sanada.q,f.o===2,t); stdRender(f,t,dt);
      W.bN.visible=f.o===3; if(f.o===3) W.bN.position.set(W.noroshi.x,W.noroshi.y,W.noroshi.z);
      if(f.smoke&&!W.smk){ W.smk=1; fxSet('noro',{type:'column',x:W.noroshi.x,y:W.noroshi.y+6,z:W.noroshi.z,r:3,rate:8}); } },
    check(f){ return [[-380,884],[-380,930],[-390,1030],[-390,1060],[-390,1060]][f.o]; } };

  /* ---------- 其の七　台所の裏切り（昼過ぎ・三の丸の東） ---------- */
  const NIN=()=>{ const n=Math.max(1,Math.min(3,nOnV())); return ['ひとり','二人','三人'][n-1]; };
  const N7_KURA=[{x:300,z:-282,n:'西の米蔵'},{x:470,z:-282,n:'東の米蔵'},{x:536,z:-200,n:'奥の武具蔵'}];
  const N7_CLUE=[{x:236,z:66,n:'焦げた草履',spr:'wara'},{x:551,z:-113,n:'こぼれた油の跡',spr:'jar'},{x:400,z:-40,n:'落ちていた台所の前掛け',spr:'zabuton_g'}];
  const N7={ name:'台所の裏切り', sub:'慶長二十年 五月七日 ・ 昼過ぎ ・ 三の丸の東', time:1, scen:'natsu', phase:0, limit:780, phases:5, img:'win4',
    noise:true, heavy:['水'], searchT:10,
    shift:{every:50,dur:16,who:[6,7],post:{x:400,z:-115}},
    story:'台所頭が徳川方に内通し、三の丸に火を放った。火は放っておくと燃え広がり、道をふさぐ。井戸の水を手分けして運んで火を消し、内通者の逃げ込んだ蔵を突き止めよ。蔵の扉は重く、三人がかり（人数が少なければ全員）で押さないと開かない。',
    bounds:{x0:216,x1:560,z0:-306,z1:300}, spawn:[400,290,0],
    patrols:[{p:[[240,253],[550,253]],s:1.6},{p:[[400,240],[400,-110]],s:1.5,spr:'k_ninja'},{p:[[240,66],[550,66]],s:1.7},{p:[[236,240],[236,-110]],s:1.5,spr:'k_ninja'},{p:[[551,240],[551,-110]],s:1.5},{p:[[240,-115],[550,-115]],s:1.6,spr:'k_ninja'},{p:[[240,-282],[550,-282]],s:1.5,spr:'k_teppo'},{p:[[520,-270],[520,-200]],s:1.3}],
    setup(){ return {kura:rint(3)}; },
    build(s){ W.jochu=npc('jijo',406,246,'台所の女中'); W.wells=[makeWell(392,260),makeWell(392,-108)]; W.clue=outSpots(N7_CLUE);
      W.kura=N7_KURA.map(d=>{ const o=spot(d.x,d.z); aSpr('kg_door',o.x,o.y,o.z,{s:1.2}); o.n=d.n; const tg=aObj(nameTag(d.n,'#e8b13a')); tg.position.set(o.x,o.y+3.6,o.z); return o; });
      W.traitor=null; W.goal=spot(226,253); W.bGoal=aObj(beam(0x9effa8)); },
    init(){ return {o:0,clue:[0,0,0],tried:[0,0,0],open:-1,caught:0,fires:[{x:400,z:66,r:3,max:10,grow:.04,cut:2.3},{x:252,z:-115,r:2.5,max:9,grow:.035,cut:2.3},{x:551,z:66,r:2.5,max:9,grow:.035,cut:2.3}]}; },
    target(f,p){ if(near(p,W.jochu)) return {k:'jochu',l:'台所の女中に話を聞く',d:.15};
      if(f.o===1){ const fp=firePour(f,p); if(fp) return fp; if(!p.carry) for(const w of W.wells) if(near(p,w,3)) return {k:'fill',l:'水をくむ',d:.8};
        for(let i=0;i<3;i++) if(!f.clue[i]&&near(p,W.clue[i],2.6)) return {k:'clue'+i,l:N7_CLUE[i].n+'を調べる',d:.6}; }
      if(f.o===2) for(let i=0;i<3;i++) if(!f.tried[i]&&near(p,W.kura[i],3.4)) return {k:'kura'+i,l:N7_KURA[i].n+'の扉を押し開ける（'+NIN()+'で・手を離すと戻る）',d:6,hold:{key:'kura'+i,need:3,dec:.12}};
      if(f.o===3&&W.traitor&&near(p,W.traitor,3)) return {k:'catch',l:'内通者に縄をかける（3秒・見つかるとやり直し）',d:3,hold:{key:'catch',int:'reset'}};
      return null; },
    complete(p,k){ const f=G.f,s=SET; if(fireDo(k,p)) { if(f.fires.every(q=>q.r<=0)&&f.o===1){ f.o=2; event('三の丸の火は消し止めた！ 内通者が逃げ込んだ蔵を突き止め、扉を押し開けよ'); } return; }
      if(k==='jochu'){ const m='女中「台所頭さまが、徳川に通じておったのです！ 火を放って蔵のほうへ……。火は放っておくと燃え広がります。井戸の水で消してくださいまし。あの方の足取りは、焦げた草履と油の跡と前掛けに残っておるはず」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k==='fill') p.carry='水';
      else if(k.startsWith('clue')){ const i=+k.slice(4); f.clue[i]=1; const H=[`焦げた草履は${s.kura===2?'東':'北'}へ向かって脱ぎ捨てられている`,`油の跡は${s.kura===0?'西':'東'}のほうへ続いている`,`前掛けには${s.kura===2?'鉄さび':'米ぬか'}がついている`][i]; note(N7_CLUE[i].n+'：'+H); event(p.n+'：'+H); }
      else if(k.startsWith('kura')){ const i=+k.slice(4); f.tried[i]=1; if(i===s.kura){ f.open=i; f.o=3; const o=W.kura[i]; W.traitor=spot(o.x+(i===2?-3:0),o.z+(i===2?0:3)); event(N7_KURA[i].n+'の扉が開いた――内通者がいた！ 縄をかけろ'); } else penalty(15,N7_KURA[i].n+'は空っぽだった'); }
      else if(k==='catch'){ f.caught=1; f.o=4; event('内通者を取り押さえた！ 二の丸の虎口へ、全員で知らせに走れ'); } },
    drop(p){ p.carry=false; },
    tick(dt){ const f=G.f; if(f.o===3&&!W.traitor){ const o=W.kura[f.open]; W.traitor=spot(o.x+(f.open===2?-3:0),o.z+(f.open===2?0:3)); } if(f.o===4&&allIn(W.goal,10)) finish(true,'内通者は捕らえられた。だが城の南では、もう決戦の火ぶたが切られていた――'); },
    tasks(f,mine){ const wn=W.wells.slice().sort((a,b)=>Math.hypot(a.x-P.x,a.z-P.z)-Math.hypot(b.x-P.x,b.z-P.z))[0], src={x:wn.x,z:wn.z,n:'井戸'}; return [
      Object.assign(tk('台所の女中の話を聞く',f.o>0,W.jochu),{ph:0}),
      Object.assign(fireTask(f,0,'辻の火を消す',mine,src),{ph:1}), Object.assign(fireTask(f,1,'西の火を消す',mine,src),{ph:1}), Object.assign(fireTask(f,2,'東の火を消す',mine,src),{ph:1}),
      ...N7_CLUE.map((c,i)=>Object.assign(tk(c.n+'を調べる',f.clue[i],{x:W.clue[i].x,z:W.clue[i].z,n:c.n},true),{ph:1})),
      Object.assign(tk('内通者の逃げ込んだ蔵を突き止め、扉を'+NIN()+'で押し開ける',f.open>=0,null),{ph:2,many:W.kura.filter((o,i)=>!f.tried[i]).map(o=>({x:o.x,z:o.z,n:o.n}))}),
      Object.assign(tk('内通者に縄をかける（3秒）',f.caught,W.traitor?{x:W.traitor.x,z:W.traitor.z,n:'内通者'}:null),{ph:3}),
      Object.assign(tk('二の丸の虎口へ全員で知らせる',false,{x:W.goal.x,z:W.goal.z,n:'二の丸の虎口'}),{ph:4})]; },
    glints(f){ const g=[]; if(f.o===1) W.clue.forEach((o,i)=>{ if(!f.clue[i]) g.push([o.x,o.y+1.4,o.z]); }); if(f.o===2) W.kura.forEach((o,i)=>{ if(!f.tried[i]) g.push([o.x,o.y+2.6,o.z]); }); return g; },
    render(f,t,dt){ bob(W.jochu.q,f.o===0,t); stdRender(f,t,dt); if(f.o>=3&&f.open>=0&&!W.traitor){ const o=W.kura[f.open]; W.traitor=spot(o.x+(f.open===2?-3:0),o.z+(f.open===2?0:3)); }
      if(f.o>=3&&!W.trSpr&&W.traitor){ W.trSpr=aSpr('k_ninja',W.traitor.x,W.traitor.y,W.traitor.z,{s:1}); W.trTag=aObj(nameTag('内通者（台所頭）','#ff6b55')); W.trTag.position.set(W.traitor.x,W.traitor.y+3,W.traitor.z); }
      if(f.caught&&W.trTag) W.trTag.visible=false; W.bGoal.visible=f.o===4; if(f.o===4) W.bGoal.position.set(W.goal.x,W.goal.y,W.goal.z); },
    check(f){ return [[400,290],[400,240],[400,-100],[400,-200],[400,-100]][f.o]; } };

  /* ---------- 其の八　大手口の殿（夕・三の丸の西と大手口） ---------- */
  const N8_GATE={x0:-234,x1:-230,z0:101,z1:111};
  const N8_HURT=[[-560,66],[-437,330],[-600,253],[-437,-112]];
  const N8_BAR=[{x:-300,z:66,n:'番所の土間',spr:'shelf'},{x:-262,z:250,n:'武具蔵の前',spr:'spears'},{x:-437,z:150,n:'荷車の下',spr:'cart'}];
  const N8={ name:'大手口の殿', sub:'慶長二十年 五月七日 ・ 夕 ・ 三の丸の西と大手口', time:2, scen:'natsu', phase:0, limit:780, phases:5, img:'win2',
    noise:true, relight:true, heavy:['負傷兵'], carrySpr:{'負傷兵':'taore'}, searchT:10,
    shift:{every:40,dur:15,who:[0,1,2],post:{x:-241,z:106}},
    story:'天王寺口は破れ、徳川勢が三の丸へ押し寄せる。逃げ遅れた負傷兵を大手門の内へ運び込み、門を閉ざせ。門前には寄せ手がときおり押し寄せる。引いた隙に、三人がかり（人数が少なければ全員）で門扉を押し、閂を差せ。',
    bounds:{x0:-640,x1:-205,z0:-120,z1:420}, spawn:[-216,112,Math.PI/2],
    patrols:[{p:[[-290,66],[-290,250]],s:1.5},{p:[[-262,-110],[-262,240]],s:1.6,spr:'k_teppo'},{p:[[-290,330],[-262,330]],s:1.3},{p:[[-620,66],[-300,66]],s:1.7},{p:[[-437,-110],[-437,400]],s:1.6,spr:'k_ninja'},{p:[[-620,253],[-300,253]],s:1.6},{p:[[-620,-112],[-300,-112]],s:1.5,spr:'k_teppo'},{p:[[-630,-100],[-630,400]],s:1.5,spr:'k_ninja'},{p:[[-600,332],[-300,332]],s:1.6}],
    setup(){ return {bar:rint(3),hurt:shuffle([0,1,2,3]).slice(0,3)}; },
    build(s){ W.kashira=npc('sam_armor',-214,124,'物頭'); W.camp=spot(-214,96); aSpr('jinmaku',W.camp.x,W.camp.y,W.camp.z,{}); W.cTag=aObj(nameTag('救護所','#9effa8')); W.cTag.position.set(W.camp.x,W.camp.y+3,W.camp.z);
      W.hurt=s.hurt.map(i=>{ const o=spot(...N8_HURT[i]); return o; }); W.bar=outSpots(N8_BAR);
      W.gate=doorMesh(N8_GATE); W.hA=spot(-226,103,{fixed:true}); W.hB=spot(-226,110,{fixed:true}); W.hC=spot(-224,106.5,{fixed:true});
      W.taiko=spot(-218,86); aSpr('taiko',W.taiko.x,W.taiko.y,W.taiko.z,{s:1.1}); W.tTag=aObj(nameTag('千貫櫓の太鼓','#e8b13a')); W.tTag.position.set(W.taiko.x,W.taiko.y+3,W.taiko.z);
      makeLamps([[-262,66,'番所の篝火'],[-437,253,'辻の篝火'],[-437,66,'辻の篝火'],[-560,253,'辻の篝火'],[-262,253,'武具蔵の篝火']]);
      W.hs=W.hurt.map(o=>aSpr('taore',o.x,o.y,o.z,{s:1})); W.rG=aObj(ring(0xffd36a)); W.bG=aObj(beam(0xffd36a));
      for(const [x,z] of [[-660,150],[-700,300],[-680,0]]) fxSet('bg'+x+'_'+z,{type:'column',x,y:2,z,r:12,rate:3}); },
    init(){ return {o:0,hurt:[0,0,0],saved:0,srch:[0,0,0],bar:0,shut:0,lock:0,lamp:[1,1,1,1,1]}; },
    target(f,p){ if(near(p,W.kashira)) return {k:'kashira',l:'物頭に話を聞く',d:.15}; const lo=lampOps(f,p); if(lo) return lo;
      if(f.o===1){ if(!p.carry) for(let i=0;i<3;i++) if(!f.hurt[i]&&near(p,W.hurt[i],2.6)) return {k:'hurt'+i,l:'負傷兵を背負う',d:1.2};
        if(p.carry==='負傷兵'&&near(p,W.camp,4)) return {k:'save',l:'負傷兵を救護所に下ろす',d:.6};
        if(!f.bar) for(let i=0;i<3;i++) if(!f.srch[i]&&near(p,W.bar[i],2.6)) return {k:'bar'+i,l:N8_BAR[i].n+'を調べる',d:.8}; }
      if(f.o===2&&(near(p,W.hA,2.6)||near(p,W.hB,2.6))) return {k:'shut',l:'門扉を押して閉める（'+NIN()+'で・見つかると押し戻される）',d:6,hold:{key:'shut',need:3,dec:.15,int:'drain'}};
      if(f.o===3&&near(p,W.hC,2.6)) return {k:'kannuki',l:'閂を差す（5秒・見つかるとやり直し）',d:5,hold:{key:'kannuki',int:'reset'}};
      if(f.o===4&&near(p,W.taiko,3)) return {k:'taiko',l:'千貫櫓の太鼓を打つ',d:1};
      return null; },
    complete(p,k){ const f=G.f,s=SET; if(lampDo(k)) return;
      if(k==='kashira'){ const m='物頭「逃げ遅れた負傷兵が三の丸に三人おる。背負って救護所へ運べ。背負っておる間は走れぬぞ。大手門の閂はどこかに転がっておる――番所か、武具蔵か、荷車の下か。寄せ手は時折、門前へ押し寄せる。引いた隙に門を閉めよ」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k.startsWith('hurt')){ const i=+k.slice(4); f.hurt[i]=1; p.carry='負傷兵'; p.hi=i; event(p.n+'が負傷兵を背負った。救護所へ'); }
      else if(k==='save'){ p.carry=false; f.saved++; event('負傷兵を救護所へ運び込んだ（'+f.saved+' / 3）'); }
      else if(k.startsWith('bar')){ const i=+k.slice(3); f.srch[i]=1; if(i===s.bar){ f.bar=1; event(p.n+'が'+N8_BAR[i].n+'で大手門の閂を見つけた！'); } else penalty(6,N8_BAR[i].n+'に閂はなかった'); }
      else if(k==='shut'){ f.shut=1; f.o=3; for(const q of G.pl){ if(q.off||q.x>-232) continue; const o=nudge(-216,112); q.x=o[0]; q.z=o[1]; sendTo(q.id,{t:'tp',x:q.x,z:q.z}); } event('門扉が閉まった！ 今のうちに閂を差せ（5秒）'); }
      else if(k==='kannuki'){ f.lock=1; f.o=4; event('閂が差された！ 千貫櫓の太鼓を打ち、城内に知らせよ'); }
      else if(k==='taiko'){ finish(true,'大手門は閉ざされ、負傷兵は城内へ逃れた。だが夜が来る――大坂城の最後の夜が'); }
      if(f.o===1&&f.saved>=3&&f.bar){ f.o=2; event('負傷兵も閂もそろった！ 寄せ手が門前から引いた隙に、門扉を押して閉めよ'); } },
    drop(p){ if(p.carry==='負傷兵'&&p.hi!==undefined){ G.f.hurt[p.hi]=0; event('負傷兵を下ろしてしまった……もう一度背負え'); } p.carry=false; },
    block(x,z,f){ return f.shut&&inR(N8_GATE,x,z,.2); },
    eblock(x,z,f){ return (f.shut&&inR(N8_GATE,x,z,.4))||x>-231.5; },
    tasks(f,mine){ return [
      Object.assign(tk('物頭の話を聞く',f.o>0,W.kashira),{ph:0}),
      Object.assign(tk(`負傷兵を救護所へ運ぶ（${f.saved} / 3）`,f.saved>=3,mine&&mine.carry==='負傷兵'?{x:W.camp.x,z:W.camp.z,n:'救護所'}:null),{ph:1,many:mine&&mine.carry?[]:W.hurt.filter((o,i)=>!f.hurt[i]).map(o=>({x:o.x,z:o.z,n:'負傷兵'}))}),
      Object.assign(tk('大手門の閂を探す',f.bar,null),{ph:1,many:f.bar?[]:W.bar.filter((o,i)=>!f.srch[i]).map(o=>({x:o.x,z:o.z,n:o.n}))}),
      Object.assign(tk('寄せ手が引いた隙に、門扉を'+NIN()+'で押して閉める',f.shut,{x:W.hA.x,z:W.hA.z,n:'大手門'}),{ph:2}),
      Object.assign(tk('閂を差す（5秒・見つかるとやり直し）',f.lock,{x:W.hC.x,z:W.hC.z,n:'閂'}),{ph:3}),
      Object.assign(tk('千貫櫓の太鼓を打つ',false,{x:W.taiko.x,z:W.taiko.z,n:'千貫櫓の太鼓'}),{ph:4})]; },
    status(f){ const SH=shiftState(V.el||0); return f.o===2&&SH?[SH.on?'寄せ手が門前に押し寄せている！':'寄せ手が引いている――今だ']:[]; },
    glints(f){ const g=[]; if(f.o===1){ W.hurt.forEach((o,i)=>{ if(!f.hurt[i]) g.push([o.x,o.y+1.2,o.z]); }); if(!f.bar) W.bar.forEach((o,i)=>{ if(!f.srch[i]) g.push([o.x,o.y+1.6,o.z]); }); } return g; },
    render(f,t,dt){ bob(W.kashira.q,f.o===0,t); stdRender(f,t,dt); W.hurt.forEach((o,i)=>crowd.move(W.hs[i],f.hurt[i]?0:o.x,f.hurt[i]?-999:o.y,o.z)); doorSet(W.gate,!f.shut,dt);
      const sh=f.o===2||f.o===3; W.bG.visible=sh; W.rG.visible=sh; if(sh){ const o=f.o===2?W.hA:W.hC; W.bG.position.set(o.x,o.y,o.z); W.rG.position.set(o.x,o.y+.05,o.z); } },
    check(f){ return [[-216,112],[-262,150],[-216,112],[-216,112],[-216,100]][f.o]; } };

  /* ---------- 其の十　炎上・京橋口（夜更け・三の丸の北と大川のほとり） ---------- */
  const N10_FX=-205, N10_DOOR={x0:-207,x1:-203,z0:-291,z1:-275};
  const N10_KEY=[{x:-186,z:-236,n:'番所の箪笥',spr:'cabinet'},{x:-110,z:-205,n:'焼け残った長持',spr:'chest_m'},{x:-40,z:-150,n:'井戸端の桶',spr:'pot'}];
  const N10_BOAT={x:-520,z:-304};
  const N10={ name:'炎上・京橋口', sub:'慶長二十年 五月七日 ・ 夜更け ・ 三の丸の北から大川へ', time:3, scen:'natsu', phase:3, keepFire:true, limit:900, phases:6, img:'win5', final:true,
    lose:'天守は焼け落ち、京橋口は炎に閉ざされた……。脱出はかなわなかった',
    noise:true, relight:true, heavy:['水'], searchT:11, burnDur:880,
    shift:{every:42,dur:16,who:[0,1],post:{x:-196,z:-176}},
    story:'天守が燃えている。焼け落ちる前に、京橋口から大川の湊へ落ちのびよ。燃え広がる火を大川の水で消し、門の鍵を探せ。門番は交代の刻だけ持ち場を離れる。最後の門扉は、残った者すべての力で押し開けよ。',
    bounds:{x0:-640,x1:40,z0:-312,z1:-110}, spawn:[-14,-286,Math.atan2(-44,-242)],
    patrols:[{p:[[-198,-300],[-198,-262]],s:1.3},{p:[[-200,-262],[-200,-150]],s:1.4,spr:'k_teppo'},{p:[[-180,-280],[20,-280]],s:1.7},{p:[[-26,-260],[-26,-120]],s:1.6,spr:'k_ninja'},{p:[[-130,-260],[-130,-120]],s:1.5},{p:[[-600,-284],[-230,-284]],s:1.7,spr:'k_teppo'},{p:[[-435,-262],[-435,-120]],s:1.5,spr:'k_ninja'},{p:[[-600,-115],[-230,-115]],s:1.6},{p:[[-260,-262],[-260,-120]],s:1.5,spr:'k_ninja'},{p:[[-180,-115],[20,-115]],s:1.5,spr:'k_teppo'}],
    setup(){ return {key:rint(3)}; },
    build(s){ W.roshin=npc('roujin',-6,-282,'老臣'); W.keys=outSpots(N10_KEY); W.river=[spot(-90,-309),spot(-380,-309),spot(-560,-309)]; W.river.forEach(o=>aSpr('bucket',o.x,o.y,o.z,{}));
      fenceLine(N10_FX,-312,N10_FX,-110,'saku',3,N10_DOOR); W.door=doorMesh(N10_DOOR); W.hA=spot(-200,-287,{fixed:true}); W.hB=spot(-200,-279,{fixed:true}); W.lockP=spot(-200.5,-283,{fixed:true});
      makeLamps([[-160,-266,'門前の篝火'],[-240,-266,'門外の篝火'],[-60,-266,'辻の篝火'],[-400,-266,'湊の篝火']]);
      W.boat=null; try{ const g=makeBoat(PROP,'river'); if(g&&g.position){ g.position.set(N10_BOAT.x,WATER_Y+.3,N10_BOAT.z-12); g.rotation.y=Math.PI/2; LIT.objs.push(g); W.boat=g; } }catch(e){}
      { const d=mesh(new THREE.BoxGeometry(6,.3,12),M.wood||M.darkwood); d.position.set(N10_BOAT.x,-.1,N10_BOAT.z-4); aObj(d); } W.boatP=spot(N10_BOAT.x,N10_BOAT.z);
      W.bL=aObj(beam(0xffd36a)); W.bB=aObj(beam(0x9effa8)); W.rB=aObj(ring(0x9effa8));
      for(const [x,z,r] of [[20,-60,18],[-30,-20,14],[60,-90,12]]) fxSet('sky'+x+'_'+z,{type:'column',x,y:30,z,r,rate:6});
      { const ty=groundH(30,-44); W.glow=[[95,ty+52,0xff6a20,.55],[45,ty+44,0xffb050,.75]].map(([sc,y,c,o])=>{ const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,color:c,transparent:true,opacity:o,blending:THREE.AdditiveBlending,depthWrite:false,fog:false})); sp.scale.setScalar(sc); sp.position.set(30,y,-44); sp.renderOrder=3; sp.userData.o=o; return aObj(sp); }); } },
    init(){ return {o:0,srch:[0,0,0],key:0,lock:0,open:0,lamp:[1,1,1,1],fires:[{x:-110,z:-284,r:5,max:14,grow:.045,cut:2.6},{x:-330,z:-284,r:4,max:13,grow:.04,cut:2.6},{x:-160,z:-180,r:3,max:9,grow:.03,cut:2.4}]}; },
    target(f,p){ if(near(p,W.roshin)) return {k:'roshin',l:'老臣に話を聞く',d:.15}; const lo=lampOps(f,p); if(lo) return lo;
      const fp=firePour(f,p); if(fp) return fp; if(!p.carry) for(const w of W.river) if(near(p,w,3.2)) return {k:'fill',l:'大川の水をくむ',d:.8};
      if(f.o===1&&!f.key) for(let i=0;i<3;i++) if(!f.srch[i]&&near(p,W.keys[i],2.6)) return {k:'key'+i,l:N10_KEY[i].n+'を調べる',d:.8};
      if(f.o===2&&near(p,W.lockP,2.8)) return {k:'jo',l:'京橋口の錠を外す（5秒・見つかるとやり直し）',d:5,hold:{key:'jo',int:'reset'}};
      if(f.o===3&&(near(p,W.hA,2.6)||near(p,W.hB,2.6))) return {k:'open',l:'門扉を押し開ける（全員で・手を離すと戻る）',d:7,hold:{key:'open',need:4,dec:.15}};
      return null; },
    complete(p,k){ const f=G.f,s=SET; if(lampDo(k)) return;
      if(fireDo(k,p)){ if(f.o===1&&f.key&&f.fires[0].r<=0){ f.o=2; event('道が開いた！ 京橋口の錠を外せ。門番は交代の刻だけ持ち場を離れる'); } if(f.o===4&&f.fires[1].r<=0){ f.o=5; event('湊への道が開いた！ 全員で小舟へ'); } return; }
      if(k==='roshin'){ const m='老臣「天守が燃えておる……もはやこれまでじゃ。京橋口から大川の湊へ落ちよ。門には錠が下りておる。鍵は番所の箪笥か、焼け残った長持か、井戸端の桶のどれかに隠したはず。道をふさぐ火は、大川の水で消すのじゃ」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k==='fill') p.carry='水';
      else if(k.startsWith('key')){ const i=+k.slice(3); f.srch[i]=1; if(i===s.key){ f.key=1; event(p.n+'が'+N10_KEY[i].n+'から京橋口の鍵を見つけた！'); } else penalty(8,N10_KEY[i].n+'に鍵はなかった'); }
      else if(k==='jo'){ f.lock=1; f.o=3; event('錠が外れた！ 門扉は重い――残った者すべてで押し開けろ'); }
      else if(k==='open'){ f.open=1; f.o=4; event('京橋口が開いた！ 湊への道をふさぐ火を消し、小舟へ'); if(f.fires[1].r<=0){ f.o=5; event('全員で小舟へ！'); } }
      if(f.o===1&&f.key&&f.fires[0].r<=0){ f.o=2; event('道が開いた！ 京橋口の錠を外せ。門番は交代の刻だけ持ち場を離れる'); } },
    drop(p){ p.carry=false; },
    block(x,z,f){ if(Math.abs(x-N10_FX)<2.2&&!(inR(N10_DOOR,x,z,0)&&f.open)) return true; return false; },
    eblock(x,z,f){ return Math.abs(x-N10_FX)<2.6; },
    tick(dt){ const f=G.f; if(f.o===5){ const all=onl().every(p=>!p.cap&&Math.hypot(p.x-W.boatP.x,p.z-W.boatP.z)<7); if(all){ G.winT=(G.winT||0)+dt; if(G.winT>2) finish(true,'燃え落ちる天守を背に、小舟は大川へ漕ぎ出した。夜空を焦がして大坂城は焼け落ち、豊臣の世は終わりを告げた――。（完）'); } else G.winT=0; } },
    tasks(f,mine){ const wn=W.river.slice().sort((a,b)=>Math.hypot(a.x-P.x,a.z-P.z)-Math.hypot(b.x-P.x,b.z-P.z))[0], src={x:wn.x,z:wn.z,n:'大川の水'}; const n=V.pl.filter(p=>!p.cap&&Math.hypot(p.x-W.boatP.x,p.z-W.boatP.z)<7).length; return [
      Object.assign(tk('老臣の話を聞く',f.o>0,W.roshin),{ph:0}),
      Object.assign(fireTask(f,0,'京橋口への道をふさぐ火を消す',mine,src),{ph:1}),
      Object.assign(tk('京橋口の鍵を探す',f.key,null),{ph:1,many:f.key?[]:W.keys.filter((o,i)=>!f.srch[i]).map(o=>({x:o.x,z:o.z,n:o.n}))}),
      Object.assign(fireTask(f,2,'番所への火を消す',mine,src),{ph:1,h:true}),
      Object.assign(tk('門番の交代の隙に、京橋口の錠を外す（5秒）',f.lock,{x:W.lockP.x,z:W.lockP.z,n:'京橋口'}),{ph:2}),
      Object.assign(tk('門扉を全員で押し開ける（手を離すと戻る）',f.open,{x:W.hA.x,z:W.hA.z,n:'京橋口の門扉'}),{ph:3}),
      Object.assign(fireTask(f,1,'湊への道をふさぐ火を消す',mine,src),{ph:4}),
      Object.assign(tk('大川の小舟へ全員で乗り込む'+(n?`（舟に ${n} / ${V.pl.length}人）`:''),false,{x:W.boatP.x,z:W.boatP.z,n:'大川の小舟'}),{ph:5})]; },
    status(f){ return [lampDark(f,P.x,P.z)?'闇の中（見つかりにくい）':'']; },
    glints(f){ const g=[]; if(f.o===1&&!f.key) W.keys.forEach((o,i)=>{ if(!f.srch[i]) g.push([o.x,o.y+1.6,o.z]); }); return g; },
    render(f,t,dt){ bob(W.roshin.q,f.o===0,t); stdRender(f,t,dt); doorSet(W.door,!!f.open,dt);
      W.bL.visible=f.o===2||f.o===3; if(W.bL.visible){ const o=f.o===2?W.lockP:W.hA; W.bL.position.set(o.x,o.y,o.z); }
      W.bB.visible=W.rB.visible=f.o===5; if(f.o===5){ W.bB.position.set(W.boatP.x,W.boatP.y,W.boatP.z); W.rB.position.set(W.boatP.x,W.boatP.y+.05,W.boatP.z); }
      if(W.boat) W.boat.position.y=WATER_Y+.3+Math.sin(t*1.3)*.08; if(W.glow) W.glow.forEach((g,i)=>{ g.material.opacity=g.userData.o*(.8+.2*Math.sin(t*(2.3+i)+i)); }); },
    check(f){ return [[-14,-286],[-60,-270],[-160,-270],[-170,-283],[-240,-270],[-400,-280]][f.o]; } };

  /* 其の九（落城の夜）は、侍女たちを舟で落とす面に。最後の脱出は其の十へ */
  L5.noise=true; L5.burnDur=1500; L5.img='win5'; L5.lose='天守も御殿も焼け落ちた……。脱出はかなわなかった';

  const LEVELS=[L1,L2,L3,L4,N5,N6,N7,N8,L5,N10];
  const lvTitle=i=>'其の'+KAN[i]+'　'+LEVELS[i].name;

  /* =====================================================================
     進行（ホストだけが計算）
     ===================================================================== */
  function newGame(players,lv,set){
    G={lv,set,t:LEVELS[lv].limit,over:null,winT:0,allCapT:0,rescues:0,caught:0,sw:{},gh:0,notes:[],f:null,
      pl:players.map((p,i)=>({id:p.id,n:p.n,c:i,x:0,y:1.6,z:0,yaw:0,cr:false,run:false,use:false,room:false,cap:false,grace:3,carry:false,hk:null,hp:0,rel:false})),
      en:LEVELS[lv].patrols.slice(0,MAXE).map(P0=>({p:P0.p.map(c=>[c[0],c[1]]),s:P0.s,spr:P0.spr||'k_yari',i:1,x:0,z:0,yaw:0,pause:0,al:{},look:0}))};
    for(const e of G.en){ e.x=e.p[0][0]; e.z=e.p[0][1]; }
  }
  function targetFor(st,p){
    if(p.cap||!LV) return null;
    for(const q of st.pl) if(q!==p&&q.cap&&!q.off&&dist(p.x,p.z,q.x,q.z)<2.6) return {k:'res:'+q.id,l:q.n+'の縄を解く',d:1.8};
    return LV.target(st.f,p);
  }
  function complete(p,k){
    if(k==='chat') return;
    if(k.startsWith('res:')){ const q=G.pl.find(x=>'res:'+x.id===k); if(q&&q.cap){ q.cap=false; q.grace=4; G.rescues++; event(p.n+'が'+q.n+'の縄を解いた！'); } return; }
    if(k==='lock'){ sendTo(p.id,{t:'lockui'}); return; }
    LV.complete(p,k);
  }
  function onCode(v,syms){ if(!G||G.over||!LV.code) return; LV.code(v,syms||[]); }
  function seen(e,p){
    if(p.off||p.cap||p.grace>0||p.room) return 0;
    const d=dist(e.x,e.z,p.x,p.z),rng=(p.cr?6.5:(p.run?17:SIGHT))*(W.lamps&&lampDark(G.f,p.x,p.z)?.5:1)*(e.st==='search'?1.15:1); if(d>rng) return 0;
    if(Math.abs(p.y-1.6-groundH(e.x,e.z))>4.2) return 0;    /* 段差の上下は見えにくい */
    const fx=-Math.sin(e.yaw),fz=-Math.cos(e.yaw),dot=(fx*(p.x-e.x)+fz*(p.z-e.z))/Math.max(.01,d);
    if(d>2&&dot<Math.cos(SIGHT_HALF)) return 0;
    for(let s=1.2;s<d-.6;s+=1.2){ const x=e.x+(p.x-e.x)*s/d,z=e.z+(p.z-e.z)*s/d; if(hitBlock(x,z,0)) return 0; }
    return d<4?1.5:.6;    /* 満タン（捕縛）まで：遠くで約1.7秒、近くで約0.7秒 */
  }
  /* ---------- 共通のしかけ（後半の面で使う） ----------
     hold : 押し続ける仕掛け。{key, need:人数, dec:手を離すと戻る速さ, int:'reset'|'drain' 見つかると0に戻る/減る}
     shift: 見張りの交代。{every:周期, dur:交代にかかる時間, who:[追手の番号], post:{x,z}}
     tgate: 一定の間隔でしか開かない門。{every, open, rect, n}
     fires: 燃え広がる火（G.f.fires = [{x,z,r,max,grow}]）
     lamps: 灯り（G.f.lamp[i]=1 で点いている。消すと周りが暗くなり、追手から見えにくい）
     noise: 物音（走ると上がり、近くの追手が音のした所へ探しに来る）
     heavy: 重い荷物（運んでいる間は走れない・しゃがめない） */
  const curEl=()=>G?G.el||0:V?V.el||0:0;
  function shiftState(el){ const S=LV&&LV.shift; if(!S) return null; const ph=(el+(S.off||0))%S.every,on=ph>=S.every-S.dur; return {on,left:on?S.every-ph:S.every-S.dur-ph}; }
  function gateOpen(g,el){ const ph=(el+(g.off||0))%g.every; return {open:ph<g.open,left:ph<g.open?g.open-ph:g.every-ph}; }
  function inFire(f,x,z,pad){ if(!f||!f.fires) return -1; for(let i=0;i<f.fires.length;i++){ const q=f.fires[i]; if(q.r>.6&&Math.hypot(x-q.x,z-q.z)<q.r+(pad||0)) return i; } return -1; }
  function lampDark(f,x,z){ const L=W.lamps; if(!L||!f||!f.lamp) return false; let dark=false; for(let i=0;i<L.length;i++){ const d=Math.hypot(x-L[i].x,z-L[i].z); if(d<(L[i].r||11)){ if(f.lamp[i]) return false; dark=true; } } return dark; }
  const isHeavy=c=>!!(c&&LV&&LV.heavy&&LV.heavy.includes(c));
  /* 共通の block：火・時間で開く門 */
  function commonBlock(x,z,f){ if(inFire(f,x,z,.3)>=0) return true; if(LV.tgates){ const el=curEl(); for(const g of LV.tgates) if(inR(g.rect,x,z,.25)&&!gateOpen(g,el).open) return true; } return false; }

  function hostStep(dt){
    if(!G||G.over) return;
    G.el=(G.el||0)+dt;
    G.t-=dt; if(G.t<=0){ G.t=0; return finish(false,LV.lose||'時間切れ……。徳川方に先を越されてしまった'); }
    const h=G.pl.find(p=>p.id===0); if(h) readMe(h);
    for(const p of G.pl){ p.grace=Math.max(0,p.grace-dt); if(isHeavy(p.carry)){ p.run=false; p.cr=false; } }
    G.sw={}; if(!G.hold){ G.hold={}; G.hdef={}; } const HH={};
    for(const p of G.pl){ if(p.off){ p.use=false; continue; } const tg=targetFor(G,p);
      if(!p.use) p.rel=false;
      if(tg&&tg.hold&&p.use&&!p.rel){ const k=tg.hold.key||tg.k; (HH[k]||(HH[k]={tg,ps:[]})).ps.push(p); p.hk=tg.k; continue; }
      if(!tg||!p.use||p.rel){ p.hk=tg?tg.k:null; p.hp=0; continue; }
      if(tg.sw){ G.sw[tg.k]=1; p.hk=tg.k; continue; }
      if(p.hk!==tg.k){ p.hk=tg.k; p.hp=0; }
      p.hp+=dt/tg.d; if(p.hp>=1){ p.hp=0; p.rel=true; complete(p,tg.k); if(G.over) return; } }
    /* 押し続ける仕掛け（みんなで1本のゲージ） */
    G.hn={};
    for(const k of new Set([...Object.keys(HH),...Object.keys(G.hold)])){ const H=HH[k]; if(H) G.hdef[k]={...H.tg.hold,d:H.tg.d,k:H.tg.k}; const D=G.hdef[k]; if(!D) continue;
      let v=G.hold[k]||0; const need=Math.max(1,Math.min(D.need||1,nOn())),n=H?H.ps.length:0; G.hn[k]=n;
      const watched=D.int&&H&&H.ps.some(p=>G.en.some(e=>(e.al[p.id]||0)>.12));
      if(watched){ if(D.int==='reset'){ if(v>.05&&G.el-(G.intT||0)>2.5){ G.intT=G.el; event('追手に気づかれかけ、手を止めた！ やり直し――見張り役と手分けしよう'); } v=0; } else v=Math.max(0,v-dt*.6); }
      else if(n>=need) v+=dt/D.d;
      else v=Math.max(0,v-dt*(D.dec===undefined?1:D.dec));
      if(v>=1&&H){ v=0; H.ps.forEach(p=>p.rel=true); delete G.hold[k]; complete(H.ps[0],D.k); if(G.over) return; continue; }
      if(v<=0&&!H) delete G.hold[k]; else G.hold[k]=v; }
    /* 物音 */
    if(LV.noise){ for(const p of G.pl){ if(p.off||p.cap||p.room){ p.nz=0; continue; } const mv=Math.hypot(p.x-(p.ox||p.x),p.z-(p.oz||p.z))/Math.max(dt,1e-3); p.ox=p.x; p.oz=p.z;
        p.nz=Math.max(0,Math.min(1,(p.nz||0)+(p.run?dt*.5:(p.cr||mv<.3)?-dt*.45:-dt*.12)));
        if(p.nz>.3&&G.el-(p.nzT||0)>.6){ p.nzT=G.el; const R=7+p.nz*20; for(const e of G.en) if(e.st!=='chase'&&!(e.al[p.id]>.25)&&dist(e.x,e.z,p.x,p.z)<R) hear(e,p.x+(Math.random()-.5)*4,p.z+(Math.random()-.5)*4); } } }
    /* 燃え広がる火：中にいる人は押し出す */
    if(G.f.fires){ for(const q of G.f.fires){ if(q.r>0&&q.r<q.max) q.r=Math.min(q.max,q.r+dt*(q.grow||.05)); }
      for(const p of G.pl){ if(p.off||p.room) continue; const i=inFire(G.f,p.x,p.z,0); if(i>=0){ const q=G.f.fires[i],d=Math.max(.01,dist(p.x,p.z,q.x,q.z)),o=nudge(q.x+(p.x-q.x)/d*(q.r+2.5),q.z+(p.z-q.z)/d*(q.r+2.5)); p.x=o[0]; p.z=o[1]; sendTo(p.id,{t:'tp',x:p.x,z:p.z}); penalty(5,p.n+'が火に巻かれそうになった'); } } }
    /* 時間で閉まる門に挟まれた人は押し出す */
    if(LV.tgates) for(const g of LV.tgates){ if(gateOpen(g,G.el).open) continue; for(const p of G.pl){ if(p.off||p.room||!inR(g.rect,p.x,p.z,.25)) continue; const o=nudge(p.x+(g.push?g.push[0]:0)*2.5,p.z+(g.push?g.push[1]:0)*2.5); p.x=o[0]; p.z=o[1]; sendTo(p.id,{t:'tp',x:p.x,z:p.z}); } }
    if(LV.tick){ LV.tick(dt); if(G.over) return; }
    /* 追手 */
    const SH=shiftState(G.el);
    for(let i=0;i<G.en.length;i++) enemyStep(G.en[i],i,dt,SH);
    if(onl().length&&onl().every(p=>p.cap)){ G.allCapT+=dt; if(G.allCapT>2.6){ G.allCapT=0; G.t-=45; resetToCheck('全員捕まってしまった……（−45秒）。少し前からやり直し'); } } else G.allCapT=0;
  }
  /* 物音を聞いた追手は、その場所へ確かめに行く */
  function hear(e,x,z){ if(e.st==='chase') return; if(e.st==='pat'||e.st==='shift') e.tr=[[e.x,e.z]]; e.st='inv'; e.lk={x,z}; e.stT=0; }
  /* ---------- 追手の頭（見回り → 気づく → 追う → 見失った所を探す → 来た道を戻る） ---------- */
  function enemyStep(e,i,dt,SH){
    if(!e.fx){ e.fx=1; e.p=fixPath(e.p.map(c=>nudge(c[0],c[1])),LV.bounds); e.x=e.p[0][0]; e.z=e.p[0][1]; e.i=1%e.p.length; e.st='pat'; e.tr=[]; }
    { const fi=G.f.fires?inFire(G.f,e.x,e.z,.5):-1; if(fi>=0){ const q=G.f.fires[fi],d=Math.max(.01,dist(e.x,e.z,q.x,q.z)),o=nudge(q.x+(e.x-q.x)/d*(q.r+2),q.z+(e.z-q.z)/d*(q.r+2)); e.x=o[0]; e.z=o[1]; } }
    let maxA=0,tgt=null,vis=null;
    for(const p of G.pl){ const s=seen(e,p),a=e.al[p.id]||0,keep=(e.st==='chase'||e.st==='search')?.3:.7,na=s>0?Math.min(1.2,a+dt*s):Math.max(0,a-dt*keep); e.al[p.id]=na;
      if(s>0&&(!vis||na>(e.al[vis.id]||0))) vis=p; if(na>maxA){ maxA=na; tgt=p; }
      if(na>=1&&!p.cap){ p.cap=true; if(LV.drop) LV.drop(p); p.carry=false; e.al[p.id]=0; e.pause=3; G.caught++; event(p.n+'が徳川方の追手に見つかり、捕まった！'+(nPl()>1?' 近づいて「縄を解く」で助けよう':'')); e.st='search'; e.stT=0; e.srT=4; e.lk={x:p.x,z:p.z}; } }
    if(vis){ e.lk={x:vis.x,z:vis.z}; }
    const off=e.st!=='pat';
    const face=(x,z)=>{ e.yaw=Math.atan2(-(x-e.x),-(z-e.z)); };
    const goTo=(x,z,sp)=>{ const d=dist(e.x,e.z,x,z); if(d<.35) return true; face(x,z); const st=Math.min(d,sp*dt); const ok=enMove(e,e.x+(x-e.x)/d*st,e.z+(z-e.z)/d*st); e.stk=ok?0:(e.stk||0)+dt; return false; };
    const crumb=()=>{ const t=e.tr; if(!t.length||dist(e.x,e.z,t[t.length-1][0],t[t.length-1][1])>1.5){ t.push([e.x,e.z]); if(t.length>160) t.splice(1,1); } };
    if(e.pause>0){ e.pause-=dt; e.yaw+=Math.sin(performance.now()/700+e.x)*dt*.8; e.look=Math.max(maxA,e.st==='search'?.2:0); return; }
    /* 気づいた・見つけた */
    if(vis&&maxA>.5){ if(e.st==='pat'||e.st==='shift') e.tr=[[e.x,e.z]]; e.st='chase'; }
    else if(vis&&maxA>.2&&(e.st==='pat'||e.st==='ret'||e.st==='shift'||e.st==='search')){ if(e.st==='pat'||e.st==='shift') e.tr=[[e.x,e.z]]; e.st='sus'; e.stT=0; }
    switch(e.st){
      case 'sus': e.stT+=dt; face(e.lk.x,e.lk.z); if(!vis&&e.stT>1.2){ e.st='inv'; e.stT=0; } else if(e.stT>6) { e.st='inv'; e.stT=0; } break;
      case 'chase': crumb(); if(vis&&dist(e.x,e.z,vis.x,vis.z)<1.6){ face(vis.x,vis.z); break; }
        if(goTo(e.lk.x,e.lk.z,Math.max(1.5,e.s*1.05))||(e.stk||0)>1.5||(!vis&&maxA<.15)){ e.st='search'; e.stT=0; e.srT=LV.searchT||8; e.sp=null; e.stk=0; } break;
      case 'inv': crumb(); e.stT+=dt; if(goTo(e.lk.x,e.lk.z,e.s*.95)||(e.stk||0)>1.5||e.stT>25){ e.st='search'; e.stT=0; e.srT=(LV.searchT||8)*.7; e.sp=null; e.stk=0; } break;
      case 'search': crumb(); e.srT-=dt; e.stT+=dt;
        if(!e.sp||e.stT>2.6||goTo(e.sp[0],e.sp[1],e.s*.75)||(e.stk||0)>1){ e.stT=0; e.stk=0; e.sp=null; for(let k=0;k<8&&!e.sp;k++){ const a=Math.random()*6.283,r=2+Math.random()*6,x=e.lk.x+Math.cos(a)*r,z=e.lk.z+Math.sin(a)*r; if(enOk(x,z,LV.bounds)&&losClear(e.x,e.z,x,z)) e.sp=[x,z]; } if(!e.sp){ e.yaw+=dt*2.5; } }
        if(e.srT<=0){ e.st='ret'; e.stk=0; } break;
      case 'ret': { const t=e.tr; if(!t.length){ e.st='pat'; break; } const c=t[t.length-1]; if(goTo(c[0],c[1],e.s)||(e.stk||0)>1.2){ t.pop(); e.stk=0; } } break;
      case 'shift': { const S=LV.shift; if(!SH||!SH.on){ e.st='ret'; break; } crumb(); if(goTo(S.post.x+(i%3-1)*1.6,S.post.z+((i/3|0)%2)*1.6,e.s*1.1)||(e.stk||0)>2){ e.yaw+=dt*.3; } } break;
      default: {
        if(SH&&SH.on&&LV.shift.who.includes(i)){ e.tr=[[e.x,e.z]]; e.st='shift'; break; }
        if(LV.relight&&W.lamps&&G.f.lamp){ for(let j=0;j<W.lamps.length;j++){ const L=W.lamps[j]; if(!G.f.lamp[j]&&dist(e.x,e.z,L.x,L.z)<4.5){ e.lt=(e.lt||0)+dt; face(L.x,L.z); if(e.lt>2.2){ e.lt=0; G.f.lamp[j]=1; event('見張りが'+(L.n||'灯り')+'をつけ直した'); } e.look=maxA; return; } } }
        const w=e.p[e.i],d=dist(e.x,e.z,w[0],w[1]);
        if(d<.4){ e.i=(e.i+1)%e.p.length; e.pause=1.6; break; }
        face(w[0],w[1]); const st=Math.min(d,e.s*dt); if(!enMove(e,e.x+(w[0]-e.x)/d*st,e.z+(w[1]-e.z)/d*st)){ e.stk=(e.stk||0)+dt; if(e.stk>1.5){ e.stk=0; e.i=(e.i+1)%e.p.length; e.pause=.8; } } else e.stk=0; }
    }
    e.look=Math.max(maxA,e.st==='search'||e.st==='inv'?.2:e.st==='sus'?.3:0);
  }
  function losClear(x0,z0,x1,z1){ const d=dist(x0,z0,x1,z1); for(let s=1;s<d;s+=1){ const x=x0+(x1-x0)*s/d,z=z0+(z1-z0)*s/d; if(!enOk(x,z,LV.bounds)) return false; } return true; }
  /* 見回りの道が建物や堀を突き抜けないよう、歩ける所へずらす（だめなら歩ける区間だけに縮める） */
  function enOk(x,z,B){ return (!B||inR(B,x,z,0))&&_walkable(x,z)&&!hitBlock(x,z,.6)&&!(G&&G.f&&(inFire(G.f,x,z,.5)>=0||(LV.eblock&&LV.eblock(x,z,G.f)))); }
  function segBad(a,b,B){ const L=Math.hypot(b[0]-a[0],b[1]-a[1]),n=Math.max(2,Math.ceil(L/1.5)); let k=0; for(let i=0;i<=n;i++){ const t=i/n; if(!enOk(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,B)) k++; } return k/(n+1); }
  function pathBad(p,B){ let w=0; for(let i=0;i<p.length;i++){ if(p.length===2&&i===1) break; w=Math.max(w,segBad(p[i],p[(i+1)%p.length],B)); } return w; }
  function fixPath(p,B){ if(pathBad(p,B)<=.02) return p;
    for(let r=1;r<=14;r++) for(const [dx,dz] of [[r,0],[-r,0],[0,r],[0,-r]]){ const q=p.map(c=>[c[0]+dx,c[1]+dz]); if(pathBad(q,B)<=.02) return q; }
    if(p.length===2){ const a=p[0],b=p[1],L=Math.hypot(b[0]-a[0],b[1]-a[1]),n=Math.max(2,Math.ceil(L/1.5)); let bs=-1,bl=0,cs=-1;
      for(let i=0;i<=n+1;i++){ const t=i/n,ok=i<=n&&enOk(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,B); if(ok&&cs<0) cs=i; if(!ok&&cs>=0){ if(i-cs>bl){ bl=i-cs; bs=cs; } cs=-1; } }
      if(bl>=3){ const P=t=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]; return [P(bs/n),P((bs+bl-1)/n)]; } }
    return p; }
  function enMove(e,nx,nz){ const B=LV&&LV.bounds; if(enOk(nx,nz,B)){ e.x=nx; e.z=nz; return true; } if(enOk(nx,e.z,B)){ e.x=nx; return true; } if(enOk(e.x,nz,B)){ e.z=nz; return true; } return false; }
  const OFFS=[[0,0],[3,0],[-3,0],[0,3]];
  function resetToCheck(m){ const c=LV.check(G.f); G.pl.forEach((p,i)=>{ p.cap=false; p.grace=5; if(LV.drop) LV.drop(p); p.carry=false; const q=nudge(c[0]+OFFS[i][0],c[1]+OFFS[i][1]); p.x=q[0]; p.z=q[1]; sendTo(p.id,{t:'tp',x:p.x,z:p.z}); }); for(const e of G.en) e.al={}; event(m); }
  function finish(win,msg){ const used=LEVELS[G.lv].limit-G.t; G.over={win,msg,used,res:G.rescues,cau:G.caught,lv:G.lv}; broadcast({t:'end',...G.over}); onEnd(G.over); }
  function snap(){ const ho={}; for(const k in G.hold||{}) ho[k]=+G.hold[k].toFixed(3); return {t:'g',lv:G.lv,f:G.f,tm:Math.round(G.t*10)/10,el:+(G.el||0).toFixed(2),hold:ho,hn:G.hn||{},sw:G.sw,gh:G.gh,notes:G.notes,
    pl:G.pl.map(p=>({id:p.id,n:p.n,c:p.c,x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2),yaw:+p.yaw.toFixed(2),cr:p.cr,cap:p.cap,carry:p.carry,hk:p.hk,hp:+p.hp.toFixed(2),room:p.room,off:!!p.off,nz:+(p.nz||0).toFixed(2)})),
    en:G.en.map(e=>[+e.x.toFixed(2),+e.z.toFixed(2),+e.yaw.toFixed(2),+e.look.toFixed(2),e.spr])}; }

  /* ---------- 自分・通信 ---------- */
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
        c.on('data',m=>{ if(m.t==='hello'){
            const back=m.tok&&lobby.find(p=>p.tok===m.tok&&p.id!==0);
            if(back){ id=back.id; const old=net.conns.get(id); if(old&&old!==c){ try{ old.close(); }catch(e){} } net.conns.set(id,c); back.off=false; clearTimeout(back.drop); c.send({t:'welcome',id,code:net.code});
              const gp=G&&!G.over&&G.pl.find(q=>q.id===id); if(gp){ gp.off=false; gp.grace=5; gp.cap=false; c.send({t:'start',i:gp.c,lv:G.lv,set:G.set,resume:1,x:gp.x,z:gp.z}); event(gp.n+'が戻ってきた！'); } else syncLobby(); return; }
            if(me.inGame||lobby.length>=MAXP){ c.send({t:'full',m:me.inGame?'もう出陣しています':'満員です（4人まで）'}); setTimeout(()=>c.close(),400); return; }
            id=Math.max(0,...lobby.map(p=>p.id))+1; net.conns.set(id,c); lobby.push({id,n:String(m.n||'名無し').slice(0,10),tok:m.tok||''}); c.send({t:'welcome',id,code:net.code}); syncLobby(); return; }
          if(m.t==='code'&&G){ onCode(m.v,m.syms); return; }
          if(m.t==='s'&&G){ const p=G.pl.find(q=>q.id===id); if(p&&!p.cap){ Object.assign(p,{x:m.x,y:m.y,z:m.z,yaw:m.yaw,cr:!!m.cr,use:!!m.use,run:!!m.run,room:!!m.room}); } else if(p){ p.use=!!m.use; } } });
        c.on('close',()=>{ if(!id||net.conns.get(id)!==c) return; net.conns.delete(id); const p=lobby.find(q=>q.id===id); if(!p) return;
          const gp=G&&!G.over&&G.pl.find(q=>q.id===id);
          if(gp){ gp.off=true; gp.use=false; p.off=true; event(p.n+'の通信が切れた。戻ってくるのを待っています（3分）'); const pid=id;
            p.drop=setTimeout(()=>{ const q=lobby.find(x=>x.id===pid); if(q&&q.off){ lobby=lobby.filter(x=>x.id!==pid); if(G) G.pl=G.pl.filter(x=>x.id!==pid); event(q.n+'は戻らなかった'); syncLobby(); } },180000); }
          else { lobby=lobby.filter(q=>q.id!==id); syncLobby(); } }); }); };
    tryOpen(0);
  }
  const myTok=(()=>{ try{ let t=localStorage.getItem('escTok'); if(!t){ t=Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem('escTok',t); } return t; }catch(e){ return Math.random().toString(36).slice(2); } })();
  function saveRoom(code){ try{ localStorage.setItem('escRoom',JSON.stringify({code,t:Date.now(),n:me.name})); }catch(e){} }
  function lastRoom(){ try{ const r=JSON.parse(localStorage.getItem('escRoom')||'null'); return r&&Date.now()-r.t<20*60000?r:null; }catch(e){ return null; } }
  function clearRoom(){ try{ localStorage.removeItem('escRoom'); }catch(e){} }
  let rejoinN=0,leaving=false;
  async function join(code,again){
    net.mode='client'; if(!again) lobbyStatus('部屋をさがしています…');
    try{ await loadPeer(); }catch(e){ return lobbyErr(e.message); }
    if(net.peer){ try{ net.peer.destroy(); }catch(e){} }
    const pr=new Peer(peerOpts()); net.peer=pr;
    pr.on('error',e=>{ if(again) return retryJoin(); lobbyErr(e.type==='peer-unavailable'?'部屋が見つかりません（番号を確認してください）':'通信エラー：'+(e.type||e.message)); });
    pr.on('open',()=>{ const c=pr.connect(PEER_PREFIX+code,{reliable:true,serialization:'json'}); net.host=c; net.code=code;
      const to=setTimeout(()=>{ if(!c.open){ if(again) return retryJoin(); lobbyErr('つながりませんでした。回線（モバイル回線どうし等）によっては接続できないことがあります'); } },12000);
      c.on('open',()=>{ clearTimeout(to); rejoinN=0; c.send({t:'hello',n:me.name,tok:myTok}); saveRoom(code); });
      c.on('data',onMsg);
      c.on('close',()=>{ if(net.host!==c||leaving) return; if(G&&G.over) return; if(me.inGame||el('escEnd').hidden===false){ showDrop(true); retryJoin(); } else lobbyErr('部屋との接続が切れました'); }); });
  }
  function retryJoin(){ if(leaving) return; rejoinN++; showDrop(true); if(rejoinN>40){ showDrop(false); onEvent('部屋に戻れませんでした。タイトルから「前の部屋に戻る」を試してください'); return; } setTimeout(()=>join(net.code,true),3000); }
  function showDrop(on){ const d=el('escDrop'); if(!d) return; d.hidden=!on; if(on) d.innerHTML='通信が切れました<br><span style="font-size:14px;font-weight:400">部屋に戻ろうとしています…（'+rejoinN+'回目）</span>'; }
  function onMsg(m){
    if(m.t==='welcome'){ net.myId=m.id; showDrop(false); if(!me.inGame) showLobby(); }
    else if(m.t==='full'){ lobbyErr(m.m); }
    else if(m.t==='lobby'){ lobby=m.l; showLobby(); }
    else if(m.t==='start'){ showDrop(false); startWorld(m.i,m.lv,m.set,m.resume?m:null); }
    else if(m.t==='bye'){ leaving=true; clearRoom(); alertBox('主が部屋を閉じました',()=>location.reload()); }
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
@media (max-height:520px){#escL h1{font-size:26px}#escL .lead{display:none}#escL .lvs{display:grid;gap:6px;margin:4px 0 12px;text-align:left}
@media (orientation:landscape) and (max-height:500px){ #escL .box{width:min(760px,100%)} #escL .lvs{display:grid;grid-template-columns:1fr 1fr;gap:6px} #escL .lvs .lv{margin:0!important} }
#escL .lv{display:block;width:100%;border-radius:10px;border:1px solid var(--line);background:#1d1e22;color:#fff;padding:9px 12px;font:inherit;cursor:pointer}
#escL .lv b{display:block;font-size:14px}
#escL .lv small{display:block;font-size:11px;color:var(--mute);margin-top:2px}
#escL .lv.on{border-color:#e8b13a;background:#2b2516}
#escL .lv:disabled{opacity:.4}
#escL .how{display:none}#escL .code{font-size:34px}#escL button.b{height:44px;margin-bottom:8px}#escL input{height:42px}#escL .pls{grid-template-columns:1fr 1fr}}
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
#escMin{position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);z-index:30;pointer-events:none;text-align:center;font-family:var(--f-disp);font-weight:800;font-size:clamp(34px,11vw,92px);line-height:1.15;letter-spacing:.04em;white-space:nowrap;color:#ff2a1a;text-shadow:0 0 18px rgba(0,0,0,.9),0 3px 0 #000,0 0 40px rgba(255,40,20,.6);animation:escMinA 3.4s ease-out forwards}
@keyframes escMinA{0%{opacity:0;transform:translate(-50%,-50%) scale(1.6)}10%{opacity:1;transform:translate(-50%,-50%) scale(1)}20%{opacity:.55}30%{opacity:1}40%{opacity:.55}50%{opacity:1}85%{opacity:1}100%{opacity:0}}
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
#escEnd{position:fixed;inset:0;z-index:41;display:flex;overflow:auto;touch-action:pan-y;background:#0a0a0c center/cover no-repeat;padding:20px}
#escEnd::before{content:'';position:fixed;inset:0;background:linear-gradient(0deg,rgba(8,8,10,0) 55%,rgba(8,8,10,.25) 100%);pointer-events:none}
@media (orientation:landscape){#escEnd::before{background:linear-gradient(90deg,rgba(8,8,10,0) 55%,rgba(8,8,10,.25) 100%)}}
#escEnd .box{position:relative;background:rgba(10,10,14,.28);-webkit-backdrop-filter:blur(1.5px);backdrop-filter:blur(1.5px);border:1px solid rgba(232,177,58,.35);border-radius:16px;padding:18px 18px 8px}
#escEnd h2,#escEnd p,#escEnd dl,#escEnd .box>div{text-shadow:0 0 3px #000,0 1px 8px #000,0 0 14px rgba(0,0,0,.8)}
#escEnd dt{color:#e4e4e4!important}
#escEnd button:not(.p){background:rgba(30,31,36,.55)!important;border:1px solid rgba(255,255,255,.25)!important}
#escEnd .box{width:min(380px,100%);text-align:center;margin:calc(env(safe-area-inset-top,0px) + 4px) auto auto}
@media (orientation:landscape){#escEnd .box{margin:auto 0 auto auto;width:min(360px,46vw)}}
@media (max-height:520px){#escEnd h2{font-size:26px;margin-bottom:4px}#escEnd dl{margin:6px 0 10px}#escEnd button{height:42px;margin-bottom:6px}}
#escEnd h2{font-family:var(--f-disp);font-size:30px;letter-spacing:.14em;margin:0 0 6px}
#escEnd p{color:#d6d8da;line-height:1.7;font-size:13.5px;margin:6px 0}
#escEnd dl{display:grid;grid-template-columns:auto auto;gap:3px 16px;justify-content:center;margin:8px 0 12px;font-size:13px}
#escEnd dt{color:var(--mute)} #escEnd dd{margin:0;font-weight:700;text-align:left}
#escEnd button{width:100%;height:46px;border-radius:12px;border:0;font:inherit;font-weight:700;font-size:16px;margin-bottom:10px;background:#2a2b30;color:#fff}
#escEnd button.p{background:var(--shu)}
#escHud .obj .tk{margin:1px 0}
#escHud .stat{font-size:11.5px;font-weight:700;color:#ffd36a;text-shadow:0 1px 4px #000;margin:2px 0 3px}
#escHud .nz{display:flex;align-items:center;gap:6px;font-size:11px;color:#e9dcc0;text-shadow:0 1px 4px #000;margin:2px 0 4px}
#escHud .nz i{display:block;width:90px;height:6px;border-radius:3px;background:rgba(255,255,255,.18);overflow:hidden}
#escHud .nz b{display:block;height:100%;width:0;transition:width .15s}
#escDark{position:fixed;inset:0;z-index:4;pointer-events:none;background:radial-gradient(ellipse at center,rgba(0,0,0,.05) 25%,rgba(0,0,8,.72) 85%)}
#escCr.dis{opacity:.35}
#escHud .obj .tk.ok{color:#9effa8;opacity:.75;text-decoration:line-through;text-decoration-color:rgba(158,255,168,.6)}
#escHud .obj .tk.h:not(.ok){color:#e9dcc0;font-weight:600}
#escHud .obj .tk small{font-size:10px;color:#cdbb8f;margin-left:3px}
#escHud .obj .tk.hint{color:#ffd36a;font-weight:600;font-size:12px}
#escPl{left:auto;right:calc(env(safe-area-inset-right,0px) + 12px);top:calc(env(safe-area-inset-top,0px) + 166px);flex-direction:column;align-items:flex-end;max-width:40vw}
#escPl div.off{opacity:.55}
#escNB{right:calc(env(safe-area-inset-right,0px) + 56px)}
#escMenu{position:fixed;z-index:8;right:calc(env(safe-area-inset-right,0px) + 12px);top:calc(env(safe-area-inset-top,0px) + 126px);width:38px;height:32px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:#fff;font:inherit;font-size:18px;line-height:1;padding:0}
@media (min-width:760px){#escNB,#escMenu{top:calc(env(safe-area-inset-top,0px) + 152px)}#escPl{top:calc(env(safe-area-inset-top,0px) + 192px)}}
body.escPlay #mini{pointer-events:auto!important;cursor:pointer}
@media (orientation:portrait){body.escPlay #hint{bottom:calc(env(safe-area-inset-bottom,0px) + 306px)!important}}
body.escPlay #mini .tap{display:block!important}
#escMap{position:fixed;inset:0;z-index:40;touch-action:none}
#escMap canvas{width:100%;height:100%;display:block}
#escDrop{position:fixed;left:50%;top:30%;transform:translateX(-50%);z-index:45;background:rgba(120,20,12,.92);border:1px solid #ff8f7e;color:#fff;border-radius:14px;padding:12px 18px;font-weight:800;font-size:17px;text-align:center;line-height:1.5;pointer-events:none;max-width:90vw}
#escAsk{position:fixed;inset:0;z-index:46;display:flex;background:rgba(8,8,10,.72);padding:16px;overflow:auto}
#escAsk .box{margin:auto;width:min(380px,100%);background:#17181b;border:1px solid var(--line);border-radius:16px;padding:16px}
#escAsk h3{font-family:var(--f-disp);margin:0 0 8px;font-size:20px;letter-spacing:.1em}
#escAsk p{font-size:13.5px;line-height:1.7;color:#d6d8da;margin:0 0 10px}
#escAsk .b{width:100%;height:46px;border-radius:12px;border:0;font:inherit;font-weight:700;font-size:15px;margin-top:6px;background:#2a2b30;color:#fff}
#escAsk .b.p{background:var(--shu)}
@media (orientation:landscape) and (max-height:500px){
 #escHud{right:auto;width:min(42vw,320px);top:calc(env(safe-area-inset-top,0px) + 6px)} #escHud .stg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.08em}
 #escHud .tm{font-size:22px} #escHud .obj{font-size:11.5px} #escHud .obj .tk.hint{font-size:11px}
 #escPl{top:calc(env(safe-area-inset-top,0px) + 6px);right:calc(env(safe-area-inset-right,0px) + 112px);max-width:none}
 #escPl div{font-size:10.5px;padding:3px 7px}
 #escNB{top:calc(env(safe-area-inset-top,0px) + 104px);right:calc(env(safe-area-inset-right,0px) + 54px);height:30px;padding:0 10px}
 #escMenu{top:calc(env(safe-area-inset-top,0px) + 104px);height:30px;width:36px}
 #escUse{right:calc(env(safe-area-inset-right,0px) + 130px);bottom:calc(env(safe-area-inset-bottom,0px) + 30px);width:76px;height:76px}
 #escCr{right:calc(env(safe-area-inset-right,0px) + 140px);bottom:calc(env(safe-area-inset-bottom,0px) + 116px);width:56px;height:56px}
 #escLog{max-width:min(300px,36vw)} #escLog div{font-size:11px;padding:4px 7px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden} #escLog div:nth-child(n+2){display:none} #escHud .stat{font-size:10.5px;margin:1px 0} #escHud .nz{margin:1px 0 2px}
 #escArrow{bottom:calc(env(safe-area-inset-bottom,0px) + 6px)}
}
@media (orientation:landscape) and (max-height:350px){
 #escUse{width:64px;height:64px;font-size:12px} #escCr{width:48px;height:48px;bottom:calc(env(safe-area-inset-bottom,0px) + 100px);right:calc(env(safe-area-inset-right,0px) + 138px);font-size:11px}
 #escNB,#escMenu{top:calc(env(safe-area-inset-top,0px) + 100px)}
 body.escPlay #hint{bottom:calc(env(safe-area-inset-bottom,0px) + 50px)!important;max-width:calc(100% - 470px)!important;min-width:200px}
}
`; document.head.appendChild(css);
    const L=document.createElement('section'); L.id='escL'; document.body.appendChild(L);
    const hud=document.createElement('div'); hud.innerHTML=`<div id="escHud" hidden><div class="stg" id="escStg"></div><div class="tm" id="escTm"></div><div class="stat" id="escStat"></div><div class="nz" id="escNz" hidden><span>物音</span><i><b id="escNzB"></b></i></div><div class="obj" id="escObj"></div></div><div id="escDark" hidden></div>
<div id="escArrow" hidden><svg viewBox="0 0 34 34"><path d="M17 3 L29 29 L17 22 L5 29 Z" fill="#ffd36a" stroke="#111" stroke-width="1.5"/></svg><span id="escDist"></span></div>
<button id="escUse" hidden><span id="escUseL">調べる</span><span class="pg" id="escPg"></span></button><button id="escCr" hidden aria-pressed="false">しゃがむ</button>
<button id="escNB" hidden>手控え 0</button><section id="escNotes" hidden></section><section id="escLock" hidden></section><div id="escVig"></div><div id="escMin" hidden><div>残り時間</div><div style="font-size:1.5em">1分</div></div><div id="escWarn" hidden></div><section id="escIntro" hidden></section><div id="escCap" hidden></div><div id="escLog"></div><div id="escPl"></div><section id="escEnd" hidden></section><button id="escMenu" hidden aria-label="メニュー">≡</button><section id="escMap" hidden><canvas id="escMapC"></canvas></section><div id="escDrop" hidden></div><section id="escAsk" hidden></section>`; document.body.append(...hud.children);
    const U=el('escUse'); const down=e=>{ e.preventDefault(); e.stopPropagation(); if(tgKey==='chat'){ const c=chatTarget(); if(c) doChat(c.it); return; } me.use=true; latch(); }, up=e=>{ e.preventDefault(); e.stopPropagation(); me.use=false; };
    U.addEventListener('pointerdown',down); U.addEventListener('pointerup',up); U.addEventListener('pointercancel',up); U.addEventListener('pointerleave',up);
    el('escNB').addEventListener('click',e=>{ e.stopPropagation(); openNotes(); });
    el('escMenu').addEventListener('click',e=>{ e.stopPropagation(); openMenu(); });
    el('escMap').addEventListener('pointerdown',e=>{ e.preventDefault(); e.stopPropagation(); closeBigMap(); });
    { const mn=$('mini'),oc=mn.onclick; mn.onclick=e=>{ if(me.inGame){ e.stopPropagation(); resetPad(); openBigMap(); return; } if(oc) oc.call(mn,e); }; }
    addEventListener('resize',()=>{ hudHTML=''; });
    el('escCr').addEventListener('pointerdown',e=>{ e.preventDefault(); e.stopPropagation(); me.cr=!me.cr; el('escCr').setAttribute('aria-pressed',me.cr); });
    addEventListener('keydown',e=>{ if(e.target&&e.target.tagName==='INPUT') return; if((e.code==='KeyE'||e.code==='Space')&&!e.repeat){ if(tgKey==='chat'){ const c=chatTarget(); if(c) doChat(c.it); } else { me.use=true; latch(); } } if(e.code==='KeyM'&&!e.repeat&&me.inGame){ el('escMap').hidden?openBigMap():closeBigMap(); } if(e.code==='KeyC'&&!e.repeat){ me.cr=!me.cr; el('escCr').setAttribute('aria-pressed',me.cr); } });
    addEventListener('keyup',e=>{ if(e.code==='KeyE'||e.code==='Space') me.use=false; });
    titleScreen();
    addEventListener('error',e=>{ const s=el('escSt'); if(s&&!me.inGame){ s.className='st er'; s.textContent='エラー：'+(e.message||e.error); } });
  }
  /* 調べるボタンは軽く押すだけでもよい（終わるまで押さえ続けた扱い。動くか対象が変わると離す） */
  let tgKey=null;
  function latch(){ if(!tgKey) return; me.latch=true; me.latchKey=tgKey; me.latchX=P.x; me.latchZ=P.z; me.latchT=performance.now(); }
  function useNow(){ return me.use||!!me.latch; }
  function titleScreen(){ const L=el('escL'); L.hidden=false; let nm=''; try{ nm=localStorage.getItem('escName')||''; }catch(e){}
    L.innerHTML=`<div class="box"><h1><small>大坂の陣 ・ 十の任務</small>大坂城脱出</h1>
<p class="lead">慶長十九年から二十年、大坂の陣。豊臣方に仕えるあなたたちは、城下から本丸、そして燃え落ちる天守まで、十の任務に挑む。聞き込み、謎を解き、探し出し、徳川方の追手をかわして脱出せよ。1〜4人で遊べる協力脱出ゲームです。</p>
<input id="escName" maxlength="10" placeholder="名前（例：才蔵）" value="${esc(nm)}" autocomplete="off">
<button class="b p" id="escSolo" disabled>読み込み中…</button>
<div class="row"><button class="b" id="escHost" disabled>部屋をつくる</button><button class="b" id="escJoinB" disabled>部屋に入る</button></div>
${lastRoom()?`<button class="b" id="escRe">前の部屋（${esc(lastRoom().code)}）に戻る</button>`:''}${clearedN()>0?`<div class="st">クリアした面：${clearedN()>=LEVELS.length?'すべて':clearedN()+' 面まで'}　部屋をつくると、そこまでの好きな面から始められます</div>`:''}
<div id="escJoinF" hidden><input id="escCode" inputmode="numeric" maxlength="4" placeholder="部屋番号（4桁）"><button class="b p" id="escJoin">入る</button></div>
<div class="st" id="escSt"></div>
<div class="how"><b>操作</b>　左のパッドで移動、右側で見回し。<b>調べる</b>は長押し、<b>しゃがむ</b>で追手に見つかりにくくなります（PCは WASD・E・C・Shiftで走る）。<br><b>追手</b>に見つかると「！」がたまり、満タンで捕まります。仲間は近づいて縄を解けます。</div></div>`;
    const name=()=>{ const v=(el('escName').value||'').trim()||'名無し'; me.name=v.slice(0,10); try{ localStorage.setItem('escName',me.name); }catch(e){} };
    el('escSolo').onclick=()=>{ name(); net.solo=true; host(); };
    el('escHost').onclick=()=>{ name(); net.solo=false; host(); };
    el('escJoinB').onclick=()=>{ el('escJoinF').hidden=false; el('escCode').focus(); };
    el('escJoin').onclick=()=>{ const c=(el('escCode').value||'').replace(/\D/g,''); if(c.length!==4) return lobbyErr('4桁の部屋番号を入れてください'); name(); join(c); };
    if(el('escRe')) el('escRe').onclick=()=>{ name(); join(lastRoom().code); };
    const pc=qs.get('room'); if(pc){ el('escJoinF').hidden=false; el('escCode').value=pc; }
    waitReady(); }
  function waitReady(){ if(!ready){ setTimeout(waitReady,200); return; } const s=el('escSolo'); if(!s) return; s.disabled=false; s.textContent='ひとりで遊ぶ'; el('escHost').disabled=false; el('escJoinB').disabled=false; }
  function lobbyStatus(t){ const s=el('escSt'); if(s){ s.className='st'; s.textContent=t; } }
  function lobbyErr(t){ const s=el('escSt'); if(s){ s.className='st er'; s.textContent=t; } if(!el('escSt')) onEvent(t); }
  function showLobby(){ if(me.inGame) return; const L=el('escL'); L.hidden=false; const isHost=net.mode==='host'; if(pickLv===null) pickLv=progress(); const sel=pickLv;
    const url=location.origin+location.pathname+'?room='+net.code+(qs.get('peer')?'&peer='+qs.get('peer'):'');
    L.innerHTML=`<div class="box"><h1 style="font-size:24px"><small>${net.solo?'ひとりで':'部屋番号'}</small></h1>${net.solo?'':`<div class="code">${net.code}</div><div class="st">この番号を仲間に伝えてください（最大4人）</div>${isHost&&navigator.share?'<button class="b" id="escShare">招待リンクを送る</button>':''}`}
<div class="pls">${lobby.map((p,i)=>`<div class="pl"><i style="background:${COLS[i%4]}"></i>${esc(p.n)}${p.id===0?'（主）':''}${p.id===net.myId?' ← あなた':''}</div>`).join('')}</div>
${isHost?`<div class="lvs">${LEVELS.map((L,i)=>`<button class="lv${i===sel?' on':''}" data-lv="${i}" ${i>progress()?'disabled':''}><b>${esc(lvTitle(i))}</b><small>${i>progress()?'前の面をクリアすると遊べる':esc(L.sub)}</small></button>`).join('')}</div><button class="b p" id="escGo">出陣する（${lobby.length}人）</button>`:'<div class="st">主が面を選んで出陣するのを待っています…</div>'}
<button class="b" id="escBack">もどる</button><div class="st" id="escSt"></div></div>`;
    if(el('escShare')) el('escShare').onclick=()=>navigator.share({title:'大坂城脱出',text:'部屋番号 '+net.code+' で一緒に脱出しよう',url}).catch(()=>{});
    if(el('escGo')) el('escGo').onclick=()=>hostStart(pickLv); L.querySelectorAll('.lv').forEach(b=>b.onclick=()=>{ pickLv=+b.dataset.lv; showLobby(); });
    el('escBack').onclick=()=>location.reload(); }
  function clearedN(){ try{ return +(localStorage.getItem('escClear')||0); }catch(e){ return 0; } }
  function progress(){ try{ return Math.min(LEVELS.length-1,+(localStorage.getItem('escClear')||0)); }catch(e){ return 0; } }
  function saveClear(lv){ try{ const c=+(localStorage.getItem('escClear')||0); if(lv+1>c) localStorage.setItem('escClear',String(Math.min(LEVELS.length,lv+1))); }catch(e){} }
  let pickLv=null;
  function hostStart(lv){ if(lv===undefined) lv=pickLv!==null?pickLv:progress(); const set=LEVELS[lv].setup(); newGame(lobby,lv,set); G.pl.forEach((p,i)=>{ if(p.id) sendTo(p.id,{t:'start',i,lv,set}); }); startWorld(0,lv,set); }

  /* ---------- 手控え（集めた手がかり）と錠前・合言葉 ---------- */
  const notesSeen={n:0};
  function renderNotes(){ const N=(V&&V.notes)||[]; el('escNotes').innerHTML=`<div class="box"><h3>手控え</h3>${N.length?`<ol>${N.map(t=>`<li>${esc(t)}</li>`).join('')}</ol>`:'<p class="none">まだ手がかりはない。人に話を聞いたり、あやしい所を調べたりしよう。</p>'}<button id="escNX">閉じる</button></div>`; el('escNX').onclick=closeNotes; }
  function openNotes(){ resetPad(); renderNotes(); el('escNotes').hidden=false; }
  function closeNotes(){ const n=el('escNotes'); if(n) n.hidden=true; }
  let lockVal=[0,0,0],lockDef=null;
  function openLock(){ if(!LV||!LV.lock||!V) return; const L=el('escLock'); L.hidden=false; resetPad(); me.latch=false; lockDef=LV.lock(); lockVal=[0,0,0];
    const draw=()=>{ const D=lockDef; L.innerHTML=`<div class="box"><h3>${esc(D.title)}</h3><p class="sub">${esc(D.sub)}</p>
<p class="clues">${esc(D.known||'')}</p>
<div class="dials">${[...Array(D.slots).keys()].map(i=>`<div class="dial">${D.slots>1?`<span>${ORD[i]||''}</span>`:''}<button data-i="${i}">${esc(D.syms[lockVal[i]])}</button><small>押すと変わる</small></div>`).join('')}</div>
<button class="b p" id="escLockGo">${D.slots>1?'合わせる':'答える'}</button><button class="b" id="escLockX">やめる</button></div>`;
      L.querySelectorAll('.dial button').forEach(b=>b.onclick=()=>{ const i=+b.dataset.i; lockVal[i]=(lockVal[i]+1)%D.syms.length; draw(); });
      el('escLockGo').onclick=()=>{ const v=lockVal.slice(0,D.slots),syms=D.syms.slice(); if(net.mode==='host') onCode(v,syms); else if(net.host&&net.host.open) net.host.send({t:'code',v,syms}); closeLock(); };
      el('escLockX').onclick=closeLock; };
    draw(); }
  function closeLock(){ const L=el('escLock'); if(L) L.hidden=true; }
  function showIntro(lv){ const I=el('escIntro'); I.hidden=false; const L=LEVELS[lv];
    I.innerHTML=`<div class="box"><div style="color:#e8b13a;font-size:12px;letter-spacing:.2em">${esc(L.sub)}</div><h3>${esc(lvTitle(lv))}</h3><p style="font-size:14px;line-height:1.75;margin:0 0 12px">${esc(L.story)}</p>
<div class="row"><svg viewBox="0 0 64 64"><path d="M32 54 L8 14 A46 46 0 0 1 56 14 Z" fill="rgba(255,176,48,.35)" stroke="#ffb030" stroke-width="2"/><circle cx="32" cy="54" r="6" fill="#c33"/></svg><div><b>徳川方の追手</b>（赤い「追手」の札、提灯の明かり）が城内を見回っている。<b>地面のオレンジの扇形</b>が追手の視界だ。</div></div>
<div class="row"><svg viewBox="0 0 64 64"><text x="16" y="46" font-size="40" font-weight="bold" fill="#ffd36a" stroke="#000" stroke-width="2">？</text></svg><div>扇形に入ると頭上に「？」、さらに「！」が出て、扇形が赤くなる。そのままだと<b>捕まる</b>。すぐ扇形の外へ。</div></div>
<div class="row"><svg viewBox="0 0 64 64"><rect x="10" y="22" width="44" height="26" rx="13" fill="#3fa7d6"/><text x="32" y="40" font-size="12" text-anchor="middle" fill="#111" font-weight="bold">しゃがむ</text></svg><div><b>しゃがむ</b>と、扇形の奥のほうでは見つからない（近くは別）。<b>走る</b>と見つかりやすい。建物の中にいれば見つからない。</div></div>
<button id="escIntroGo">はじめる</button></div>`; el('escIntroGo').onclick=()=>{ I.hidden=true; }; }

  /* ---------- 落城の夜の舞台に入る ---------- */

  /* ---------- 面の舞台に入る ---------- */
  function startWorld(i,lv,set,resume){
    me.inGame=true; V=null; clearOthers(); el('escL').hidden=true; el('escEnd').hidden=true; el('escLog').innerHTML='';
    LVI=lv; LV=LEVELS[lv]; SET=set; W={};
    if(LV.scen){ chooseEra(LV.scen); setPhase(LV.phase); const keep=LV.keepFire?FXS.filter(f=>f.type==='blaze'||f.type==='column'):[]; clearUnits(); for(const f of keep) FXS.push(f); if(LV.burnDur&&typeof PH!=='undefined'&&PH&&PH.burn) PH.burn={t0:3,dur:LV.burnDur}; }
    else chooseEra('toyo');
    tourStop(); powerMode(); auto=false; $('scen').hidden=true; $('ticker').hidden=true; setFov(1); applyTime(LV.time); closeHint();
    $('eyebrow').textContent='大坂城脱出 · '+lvTitle(lv);
    started=true; if(isTouch) document.body.classList.add('touchui'); syncPad();
    clearLv(); LV.build(set);
    if(net.mode==='host'&&G){ G.f=LV.init(); G.pl.forEach((p,k)=>{ const q=nudge(LV.spawn[0]+OFFS[k][0],LV.spawn[1]+OFFS[k][1]); p.x=q[0]; p.z=q[1]; p.y=groundH(q[0],q[1])+1.6; }); }
    const q=nudge(LV.spawn[0]+OFFS[i||0][0],LV.spawn[1]+OFFS[i||0][1]); P.room=null; P.level=-1; P.mode='walk'; P.x=q[0]; P.z=q[1]; P.y=groundH(P.x,P.z)+1.6; P.yaw=LV.spawn[2]; P.pitch=-.05; lastArea='';
    closeLock(); closeNotes(); notesSeen.n=-1;
    for(const id of ['escHud','escArrow','escUse','escCr','escNB','escMenu']) el(id).hidden=false; document.body.classList.add('escPlay'); chatUsed.clear(); me.cr=false; el('escCr').setAttribute('aria-pressed','false');
    lastTm=1e9; el('escMin').hidden=true; preloadRes(lv);
    if(resume){ P.x=resume.x; P.z=resume.z; P.y=groundH(P.x,P.z)+1.6; el('escIntro').hidden=true; onEvent('部屋に戻った！ 続きから'); } else { showIntro(lv); onEvent(lvTitle(lv)+' はじまり'); }
  }
  function closeHint(){ const h=$('hint'); if(h){ h.hidden=true; h.style.opacity='0'; } }

  /* 面の範囲と、門・火などの当たり判定 */
  const _walkable=walkable;
  walkable=function(x,z){ if(me.inGame&&LV){ const f=view(); if(LV.bounds&&!inR(LV.bounds,x,z,0)){ boundsHint(); return false; } if(f&&LV.block&&LV.block(x,z,f)) return false; if(f&&commonBlock(x,z,f)) return false; } return _walkable(x,z); };
  let bhT=0; function boundsHint(){ const t=performance.now(); if(t-bhT>4000){ bhT=t; showHint('この面では、これより先へは行けない'); } }
  function view(){ if(net.mode==='host'&&G) return G.f; if(V) return V.f; return null; }

  /* ---------- 毎フレーム ---------- */
  let logN=0;
  function onEvent(m){ const lg=el('escLog'); if(!lg) return; const d=document.createElement('div'); d.textContent=m; lg.prepend(d); while(lg.children.length>3) lg.lastChild.remove(); const id=++logN; setTimeout(()=>{ d.style.opacity='0'; setTimeout(()=>d.remove(),700); },7000); }
  function update(dt){
    if(!me.inGame) return;
    const sp=Math.hypot(P.x-lastX,P.z-lastZ)/Math.max(dt,1e-3); lastX=P.x; lastZ=P.z; me.run=sp>3.2;
    if(net.mode==='host'&&G&&!G.over){ hostStep(dt); net.sendT+=dt; if(net.sendT>=1/NET_HZ||!V){ net.sendT=0; V=snap(); broadcast(V); } }
    else if(net.mode==='client'){ net.sendT+=dt; if(net.sendT>=1/NET_HZ&&net.host&&net.host.open){ net.sendT=0; net.host.send(myState()); } }
    if(!V||!V.f||V.lv!==LVI) return;
    const mine=V.pl.find(p=>p.id===net.myId);
    ESCF.lock=!el('escIntro').hidden||!!(mine&&mine.cap)||!!(G&&G.over)||!el('escEnd').hidden||!el('escLock').hidden;
    { const hv=!!(mine&&isHeavy(mine.carry)); ESCF.hv=hv; if(hv&&me.cr){ me.cr=false; el('escCr').setAttribute('aria-pressed','false'); } el('escCr').classList.toggle('dis',hv); }
    ESCF.cr=me.cr;
    /* 他の人 */
    const seenIds=new Set();
    for(const p of V.pl){ if(p.id===net.myId) continue; seenIds.add(p.id); const o=otherOf(p);
      const t=o.t||(o.t={x:p.x,y:p.y,z:p.z,yaw:p.yaw}); const k=Math.min(1,dt*10); t.x+=(p.x-t.x)*k; t.y+=(p.y-t.y)*k; t.z+=(p.z-t.z)*k; t.yaw=p.yaw;
      if(Math.hypot(p.x-t.x,p.z-t.z)>8){ t.x=p.x; t.z=p.z; t.y=p.y; }
      const gy=t.y-(p.cr?.95:1.6),low=p.cr||p.cap,hid=p.room&&!(P.room||P.level>=0);
      if(hid){ hideFig(o.F); hideFig(o.C); } else if(low){ hideFig(o.F); placeFig(o.C,t.x,gy,t.z,t.yaw); } else { hideFig(o.C); placeFig(o.F,t.x,gy,t.z,t.yaw); }
      o.tag.position.set(t.x,gy+(low?2.3:3.2),t.z); o.tag.visible=!hid; o.tag.material.opacity=p.cap?.55:1;
      if(o.bk) crowd.move(o.bk,p.carry==='水'&&!hid?t.x:0,p.carry==='水'&&!hid?gy+1.9:-999,t.z);
      { const cs=p.carry&&p.carry!=='水'&&LV.carrySpr&&LV.carrySpr[p.carry]; if(o.cs&&o.csN!==cs){ crowd.move(o.cs,0,-999,0); o.cs=null; } if(cs&&!o.cs){ o.cs=crowd.add(cs,0,-999,0,{s:.8}); o.csN=cs; } if(o.cs) crowd.move(o.cs,hid?0:t.x,hid?-999:gy+(low?.8:1.5),t.z); } }
    for(const [id,o] of others) if(!seenIds.has(id)){ hideFig(o.F); hideFig(o.C); PROP.remove(o.tag); if(o.bk) crowd.move(o.bk,0,-999,0); if(o.cs) crowd.move(o.cs,0,-999,0); others.delete(id); }
    /* 追手 */
    const inside=!!(P.room||P.level>=0);
    for(let i=0;i<MAXE;i++){ const e=V.en[i]; if(!e){ hideEnemy(i); continue; }
      const y=groundH(e[0],e[1]),dd=Math.hypot(e[0]-P.x,e[1]-P.z),nr=dd<70&&!inside; placeFig(enemyFig(i,e[4]||'k_yari'),e[0],y,e[1],e[2]);
      const fn=fans[i]; fn.visible=nr; if(nr){ fn.position.set(e[0],y+.12,e[1]); fn.rotation.y=e[2]; const hot=Math.min(1,e[3]*1.4),c=new THREE.Color(0xffb030).lerp(new THREE.Color(0xff2a10),hot); fn.userData.f.material.color.copy(c); fn.userData.e.material.color.copy(c); fn.userData.f.material.opacity=.24+hot*.24; }
      const lt=lanterns[i]; lt.visible=nr; if(nr) lt.position.set(e[0]-Math.sin(e[2])*.5,y+1.5,e[1]-Math.cos(e[2])*.5);
      const ft=foeTags[i]; ft.visible=nr&&dd<45; if(ft.visible) ft.position.set(e[0],y+3.1,e[1]);
      const a=alertTags[i]; a.visible=e[3]>.08; if(a.visible){ a.material.map=e[3]>.5?TEX_X:TEX_Q; a.position.set(e[0],y+4.1+Math.sin(performance.now()/90)*.06*e[3],e[1]); a.material.opacity=Math.min(1,.4+e[3]); a.scale.setScalar(.9+e[3]*.7); } }
    /* 自分への視線 */
    let danger=0; if(G&&net.mode==='host'){ for(const e of G.en) danger=Math.max(danger,e.al[net.myId]||0); } else { for(const e of V.en){ const dd=Math.hypot(e[0]-P.x,e[1]-P.z); if(dd<20) danger=Math.max(danger,e[3]*(dd<14?1:.4)); } }
    { const w=el('escWarn'); w.hidden=!(danger>.08)||!!(mine&&mine.cap); if(!w.hidden) w.textContent=danger>.5?'見つかる！ 追手の視界（扇形）から出ろ！':'追手に気づかれかけている……しゃがむか、離れろ'; }
    el('escDark').hidden=!(W.lamps&&!inside&&lampDark(V.f,P.x,P.z));
    { const nzOn=!!LV.noise&&!!mine; el('escNz').hidden=!nzOn; if(nzOn){ const v=mine.nz||0; el('escNzB').style.width=Math.round(v*100)+'%'; el('escNzB').style.background=v>.3?'#ff5a3a':'#e8b13a'; } }
    { const st=[]; const el0=V.el||0; const SH=shiftState(el0); if(SH) st.push(SH.on?'見張りの交代中　あと'+Math.ceil(SH.left)+'秒':'見張りの交代まで　'+Math.ceil(SH.left)+'秒');
      if(LV.tgates) for(const g of LV.tgates){ const o=gateOpen(g,el0); st.push(o.open?g.n+'：開いている　あと'+Math.ceil(o.left)+'秒':g.n+'：開くまで　'+Math.ceil(o.left)+'秒'); }
      if(V.f.fires){ const n=V.f.fires.filter(q=>q.r>.6).length; if(n) st.push('火の手 '+n+'か所'+(V.f.fires.some(q=>q.r>.6&&q.r>=q.max-.05)?'（燃え盛っている）':'')); }
      if(LV.status) st.push(...(LV.status(V.f)||[]).filter(Boolean));
      const sh=st.join('　｜　'); if(sh!==statHTML){ statHTML=sh; el('escStat').textContent=sh; el('escStat').hidden=!sh; hudHTML=''; } }
    el('escVig').style.boxShadow=danger>.05?`inset 0 0 ${60+danger*90}px ${10+danger*40}px rgba(255,40,20,${Math.min(.75,danger*.8)})`:'none';
    const cap=el('escCap'); if(mine&&mine.cap){ cap.hidden=false; cap.innerHTML='徳川方の追手に捕まった！<br><span style="font-size:15px">'+(V.pl.length>1?'仲間が来て縄を解くのを待て':'まもなく少し前からやり直し（−45秒）')+'</span><br><span style="font-size:13px;font-weight:400">地面のオレンジの扇形が追手の視界。入らないように</span>'; P.pitch+=(-.5-P.pitch)*Math.min(1,dt*3); } else cap.hidden=true;
    /* 面の小道具 */
    const t=performance.now()/1000;
    const gl=LV.glints(V.f)||[], ph=.75+Math.sin(t*4)*.25; for(let i=0;i<glints.length;i++){ const g=gl[i],sp=glints[i]; sp.visible=!!g; if(g){ sp.position.set(g[0],g[1],g[2]); sp.scale.setScalar(ph); } }
    LV.render(V.f,t,dt);
    hudUpdate(mine);
  }
  let lastTm=1e9,minT=0;
  /* ---------- 任務の一覧（いま進められるものを全部表示）と矢印 ---------- */
  function curTasks(mine){ const all=(LV.tasks(V.f,mine)||[]).map(t=>{ if(t.ph===undefined) t.ph=0; return t; }); return {all,cur:all.filter(t=>t.ph===V.f.o)}; }
  function targetsOf(cur){ const c=[]; for(const t of cur){ if(t.d) continue; if(t.many) c.push(...t.many); else if(t.at) c.push(t.at); } return c.filter(o=>o&&o.x!==undefined); }
  function hudUpdate(mine){
    const {all,cur}=curTasks(mine), req=all.filter(t=>!t.h), dn=req.filter(t=>t.d).length;
    el('escStg').textContent=lvTitle(LVI)+'　任務 '+dn+' / '+req.length;
    const hint=LV.roomHint?LV.roomHint(V.f,mine):'';
    const html=cur.map(t=>`<div class="tk${t.d?' ok':''}${t.h?' h':''}">${t.d?'☑':'☐'} ${esc(t.t)}${t.h?'<small>（手がかり）</small>':''}</div>`).join('')+(hint?`<div class="tk hint">${esc(hint)}</div>`:'');
    if(html!==hudHTML){ hudHTML=html; el('escObj').innerHTML=html; const r=el('escHud').getBoundingClientRect(); el('escLog').style.top=Math.round(r.bottom+6)+'px'; }
    const tm=el('escTm'); tm.textContent=fmt(V.tm); tm.classList.toggle('low',V.tm<60);
    if(V.tm<=60&&lastTm>60){ const m=el('escMin'); m.hidden=true; void m.offsetWidth; m.hidden=false; clearTimeout(minT); minT=setTimeout(()=>{ m.hidden=true; },3500); } lastTm=V.tm;
    /* 矢印：捕まった仲間 → 面ごとの指定 → いちばん近い未完了の目的地 */
    let T=null; const capd=V.pl.find(p=>p.cap&&!p.off&&p.id!==net.myId); if(capd&&mine&&!mine.cap) T={x:capd.x,z:capd.z,n:capd.n+'を助ける'};
    if(!T&&LV.arrowOverride) T=LV.arrowOverride(V.f,mine);
    if(!T){ let b=null,bd=1e9; for(const o of targetsOf(cur)){ const d=Math.hypot(o.x-P.x,o.z-P.z); if(d<bd){ bd=d; b=o; } } T=b||{n:hint||'手分けして探そう'}; }
    const svg=el('escArrow').querySelector('svg');
    if(T.x===undefined){ svg.style.display='none'; el('escDist').textContent=T.n||''; }
    else { const dx=T.x-P.x,dz=T.z-P.z,d=Math.hypot(dx,dz),ang=Math.atan2(-dx,-dz)-P.yaw; svg.style.display=''; svg.style.transform=`rotate(${-ang}rad)`; el('escDist').textContent=(T.n||'')+' '+Math.round(d)+'m'; }
    { const n=(V.notes||[]).length; if(n!==notesSeen.n){ notesSeen.n=n; el('escNB').textContent='手控え '+n; if(!el('escNotes').hidden) renderNotes(); } }
    const me2=mine&&{...mine,x:P.x,z:P.z,y:P.y}; let tg=me2?targetFor({f:V.f,pl:V.pl.map(p=>p.id===net.myId?me2:p)},me2):null;
    if(!tg&&mine&&!mine.cap){ const c=chatTarget(); if(c) tg={k:'chat',l:c.sc?'話しかける':c.who+'に話しかける',d:.1}; }
    tgKey=tg?tg.k:null;
    if(me.latch&&(tgKey!==me.latchKey||Math.hypot(P.x-me.latchX,P.z-me.latchZ)>1.5||(!/^sw/.test(me.latchKey||'')&&performance.now()-me.latchT>4000))) me.latch=false;
    const U=el('escUse'); U.classList.toggle('on',!!tg); U.classList.toggle('hold',!!me.latch); el('escUseL').textContent=tg?tg.l+(tg.hold&&Math.min(tg.hold.need||1,nOnV())>1?'（'+((V.hn||{})[tg.hold.key||tg.k]||0)+' / '+Math.min(tg.hold.need,nOnV())+'人）':''):'調べる';
    el('escPg').style.width=(tg&&tg.hold?((V.hold||{})[tg.hold.key||tg.k]||0)*100:mine&&tg&&mine.hk===tg.k?(tg.sw?(V.gh/1.2*100):mine.hp*100):0)+'%';
    const pl=V.pl.map(p=>`<div${p.off?' class="off"':''}><i style="background:${COLS[p.c%4]}"></i>${esc(p.n)}${p.off?' 通信切れ':p.cap?' 捕縛':''}${p.carry?' '+esc(p.carry):''}</div>`).join(''); if(pl!==plHTML){ plHTML=pl; el('escPl').innerHTML=pl; }
    if(!el('escMap').hidden) drawBigMap();
  }
  let hudHTML='',plHTML='',statHTML=null;

  /* ---------- 全体マップ（ミニマップをタップ） ---------- */
  function openBigMap(){ if(!me.inGame||!LV||!V) return; el('escMap').hidden=false; drawBigMap(); }
  function closeBigMap(){ el('escMap').hidden=true; }
  function drawBigMap(){ if(!V||!LV) return; const cv=el('escMapC'),dpr=Math.min(2,devicePixelRatio||1),W0=innerWidth,H0=innerHeight; if(cv.width!==Math.round(W0*dpr)){ cv.width=Math.round(W0*dpr); cv.height=Math.round(H0*dpr); }
    const g=cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,W0,H0);
    const B=LV.bounds,m=12,bx0=B.x0-m,bx1=B.x1+m,bz0=B.z0-m,bz1=B.z1+m,bw=bx1-bx0,bh=bz1-bz0,pad=44,k=Math.min((W0-pad*2)/bw,(H0-pad*2-20)/bh),ox=(W0-bw*k)/2,oz=(H0-bh*k)/2+10;
    const X=x=>ox+(x-bx0)*k,Z=z=>oz+(z-bz0)*k;
    g.fillStyle='rgba(8,8,10,.6)'; g.fillRect(0,0,W0,H0);
    try{ g.drawImage(mapC,(bx0-DX0)*GS,(bz0-DZ0)*GS,bw*GS,bh*GS,ox,oz,bw*k,bh*k); }catch(e){ g.fillStyle='#2b2a26'; g.fillRect(ox,oz,bw*k,bh*k); }
    g.strokeStyle='rgba(232,177,58,.9)'; g.lineWidth=2; g.strokeRect(X(B.x0),Z(B.z0),(B.x1-B.x0)*k,(B.z1-B.z0)*k);
    g.font='bold 13px sans-serif'; g.textAlign='center'; g.fillStyle='#fff'; g.fillText('北',X((B.x0+B.x1)/2),oz-6);
    /* 目的地 🚩 */
    const {cur}=curTasks(V.pl.find(p=>p.id===net.myId)); g.font='22px sans-serif'; g.textBaseline='bottom';
    for(const o of targetsOf(cur)){ const x=X(o.x),y=Z(o.z); g.fillText('🚩',x+7,y+3); if(o.n){ g.font='bold 11px sans-serif'; g.lineWidth=3; g.strokeStyle='rgba(0,0,0,.8)'; g.strokeText(o.n,x,y-20); g.fillStyle='#ffe9a8'; g.fillText(o.n,x,y-20); g.fillStyle='#fff'; g.font='22px sans-serif'; } }
    g.textBaseline='alphabetic';
    /* 仲間と自分 */
    for(const p of V.pl){ if(p.id===net.myId||p.off) continue; let x=p.x,z=p.z; if(p.room){ const lo=lastOut.get(p.id); if(!lo) continue; x=lo[0]; z=lo[1]; }
      g.fillStyle=COLS[p.c%4]; g.strokeStyle=p.cap?'#ff3b2f':'#fff'; g.lineWidth=2; g.beginPath(); g.arc(X(x),Z(z),6,0,6.283); g.fill(); g.stroke();
      g.font='bold 12px sans-serif'; g.lineWidth=3; g.strokeStyle='rgba(0,0,0,.8)'; g.strokeText(p.n,X(x),Z(z)-10); g.fillStyle='#fff'; g.fillText(p.n,X(x),Z(z)-10); }
    let mx=P.x,mz=P.z; if(P.room&&P.room.door){ mx=P.room.door[0]; mz=P.room.door[1]; }
    g.save(); g.translate(X(mx),Z(mz)); g.rotate(-P.yaw); g.fillStyle='#ff4d3a'; g.strokeStyle='#fff'; g.lineWidth=2; g.beginPath(); g.moveTo(0,-11); g.lineTo(8,8); g.lineTo(0,4); g.lineTo(-8,8); g.closePath(); g.fill(); g.stroke(); g.restore();
    g.font='12px sans-serif'; g.fillStyle='rgba(255,255,255,.85)'; g.fillText('画面をタップすると戻る',W0/2,H0-14); }

  /* ---------- メニュー（タイトルへ戻る） ---------- */
  function alertBox(msg,ok){ const A=el('escAsk'); A.hidden=false; A.innerHTML=`<div class="box"><p>${esc(msg)}</p><button class="b p" id="escAskOk">OK</button></div>`; el('escAskOk').onclick=()=>{ A.hidden=true; if(ok) ok(); }; }
  function openMenu(){ const A=el('escAsk'); A.hidden=false; resetPad(); const host=net.mode==='host'&&!net.solo;
    A.innerHTML=`<div class="box"><h3>メニュー</h3><p>${host?'主がタイトルに戻ると、部屋は閉じて仲間もタイトルに戻ります。':net.mode==='client'?'タイトルに戻ると部屋を抜けます（あとで「前の部屋に戻る」から戻れます）。':'タイトルに戻ると、この面の進み具合は消えます。'}</p>
<button class="b p" id="escAskGo">つづける</button><button class="b" id="escAskT">タイトルへ戻る</button></div>`;
    el('escAskGo').onclick=()=>{ A.hidden=true; }; el('escAskT').onclick=()=>{ leaving=true; if(net.mode==='host'){ broadcast({t:'bye'}); setTimeout(()=>location.reload(),300); } else location.reload(); }; }

  /* ---------- 町の人との会話（すべての人に話しかけられる） ---------- */
  const PERSONA=[[/^(musume_r|q_girl|w_umbrella|miko|w_red|w_bucket|w_tray|lady_walk)$/,'musume'],[/^(q_redw|p_woman|okami_p|lady_tray2?|q_purple|q_green|onna_b?)$/,'onna'],[/^(wara|w_straw)$/,'hyakusho'],[/^jijo$/,'jochu'],[/^(w_oldw|q_oldw)$/,'baba'],[/^(kodomo|q_child|w_boy|nobori_kid|p_flagboy)$/,'ko'],
    [/^(shonin|q_merchant|machishu|w_box)$/,'akindo'],[/^(w_yoke|q_yoke)$/,'uri'],[/^(samurai_[ab]|samurai_p|sam_armor|sam_haori|sam_kami|w_samurai|w_youth|lord_\w+|tsukaiban|mitsunari)$/,'bushi'],[/^q_ronin$/,'ronin'],[/^(p_monk|t_monk|k_monk|tabisou)$/,'sou'],
    [/^(w_traveler|q_traveler)$/,'tabi'],[/^(ninpu|workers|mokko|p_naked|p_porter|ishiku|touryou|log)$/,'ninsoku'],[/^roujin$/,'jii'],[/^(ashigaru|yari_a|t_yari|y_\w+|k_yari)$/,'ashi'],[/^kuge\w*$/,'kuge'],[/^kago$/,'kago'],[/^(nanban|frois)$/,'nanban'],[/^takajo$/,'takajo']];
  const PNAME={musume:'町娘',onna:'町の女',jochu:'侍女',baba:'老婆',ko:'子ども',akindo:'商人',uri:'物売り',bushi:'侍',ronin:'浪人',sou:'僧',tabi:'旅の者',ninsoku:'人足',jii:'老人',wakamono:'若者',hyakusho:'百姓',ashi:'足軽',kuge:'公家',kago:'駕籠かき',nanban:'南蛮の人',takajo:'鷹匠',hito:'町の人'};
  const PNAME3={onna:'女中',musume:'奥女中',akindo:'出入りの商人',ninsoku:'中間',hito:'屋敷の者'};
  const CHAT={
    0:{musume:['お城の普請がまた始まったんですって。戦になるのかしら。','黒い身なりの人を見たら、近づかないほうがいいわ。','朝の市で櫛を買ったの。きれいでしょう？','お侍さまが大勢、町を見回っていらっしゃるわ。','このあたりのお店は、朝が一番にぎやかなのよ。','おっかさんに頼まれて、お豆腐を買いに来たの。','京の反物が入ったって聞いて、見に来たのよ。','近ごろは日が暮れると、怖くて表に出られないわ。','お祭りの頃は、もっと人が多いんですよ。','あの角の茶店のお団子、とってもおいしいの。','お城の天守、朝日を浴びると金色に光るのよ。','お嫁に行くなら、戦のない世がいいわ。'],
      onna:['うちの人は朝から城の普請に出てるよ。','井戸端じゃ、間者が紛れ込んでるって噂でもちきりさ。','米の値がまた上がったよ。困ったもんだねえ。','子どもらには、日が暮れたら外に出るなって言ってあるのさ。','寺町のお坊さまは、字の読めない者にも親切だよ。','洗い物がたまっちまって、朝から大忙しさ。','戦が始まったら、田舎の実家に身を寄せようかねえ。','この先の酒屋は、昼間から男衆が入りびたってるよ。','味噌を切らしちまってね、買いに行くところさ。','浪人衆が増えて、町がなんだか落ち着かないねえ。','見かけない顔だね。どこから来なすった？','うちの坊主ときたら、すぐ遊びに行っちまうんだから。','木戸番さんは、夜になると厳しいからね。','薬種屋さんの薬は、よく効くって評判だよ。'],
      jochu:['お使いの途中でございます。急いでおりますので……','奥方さまのお好きな菓子を求めに参りました。','お城の奥は、外よりずっと静かでございますよ。'],
      baba:['長生きはするもんじゃのう。こんな大きなお城が見られるとは。','戦なんぞ、もうこりごりじゃ……。','若い頃は堺に住んでおってな。あそこも賑やかじゃった。','見回りのお侍の目つきが、このところ険しゅうてのう。','孫の顔を見るのが、何よりの楽しみじゃ。','腰が痛うてかなわん。年は取りたくないもんじゃ。','太閤さまのご葬儀の頃を思い出すのう……。','あんた、ちゃんとご飯は食べとるかえ？','昔はこのあたり、田んぼばかりじゃったんじゃよ。','夜の物音には気をつけなされ。物騒な世の中じゃ。'],
      ko:['ねえねえ、お城のてっぺんって金ぴかなんだよ！','忍者ごっこしてたら、本物みたいな黒い人がいたんだ！','おいら、大きくなったら槍の名人になるんだ。','竹とんぼ、遠くまで飛ぶんだぜ。','かくれんぼしてるの。言わないでね！','おっとうは城の石垣を積んでるんだ。すごいだろ！','あめ玉もらったんだ。一個あげよっか？','あっちの路地は行き止まりだよ。','お侍さんの馬、でっかかったなあ！','寺子屋の先生、怒るとこわいんだよ。'],
      akindo:['戦が近いとなれば、米も刀も値が上がる。商いどきですな。','堺の商人仲間が、徳川さまの陣にも出入りしておるとか。','うちの帳場は、毎朝ここから始まるんで。','怪しい客は、店の奥へは通さぬことにしております。','三の丸の門は、合言葉を知らぬと通してもらえぬそうな。','このところ、鉄砲の玉薬がよう売れましてな。','京から上等の反物が入りました。お一ついかがで？','掛け売りはお断りしております。ご勘弁を。','品物を運ぶ船が、大川に着く頃合いでして。','商家・酒屋・薬種屋……この通りは老舗が多うございます。','お代はきっちり頂戴いたしますよ。','銭の勘定だけは、誰にも負けませぬ。'],
      uri:['えー、しじみー、しじみはいらんかねー。','担いで歩くのも楽じゃないよ。今日は売れ行きがいいがね。','朝のうちに売り切らねえと、商売あがったりさ。','朝採れの青物だよ！ 安くしとくよ！','肩が痛えが、これも暮らしのためさ。','お城のほうへ売りに行くと、お侍がよく買ってくれるんだ。','水売りだよー。冷たい水はいらんかねー。','雨の日は商売にならねえんだよなあ。','この天秤棒、親父の代から使ってるんだ。','木戸が閉まる前に、家へ帰らねえとな。'],
      bushi:['城下に間者が紛れておる。怪しい者を見たら知らせよ。','三の丸の門は合言葉なしには通れぬ。心得ておけ。','このところ浪人衆が城に集まってきておるな。','見回りの交代の刻限じゃ。気を抜くでないぞ。','徳川方との談判は、うまくいっておらぬらしい。','刀の手入れを怠る者に、武士を名乗る資格はない。','殿のご命令で、町の木戸を改めて回っておる。','そなた、どこの者じゃ？ 用がないなら早う帰れ。','秀頼さまのため、この命惜しくはない。','鉄砲組の稽古の音が、朝から響いておるわ。','夜回りの者を増やせとのお達しじゃ。','町人に無礼を働く者は、侍とて許されぬぞ。'],
      ronin:['この城で一旗揚げるために、はるばるやって来た。','腕には覚えがある。仕官の口があればよいのだが。','徳川の世になれば、俺たちのような者に居場所はない。','関ヶ原では、主家が負けてな……それ以来この有様よ。','真田の殿が城に入られたと聞いた。胸が躍るわ。','金はないが、刀だけは手放せぬ。','酒屋のツケがたまっておってな……。','戦が始まれば、俺の槍の出番だ。','この町の飯は安くてうまい。それだけが救いよ。','間者だと？ 俺は違うぞ。疑うなら斬ってみるか。'],
      sou:['南無阿弥陀仏……戦の世が早う終わりますように。','寺には、町の人がよく相談に来られます。','字の読み書きなら、拙僧がお教えしましょう。','托鉢の途中でございます。','仏さまは、どなたのことも見ておられますよ。','寺町の鐘の音は、遠くまで届くのです。'],
      tabi:['京から来たのですが、大坂の賑わいには驚きました。','宿を探しておるのですが、どこも満杯でしてな。','街道でも、戦が近いという噂ばかりですよ。','伊勢参りの帰りに立ち寄ったのです。','この町は道が入り組んでいて、すぐ迷ってしまいます。','堺へ行くには、どちらの道がよいのでしょう。','お城を一目見ようと、遠回りしてきました。','草鞋がすり切れてしまいましてな。どこかで買えませぬか。','明日の朝には発つつもりです。','国の者に、大坂の話を土産にしたいものです。'],
      ninsoku:['えっさ、ほいさ。城の石運びはきついぜ。','普請の飯はうまいが、休む間もねえや。','この荷を三の丸まで運べって言われててな。','材木はまだまだ足りねえらしいぜ。','親方に怒鳴られる前に、運んじまわねえと。','汗だくだぜ。水を一杯もらえねえかな。','この俵、ひとつで米四斗も入ってるんだ。','背中の荷が重くて、腰が抜けそうだ。','普請場じゃ、噂話をしてる暇もねえよ。','日が暮れたら一杯やるのが楽しみでな。','石垣の石は、遠くの島から船で運んでくるんだと。','おっと、ぶつかるぜ。道をあけてくんな。'],
      jii:['わしは若い頃、太閤さまの普請に出ておったんじゃ。','城下も随分と広うなったもんじゃのう。','近ごろ、見慣れぬ顔が増えたわい。'],
      wakamono:['俺も城の兵に加えてもらおうかと思ってるんだ。','夜は木戸が閉まるから、早めに帰らないとな。','あの角の店の団子、うまいんだぜ。','親父の店を継ぐか、侍になるか、迷ってるんだ。','力比べなら、町内で誰にも負けねえ。','近ごろ、夜道で黒い影を見たって奴が多いんだ。','祭りの神輿は、俺たちの組が担ぐんだぜ。','戦になったら、俺は母ちゃんを守らなきゃな。','あっちの酒屋の娘、べっぴんだって評判だぜ。','寺の境内で、相撲を取るのが好きなんだ。'],
      ashi:['門の守りは片時も気を抜けぬ。','怪しい者は、ここで改めることになっておる。','槍の手入れは毎朝欠かさぬ。','夜は門を閉める。用があるなら日のあるうちに参れ。','近ごろ、黒装束の怪しい者が出るそうな。','交代はまだかのう……足が棒のようじゃ。'],
      hyakusho:['村から藁を納めに来たところだ。','今年は米の出来がまずまずでな。','戦になったら、田畑が荒らされねえか心配だ。','城下は人が多くて、目が回りそうだよ。','帰りに塩を買って帰らねえと、かかあに叱られる。'],
      kuge:['京より下ってまいったが、大坂は賑やかでおじゃるな。','和議の使いで参ったのじゃ。うまくまとまればよいが。','この町の者は、声が大きゅうて驚くでおじゃる。'],
      takajo:['この鷹は、まだ若いが筋がよい。','鷹は人の気配に敏い。驚かさぬよう静かにな。','鷹狩りの支度に、朝から大忙しよ。'],
      kago:['へい、駕籠はいかがで？ 三の丸まで一走りですぜ。','相棒と息を合わせねえと、駕籠は担げねえんだ。','重いお客は、酒代をはずんでもらわねえとな。'],
      nanban:['この国の城は、まことに美しい。','わたしは遠い海の向こうから来ました。','大坂の町は、南蛮にも負けぬ賑わいです。'],
      hito:['今日もいいお日和ですねえ。','お城の普請の音が、朝から響いてますよ。','このあたりは道が入り組んでいて迷いやすいんです。','戦が来ないといいんですがねえ。','火の用心をしっかりしないとね。']},
    2:{onna:['こんな夜更けに出歩くなんて、危のうございますよ。','奥方さまは、もうお休みになられました。','先ほど、廊下を黒い影が通ったような……。','行灯の油を足しに参るところでございます。'],
      jochu:['夜分に何のご用でございましょう。','奥のお部屋には、近づかれませぬように。','火の元の見回りをしておりました。'],
      musume:['お屋敷の夜は、静かすぎて怖いくらいです。','見回りのお侍さまの足音が、ずっと聞こえております。','奥座敷の屏風は、鶴の絵が見事なのですよ。'],
      bushi:['夜回りは交代でやっておる。油断するな。','城内に内通者がおるという噂、まことであろうか。','篝火を絶やすでないぞ。','この屋敷の広間には、殿の具足が置いてある。','堀を埋められては、この城も裸同然よ……。','夜明けまでは、気を抜くことは許されぬ。'],
      ashi:['こんな夜に何用じゃ。早う持ち場へ戻れ。','腹が減ったのう……夜食はまだか。','火薬蔵のあたりは、火を近づけるでないぞ。','眠うてかなわん。だが見張りは見張りじゃ。','さっき、向こうで物音がしたような……。','夜は冷えるのう。篝火の側が一番じゃ。'],
      kuge:['京より参ったのじゃが、とんだ騒ぎに巻き込まれたものよ。','夜の城は物騒でおじゃるな。','和議の行方が気がかりでおじゃる。'],
      kago:['お客を待ってるんだが、夜は誰も乗らねえや。','駕籠を担ぐのは、二人の息が合わねえとな。'],
      akindo:['夜分に失礼いたします。ご注文の品をお届けに……。','出入りの者にも、近ごろはきつい改めがありましてな。'],
      ninsoku:['水汲みは夜のうちに済ませておけと言われてな。','井戸は向こうにある。夜は足元に気をつけなよ。','荷車の手入れも、わしら中間の仕事でさ。'],
      sou:['夜の祈りを捧げておりました。','このお屋敷の皆さまのご無事を祈っております。'],
      jii:['年寄りは夜が長うてのう。眠れんのじゃ。','わしが若い頃は、この城も、もっと華やかじゃった。'],
      hito:['夜はひと気がなくて、足音がよく響きますね。','篝火のまわりなら、少しは明るいですよ。','二の丸のお屋敷は、どれも似たような造りで迷います。','月が雲に隠れると、真っ暗になりますな。']},
    4:{musume:['こんな夜更けに……火事が怖くて眠れないの。','おっかさんと、明日には在所へ逃げるつもりよ。','さっき屋根の上を、黒い影が走っていったの。','篝火が消えると、真っ暗で何も見えないわ。','戦が始まったら、この町も焼けてしまうのかしら。','お侍さまが、走るなっておっしゃってたわ。足音でわかるからって。'],
      onna:['荷物はもうまとめてあるよ。いつでも逃げられるようにね。','亭主は城に籠もるって言うし、どうしたもんかねえ。','火の用心だよ。こんな夜に火が出たら、町じゅう丸焼けさ。','見回りの足音が近づいたら、物陰でじっとしてるんだよ。','子どもらは、もう寝かしつけたよ。','井戸の水は、いざという時のために汲んであるのさ。'],
      baba:['この年で、また戦を見ることになるとはのう……。','夜は冷える。早う家に入りなされ。','わしは逃げんよ。この家で死ぬと決めておる。','闇の中を走ると、かえって目立つぞい。'],
      ko:['眠れないんだ。おいらも戦えるのに。','忍者って、本当に足音がしないのかな？','あっちの畑のほう、夜中に灯りが三つ光ってたよ。','おっかあが、夜は外に出ちゃだめだって。'],
      akindo:['店の品は、もう蔵の奥に隠しましたよ。','徳川さまの世になったら、商いはどうなるやら。','この騒ぎで、米も油も値が三倍ですわ。','夜逃げする客ばかりで、掛け取りもできやしません。'],
      uri:['こんな夜でも、腹は減るからな。売れ残りの団子でも食うかい？','明日は商いどころじゃなさそうだ。','天秤棒は、いざとなりゃ武器にもなるさ。'],
      bushi:['城下の夜回りを仰せつかった。怪しい者を見ておらぬか。','忍びが火付けを企んでおるとの知らせがあった。','篝火を絶やすな。闇は忍びの味方じゃ。','明日か明後日には、決戦となろう。'],
      ronin:['いよいよ決戦か。腕が鳴るわ。','死に場所を求めて、この城に来たのだ。','真田の殿の下で戦えるなら、本望よ。'],
      tabi:['大坂を出ようとしたら、どの道も兵だらけでしてな。','宿の主人まで逃げ出してしまいましたよ。'],
      ninsoku:['夜通し堀ばたの土嚢積みだよ。','荷車を引いて、蔵の米を城へ運んでいるところさ。','腹が減っては戦もできねえってな。'],
      sou:['寺には逃げてきた人たちが大勢おられます。','皆の無事を祈っております。'],
      hyakusho:['村が焼かれる前に、城下へ逃げてきたんだ。','田植えの時期だってのに、戦とはなあ。'],
      hito:['今夜は、やけに静かですね……。','火事にだけは気をつけないと。','篝火のまわりは明るいから、怪しい者もすぐわかります。','走る足音がすると、見回りがすぐ駆けつけますよ。']},
    any:{hito:['足元に気をつけて。','このあたりは物騒になってきましたな。','早く平穏な日々が戻るとよいのですが。']}};
  const chatUsed=new Map(), chatLast=[];
  let TALKOF=null;
  function talkOf(it){ if(!TALKOF){ TALKOF=new Map(); if(typeof TALK!=='undefined') for(const t of TALK) if(t.it&&t.say) TALKOF.set(t.it,t); } return TALKOF.get(it); }
  function personaOf(n){ n=String(n||''); for(const [re,k] of PERSONA) if(re.test(n)) return k; return 'hito'; }
  function chatLine(it){ if(it._escSay&&it._escLv===LVI) return it._escSay; const T0=talkOf(it); let line;
    { const per=personaOf(it.name),T=CHAT[LVI]||CHAT.any, pool=T[per]||T.hito||CHAT.any.hito, key=LVI+':'+(T[per]?per:'hito');
      let u=chatUsed.get(key); if(!u){ u=new Set(); chatUsed.set(key,u); } if(u.size>=pool.length) u.clear();
      let un=pool.filter(l=>!u.has(l)&&!chatLast.includes(l)); if(!un.length) un=pool.filter(l=>!u.has(l)); if(!un.length) un=pool;
      line=un[Math.floor(Math.random()*un.length)]; u.add(line); }
    chatLast.push(line); if(chatLast.length>6) chatLast.shift(); it._escSay=line; it._escLv=LVI; return line; }
  function chatName(it){ const T0=talkOf(it); if(T0&&T0.name&&!/三成|乗物|太閤/.test(T0.name)) return LVI===2&&/町|村|百姓|茶屋/.test(T0.name)?(PNAME3[personaOf(it.name)]||'屋敷の者'):T0.name; if(it.name==='kago') return '駕籠かき'; const per=personaOf(it.name); return (LVI===2&&PNAME3[per])||PNAME[per]||'町の人'; }
  const _pv2=new THREE.Vector3();
  function chatTarget(){ if(P.room) return null; let b=null,bd=2.8;
    if(LV&&LV.scen){ if(typeof bCrowd==='undefined'||!bCrowd) return null; for(const it of bCrowd.items){ if(!it||it.hidden||it.off||!it.h||(typeof roleOf==='function'&&!roleOf(it.name))) continue; const d=Math.hypot(it.x-P.x,it.z-P.z); if(d<bd&&Math.abs(it.y-(P.y-1.6))<3){ bd=d; b=it; } } return b?{it:b,who:'話しかける',sc:1}:null; }
    if(typeof NPCS==='undefined') return null;
    for(const n of NPCS){ const it=n.it; if(!it||it.hidden||it.off||it.y<-500) continue; const d=Math.hypot(it.x-P.x,it.z-P.z); if(d<bd&&Math.abs(it.y-(P.y-1.6))<3){ bd=d; b=it; } }
    return b?{it:b,who:chatName(b)}:null; }
  function doChat(it){ if(!it) return; if(LV&&LV.scen){ _pv2.set(it.x,it.y+it.h*.5,it.z).project(camera); const r=_pa0((_pv2.x*.5+.5)*innerWidth,(-_pv2.y*.5+.5)*innerHeight); if(r) showHint(r.name+'「'+r.say+'」'); return; } showHint(chatName(it)+'「'+chatLine(it)+'」'); }
  const _pa0=typeof pickAny==='function'?pickAny:()=>null;
  if(typeof pickAny==='function'){ pickAny=function(sx,sy){ if(!me.inGame||(LV&&LV.scen)) return _pa0(sx,sy); let best=null,bd=1e9; if(typeof NPCS!=='undefined') for(const n of NPCS){ const it=n.it; if(!it||it.hidden||it.off) continue; const d=tapHit(it,sx,sy,40); if(d>=0&&d<bd){ bd=d; best=it; } } return best?{name:chatName(best),say:chatLine(best)}:null; }; }
  const resImg=(win,lv)=>'result/'+(win?(lv<4?'win'+(lv+1):'stage'+(lv+1)):'lose')+'.webp';
  const resImg2=(win,lv)=>'result/'+(win?(LEVELS[lv].img||'win'+(lv+1)):'lose')+'.webp';
  function preloadRes(lv){ for(const w of [true,false]){ const im=new Image(); im.src=resImg(w,lv); if(w&&lv>=4){ const i2=new Image(); i2.src=resImg2(w,lv); } } }
  function onEnd(r){ me.inGame=false; me.use=false; if(r.win) saveClear(r.lv); const E=el('escEnd'); E.style.backgroundImage=r.win&&r.lv>=4?`url(${resImg(r.win,r.lv)}), url(${resImg2(r.win,r.lv)})`:`url(${resImg(r.win,r.lv)})`; E.style.backgroundPosition=(r.win?(['22% 60%','78% 60%','72% 60%','55% 60%','22% 60%','78% 60%','55% 60%','78% 60%','18% 60%','18% 60%'][r.lv]||'50% 60%'):'60% 50%'); E.hidden=false; for(const id of ['escHud','escArrow','escUse','escCr','escCap','escNB','escWarn','escIntro','escMin','escMenu','escMap']) el(id).hidden=true; document.body.classList.remove('escPlay'); closeLock(); closeNotes();
    const last=r.lv>=LEVELS.length-1, host=net.mode==='host';
    E.innerHTML=`<div class="box"><div style="color:#e8b13a;font-size:12px;letter-spacing:.2em">${esc(lvTitle(r.lv))}</div><h2 style="color:${r.win?'#9effa8':'#ff8f7e'}">${r.win?(last?'脱出成功':'面クリア'):'失敗'}</h2><p>${esc(r.msg)}</p>
<dl><dt>かかった時間</dt><dd>${fmt(r.used)}</dd><dt>捕まった回数</dt><dd>${r.cau}回</dd><dt>仲間を助けた</dt><dd>${r.res}回</dd></dl>
${r.win&&last?'<p>十の面をすべて越えた。燃え落ちる大坂城から、最後まで生きのびた――見事な働きであった！</p>':''}
${host?(r.win&&!last?`<button class="p" id="escNext">次の面へ：${esc(lvTitle(r.lv+1))}</button><button id="escAgain">この面をもう一度</button>`:'<button class="p" id="escAgain">もう一度（同じ仲間で）</button>'):'<p>主が次を選ぶのを待っています</p>'}${host&&progress()>0?'<button id="escPick">面をえらぶ</button>':''}<button id="escTitle">タイトルへ</button></div>`;
    const keep=()=>{ lobby=lobby.filter(p=>p.id===0||net.conns.has(p.id)); };
    if(el('escNext')) el('escNext').onclick=()=>{ keep(); hostStart(r.lv+1); };
    if(el('escAgain')) el('escAgain').onclick=()=>{ keep(); hostStart(r.lv); };
    if(el('escPick')) el('escPick').onclick=()=>{ keep(); E.hidden=true; pickLv=r.win?Math.min(r.lv+1,progress()):r.lv; showLobby(); if(!net.solo) broadcast({t:'lobby',l:lobby}); };
    el('escTitle').onclick=()=>{ leaving=true; if(host&&!net.solo) broadcast({t:'bye'}); setTimeout(()=>location.reload(),200); }; }
  const lastOut=new Map();
  function drawMates(){ if(!V) return; const dpr=Math.min(2,devicePixelRatio||1),S=miniC.width,k=S/150;
    const cx0=P.room&&P.room.door?P.room.door[0]:P.x, cz0=P.room&&P.room.door?P.room.door[1]:P.z;
    for(const p of V.pl){ if(p.id===net.myId) continue; let x=p.x,z=p.z;
      if(p.room){ const lo=lastOut.get(p.id); if(!lo) continue; x=lo[0]; z=lo[1]; } else lastOut.set(p.id,[x,z]);
      let mx=S/2+(x-cx0)*k, my=S/2+(z-cz0)*k; const m=7*dpr, out=mx<m||mx>S-m||my<m||my>S-m; mx=Math.max(m,Math.min(S-m,mx)); my=Math.max(m,Math.min(S-m,my));
      mini2.fillStyle=COLS[p.c%4]; mini2.strokeStyle=p.cap?'#ff3b2f':'#fff'; mini2.lineWidth=(p.cap?2.5:1.5)*dpr;
      mini2.beginPath(); mini2.arc(mx,my,(out?3.5:5)*dpr,0,6.283); mini2.fill(); mini2.stroke();
      if(!out){ mini2.font=`bold ${9*dpr}px sans-serif`; mini2.textAlign='center'; mini2.lineWidth=3*dpr; mini2.strokeStyle='rgba(0,0,0,.75)'; const nm=p.n.slice(0,4); mini2.strokeText(nm,mx,my-8*dpr); mini2.fillStyle='#fff'; mini2.fillText(nm,mx,my-8*dpr); } } }
  const _dm=drawMini; drawMini=function(){ if(!me.inGame) return _dm(); $('mini').classList.remove('battle'); _drawMini0(); drawMates(); };

  /* ---------- 部屋の入口〜出口の通り道をあける（家具の当たり判定が入口をふさぐ部屋がある） ---------- */
  for(const R of ROOMS){ if(!R.exitZone||!R.spawn||!R.boxes) continue; const ez=R.exitZone,sx=R.spawn[0],sz=R.spawn[1];
    const cor={x0:Math.min(sx,ez.x0)-.6,x1:Math.max(sx,ez.x1)+.6,z0:Math.min(sz,ez.z0)-1.2,z1:Math.max(sz,ez.z1)+.6};
    R.boxes=R.boxes.filter(b=>!(b.x1+.25>cor.x0&&b.x0-.25<cor.x1&&b.z1+.25>cor.z0&&b.z0-.25<cor.z1)); }

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
  return {get G(){ return G; },get V(){ return V; },get LV(){ return LV; },get W(){ return W; },get SET(){ return SET; },LEVELS,net,me,host,join,hostStart,update,targetFor,onCode,openLock,
    debug:{walk:(x,z)=>walkable(x,z),step:(n,dt)=>{ for(let i=0;i<n;i++) update(dt||.05); },tp:(x,z)=>{ P.room=null; P.level=-1; P.x=x; P.z=z; P.y=groundH(x,z)+1.6; },enter:R=>enterRoom(R),room,unlock:()=>{ try{ localStorage.setItem('escClear','5'); }catch(e){} },chat:()=>{ const c=chatTarget(); return c&&{who:c.who,name:c.it.name,line:chatLine(c.it)}; },npcs:()=>NPCS.filter(n=>n.it&&!n.it.hidden&&!n.it.off).map(n=>[n.it.name,n.it.x,n.it.z,personaOf(n.it.name)]),bigMap:openBigMap,walkGrid:(x0,z0,x1,z1,st)=>{ const o=[]; for(let z=z0;z<=z1;z+=st){ let r=''; for(let x=x0;x<=x1;x+=st) r+=(_walkable(x,z)&&!hitBlock(x,z,.3))?'1':'0'; o.push(r); } return o; },rooms:()=>ROOMS.filter(R=>R.era==='toyo').map(R=>[R.name,R.door.map(Math.round)]),mapURL:()=>mapC.toDataURL('image/png'),area:(x,z)=>areaAt(x,z),spots:()=>SPOTS.map(s=>{ const t=s.toyo||s; return [t.name,(t.at||s.at)]; }),reach:()=>{ const B=LV.bounds,x0=Math.floor(B.x0),z0=Math.floor(B.z0),nx=Math.ceil(B.x1-x0)+1,nz=Math.ceil(B.z1-z0)+1,ok=(x,z)=>inR(B,x,z,0)&&_walkable(x,z)&&!hitBlock(x,z,.3),seen=new Uint8Array(nx*nz),q=[]; const sp=nudge(LV.spawn[0],LV.spawn[1]); const si=Math.round(sp[0])-x0,sj=Math.round(sp[1])-z0; seen[sj*nx+si]=1; q.push(si,sj); let h=0; while(h<q.length){ const i=q[h++],j=q[h++]; for(const [di,dj] of [[1,0],[-1,0],[0,1],[0,-1]]){ const a=i+di,b=j+dj; if(a<0||b<0||a>=nx||b>=nz||seen[b*nx+a]) continue; seen[b*nx+a]=2; if(ok(a+x0,b+z0)){ seen[b*nx+a]=1; q.push(a,b); } } }
      const near=(x,z,r)=>{ for(let dx=-r;dx<=r;dx++) for(let dz=-r;dz<=r;dz++){ const a=Math.round(x)+dx-x0,b=Math.round(z)+dz-z0; if(a>=0&&b>=0&&a<nx&&b<nz&&seen[b*nx+a]===1) return true; } return false; };
      const out=[],chk=(k,o)=>{ if(!o||typeof o!=='object') return; if(Array.isArray(o)){ o.forEach((v,i)=>chk(k+'['+i+']',v)); return; } if(typeof o.x==='number'&&typeof o.z==='number'&&!o.inRoom){ if(!near(o.x,o.z,3)) out.push(k+'@'+Math.round(o.x)+','+Math.round(o.z)); } else if(o.door&&Array.isArray(o.door)){ if(!near(o.door[0],o.door[1],3)) out.push(k+'.door'); } };
      for(const k in W) chk(k,W[k]); return {cells:q.length/2,bad:out}; },seen:(i)=>{ const e=G.en[i],p=G.pl[0]; return {s:seen(e,p),d:dist(e.x,e.z,p.x,p.z),grace:p.grace,room:p.room,cap:p.cap,dy:p.y-1.6-groundH(e.x,e.z),yaw:e.yaw,st:e.st}; },enOk:(x,z)=>[enOk(x,z,LV.bounds),_walkable(x,z),hitBlock(x,z,.6),inR(LV.bounds,x,z,0)]}};
})();
window.__esc=ESC;
