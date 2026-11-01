/* =====================================================================
   大坂城脱出 ― 大坂の陣 五つの夜明け（協力脱出ゲーム層）
   大阪城さんぽの3Dマップの上で動く。最大4人、PeerJS（P2P）で同期。
   ホスト（部屋を作った人）が進行・追手・当たり判定をまとめて計算し、10回/秒で全員に配る。
   面（ステージ）はすべて LEVELS のデータと小さな関数で書く。
   ===================================================================== */
const ESC=(()=>{
  const VER='0.3';
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
  function clearOthers(){ for(const o of others.values()){ hideFig(o.F); hideFig(o.C); PROP.remove(o.tag); if(o.bk) crowd.move(o.bk,0,-999,0); } others.clear(); }

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
  function clearLv(){ for(const it of LIT.items) crowd.hide(it); for(const o of LIT.objs){ if(o.parent) o.parent.remove(o); } LIT.items=[]; LIT.objs=[]; for(const k of [...fxMap.keys()]) fxSet(k,null); fxMap.clear(); }
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
  const KAN=['一','二','三','四','五'];

  /* ---------- ホストが使う道具 ---------- */
  function event(m){ if(net.mode==='host') broadcast({t:'ev',m}); onEvent(m); }
  function note(m){ if(!G.notes.includes(m)){ G.notes.push(m); if(G.notes.length>16) G.notes.shift(); } }
  function penalty(s,m){ G.t-=s; event(m+'（−'+s+'秒）'); }
  const nPl=()=>G.pl.length;
  const allIn=(o,r)=>G.pl.length>0&&G.pl.every(p=>!p.cap&&!p.room&&Math.hypot(p.x-o.x,p.z-o.z)<(r||8));
  const inCount=(o,r)=>G.pl.filter(p=>!p.cap&&!p.room&&Math.hypot(p.x-o.x,p.z-o.z)<(r||8)).length;

  /* =====================================================================
     面（ステージ）
     ===================================================================== */
  let LV=null, LVI=0, SET=null, W={};

  /* ---------- 其の一　城下の密書（朝・上町の城下町） ---------- */
  const SHOPS=[['町家（上町の商家）','商家'],['町家（酒屋）','酒屋'],['町家（薬種屋）','薬種屋']];
  const SHOP_ELIM={商家:'反物や小間物には目もくれなかったよ',酒屋:'酒の匂いなんぞ、しなかったねえ',薬種屋:'薬臭くはなかったぞ'};
  const SHOP_SPOTS=[{n:'帳場の箪笥',spr:'cabinet'},{n:'奥の棚',spr:'shelf'},{n:'土間の甕',spr:'jar'}];
  const SPOT_HINT=['帳場で銭勘定をするふりをしておった','奥の棚に手を伸ばしておった','土間の甕をのぞきこんでおった'];
  const PW=[['山','川'],['月','花'],['松','鶴'],['雪','炭']];
  const RUM_POS=[[-160,710],[-360,630],[-60,590],[140,670],[-160,510],[140,510],[-260,750]];
  const L1={ name:'城下の密書', sub:'慶長十九年 十月 ・ 朝 ・ 上町の城下町', time:0, scen:null, limit:600,
    story:'大坂の陣を前に、徳川の間者が大坂城の絵図を写した「密書」を城下の店に隠した。町の者に聞き込み、密書を取り返して三の丸の門まで届けよ。',
    bounds:{x0:-400,x1:180,z0:428,z1:842}, spawn:[-72,800,-Math.PI/2],
    patrols:[{p:[[-340,590],[120,590]],s:1.7,spr:'k_ninja'},{p:[[120,710],[-340,710]],s:1.6,spr:'k_ninja'},{p:[[-160,480],[-160,800]],s:1.5,spr:'k_ninja'},{p:[[140,800],[140,480]],s:1.5,spr:'k_ninja'},{p:[[-340,510],[0,510]],s:1.6,spr:'k_ninja'},{p:[[-360,780],[-360,480]],s:1.4,spr:'k_ninja'}],
    setup(){ const sh=rint(3),wr=shuffle([0,1,2].filter(i=>i!==sh)); return {shop:sh,wrong:wr,spot:rint(3),rpos:shuffle([...RUM_POS.keys()]).slice(0,3),pw:rint(PW.length)}; },
    build(s){ W.elder=npc('roujin',-50,798,'町年寄'); W.rum=s.rpos.map((ci,j)=>npc(['musume_r','shonin','onna_b'][j],RUM_POS[ci][0],RUM_POS[ci][1],'町の者'));
      W.spots=SHOPS.map(sp=>roomProps(room(sp[0]),SHOP_SPOTS)); W.guard=npc('samurai_a',-50,468,'三の丸の門番'); W.goal=spot(-60,440,{fixed:true}); W.gateBlk={x0:-64.5,x1:-55.5,z0:451,z1:462}; },
    init(){ return {o:0,t0:0,r:[0,0,0],srch:[[0,0,0],[0,0,0],[0,0,0]],mitsu:0,pass:0}; },
    rumor(j){ const s=SET; if(j<2) return ['町娘','商人'][j]+'「黒い身なりの男が店に入るのを見たよ。'+SHOP_ELIM[SHOPS[s.wrong[j]][1]]+'」'; return '女「あの男、店の中で'+SPOT_HINT[s.spot]+'」'; },
    target(f,p){ if(near(p,W.elder)) return {k:'elder',l:'町年寄に話を聞く',d:.15};
      if(f.o>=1&&!f.mitsu){ for(let j=0;j<3;j++) if(near(p,W.rum[j])) return {k:'rum'+j,l:'町の者に話を聞く',d:.15};
        for(let s=0;s<3;s++) for(let i=0;i<3;i++){ const o=W.spots[s][i]; if(o&&!f.srch[s][i]&&near(p,o,2)) return {k:'s'+s+i,l:o.n+'を調べる',d:.7}; } }
      if(near(p,W.guard,3.2)) return f.mitsu&&!f.pass?{k:'lock',l:'門番に合言葉を答える',d:.1}:{k:'guard',l:'門番に話しかける',d:.15};
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='elder'){ const m='町年寄「間者は、商家・酒屋・薬種屋のどれかに密書を隠したらしい。町の者に聞き込んでくれ。店へは町家の入口から入れる」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k.startsWith('rum')){ const j=+k[3],m=L1.rumor(j); f.r[j]=1; note(m); event(m); }
      else if(k[0]==='s'){ const sh=+k[1],i=+k[2]; f.srch[sh][i]=1;
        if(sh===s.shop&&i===s.spot){ f.mitsu=1; f.o=2; const pr=shuffle(PW.map((q,ix)=>ix)).filter(ix=>ix!==s.pw).slice(0,2).concat([s.pw]); const pairs=shuffle(pr).map(ix=>`問い「${PW[ix][0]}」には「${PW[ix][1]}」`).join('、');
          note('密書の端に、合言葉の控え：'+pairs); event(p.n+'が'+SHOPS[sh][1]+'の'+SHOP_SPOTS[i].n+'から密書を見つけた！ 三の丸の門番に合言葉を答えて城へ'); }
        else if(sh!==s.shop) penalty(10,SHOPS[sh][1]+'の'+SHOP_SPOTS[i].n+'には何もない。この店ではなさそうだ'); else penalty(10,SHOP_SPOTS[i].n+'には何もない'); }
      else if(k==='guard') event(f.pass?'門番「よし、通れ」':'門番「密書を持たぬ者は通せぬ。合言葉もな」'); },
    lock(){ const f=V.f,s=SET; const opts=shuffle([...new Set([s.pw,...shuffle([...PW.keys()])])].slice(0,4)).map(i=>PW[i][1]); return {title:'三の丸の門番',sub:`「合言葉は？」――問いは「${PW[s.pw][0]}」`,slots:1,syms:opts,known:'手控えの「密書の控え」を見よう'}; },
    code(v,syms){ const f=G.f; if(syms[v[0]]===PW[SET.pw][1]){ f.pass=1; f.o=3; event('門番「……よし、通れ。密書は城へ届けよ」'); } else penalty(15,'門番「違う！ 怪しい奴め」'); },
    tick(){ const f=G.f; if(f.o===3&&allIn(W.goal,7)) finish(true,'密書は無事に城へ届いた。間者のたくらみは潰えた――'); },
    block(x,z,f){ return !f.pass&&inR(W.gateBlk,x,z,.2); },
    obj(f){ return ['町年寄の話を聞け','町の者に聞き込み、密書を隠した店を突き止めて探せ','密書を三の丸の門へ。門番に合言葉を答えよ','三の丸の門をくぐって城へ入れ'][f.o]+(f.o===1?`（聞き込み ${f.r.filter(Boolean).length} / 3）`:''); },
    arrow(f){ if(f.o===0) return W.elder; if(f.o===1){ const j=f.r.findIndex(x=>!x); if(j>=0) return {x:W.rum[j].x,z:W.rum[j].z,n:'町の者'}; return P.room?{n:'店の中を調べよう'}:{n:'町家の入口から店に入ろう'}; } if(f.o===2) return W.guard; return {x:W.goal.x,z:W.goal.z,n:'三の丸の門'}; },
    glints(f){ const g=[]; if(f.o===1&&!f.mitsu) W.spots.forEach((S,s)=>S.forEach((o,i)=>{ if(o&&!f.srch[s][i]) g.push([o.x,o.y+1.3,o.z]); })); return g; },
    render(f,t){ bob(W.elder.q,f.o===0,t); W.rum.forEach((r,j)=>bob(r.q,f.o>=1&&!f.r[j],t)); bob(W.guard.q,f.o===2,t); },
    check(f){ return f.o>=2?[-60,560]:[-72,800]; } };

  /* ---------- 其の二　真田丸の狼煙（夕・惣構の南） ---------- */
  const SMOKE_C=[['赤','nb_red','夕日が燃え'],['白','nb_white','雪が舞い'],['黒','nb_black','夜が来る']];
  const SITE_POS=[[60,960],[160,1045],[250,905],[440,1035],[110,905],[210,1005],[400,915]];
  const L2={ name:'真田丸の狼煙', sub:'慶長十九年 十二月 ・ 夕 ・ 惣構の南', time:2, scen:'fuyu', phase:2, limit:600,
    story:'徳川の大軍が真田丸に迫っている。三つの狼煙台に、正しい順で火を入れて城へ合図を送れ。そして真田丸へ駆け込め。',
    bounds:{x0:-130,x1:520,z0:880,z1:1092}, spawn:[-60,896,Math.PI],
    patrols:[{p:[[30,1000],[210,1000]],s:1.6},{p:[[120,925],[120,1070]],s:1.5,spr:'k_teppo'},{p:[[300,1070],[480,1070]],s:1.7},{p:[[470,900],[470,1060]],s:1.4,spr:'k_teppo'},{p:[[-100,1060],[20,1060]],s:1.5},{p:[[200,940],[200,1070]],s:1.6}],
    setup(){ return {sites:shuffle([...SITE_POS.keys()]).slice(0,3),col:shuffle([0,1,2]),order:shuffle([0,1,2])}; },
    build(s){ W.scout=npc('r_bushou',-40,904,'真田の物見'); W.fire=spot(-28,900); aSpr('kagaribi',W.fire.x,W.fire.y,W.fire.z,{s:1.2});
      W.sites=s.sites.map((ci,j)=>{ const o=spot(SITE_POS[ci][0],SITE_POS[ci][1]); aSpr('log',o.x+.6,o.y,o.z,{s:1.2}); aSpr(SMOKE_C[s.col[j]][1],o.x-.9,o.y,o.z+.3,{}); return o; });
      W.goal=spot(268,947); },
    init(){ return {o:0,lit:0,on:[0,0,0]}; },
    target(f,p){ if(near(p,W.scout)) return {k:'scout',l:'真田の物見に話を聞く',d:.15};
      if(f.o===1){ if(p.carry!=='火種'&&near(p,W.fire,3)) return {k:'take',l:'篝火から火種をとる',d:.5};
        if(p.carry==='火種') for(let j=0;j<3;j++) if(!f.on[j]&&near(p,W.sites[j],3.2)) return {k:'lite'+j,l:SMOKE_C[SET.col[j]][0]+'い旗の狼煙台に火を入れる',d:.6}; }
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='scout'){ const m='物見「徳川勢が真田丸に迫っておる。狼煙は三つ――'+s.order.map(c=>SMOKE_C[c][2]).join('、')+'――その順に上げよ。順を誤れば、敵に気取られる」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k==='take'){ p.carry='火種'; }
      else if(k.startsWith('lite')){ const j=+k[4]; p.carry=false;
        if(s.col[j]===s.order[f.lit]){ f.on[j]=1; f.lit++; event(p.n+'が'+SMOKE_C[s.col[j]][0]+'い旗の狼煙を上げた（'+f.lit+' / 3）'); if(f.lit>=3){ f.o=2; event('三つの狼煙が上がった！ 真田丸へ駆け込め'); } }
        else { f.on=[0,0,0]; f.lit=0; penalty(15,'順が違う！ 狼煙はかき消され、はじめからやり直しだ'); } } },
    drop(p){ p.carry=false; },
    tick(){ const f=G.f; if(f.o===2&&allIn(W.goal,9)) finish(true,'狼煙は上がり、真田丸から鬨の声が響いた。合図は城へ届いた――'); },
    obj(f){ return ['真田の物見の話を聞け',`篝火の火種で、狼煙台に正しい順で火を入れよ（${f.lit} / 3）`,'真田丸の門まで全員で駆け込め'][f.o]; },
    arrow(f,mine){ if(f.o===0) return W.scout; if(f.o===1){ if(!mine||mine.carry!=='火種') return {x:W.fire.x,z:W.fire.z,n:'篝火'}; return {n:'物見の言葉を思い出し、旗の色で狼煙台を選べ'}; } return {x:W.goal.x,z:W.goal.z,n:'真田丸'}; },
    glints(f){ const g=[]; if(f.o===1){ g.push([W.fire.x,W.fire.y+2.4,W.fire.z]); W.sites.forEach((o,j)=>{ if(!f.on[j]) g.push([o.x,o.y+2.2,o.z]); }); } return g; },
    render(f,t){ bob(W.scout.q,f.o===0,t); fxSet('kg',{type:'blaze',x:W.fire.x,y:W.fire.y+.8,z:W.fire.z,r:.5,h:1.2,rate:12,ring:false});
      W.sites.forEach((o,j)=>{ const want=!!f.on[j],has=fxMap.has('sm'+j); if(want&&!has){ fxSet('sm'+j,{type:'column',x:o.x,y:o.y+1,z:o.z,r:1.4,rate:6}); fxSet('sf'+j,{type:'blaze',x:o.x,y:o.y+.5,z:o.z,r:.7,h:1.4,rate:16,ring:false}); } if(!want&&has){ fxSet('sm'+j,null); fxSet('sf'+j,null); } }); },
    check(f){ return [-60,896]; } };

  /* ---------- 其の三　二の丸の導火線（夜・二の丸の大名屋敷） ---------- */
  const DROOMS=[['大名屋敷の広間（武具の間）','広間',[{n:'鎧櫃',spr:'armor'},{n:'槍掛け',spr:'spears'},{n:'陣太鼓',spr:'drumbox'}],['武者の抜け殻の中','長き得物の掛かる所','戦を告げる音の内']],
    ['大名屋敷の書院','書院',[{n:'文机',spr:'lowtable'},{n:'掛け軸',spr:'kakejiku'},{n:'違い棚',spr:'shelf'}],['筆と硯の眠る台','絵の垂れ下がる裏','段違いの棚の上']],
    ['大名屋敷の奥座敷','奥座敷',[{n:'屏風',spr:'by_crane'},{n:'行灯',spr:'andon'},{n:'長持',spr:'chest_k'}],['鶴の舞う衝立の陰','夜を照らす灯の傍ら','衣を納める箱の底']]];
  const KG_POS=[[-120,165],[40,120],[150,40],[-100,-100],[-190,-40]];
  const L3={ name:'二の丸の導火線', sub:'慶長二十年 四月 ・ 夜 ・ 二の丸', time:3, scen:null, limit:600,
    story:'夏の陣を前に、城内の内通者が二の丸の大名屋敷に火薬の導火線を仕掛けた。三つの屋敷すべてで導火線を見つけて切り、逃げる内通者を追え。',
    bounds:{x0:-238,x1:208,z0:-232,z1:212}, spawn:[-195,190,0],
    patrols:[{p:[[-120,-150],[40,-150]],s:1.8},{p:[[-80,-205],[-80,-158],[-30,-158],[-30,-205]],s:1.6,spr:'k_teppo'},{p:[[60,-210],[60,-160]],s:1.5},{p:[[-205,60],[-205,-120]],s:1.6},{p:[[0,150],[150,150]],s:1.7,spr:'k_teppo'},{p:[[100,40],[100,-100]],s:1.5},{p:[[-150,120],[-40,120]],s:1.6},{p:[[180,-120],[180,100]],s:1.5}],
    setup(){ return {kg:rint(KG_POS.length),corr:[rint(3),rint(3),rint(3)]}; },
    build(s){ W.boss=npc('samurai_a',-200,182,'番頭'); W.kg=KG_POS.map(c=>{ const o=spot(c[0],c[1]); aSpr('kagaribi',o.x,o.y,o.z,{s:1.2}); return o; });
      W.rooms=DROOMS.map(d=>({R:room(d[0]),spots:roomProps(room(d[0]),d[2])})); W.goal=spot(-201,-214); aSpr('k_ninja',W.goal.x+2,W.goal.y,W.goal.z-4,{}); },
    init(){ return {o:0,kg:KG_POS.map(()=>0),note:0,cut:[0,0,0],srch:[[0,0,0],[0,0,0],[0,0,0]]}; },
    target(f,p){ if(near(p,W.boss)) return {k:'boss',l:'番頭に話を聞く',d:.15};
      if(f.o>=1&&!f.note) for(let j=0;j<W.kg.length;j++) if(!f.kg[j]&&near(p,W.kg[j],3)) return {k:'kg'+j,l:'篝火のまわりを調べる',d:.5};
      if(f.o>=1) for(let r=0;r<3;r++){ if(f.cut[r]) continue; for(let i=0;i<3;i++){ const o=W.rooms[r].spots[i]; if(o&&!f.srch[r][i]&&near(p,o,2)) return {k:'s'+r+i,l:o.n+'を調べる',d:.7}; } }
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='boss'){ const m='番頭「内通者が二の丸の大名屋敷――広間・書院・奥座敷に導火線を仕掛けた。あやつは見回りの篝火のそばで、書付を落としていったらしい」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k.startsWith('kg')){ const j=+k.slice(2); f.kg[j]=1; if(j===s.kg){ f.note=1; if(f.o<2) f.o=2; const m='内通者の書付「広間は'+DROOMS[0][3][s.corr[0]]+'、書院は'+DROOMS[1][3][s.corr[1]]+'、奥座敷は'+DROOMS[2][3][s.corr[2]]+'に仕掛けよ」'; note(m); event(p.n+'が篝火のそばで内通者の書付を拾った！'); } else event('篝火のまわりには何もない'); }
      else if(k[0]==='s'){ const r=+k[1],i=+k[2]; f.srch[r][i]=1; if(i===s.corr[r]){ f.cut[r]=1; const n=f.cut.filter(Boolean).length; event(p.n+'が'+DROOMS[r][1]+'の'+DROOMS[r][2][i].n+'で導火線を切った！（'+n+' / 3）'); if(n>=3){ f.o=3; event('すべての導火線を切った！ 内通者が京橋口へ逃げていく――追え！'); } } else penalty(10,DROOMS[r][2][i].n+'には何もない'); } },
    tick(){ const f=G.f; if(f.o===3&&allIn(W.goal,9)) finish(true,'京橋口で内通者を取り押さえた。二の丸は火の海にならずにすんだ――'); },
    obj(f){ return ['番頭の話を聞け','見回りの篝火のまわりで、内通者の書付を探せ',`書付を手がかりに、大名屋敷の広間・書院・奥座敷で導火線を切れ（${f.cut.filter(Boolean).length} / 3）`,'京橋口へ逃げた内通者を全員で追え'][f.o]; },
    arrow(f){ if(f.o===0) return W.boss; if(f.o===1){ let b=null,bd=1e9; W.kg.forEach((o,j)=>{ if(f.kg[j]) return; const d=Math.hypot(o.x-P.x,o.z-P.z); if(d<bd){ bd=d; b=o; } }); return b?{x:b.x,z:b.z,n:'篝火'}:{n:'篝火を調べよう'}; }
      if(f.o===2){ if(P.room) return {n:P.room.name.replace('大名屋敷の','')+'の中を調べよう'}; let b=null,bd=1e9,bn=''; W.rooms.forEach((q,r)=>{ if(f.cut[r]||!q.R) return; const d=nearestDoor(q.R); if(!d) return; const dd=Math.hypot(d[0]-P.x,d[1]-P.z); if(dd<bd){ bd=dd; b=d; bn=DROOMS[r][1]; } }); return b?{x:b[0],z:b[1],n:'大名屋敷（'+bn+'）の入口'}:{n:'大名屋敷を探そう'}; }
      return {x:W.goal.x,z:W.goal.z,n:'京橋口'}; },
    glints(f){ const g=[]; if(f.o===1) W.kg.forEach((o,j)=>{ if(!f.kg[j]) g.push([o.x,o.y+2.6,o.z]); }); if(f.o>=1&&f.o<3) W.rooms.forEach((q,r)=>{ if(!f.cut[r]) q.spots.forEach((o,i)=>{ if(o&&!f.srch[r][i]) g.push([o.x,o.y+1.3,o.z]); }); }); return g; },
    render(f,t){ bob(W.boss.q,f.o===0,t); },
    check(f){ return f.o>=3?[-60,-150]:[-195,190]; } };

  /* ---------- 其の四　裸城の宝（昼・本丸と二の丸） ---------- */
  const TREAS=[{n:'黄金の茶碗',spr:'ex_chawan_gold',d:'日の光を宿す器'},{n:'瓢箪',spr:'ex_hyotan',d:'太閤殿下の馬印と同じかたち'},{n:'松の茶壺',spr:'ex_tsubo_matsu',d:'常盤の木が描かれた壺'},{n:'伊万里の花瓶',spr:'ex_vase_imari',d:'海を渡ってきた染付'},{n:'太刀',spr:'ex_katana1',d:'鞘に眠る刃'},{n:'兜',spr:'ex_kabuto1',d:'戦場で頭を守るもの'}];
  const L4={ name:'裸城の宝', sub:'慶長二十年 五月 ・ 昼 ・ 堀を埋められた本丸', time:1, scen:'natsu', phase:0, limit:600,
    story:'堀を埋められた大坂城は、もはや裸城。徳川の手に渡る前に、本丸の御殿から本物の名物を選び出し、二の丸の長持に納めて城を出よ。',
    bounds:{x0:-278,x1:208,z0:-100,z1:212}, spawn:[0,126,0],
    patrols:[{p:[[-200,150],[100,150]],s:1.8},{p:[[-44,14],[54,14]],s:1.5,spr:'k_ninja'},{p:[[-66,-6],[-66,66]],s:1.5,spr:'k_ninja'},{p:[[70,-40],[70,70]],s:1.4,spr:'k_ninja'},{p:[[-200,190],[-200,40]],s:1.6},{p:[[120,190],[120,40]],s:1.6,spr:'k_teppo'}],
    setup(){ return {order:shuffle([0,1,2,3,4,5]),real:shuffle([0,1,2,3,4,5]).slice(0,3)}; },
    build(s){ W.mekiki=npc('shonin',14,124,'目利き'); W.box=spot(-8,128); aSpr('chest_k',W.box.x,W.box.y,W.box.z,{s:1.2});
      const a=roomProps(room('千畳敷（表御殿の大広間）'),s.order.slice(0,3).map(i=>({n:TREAS[i].n,spr:TREAS[i].spr,s:1.3}))),b=roomProps(room('対面所（表御殿）'),s.order.slice(3).map(i=>({n:TREAS[i].n,spr:TREAS[i].spr,s:1.3})));
      W.items=[]; s.order.forEach((ti,k)=>{ W.items[ti]=(k<3?a[k]:b[k-3]); }); W.goal=spot(-248,107); W.R1=room('千畳敷（表御殿の大広間）'); W.R2=room('対面所（表御殿）'); },
    init(){ return {o:0,taken:[0,0,0,0,0,0],fake:[0,0,0,0,0,0],dl:0}; },
    target(f,p){ if(near(p,W.mekiki)) return {k:'mekiki',l:'目利きに話を聞く',d:.15};
      if(f.o===1){ if(!p.carry) for(let i=0;i<6;i++){ const o=W.items[i]; if(o&&!f.taken[i]&&!f.fake[i]&&near(p,o,2)) return {k:'it'+i,l:TREAS[i].n+'を手に取る',d:.5}; }
        if(p.carry==='宝物'&&near(p,W.box,3)) return {k:'put',l:'長持に納める',d:.5}; }
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='mekiki'){ const m='目利き「本物の名物は三つ――'+s.real.map(i=>TREAS[i].d).join('、')+'。それ以外は贋物じゃ。御殿の千畳敷と対面所にある」'; note(m); event(m); if(f.o<1) f.o=1; }
      else if(k.startsWith('it')){ const i=+k.slice(2); if(s.real.includes(i)){ f.taken[i]=1; p.carry='宝物'; p.ci=i; event(p.n+'が'+TREAS[i].n+'を手に取った。二の丸の長持へ運べ'); } else { f.fake[i]=1; penalty(10,TREAS[i].n+'は贋物だった'); } }
      else if(k==='put'){ p.carry=false; f.dl++; event('長持に名物を納めた（'+f.dl+' / 3）'); if(f.dl>=3){ f.o=2; event('名物はすべて納めた！ 大手門から城を出よ'); } } },
    drop(p){ if(p.carry==='宝物'&&p.ci!==undefined){ G.f.taken[p.ci]=0; event('運んでいた名物は取り上げられ、御殿に戻された……'); } p.carry=false; },
    tick(){ const f=G.f; if(f.o===2&&allIn(W.goal,9)) finish(true,'名物を積んだ長持は、大手門から無事に運び出された――'); },
    obj(f){ return ['目利きの話を聞け',`本丸の御殿から本物の名物を選び、二の丸の長持へ運べ（${f.dl} / 3）`,'大手門から全員で城を出よ'][f.o]; },
    arrow(f,mine){ if(f.o===0) return W.mekiki; if(f.o===1){ if(mine&&mine.carry==='宝物') return {x:W.box.x,z:W.box.z,n:'長持'}; if(P.room) return {n:'目利きの言葉で本物を見分けよう'};
        const d1=W.R1&&nearestDoor(W.R1),d2=W.R2&&nearestDoor(W.R2),c=[d1,d2].filter(Boolean).sort((a,b)=>Math.hypot(a[0]-P.x,a[1]-P.z)-Math.hypot(b[0]-P.x,b[1]-P.z))[0]; return c?{x:c[0],z:c[1],n:'御殿の入口'}:{n:'本丸の御殿へ'}; }
      return {x:W.goal.x,z:W.goal.z,n:'大手門'}; },
    glints(f){ const g=[]; if(f.o===1){ W.items.forEach((o,i)=>{ if(o&&!f.taken[i]&&!f.fake[i]) g.push([o.x,o.y+1.4,o.z]); }); g.push([W.box.x,W.box.y+1.6,W.box.z]); } return g; },
    render(f,t){ bob(W.mekiki.q,f.o===0,t); },
    check(f){ return f.o>=2?[-150,110]:[0,126]; } };

  /* ---------- 其の五　落城の夜（夜・本丸から大川へ） ---------- */
  const MON=[['桐','ki_kiri'],['菊','mon_kiku'],['瓢箪','ki_hyotan'],['巴','mon_tomoe'],['梅鉢','ki_umebachi'],['桜','mon_sakura']];
  const ORD=['壱','弐','参'];
  const CLUE_CAND=[[-66,32],[-34,76],[44,76],[68,26],[70,-52],[-66,-62],[-40,44]];
  const HIDES=[{n:'虎の屏風',spr:'by_tiger',r:'寅が見張っておる、その背の陰に'},{n:'掛け軸',spr:'kakejiku',r:'山と水が垂れ下がる、その裏に'},{n:'長持',spr:'chest_m',r:'衣が眠る箱の、そのまた底に'},{n:'違い棚',spr:'shelf',r:'高さの違う段の、いちばん上に'}];
  const GATES5={W:{x0:-76.5,x1:-53.5,z0:-80.2,z1:-78.8},E:{x0:69.5,x1:76.5,z0:-80.2,z1:-78.8}};
  const FIREBOX={x0:-30,x1:-18,z0:-108,z1:-100};
  const S5={swW:{x:-64,z:-76.5},swE:{x:72.5,z:-76.5},well:{x:2,z:-91},fire:{x:-24,z:-103.5},boat:{x:-54,z:-304},lock:{x:-58,z:-78.3}};
  const L5={ name:'落城の夜', sub:'慶長二十年 五月七日 ・ 夜 ・ 本丸から大川へ', time:3, scen:'natsu', phase:3, keepFire:true, limit:900,
    story:'徳川方が城内になだれ込み、天守は炎に包まれた。抜け道の絵図を手に、山里丸から極楽橋を渡り、大川の小舟まで落ちのびよ。',
    bounds:{x0:-160,x1:120,z0:-312,z1:100}, spawn:[0,-24,Math.PI*.98],
    patrols:[{p:[[-66,-6],[-66,-66]],s:1.5},{p:[[-44,14],[54,14]],s:1.6},{p:[[72,-6],[72,-66]],s:1.4,spr:'k_teppo'},{p:[[-44,-86],[46,-86]],s:1.15},{p:[[-120,-150],[40,-150]],s:1.9},{p:[[-80,-205],[-80,-158],[-30,-158],[-30,-205]],s:1.6,spr:'k_teppo'},{p:[[60,-210],[60,-160]],s:1.5},{p:[[-110,-268],[10,-268]],s:1.8},{p:[[-140,-235],[-140,-290]],s:1.4,spr:'k_teppo'}],
    setup(){ return {code:[rint(6),rint(6),rint(6)],clue:shuffle([...CLUE_CAND.keys()]).slice(0,3),hide:rint(4)}; },
    build(s){ const OKU=room('奥御殿'),CHA=room('山里丸の茶室');
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
    target(f,p){ const s=SET;
      if(f.o===0){ if(near(p,W.npc0,3)) return {k:'talk0',l:'侍女に話を聞く',d:.15}; for(let i=0;i<4;i++){ const h=W.hide[i]; if(h&&!f.srch[i]&&near(p,h,2)) return {k:'srch'+i,l:HIDES[i].n+'を調べる',d:.7}; } }
      if(f.o===1){ if(near(p,W.npc1,3)) return {k:'talk1',l:'傷ついた兵に話を聞く',d:.15}; for(let j=0;j<3;j++) if(!f.clu[j]&&near(p,W.clue[j],3.2)) return {k:'clue'+j,l:ORD[j]+'の幟を調べる',d:.3};
        if(!f.lock&&near(p,S5.lock,3)) return {k:'lock',l:'錠前を開ける',d:.05};
        if(f.lock){ if(near(p,S5.swW,2.6)) return {k:'swW',l:'西の閂を押さえる',sw:1}; if(near(p,S5.swE,2.6)) return {k:'swE',l:'東の閂を押さえる',sw:1}; } }
      if(f.o===2){ if(W.rope&&f.rope<2&&near(p,W.rope,1.9)) return {k:'rope',l:'茶道具の棚を調べる',d:.6};
        if(!p.carry&&near(p,S5.well,3)) return f.rope<2?{k:'well',l:'井戸を調べる',d:.2}:{k:'fill',l:'水をくむ',d:.9};
        if(p.carry==='水'&&near(p,S5.fire,6.5)) return {k:'pour',l:'火に水をかける',d:.6}; }
      return null; },
    complete(p,k){ const f=G.f,s=SET;
      if(k==='talk0'){ const r=HIDES[s.hide].r; note('侍女「絵図は奥御殿に。'+r+'」'); f.talk0=1; event('侍女「抜け道の絵図は、奥御殿に隠してございます。'+r+'……」'); }
      else if(k.startsWith('srch')){ const i=+k.slice(4); f.srch[i]=1; if(i===s.hide){ f.o=1; note('絵図：山里丸から極楽橋を渡り、二の丸を抜けて大川へ'); event(p.n+'が'+HIDES[i].n+'から抜け道の絵図を見つけた！ だが山里丸への門には錠前が……'); } else penalty(10,HIDES[i].n+'を調べたが、何もなかった……'); }
      else if(k==='talk1'){ const m='兵「山里丸の門の錠前は、家紋を三つ合わせねば開かぬ。本丸のどこかに壱・弐・参と記した幟が立っておる……その順に合わせよ」'+(nPl()>=2?'「錠が外れても、閂は西と東に二つ。同時に押さえねば動かぬ」':''); note(m); f.talk1=1; event(m); }
      else if(k.startsWith('clue')){ const j=+k.slice(4); if(!f.clu[j]){ f.clu[j]=1; const mn=MON[s.code[j]][0]; note(ORD[j]+'の幟の家紋は「'+mn+'」'); event(p.n+'が'+ORD[j]+'の幟を見つけた。家紋は「'+mn+'」'); } }
      else if(k==='well'){ if(f.rope<1){ f.rope=1; note('井戸の釣瓶の縄が切れている。山里丸の茶室に替えがあるかもしれない'); } event('釣瓶の縄が切れている……。山里丸の茶室に替えの縄はないか？'); }
      else if(k==='rope'){ f.rope=2; note('茶室で替えの縄を見つけ、井戸に付けた'); event(p.n+'が茶室で替えの縄を見つけた！ これで井戸の水がくめる'); }
      else if(k==='fill'){ p.carry='水'; }
      else if(k==='pour'){ p.carry=false; f.water++; if(f.water>=f.need){ f.fire=0; f.o=3; event('極楽橋の火が消えた！ 二の丸を抜けて大川の舟をめざせ'); } else event('火が弱まった（あと'+(f.need-f.water)+'杯）'); } },
    lock(){ const f=V.f; return {title:'山里丸の門の錠前',sub:'家紋の輪を回して、三つ合わせよ。',slots:3,syms:MON.map(m=>m[0]),known:'わかっている家紋：'+ORD.map((o,j)=>o+'＝'+(f.clu[j]?MON[SET.code[j]][0]:'？')).join('　')}; },
    code(v){ const f=G.f; if(f.lock) return; if(v.every((x,i)=>x===SET.code[i])){ f.lock=1; event('カチリ――錠前が外れた！ '+(nPl()>=2?'西と東の閂を同時に押さえろ':'閂を押さえて門を開けろ')); } else penalty(15,'錠前はびくともしない……家紋の組み合わせが違うようだ'); },
    drop(p){ p.carry=false; },
    tick(dt){ const f=G.f;
      if(f.o===1&&f.lock){ const need=Math.min(2,nPl()),held=(G.sw.swW?1:0)+(G.sw.swE?1:0); if(held>=need){ G.gh+=dt; if(G.gh>=1.2){ f.gate=1; f.o=2; G.gh=0; event('閂が外れた！ 山里丸へ。極楽橋が燃えている――井戸の水で消せ'); } } else G.gh=Math.max(0,G.gh-dt*2); }
      if(f.o===3){ const all=G.pl.every(p=>!p.cap&&Math.hypot(p.x-S5.boat.x,p.z-S5.boat.z)<7); if(all){ G.winT=(G.winT||0)+dt; if(G.winT>2) finish(true,'全員が小舟に乗り込み、燃える大坂城をあとにした――'); } else G.winT=0; } },
    block(x,z,f){ if(!f.gate&&(inR(GATES5.W,x,z,.3)||inR(GATES5.E,x,z,.3))) return true; if(f.fire&&inR(FIREBOX,x,z,.2)) return true; return false; },
    obj(f){ if(f.o===0) return '侍女の言葉を手がかりに、奥御殿で「抜け道の絵図」を探せ'; if(f.o===1) return f.lock?(V.pl.length<2?'閂を押さえて、山里丸への門を開けろ':'西と東の閂を同時に押さえて、門を開けろ'):'本丸に立つ三本の幟の家紋を集め、山里丸への門の錠前を開けろ';
      if(f.o===2) return `井戸で水をくみ、極楽橋の火を消せ（${f.water} / ${f.need}杯）`; const n=V.pl.filter(p=>!p.cap&&Math.hypot(p.x-S5.boat.x,p.z-S5.boat.z)<7).length; return '二の丸の追手をかわし、大川の小舟へ全員で乗り込め'+(n?`（舟に ${n} / ${V.pl.length}人）`:''); },
    arrow(f,mine){ const OKU=room('奥御殿'),CHA=room('山里丸の茶室');
      if(f.o===0){ if(!f.talk0) return W.npc0; if(OKU&&P.room!==OKU){ const ex=OKU.exitPos; return {x:ex[0],z:ex[1]-1.5,n:'奥御殿'}; } return {n:'侍女の言葉をたよりに、部屋を調べよう'}; }
      if(f.o===1){ if(!f.lock){ if(!f.talk1) return W.npc1; const n=f.clu.filter(Boolean).length; if(n<3) return {n:`本丸のどこかに立つ幟を探せ（${n} / 3）`}; return {x:S5.lock.x,z:S5.lock.z,n:'山里丸の門の錠前'}; }
        const dw=Math.hypot(P.x-S5.swW.x,P.z-S5.swW.z),de=Math.hypot(P.x-S5.swE.x,P.z-S5.swE.z),ot=V.pl.filter(p=>p.id!==net.myId&&!p.cap); let w=dw<=de; if(ot.length){ const o=ot[0]; w=Math.hypot(o.x-S5.swW.x,o.z-S5.swW.z)>Math.hypot(o.x-S5.swE.x,o.z-S5.swE.z); } return w?{x:S5.swW.x,z:S5.swW.z,n:'西の閂'}:{x:S5.swE.x,z:S5.swE.z,n:'東の閂'}; }
      if(f.o===2){ if(mine&&mine.carry==='水') return {x:S5.fire.x,z:S5.fire.z,n:'極楽橋の火'}; if(f.rope===1&&CHA){ if(P.room!==CHA){ const ex=CHA.exitPos; return {x:ex[0],z:ex[1]-1.2,n:'山里丸の茶室'}; } return {n:'茶室の中を調べよう'}; } return {x:S5.well.x,z:S5.well.z,n:'井戸'}; }
      return {x:S5.boat.x,z:S5.boat.z,n:'大川の小舟'}; },
    glints(f){ const g=[]; if(f.o===0) W.hide.forEach((h,i)=>{ if(h&&!f.srch[i]) g.push([h.x,h.y+1.3,h.z]); });
      if(f.o===1){ if(!f.lock) g.push([S5.lock.x,S5.lock.y+1.9,S5.lock.z+1]); W.clue.forEach((c,j)=>{ if(!f.clu[j]) g.push([c.x,c.y+3.4,c.z]); }); }
      if(f.o===2&&W.rope&&f.rope===1) g.push([W.rope.x,W.rope.y+1.1,W.rope.z]); return g; },
    render(f,t,dt){ bob(W.npc0.q,f.o===0&&!f.talk0,t); bob(W.npc1.q,f.o===1&&!f.talk1,t); W.clue.forEach((c,j)=>{ c.tag.material.opacity=f.clu[j]?.45:1; });
      const show=(m,on,o,y)=>{ m.visible=!!on; if(on) m.position.set(o.x,y!==undefined?y:o.y,o.z); };
      const sw=f.o===1&&!!f.lock; show(W.bW,sw,S5.swW); show(W.bE,sw,S5.swE); show(W.rW,sw,S5.swW,S5.swW.y+.05); show(W.rE,sw,S5.swE,S5.swE.y+.05);
      W.rW.material.color.set(V.sw&&V.sw.swW?0x9effa8:0xffd36a); W.rE.material.color.set(V.sw&&V.sw.swE?0x9effa8:0xffd36a);
      show(W.bWell,f.o===2,S5.well); show(W.bFire,f.o===2&&f.fire,S5.fire); show(W.bBoat,f.o===3,S5.boat); show(W.rBoat,f.o===3,S5.boat,S5.boat.y+.05);
      for(const k in W.gates){ const g=W.gates[k]; if(f.gate&&g.visible){ g.position.y-=dt*1.4; if(g.position.y<g.userData.by-3.6) g.visible=false; } }
      const lvl=f.fire?Math.max(.25,1-f.water/f.need):0; if(lvl!==W.fireLvl){ W.fireLvl=lvl; if(lvl>0){ fxSet('bf',{type:'blaze',x:S5.fire.x,y:.4,z:S5.fire.z,r:1.5+1.7*lvl,h:3.5,rate:34*lvl,ring:false}); fxSet('bs',{type:'column',x:S5.fire.x,y:3,z:S5.fire.z,r:4,rate:3}); } else { fxSet('bf',null); fxSet('bs',null); } }
      if(W.boat) W.boat.position.y=WATER_Y+.3+Math.sin(t*1.3)*.08; },
    check(f){ return [[0,-24],[-64,-30],[-62,-90],[-24,-136]][f.o]; } };

  const LEVELS=[L1,L2,L3,L4,L5];
  const lvTitle=i=>'其の'+KAN[i]+'　'+LEVELS[i].name;

  /* =====================================================================
     進行（ホストだけが計算）
     ===================================================================== */
  function newGame(players,lv,set){
    G={lv,set,t:LEVELS[lv].limit,over:null,winT:0,allCapT:0,rescues:0,caught:0,sw:{},gh:0,notes:[],f:null,
      pl:players.map((p,i)=>({id:p.id,n:p.n,c:i,x:0,y:1.6,z:0,yaw:0,cr:false,run:false,use:false,room:false,cap:false,grace:3,carry:false,hk:null,hp:0,rel:false})),
      en:LEVELS[lv].patrols.slice(0,MAXE).map(P0=>({p:P0.p.map(c=>nudge(c[0],c[1])),s:P0.s,spr:P0.spr||'k_yari',i:1,x:0,z:0,yaw:0,pause:0,al:{},look:0}))};
    for(const e of G.en){ e.x=e.p[0][0]; e.z=e.p[0][1]; }
  }
  function targetFor(st,p){
    if(p.cap||!LV) return null;
    for(const q of st.pl) if(q!==p&&q.cap&&dist(p.x,p.z,q.x,q.z)<2.6) return {k:'res:'+q.id,l:q.n+'の縄を解く',d:1.8};
    return LV.target(st.f,p);
  }
  function complete(p,k){
    if(k.startsWith('res:')){ const q=G.pl.find(x=>'res:'+x.id===k); if(q&&q.cap){ q.cap=false; q.grace=4; G.rescues++; event(p.n+'が'+q.n+'の縄を解いた！'); } return; }
    if(k==='lock'){ sendTo(p.id,{t:'lockui'}); return; }
    LV.complete(p,k);
  }
  function onCode(v,syms){ if(!G||G.over||!LV.code) return; LV.code(v,syms||[]); }
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
    G.t-=dt; if(G.t<=0){ G.t=0; return finish(false,LVI===4?'天守も御殿も焼け落ちた……。脱出はかなわなかった':'時間切れ……。徳川方に先を越されてしまった'); }
    const h=G.pl.find(p=>p.id===0); if(h) readMe(h);
    for(const p of G.pl) p.grace=Math.max(0,p.grace-dt);
    G.sw={};
    for(const p of G.pl){ const tg=targetFor(G,p);
      if(!p.use) p.rel=false;
      if(!tg||!p.use||p.rel){ p.hk=tg?tg.k:null; p.hp=0; continue; }
      if(tg.sw){ G.sw[tg.k]=1; p.hk=tg.k; continue; }
      if(p.hk!==tg.k){ p.hk=tg.k; p.hp=0; }
      p.hp+=dt/tg.d; if(p.hp>=1){ p.hp=0; p.rel=true; complete(p,tg.k); if(G.over) return; } }
    if(LV.tick){ LV.tick(dt); if(G.over) return; }
    /* 追手 */
    for(const e of G.en){
      let maxA=0,tgt=null; for(const p of G.pl){ const s=seen(e,p),a=e.al[p.id]||0,na=s>0?Math.min(1.2,a+dt*s):Math.max(0,a-dt*.7); e.al[p.id]=na; if(na>maxA){ maxA=na; tgt=p; }
        if(na>=1&&!p.cap){ p.cap=true; if(LV.drop) LV.drop(p); p.carry=false; e.al[p.id]=0; e.pause=3; G.caught++; event(p.n+'が徳川方の追手に見つかり、捕まった！'+(nPl()>1?' 近づいて「縄を解く」で助けよう':'')); } }
      e.look=maxA;
      if(tgt&&maxA>.25){ e.yaw=Math.atan2(-(tgt.x-e.x),-(tgt.z-e.z)); if(maxA>.5&&dist(e.x,e.z,tgt.x,tgt.z)>1.6){ const d=dist(e.x,e.z,tgt.x,tgt.z); e.x+=(tgt.x-e.x)/d*dt*1.1; e.z+=(tgt.z-e.z)/d*dt*1.1; } continue; }
      if(e.pause>0){ e.pause-=dt; e.yaw+=Math.sin(performance.now()/700+e.x)*dt*.8; continue; }
      const w=e.p[e.i],d=dist(e.x,e.z,w[0],w[1]);
      if(d<.4){ e.i=(e.i+1)%e.p.length; e.pause=1.6; continue; }
      e.yaw=Math.atan2(-(w[0]-e.x),-(w[1]-e.z)); const st=Math.min(d,e.s*dt); e.x+=(w[0]-e.x)/d*st; e.z+=(w[1]-e.z)/d*st; }
    if(G.pl.every(p=>p.cap)){ G.allCapT+=dt; if(G.allCapT>2.6){ G.allCapT=0; G.t-=45; resetToCheck('全員捕まってしまった……（−45秒）。少し前からやり直し'); } } else G.allCapT=0;
  }
  const OFFS=[[0,0],[3,0],[-3,0],[0,3]];
  function resetToCheck(m){ const c=LV.check(G.f); G.pl.forEach((p,i)=>{ p.cap=false; p.grace=5; if(LV.drop) LV.drop(p); p.carry=false; const q=nudge(c[0]+OFFS[i][0],c[1]+OFFS[i][1]); p.x=q[0]; p.z=q[1]; sendTo(p.id,{t:'tp',x:p.x,z:p.z}); }); for(const e of G.en) e.al={}; event(m); }
  function finish(win,msg){ const used=LEVELS[G.lv].limit-G.t; G.over={win,msg,used,res:G.rescues,cau:G.caught,lv:G.lv}; broadcast({t:'end',...G.over}); onEnd(G.over); }
  function snap(){ return {t:'g',lv:G.lv,f:G.f,tm:Math.round(G.t*10)/10,sw:G.sw,gh:G.gh,notes:G.notes,
    pl:G.pl.map(p=>({id:p.id,n:p.n,c:p.c,x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2),yaw:+p.yaw.toFixed(2),cr:p.cr,cap:p.cap,carry:p.carry,hk:p.hk,hp:+p.hp.toFixed(2),room:p.room})),
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
        c.on('data',m=>{ if(m.t==='hello'){ if(me.inGame||lobby.length>=MAXP){ c.send({t:'full',m:me.inGame?'もう出陣しています':'満員です（4人まで）'}); setTimeout(()=>c.close(),400); return; }
            id=Math.max(0,...lobby.map(p=>p.id))+1; net.conns.set(id,c); lobby.push({id,n:String(m.n||'名無し').slice(0,10)}); c.send({t:'welcome',id,code:net.code}); syncLobby(); return; }
          if(m.t==='code'&&G){ onCode(m.v,m.syms); return; }
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
    else if(m.t==='start'){ startWorld(m.i,m.lv,m.set); }
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
    L.innerHTML=`<div class="box"><h1><small>大坂の陣 ・ 五つの任務</small>大坂城脱出</h1>
<p class="lead">慶長十九年から二十年、大坂の陣。豊臣方に仕えるあなたたちは、城下から本丸、そして燃え落ちる天守まで、五つの任務に挑む。聞き込み、謎を解き、探し出し、徳川方の追手をかわして脱出せよ。1〜4人で遊べる協力脱出ゲームです。</p>
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
  function showLobby(){ if(me.inGame) return; const L=el('escL'); L.hidden=false; const isHost=net.mode==='host'; if(pickLv===null) pickLv=progress(); const sel=pickLv;
    const url=location.origin+location.pathname+'?room='+net.code+(qs.get('peer')?'&peer='+qs.get('peer'):'');
    L.innerHTML=`<div class="box"><h1 style="font-size:24px"><small>${net.solo?'ひとりで':'部屋番号'}</small></h1>${net.solo?'':`<div class="code">${net.code}</div><div class="st">この番号を仲間に伝えてください（最大4人）</div>${isHost&&navigator.share?'<button class="b" id="escShare">招待リンクを送る</button>':''}`}
<div class="pls">${lobby.map((p,i)=>`<div class="pl"><i style="background:${COLS[i%4]}"></i>${esc(p.n)}${p.id===0?'（主）':''}${p.id===net.myId?' ← あなた':''}</div>`).join('')}</div>
${isHost?`<div class="lvs">${LEVELS.map((L,i)=>`<button class="lv${i===sel?' on':''}" data-lv="${i}" ${i>progress()?'disabled':''}><b>${esc(lvTitle(i))}</b><small>${i>progress()?'前の面をクリアすると遊べる':esc(L.sub)}</small></button>`).join('')}</div><button class="b p" id="escGo">出陣する（${lobby.length}人）</button>`:'<div class="st">主が面を選んで出陣するのを待っています…</div>'}
<button class="b" id="escBack">もどる</button><div class="st" id="escSt"></div></div>`;
    if(el('escShare')) el('escShare').onclick=()=>navigator.share({title:'大坂城脱出',text:'部屋番号 '+net.code+' で一緒に脱出しよう',url}).catch(()=>{});
    if(el('escGo')) el('escGo').onclick=()=>hostStart(pickLv); L.querySelectorAll('.lv').forEach(b=>b.onclick=()=>{ pickLv=+b.dataset.lv; showLobby(); });
    el('escBack').onclick=()=>location.reload(); }
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
  function startWorld(i,lv,set){
    me.inGame=true; V=null; clearOthers(); el('escL').hidden=true; el('escEnd').hidden=true; el('escLog').innerHTML='';
    LVI=lv; LV=LEVELS[lv]; SET=set; W={};
    if(LV.scen){ chooseEra(LV.scen); setPhase(LV.phase); const keep=LV.keepFire?FXS.filter(f=>f.type==='blaze'||f.type==='column'):[]; clearUnits(); for(const f of keep) FXS.push(f); }
    else chooseEra('toyo');
    tourStop(); powerMode(); auto=false; $('scen').hidden=true; $('ticker').hidden=true; setFov(1); applyTime(LV.time); closeHint();
    $('eyebrow').textContent='大坂城脱出 · '+lvTitle(lv);
    started=true; if(isTouch) document.body.classList.add('touchui'); syncPad();
    clearLv(); LV.build(set);
    if(net.mode==='host'&&G){ G.f=LV.init(); G.pl.forEach((p,k)=>{ const q=nudge(LV.spawn[0]+OFFS[k][0],LV.spawn[1]+OFFS[k][1]); p.x=q[0]; p.z=q[1]; p.y=groundH(q[0],q[1])+1.6; }); }
    const q=nudge(LV.spawn[0]+OFFS[i||0][0],LV.spawn[1]+OFFS[i||0][1]); P.room=null; P.level=-1; P.mode='walk'; P.x=q[0]; P.z=q[1]; P.y=groundH(P.x,P.z)+1.6; P.yaw=LV.spawn[2]; P.pitch=-.05; lastArea='';
    closeLock(); closeNotes(); notesSeen.n=-1;
    for(const id of ['escHud','escArrow','escUse','escCr','escNB']) el(id).hidden=false; me.cr=false; el('escCr').setAttribute('aria-pressed','false');
    showIntro(lv); onEvent(lvTitle(lv)+' はじまり');
  }
  function closeHint(){ const h=$('hint'); if(h){ h.hidden=true; h.style.opacity='0'; } }

  /* 面の範囲と、門・火などの当たり判定 */
  const _walkable=walkable;
  walkable=function(x,z){ if(me.inGame&&LV){ const f=view(); if(LV.bounds&&!inR(LV.bounds,x,z,0)){ boundsHint(); return false; } if(f&&LV.block&&LV.block(x,z,f)) return false; } return _walkable(x,z); };
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
    ESCF.cr=me.cr;
    /* 他の人 */
    const seenIds=new Set();
    for(const p of V.pl){ if(p.id===net.myId) continue; seenIds.add(p.id); const o=otherOf(p);
      const t=o.t||(o.t={x:p.x,y:p.y,z:p.z,yaw:p.yaw}); const k=Math.min(1,dt*10); t.x+=(p.x-t.x)*k; t.y+=(p.y-t.y)*k; t.z+=(p.z-t.z)*k; t.yaw=p.yaw;
      if(Math.hypot(p.x-t.x,p.z-t.z)>8){ t.x=p.x; t.z=p.z; t.y=p.y; }
      const gy=t.y-(p.cr?.95:1.6),low=p.cr||p.cap,hid=p.room&&!(P.room||P.level>=0);
      if(hid){ hideFig(o.F); hideFig(o.C); } else if(low){ hideFig(o.F); placeFig(o.C,t.x,gy,t.z,t.yaw); } else { hideFig(o.C); placeFig(o.F,t.x,gy,t.z,t.yaw); }
      o.tag.position.set(t.x,gy+(low?2.3:3.2),t.z); o.tag.visible=!hid; o.tag.material.opacity=p.cap?.55:1;
      if(o.bk) crowd.move(o.bk,p.carry==='水'&&!hid?t.x:0,p.carry==='水'&&!hid?gy+1.9:-999,t.z); }
    for(const [id,o] of others) if(!seenIds.has(id)){ hideFig(o.F); hideFig(o.C); PROP.remove(o.tag); if(o.bk) crowd.move(o.bk,0,-999,0); others.delete(id); }
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
    el('escVig').style.boxShadow=danger>.05?`inset 0 0 ${60+danger*90}px ${10+danger*40}px rgba(255,40,20,${Math.min(.75,danger*.8)})`:'none';
    const cap=el('escCap'); if(mine&&mine.cap){ cap.hidden=false; cap.innerHTML='徳川方の追手に捕まった！<br><span style="font-size:15px">'+(V.pl.length>1?'仲間が来て縄を解くのを待て':'まもなく少し前からやり直し（−45秒）')+'</span><br><span style="font-size:13px;font-weight:400">地面のオレンジの扇形が追手の視界。入らないように</span>'; P.pitch+=(-.5-P.pitch)*Math.min(1,dt*3); } else cap.hidden=true;
    /* 面の小道具 */
    const t=performance.now()/1000;
    const gl=LV.glints(V.f)||[], ph=.75+Math.sin(t*4)*.25; for(let i=0;i<glints.length;i++){ const g=gl[i],sp=glints[i]; sp.visible=!!g; if(g){ sp.position.set(g[0],g[1],g[2]); sp.scale.setScalar(ph); } }
    LV.render(V.f,t,dt);
    hudUpdate(mine);
  }
  function hudUpdate(mine){
    el('escStg').textContent=lvTitle(LVI);
    el('escObj').textContent=LV.obj(V.f); const tm=el('escTm'); tm.textContent=fmt(V.tm); tm.classList.toggle('low',V.tm<60);
    const T=LV.arrow(V.f,mine)||{n:''},svg=el('escArrow').querySelector('svg');
    if(T.x===undefined){ svg.style.display='none'; el('escDist').textContent=T.n; }
    else { const dx=T.x-P.x,dz=T.z-P.z,d=Math.hypot(dx,dz),ang=Math.atan2(-dx,-dz)-P.yaw; svg.style.display=''; svg.style.transform=`rotate(${-ang}rad)`; el('escDist').textContent=(T.n||'')+' '+Math.round(d)+'m'; }
    { const n=(V.notes||[]).length; if(n!==notesSeen.n){ notesSeen.n=n; el('escNB').textContent='手控え '+n; if(!el('escNotes').hidden) renderNotes(); } }
    const me2=mine&&{...mine,x:P.x,z:P.z,y:P.y}; const tg=me2?targetFor({f:V.f,pl:V.pl.map(p=>p.id===net.myId?me2:p)},me2):null;
    tgKey=tg?tg.k:null;
    if(me.latch&&(tgKey!==me.latchKey||Math.hypot(P.x-me.latchX,P.z-me.latchZ)>1.5||(!/^sw/.test(me.latchKey||'')&&performance.now()-me.latchT>4000))) me.latch=false;
    const U=el('escUse'); U.classList.toggle('on',!!tg); U.classList.toggle('hold',!!me.latch); el('escUseL').textContent=tg?tg.l:'調べる';
    el('escPg').style.width=(mine&&tg&&mine.hk===tg.k?(tg.sw?(V.gh/1.2*100):mine.hp*100):0)+'%';
    el('escPl').innerHTML=V.pl.map(p=>`<div><i style="background:${COLS[p.c%4]}"></i>${esc(p.n)}${p.cap?' 捕縛':''}${p.carry?' '+esc(p.carry):''}</div>`).join('');
  }
  function onEnd(r){ me.inGame=false; me.use=false; if(r.win) saveClear(r.lv); const E=el('escEnd'); E.hidden=false; for(const id of ['escHud','escArrow','escUse','escCr','escCap','escNB','escWarn','escIntro']) el(id).hidden=true; closeLock(); closeNotes();
    const last=r.lv>=LEVELS.length-1, host=net.mode==='host';
    E.innerHTML=`<div class="box"><div style="color:#e8b13a;font-size:12px;letter-spacing:.2em">${esc(lvTitle(r.lv))}</div><h2 style="color:${r.win?'#9effa8':'#ff8f7e'}">${r.win?(last?'脱出成功':'面クリア'):'失敗'}</h2><p>${esc(r.msg)}</p>
<dl><dt>かかった時間</dt><dd>${fmt(r.used)}</dd><dt>捕まった回数</dt><dd>${r.cau}回</dd><dt>仲間を助けた</dt><dd>${r.res}回</dd></dl>
${r.win&&last?'<p>五つの面をすべて越えた。見事な働きであった！</p>':''}
${host?(r.win&&!last?`<button class="p" id="escNext">次の面へ：${esc(lvTitle(r.lv+1))}</button><button id="escAgain">この面をもう一度</button>`:'<button class="p" id="escAgain">もう一度（同じ仲間で）</button>'):'<p>主が次を選ぶのを待っています</p>'}<button id="escTitle">タイトルへ</button></div>`;
    const keep=()=>{ lobby=lobby.filter(p=>p.id===0||net.conns.has(p.id)); };
    if(el('escNext')) el('escNext').onclick=()=>{ keep(); hostStart(r.lv+1); };
    if(el('escAgain')) el('escAgain').onclick=()=>{ keep(); hostStart(r.lv); };
    el('escTitle').onclick=()=>location.reload(); }
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
    debug:{walk:(x,z)=>walkable(x,z),step:(n,dt)=>{ for(let i=0;i<n;i++) update(dt||.05); },tp:(x,z)=>{ P.room=null; P.level=-1; P.x=x; P.z=z; P.y=groundH(x,z)+1.6; },enter:R=>enterRoom(R),room,unlock:()=>{ try{ localStorage.setItem('escClear','5'); }catch(e){} }}};
})();
window.__esc=ESC;
