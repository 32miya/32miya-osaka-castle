# 元の「大阪城さんぽ」index.html に脱出ゲーム層を差し込んで、新しいゲームの index.html を作る
import re,sys
src,out=sys.argv[1],sys.argv[2]
prefix=sys.argv[3] if len(sys.argv)>3 else ''   # 例: ../ （大阪城さんぽの assets を共有するとき）
s=open(src,encoding='utf-8').read()
esc=open(__file__.replace('build.py','escape.js'),encoding='utf-8').read()
def rep(a,b,count=1):
    global s
    assert s.count(a)>=1, 'not found: '+a[:80]
    s=s.replace(a,b,count)
# タイトルなど
rep('<title>大阪城さんぽ</title>','<title>大坂城脱出 ― 夏の陣・落城の夜</title>')
s=re.sub(r'<meta name="description" content="[^"]*">','<meta name="description" content="燃える大坂城から仲間と脱出する、スマホ向けの協力脱出ゲーム（最大4人）">',s,1)
# しゃがむ・捕まったときの移動
rep('function updatePlayer(dt){','const ESCF={cr:false,lock:false};\nfunction updatePlayer(dt){')
rep('const sp=drone?(run?30:15):(run?5.4:2.2);','const sp=(drone?(run?30:15):(run?5.4:2.2))*(ESCF.cr?.45:1)*(ESCF.lock?0:1);')
rep('floorY(P.level,P.x,P.z):groundH(P.x,P.z))+1.6; P.y+=','floorY(P.level,P.x,P.z):groundH(P.x,P.z))+(ESCF.cr&&!drone?.95:1.6); P.y+=')
# 画像の場所
if prefix:
    rep("'assets/atlas'","'"+prefix+"assets/atlas'")
    rep("'assets/tiles.webp'","'"+prefix+"assets/tiles.webp'")
# 散策用の窓口 __oc の後ろ（IIFEの最後）にゲーム層を入れる
i=s.rfind('})();')
s=s[:i]+esc+'\n'+s[i:]
open(out,'w',encoding='utf-8').write(s)
print('ok',len(s))
