import { setTip } from './tooltips.js';

/*
 * UI language: English and Turkish.
 * - First visit: picked from the browser / OS language list (navigator.languages).
 * - Switching (language button) applies immediately and is remembered.
 *
 * Markup uses data attributes, applied by applyTranslations():
 *   data-i18n="key"        → textContent
 *   data-i18n-html="key"   → innerHTML (only for our own strings that contain <kbd>/<b>)
 *   data-i18n-title="key"  → tooltip text
 *   data-i18n-aria="key"   → aria-label
 * Code uses t('key', { param }) for text it builds itself.
 */

const STORAGE_KEY = 'interior-design.lang';
export const LANGUAGES = { en: 'English', tr: 'Türkçe' };

const K = (k) => `<span class="k"><kbd>${k}</kbd></span>`;

const STRINGS = {
  en: {
    // left tool bar
    'tool.select': 'Select', 'tool.select.tip': 'Select (V)',
    'tool.line': 'Line', 'tool.line.tip': 'Line: click points; click the start point to close a face (L)',
    'tool.rect': 'Rectangle', 'tool.rect.tip': 'Rectangle: two corners (R)',
    'tool.circle': 'Circle', 'tool.circle.tip': 'Circle: centre, then radius (C)',
    'tool.pushpull': 'Push / Pull', 'tool.pushpull.tip': 'Push / Pull: move a face to give a shape depth (P)',
    'tool.person': 'Person', 'tool.person.tip': 'Place a person for scale (U)',
    // top bar
    'top.open': 'Open', 'top.open.tip': 'Open a design file (Ctrl+O), or drop one onto the page',
    'top.save': 'Save', 'top.save.tip': 'Save design to a file (Ctrl+S)',
    'top.screenshot': 'Screenshot', 'top.screenshot.tip': 'Screenshot: save the 3D view as an image',
    'top.clear': 'Clear scene', 'top.clear.tip': 'Clear scene: remove all shapes, lines and the person',
    'top.undo': 'Undo', 'top.undo.tip': 'Undo (Ctrl+Z)',
    'top.redo': 'Redo', 'top.redo.tip': 'Redo (Ctrl+Y)',
    'top.home': 'Home view', 'top.home.tip': 'Home view: fit the whole scene (H)',
    'top.eye': 'Eye view', 'top.eye.tip': "See through the person's eyes (E)",
    'top.view': 'Top view', 'top.view.tip': 'Toggle top view (T)', 'top.view.back': 'Back to 3D view (T)',
    'top.parallel': 'Parallel', 'top.parallel.tip': 'Parallel (orthographic) projection: no perspective distortion (O)',
    'top.help': 'Help', 'top.help.tip': 'Help & shortcuts (?)',
    'top.lang': 'Language', 'top.lang.tip': 'Language: English · click for Türkçe',
    // cards
    'card.drawing': 'Drawing', 'card.view': 'View', 'card.grid': 'Grid',
    'card.scene': 'Scene', 'card.rendering': 'Rendering',
    'card.selectedShape': 'Selected shape', 'card.selectedLine': 'Selected line',
    'f.newColor': 'Color for new shapes',
    'f.size': 'Size', 'f.height': 'Height (m)', 'f.elevation': 'Elevation (m)', 'f.color': 'Color',
    'f.fov': 'FOV', 'f.personHeight': 'Person height (m)', 'f.walkSpeed': 'Walk speed',
    'f.walkSpeed.tip': 'Hold Shift in eye view to go 2× faster',
    'f.show': 'Show', 'f.cellSize': 'Cell size', 'f.majorEvery': 'Major every', 'f.opacity': 'Opacity', 'f.snap': 'Snap',
    'f.cells2': '2 cells', 'f.cells4': '4 cells', 'f.cells5': '5 cells', 'f.cells10': '10 cells',
    'f.snapCell': 'Grid cell', 'f.snapHalf': '½ cell', 'f.snapOff': 'Off',
    'btn.removePerson': 'Remove person', 'btn.resetScene': 'Reset scene', 'btn.resetRendering': 'Reset rendering',
    'btn.delete': 'Delete', 'btn.deselect': 'Deselect', 'btn.deselect.tip': 'Deselect (Esc)',
    // generated scene / rendering controls
    's.colors': 'Colors', 's.sky': 'Sky', 's.horizon': 'Horizon / haze', 's.ground': 'Ground', 's.gridLines': 'Grid lines',
    's.distance': 'Distance & fade', 's.fog': 'Fog', 's.fogDistance': 'Fog distance', 's.gridFade': 'Grid fade',
    's.lighting': 'Lighting', 's.skyLight': 'Sky light', 's.sunLight': 'Sun light',
    's.sunDirection': 'Sun direction', 's.sunHeight': 'Sun height',
    's.mode': 'Mode', 's.realism': 'Realistic rendering',
    's.clarity': 'Clarity', 's.edges': 'Edge lines', 's.edgeStrength': 'Edge strength', 's.viewShading': 'View shading',
    's.light': 'Light', 's.envLight': 'Sky bounce light', 's.exposure': 'Exposure',
    's.sunShadows': 'Sun & shadows', 's.sun': 'Sun', 's.shadows': 'Shadows', 's.shadowSoftness': 'Shadow softness',
    's.ao': 'Corner shading (AO)', 's.aoReach': 'AO reach',
    's.dblclickReset': 'Double-click to reset',
    // messages
    'msg.screenshotSaved': 'Screenshot saved ({w}×{h})', 'msg.screenshotFailed': 'Screenshot failed',
    'msg.saved': 'Saved scene ({n} objects)', 'msg.opened': 'Opened {name} ({n} objects)',
    'msg.notJson': "Couldn't read {name}: not a valid JSON file",
    'msg.notDesign': "{name} isn't a design file from this app",
    'msg.newerVersion': 'File is from a newer version; some parts may not load',
    'msg.reportCopied': 'Report copied', 'msg.copyFailed': 'Copy failed; use Download instead',
    'msg.diagFailed': 'Diagnostics failed: {msg}',
    // FPS + diagnostics panel
    'fps.tip': 'Frames per second · time per frame. Click to run performance diagnostics.',
    'diag.title': 'Performance diagnostics', 'diag.download': 'Download report', 'diag.copy': 'Copy report', 'diag.close': 'Close',
    // help popup
    'help.title': 'Help & shortcuts', 'help.close': 'Close help', 'key.space': 'Space',
    'help.tools': 'Tools (left bar)', 'help.selectTool': 'Select', 'help.lineTool': 'Line', 'help.rectTool': 'Rectangle',
    'help.circleTool': 'Circle', 'help.pushpullTool': 'Push / Pull', 'help.personTool': 'Person',
    'help.toolsTip': 'Draw a flat shape, then push / pull it into 3D. Person tool: drag while placing to set which way they face.',
    'help.drawing': 'Drawing', 'help.linePoints': 'Line: place points', 'help.click': 'click',
    'help.closeLoop': 'Close into a face', 'help.clickStart': 'click the start point',
    'help.finishLines': 'Keep as open lines', 'help.finishHow': `double-click, ${K('Enter')} or right-click`,
    'help.rectCorners': 'Rectangle: two corners', 'help.circleSteps': 'Circle: centre, then radius',
    'help.clickOrDrag': 'click-click or drag', 'help.shiftLock': 'Line 45° / square rectangle', 'help.cancel': 'Cancel',
    'help.drawingTip': 'Shapes are drawn on the ground, or on the top face under the cursor. Points snap to the grid and to corners; the cursor ring turns orange on a corner.',
    'help.pushpull': 'Push / Pull', 'help.grabFace': 'Move a face', 'help.dragOrClick': 'drag it, or click, move, click',
    'help.topFace': 'Top / bottom face', 'help.changesHeight': 'changes the height',
    'help.sideFace': 'Side face', 'help.movesSide': 'moves that side (circle: radius)',
    'help.cancelPull': 'Cancel', 'help.escOrRight': `${K('Esc')} or right-click`,
    'help.values': 'Exact values', 'help.valueLine': 'Line length', 'help.typeLen': 'type 2.5, Enter',
    'help.valueRect': 'Rectangle size', 'help.typeRect': 'type 4;3, Enter',
    'help.valueCircle': 'Circle radius', 'help.typeRadius': 'type 0.6, Enter',
    'help.valuePull': 'Push / pull distance', 'help.typeDist': 'type 2.7, Enter',
    'help.valuesTip': 'Type while drawing or pushing; the value shows next to the cursor. Rectangle: width;depth (4,3 also works).',
    'help.editing': 'Editing', 'help.selectObj': 'Select a shape or line', 'help.clickIt': 'click it (Select tool)',
    'help.deleteObj': 'Delete selected', 'help.deselect': 'Deselect', 'help.undoRedo': 'Undo / redo',
    'help.editingTip': 'Height, elevation and colour of the selected shape are in the Selected card.',
    'help.camera': 'Camera & views', 'help.orbit': 'Orbit', 'help.orbitHow': 'drag (Select tool) or middle-drag',
    'help.pan': 'Pan', 'help.rightDrag': 'right-drag', 'help.zoom': 'Zoom', 'help.wheel': 'mouse wheel',
    'help.home': 'Home: fit the whole scene', 'help.topView': 'Top view', 'help.parallel': 'Parallel projection',
    'help.grid': 'Grid on / off',
    'help.eye': 'Eye view', 'help.enterExit': 'Enter / exit', 'help.look': 'Look around', 'help.drag': 'drag',
    'help.walk': 'Walk', 'help.orArrows': 'or arrows', 'help.run': 'Run', 'help.jump': 'Jump', 'help.fov': 'Field of view',
    'help.eyeTip': 'Shapes block you. Without a placed person, eye view drops one at the centre of the view.',
    'help.files': 'Files', 'help.saveDesign': 'Save design', 'help.openDesign': 'Open design', 'help.orDrop': 'or drop a file',
    'help.filesTip': 'A design file holds the whole scene, including every changed setting: send it to someone and they can open it here. Clear removes all shapes, lines and the person (undoable). The camera button saves a clean image of the 3D view.',
    'help.panels': 'Panels', 'help.toggleAll': 'Open / close all cards', 'help.toggleAllHow': '+ click or middle-click a header',
    'help.resetSlider': 'Reset a slider', 'help.dblclick': 'double-click it', 'help.thisHelp': 'This help', 'help.language': 'Language',
    'help.languageHow': 'EN / TR button in the top bar',
    'help.performance': 'Performance',
    'help.perfTip': 'If it feels slow, lower <b>Corner shading (AO)</b> or turn off <b>Realistic rendering</b> in the Rendering card. Click the FPS readout (bottom right) for a diagnostics report.',
  },

  tr: {
    'tool.select': 'Seç', 'tool.select.tip': 'Seç (V)',
    'tool.line': 'Çizgi', 'tool.line.tip': 'Çizgi: nokta koy; yüzey için başlangıç noktasına tıkla (L)',
    'tool.rect': 'Dikdörtgen', 'tool.rect.tip': 'Dikdörtgen: iki köşe (R)',
    'tool.circle': 'Daire', 'tool.circle.tip': 'Daire: merkez, sonra yarıçap (C)',
    'tool.pushpull': 'İt / Çek', 'tool.pushpull.tip': 'İt / Çek: şekle derinlik vermek için bir yüzeyi taşı (P)',
    'tool.person': 'Kişi', 'tool.person.tip': 'Ölçek için bir kişi yerleştir (U)',
    'top.open': 'Aç', 'top.open.tip': 'Tasarım dosyası aç (Ctrl+O) ya da sayfaya sürükle bırak',
    'top.save': 'Kaydet', 'top.save.tip': 'Tasarımı dosyaya kaydet (Ctrl+S)',
    'top.screenshot': 'Ekran görüntüsü', 'top.screenshot.tip': 'Ekran görüntüsü: 3B görünümü resim olarak kaydet',
    'top.clear': 'Sahneyi temizle', 'top.clear.tip': 'Sahneyi temizle: tüm şekilleri, çizgileri ve kişiyi kaldır',
    'top.undo': 'Geri al', 'top.undo.tip': 'Geri al (Ctrl+Z)',
    'top.redo': 'Yinele', 'top.redo.tip': 'Yinele (Ctrl+Y)',
    'top.home': 'Başlangıç görünümü', 'top.home.tip': 'Başlangıç görünümü: tüm sahneyi sığdır (H)',
    'top.eye': 'Göz görünümü', 'top.eye.tip': 'Kişinin gözünden bak (E)',
    'top.view': 'Üstten görünüm', 'top.view.tip': 'Üstten görünümü aç/kapat (T)', 'top.view.back': '3B görünüme dön (T)',
    'top.parallel': 'Paralel', 'top.parallel.tip': 'Paralel (ortografik) izdüşüm: perspektif bozulması yok (O)',
    'top.help': 'Yardım', 'top.help.tip': 'Yardım ve kısayollar (?)',
    'top.lang': 'Dil', 'top.lang.tip': 'Dil: Türkçe · English için tıkla',
    'card.drawing': 'Çizim', 'card.view': 'Görünüm', 'card.grid': 'Izgara',
    'card.scene': 'Sahne', 'card.rendering': 'Render',
    'card.selectedShape': 'Seçili şekil', 'card.selectedLine': 'Seçili çizgi',
    'f.newColor': 'Yeni şekillerin rengi',
    'f.size': 'Boyut', 'f.height': 'Yükseklik (m)', 'f.elevation': 'Taban yüksekliği (m)', 'f.color': 'Renk',
    'f.fov': 'Görüş açısı', 'f.personHeight': 'Kişi boyu (m)', 'f.walkSpeed': 'Yürüme hızı',
    'f.walkSpeed.tip': 'Göz görünümünde 2 kat hız için Shift tuşunu basılı tut',
    'f.show': 'Göster', 'f.cellSize': 'Hücre boyutu', 'f.majorEvery': 'Ana çizgi aralığı', 'f.opacity': 'Opaklık', 'f.snap': 'Yakalama',
    'f.cells2': '2 hücre', 'f.cells4': '4 hücre', 'f.cells5': '5 hücre', 'f.cells10': '10 hücre',
    'f.snapCell': 'Izgara hücresi', 'f.snapHalf': '½ hücre', 'f.snapOff': 'Kapalı',
    'btn.removePerson': 'Kişiyi kaldır', 'btn.resetScene': 'Sahneyi sıfırla', 'btn.resetRendering': 'Render ayarlarını sıfırla',
    'btn.delete': 'Sil', 'btn.deselect': 'Seçimi kaldır', 'btn.deselect.tip': 'Seçimi kaldır (Esc)',
    's.colors': 'Renkler', 's.sky': 'Gökyüzü', 's.horizon': 'Ufuk / pus', 's.ground': 'Zemin', 's.gridLines': 'Izgara çizgileri',
    's.distance': 'Mesafe ve solma', 's.fog': 'Sis', 's.fogDistance': 'Sis mesafesi', 's.gridFade': 'Izgara solma mesafesi',
    's.lighting': 'Aydınlatma', 's.skyLight': 'Gökyüzü ışığı', 's.sunLight': 'Güneş ışığı',
    's.sunDirection': 'Güneş yönü', 's.sunHeight': 'Güneş yüksekliği',
    's.mode': 'Mod', 's.realism': 'Gerçekçi görüntü',
    's.clarity': 'Netlik', 's.edges': 'Kenar çizgileri', 's.edgeStrength': 'Kenar belirginliği', 's.viewShading': 'Bakış gölgelendirmesi',
    's.light': 'Işık', 's.envLight': 'Gökyüzü yansıma ışığı', 's.exposure': 'Pozlama',
    's.sunShadows': 'Güneş ve gölgeler', 's.sun': 'Güneş', 's.shadows': 'Gölgeler', 's.shadowSoftness': 'Gölge yumuşaklığı',
    's.ao': 'Köşe gölgelendirme (AO)', 's.aoReach': 'AO erişimi',
    's.dblclickReset': 'Sıfırlamak için çift tıkla',
    'msg.screenshotSaved': 'Ekran görüntüsü kaydedildi ({w}×{h})', 'msg.screenshotFailed': 'Ekran görüntüsü alınamadı',
    'msg.saved': 'Sahne kaydedildi ({n} nesne)', 'msg.opened': '{name} açıldı ({n} nesne)',
    'msg.notJson': '{name} okunamadı: geçerli bir JSON dosyası değil',
    'msg.notDesign': '{name} bu uygulamaya ait bir tasarım dosyası değil',
    'msg.newerVersion': 'Dosya daha yeni bir sürümden; bazı kısımlar yüklenmeyebilir',
    'msg.reportCopied': 'Rapor kopyalandı', 'msg.copyFailed': 'Kopyalanamadı; bunun yerine indir',
    'msg.diagFailed': 'Tanılama başarısız: {msg}',
    'fps.tip': 'Saniyedeki kare sayısı · kare başına süre. Performans tanılaması için tıkla.',
    'diag.title': 'Performans tanılaması', 'diag.download': 'Raporu indir', 'diag.copy': 'Raporu kopyala', 'diag.close': 'Kapat',
    'help.title': 'Yardım ve kısayollar', 'help.close': 'Yardımı kapat', 'key.space': 'Boşluk',
    'help.tools': 'Araçlar (sol çubuk)', 'help.selectTool': 'Seç', 'help.lineTool': 'Çizgi', 'help.rectTool': 'Dikdörtgen',
    'help.circleTool': 'Daire', 'help.pushpullTool': 'İt / Çek', 'help.personTool': 'Kişi',
    'help.toolsTip': 'Düz bir şekil çiz, sonra it / çek ile 3B yap. Kişi aracı: yerleştirirken sürükleyerek baktığı yönü ayarla.',
    'help.drawing': 'Çizim', 'help.linePoints': 'Çizgi: nokta koy', 'help.click': 'tıkla',
    'help.closeLoop': 'Kapatıp yüzey yap', 'help.clickStart': 'başlangıç noktasına tıkla',
    'help.finishLines': 'Açık çizgi olarak bırak', 'help.finishHow': `çift tıkla, ${K('Enter')} ya da sağ tıkla`,
    'help.rectCorners': 'Dikdörtgen: iki köşe', 'help.circleSteps': 'Daire: merkez, sonra yarıçap',
    'help.clickOrDrag': 'tıkla-tıkla ya da sürükle', 'help.shiftLock': 'Çizgide 45° / kare dikdörtgen', 'help.cancel': 'İptal',
    'help.drawingTip': 'Şekiller zemine ya da imlecin altındaki üst yüzeye çizilir. Noktalar ızgaraya ve köşelere yapışır; imleç halkası bir köşede turuncuya döner.',
    'help.pushpull': 'İt / Çek', 'help.grabFace': 'Yüzeyi taşı', 'help.dragOrClick': 'sürükle ya da tıkla, taşı, tıkla',
    'help.topFace': 'Üst / alt yüzey', 'help.changesHeight': 'yüksekliği değiştirir',
    'help.sideFace': 'Yan yüzey', 'help.movesSide': 'o kenarı taşır (daire: yarıçap)',
    'help.cancelPull': 'İptal', 'help.escOrRight': `${K('Esc')} ya da sağ tıkla`,
    'help.values': 'Tam değerler', 'help.valueLine': 'Çizgi uzunluğu', 'help.typeLen': '2.5 yaz, Enter',
    'help.valueRect': 'Dikdörtgen boyutu', 'help.typeRect': '4;3 yaz, Enter',
    'help.valueCircle': 'Daire yarıçapı', 'help.typeRadius': '0.6 yaz, Enter',
    'help.valuePull': 'İt / çek mesafesi', 'help.typeDist': '2.7 yaz, Enter',
    'help.valuesTip': 'Çizerken ya da iterken yaz; değer imlecin yanında görünür. Dikdörtgen: genişlik;derinlik (4,3 de olur).',
    'help.editing': 'Düzenleme', 'help.selectObj': 'Şekil ya da çizgi seç', 'help.clickIt': 'üzerine tıkla (Seç aracı)',
    'help.deleteObj': 'Seçileni sil', 'help.deselect': 'Seçimi kaldır', 'help.undoRedo': 'Geri al / yinele',
    'help.editingTip': 'Seçili şeklin yüksekliği, taban yüksekliği ve rengi Seçili kartındadır.',
    'help.camera': 'Kamera ve görünümler', 'help.orbit': 'Döndür', 'help.orbitHow': 'sürükle (Seç aracı) ya da orta tuşla sürükle',
    'help.pan': 'Kaydır', 'help.rightDrag': 'sağ tuşla sürükle', 'help.zoom': 'Yakınlaştır', 'help.wheel': 'fare tekerleği',
    'help.home': 'Başlangıç: tüm sahneyi sığdır', 'help.topView': 'Üstten görünüm', 'help.parallel': 'Paralel izdüşüm',
    'help.grid': 'Izgarayı aç / kapat',
    'help.eye': 'Göz görünümü', 'help.enterExit': 'Gir / çık', 'help.look': 'Etrafa bak', 'help.drag': 'sürükle',
    'help.walk': 'Yürü', 'help.orArrows': 'ya da oklar', 'help.run': 'Koş', 'help.jump': 'Zıpla', 'help.fov': 'Görüş açısı',
    'help.eyeTip': 'Şekiller geçişi engeller. Yerleştirilmiş kişi yoksa göz görünümü, görünümün ortasına bir kişi koyar.',
    'help.files': 'Dosyalar', 'help.saveDesign': 'Tasarımı kaydet', 'help.openDesign': 'Tasarım aç', 'help.orDrop': 'ya da dosyayı sürükle bırak',
    'help.filesTip': 'Tasarım dosyası, değiştirilen tüm ayarlar dahil sahnenin tamamını içerir: birine gönder, o da burada açabilsin. Temizle tüm şekilleri, çizgileri ve kişiyi kaldırır (geri alınabilir). Kamera düğmesi 3B görünümün temiz bir görüntüsünü kaydeder.',
    'help.panels': 'Paneller', 'help.toggleAll': 'Tüm kartları aç / kapat', 'help.toggleAllHow': '+ başlığa tıkla ya da orta tıkla',
    'help.resetSlider': 'Kaydırıcıyı sıfırla', 'help.dblclick': 'üzerine çift tıkla', 'help.thisHelp': 'Bu yardım', 'help.language': 'Dil',
    'help.languageHow': 'üst çubuktaki EN / TR düğmesi',
    'help.performance': 'Performans',
    'help.perfTip': 'Yavaş geliyorsa Render kartında <b>Köşe gölgelendirme (AO)</b> değerini düşür ya da <b>Gerçekçi görüntü</b> seçeneğini kapat. Tanılama raporu için FPS göstergesine (sağ alt) tıkla.',
  },
};

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved in STRINGS) return saved;
  } catch { /* ignore */ }
  // Browsers report the user's preferred languages (from the browser / OS settings).
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = String(tag ?? '').toLowerCase().split('-')[0];
    if (base in STRINGS) return base;
  }
  return 'en';
}

let lang = detect();
const listeners = new Set();

export const getLang = () => lang;

/** Translate `key`, filling {placeholders} from `params`. Falls back to English, then the key. */
export function t(key, params) {
  let s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m));
  return s;
}

/** Switch language, remember the choice, update the page and notify listeners. */
export function setLang(next) {
  if (!(next in STRINGS) || next === lang) return;
  lang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  applyTranslations();
  listeners.forEach((fn) => fn(lang));
}

export function onLangChange(fn) { listeners.add(fn); }

/** Apply translations to every marked element under `root`. */
export function applyTranslations(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const text = t(el.dataset.i18nTitle);
    if (el._tippy) setTip(el, text);
    else el.setAttribute('title', text);
  }
}
