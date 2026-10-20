import json,re,sys
d=sys.argv[1]
g=json.load(open(d+'/courses/glossary.json'))
slim=[{k:x[k] for k in ('term','match','def','src','cat') if x.get(k)} for x in g]
js=json.dumps(slim,ensure_ascii=False).replace('</','<\\/')
p=d+'/wonkolingo.html'; s=open(p).read()
s,n=re.subn(r'^const GLOSSARY = .*;$', lambda m:'const GLOSSARY = '+js+';', s, count=1, flags=re.M)
assert n==1; open(p,'w').write(s); print(len(slim),'terms embedded')
