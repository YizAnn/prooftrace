from playwright.sync_api import sync_playwright
from pathlib import Path
import json,html,time
root=Path(__file__).resolve().parents[1]
out=root/'preview';out.mkdir(exist_ok=True)
markup=(root/'index.html').read_text()
registry=(root/'data/beijing_registry.js').read_text()
home=(root/'home.html').read_text()
markup=markup.replace('<script src="data/beijing_registry.js"></script>','<script>'+registry+'</script>')
markup=markup.replace('src="home.html"','srcdoc="'+html.escape(home,quote=True)+'"')
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server','--proxy-bypass-list=*'])
 page=b.new_page(viewport={'width':1440,'height':900},device_scale_factor=1)
 err=[];page.on('pageerror',lambda e:err.append(str(e)))
 page.set_content(markup,wait_until='domcontentloaded',timeout=30000)
 page.frame_locator('#p8-home-frame').locator('button.open-work').first.click()
 page.wait_for_timeout(500)
 assert page.locator('body').get_attribute('data-view')=='profile'
 page.screenshot(path=str(out/'P81_research.png'))
 active=page.locator('#p8-nav button[aria-current=page]').first
 assert 'red' not in (active.get_attribute('style') or '')
 assert page.locator('#p8-nav').evaluate('(el)=>getComputedStyle(el).scrollbarWidth')=='none'
 print('nav and research OK')
 page.evaluate("setView('pool')")
 page.wait_for_timeout(250)
 pooltext=page.locator('.view[data-view="pool"].is-active').inner_text()
 assert '从真实企业开始' in pooltext
 assert '合成样本' not in pooltext
 print('admission real case OK')
 page.screenshot(path=str(out/'P81_admission.png'))
 page.evaluate("setView('registry')")
 page.wait_for_timeout(200)
 sectors=[]
 for name in ['新一代信息技术','高端装备','生物医药','新材料','人工智能','集成电路','新能源','节能环保']:
  page.locator('.view.is-active select[data-reg2-industry]').select_option(name)
  page.wait_for_timeout(65)
  count=page.evaluate('registryFilteredRows().length')
  sectors.append((name,count))
  assert count>0, name
 print('sector sample counts:',sectors)
 page.screenshot(path=str(out/'P81_registry_sector.png'))
 page.locator('.view.is-active select[data-reg2-industry]').select_option('全部')
 page.evaluate("setView('ai')")
 page.wait_for_timeout(220)
 assert page.locator('input#p81-local-text').count()==1
 page.screenshot(path=str(out/'P81_import.png'))
 page.evaluate("setView('model')")
 page.wait_for_timeout(200)
 assert page.locator('.view.is-active .p8-tmetric').count()==5
 page.evaluate("setView('evidence')")
 page.wait_for_timeout(200)
 assert page.locator('.view.is-active [data-p8-ev]').count()==11
 print('evidence + scoring OK')
 page.screenshot(path=str(out/'P81_evidence.png'))
 page.evaluate("setView('profile')")
 page.wait_for_timeout(250)
 canvas=page.locator('.view.is-active .p81-hero-canvas')
 canvas.screenshot(path=str(out/'P81_canvas_a.png'))
 page.mouse.move(1210,158);page.wait_for_timeout(450)
 canvas.screenshot(path=str(out/'P81_canvas_b.png'))
 from PIL import Image,ImageChops
 import numpy as np
 a=np.asarray(Image.open(out/'P81_canvas_a.png').convert('RGB'),dtype=np.int16)
 b2=np.asarray(Image.open(out/'P81_canvas_b.png').convert('RGB'),dtype=np.int16)
 diff=float(np.abs(a-b2).mean());print('canvas pixel diff:',round(diff,3));assert diff>.1
 page.locator('[data-action="agent-toggle"]').first.click()
 page.wait_for_timeout(250)
 assert page.locator('#ai-rail').is_visible()
 print('agent UI OK')
 assert not err,err
 b.close()
 (out/'P81_acceptance.json').write_text(json.dumps({'errors':err,'sector_counts':sectors,'canvas_pixel_diff':diff,'checks':['profile','pool','registry','ai','model','evidence','agent']},ensure_ascii=False,indent=2))
