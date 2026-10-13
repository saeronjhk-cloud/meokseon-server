# 긴 상세 이미지를 OCR 친화 조각으로: 폭 1200 이하, 높이 1800 조각, 150px 겹침
import sys,os
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
src,outdir=sys.argv[1],sys.argv[2];os.makedirs(outdir,exist_ok=True)
im=Image.open(src).convert('RGB');w,h=im.size
if w>1200: im=im.resize((1200,int(h*1200/w)));w,h=im.size
y=0;i=0
while y<h:
    c=im.crop((0,y,w,min(h,y+1800)));c.save(f"{outdir}/{os.path.basename(src)}_{i:02d}.jpg",quality=90);i+=1
    if y+1800>=h:break
    y+=1650
print(i)
