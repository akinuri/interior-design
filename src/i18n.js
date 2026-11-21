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
    'top.v.top': 'Top view', 'top.v.top.tip': 'Top view (T) · click again to go back',
    'top.v.bottom': 'Bottom view', 'top.v.bottom.tip': 'Bottom view · click again to go back',
    'top.v.left': 'Left view', 'top.v.left.tip': 'Left view · click again to go back',
    'top.v.right': 'Right view', 'top.v.right.tip': 'Right view · click again to go back',
    'top.v.front': 'Front view', 'top.v.front.tip': 'Front view · click again to go back',
    'top.v.back': 'Back view', 'top.v.back.tip': 'Back view · click again to go back',
    'top.parallel': 'Parallel', 'top.parallel.tip': 'Parallel (orthographic) projection: no perspective distortion (O)',
    'top.help': 'Help', 'top.help.tip': 'Help & shortcuts (?)',
    'top.lang': 'Language', 'top.lang.tip': 'Language: English · click for Türkçe',
    'top.panel': 'Settings', 'top.panel.tip': 'Show / hide the settings',
    'act.value': 'Value', 'act.done': 'Done', 'act.cancel': 'Cancel',
    // cards
    'card.drawing': 'Drawing', 'card.view': 'View', 'card.grid': 'Grid',
    'card.scene': 'Scene', 'card.rendering': 'Rendering',
    'card.selection': 'Selection',
    'f.newColor': 'Color for new faces',
    'tool.sides': '{n} sides',
    'f.smooth': 'Smooth', 'f.smooth.off': 'off',
    'f.smooth.tip': 'Edges where faces meet at less than this angle are smoothed: hidden, with the shading blended across',
    'f.selected': 'Selected', 'f.area': 'Area', 'f.length': 'Length', 'f.color': 'Color',
    'sel.face': '{n} face', 'sel.faces': '{n} faces', 'sel.edge': '{n} edge', 'sel.edges': '{n} edges',
    'f.orbitCenter': 'Show orbit center', 'f.orbitCenter.tip': 'The point the view turns around (panning moves it)',
    'f.fov': 'FOV', 'f.personHeight': 'Person height (m)', 'f.walkSpeed': 'Walk speed',
    'f.walkSpeed.tip': 'Hold Shift in eye view to go 2× faster',
    'f.show': 'Show', 'f.cellSize': 'Cell size', 'f.majorEvery': 'Major every', 'f.opacity': 'Opacity', 'f.snap': 'Snap',
    'f.cells2': '2 cells', 'f.cells4': '4 cells', 'f.cells5': '5 cells', 'f.cells10': '10 cells',
    'f.snapCell': 'Grid cell', 'f.snapHalf': '½ cell', 'f.snapOff': 'Off',
    'btn.removePerson': 'Remove person', 'btn.resetScene': 'Reset scene', 'btn.resetRendering': 'Reset rendering',
    'btn.reverse': 'Reverse faces', 'btn.reverse.tip': 'Turn the selected faces around (front ↔ back)',
    'btn.delete': 'Delete', 'btn.deselect': 'Deselect', 'btn.deselect.tip': 'Deselect (Esc)',
    // generated scene / rendering controls
    's.look': 'Look', 's.look.natural': 'Natural', 's.look.clean': 'Clean',
    's.showSky': 'Show sky', 's.showGround': 'Show ground', 's.background': 'Background',
    's.colors': 'Colors', 's.sky': 'Sky', 's.horizon': 'Horizon / haze', 's.ground': 'Ground', 's.gridLines': 'Grid lines',
    's.distance': 'Distance & fade', 's.fog': 'Fog', 's.fogDistance': 'Fog distance', 's.gridFade': 'Grid fade',
    's.lighting': 'Lighting', 's.skyLight': 'Sky light', 's.sunLight': 'Sun light',
    's.sunDirection': 'Sun direction', 's.sunHeight': 'Sun height',
    's.mode': 'Mode', 's.realism': 'Realistic rendering',
    's.clarity': 'Clarity', 's.edges': 'Edge lines', 's.edgeStrength': 'Edge strength', 's.viewShading': 'View shading',
    's.backFaces': 'Color back faces', 's.backColor': 'Back face color',
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
    'help.toolsTip': 'Draw a flat shape on the ground or on any face, then push / pull it into 3D. Person tool: drag while placing to set which way they face.',
    'help.drawing': 'Drawing', 'help.linePoints': 'Line: place points', 'help.click': 'click',
    'help.closeLoop': 'Close into a face', 'help.clickStart': 'click the start point',
    'help.finishLines': 'Stop drawing lines', 'help.finishHow': `double-click, ${K('Enter')} or right-click`,
    'help.rectCorners': 'Rectangle: two corners', 'help.circleSteps': 'Circle: centre, then radius',
    'help.clickOrDrag': 'click-click or drag', 'help.shiftLock': 'Line 45° / square rectangle', 'help.cancel': 'Cancel',
    'help.drawingTip': 'Draw on the ground or on the face under the cursor (walls too). Lines across a face split it; closed loops become faces. Points snap to corners (orange ring), midpoints (teal), edges (pink) and the grid.',
    'help.pushpull': 'Push / Pull', 'help.grabFace': 'Move a face', 'help.dragOrClick': 'drag it, or click, move, click',
    'help.topFace': 'Face of a solid', 'help.changesHeight': 'out adds, in carves',
    'help.sideFace': 'Push to the far side', 'help.movesSide': 'cuts a hole (door, window)',
    'help.pushpullTip': 'A loose face grows a solid and stays as its base. Draw a shape on a face first to push / pull just that part. The distance snaps to the level of other corners.',
    'help.cancelPull': 'Cancel', 'help.escOrRight': `${K('Esc')} or right-click`,
    'help.values': 'Exact values', 'help.valueLine': 'Line length', 'help.typeLen': 'type 2.5, Enter',
    'help.valueRect': 'Rectangle size', 'help.typeRect': 'type 4;3, Enter',
    'help.valueCircle': 'Circle radius', 'help.typeRadius': 'type 0.6, Enter',
    'help.valueSides': 'Circle sides', 'help.typeSides': 'type 24 before the first click, or 24s while drawing',
    'help.valuePull': 'Push / pull distance', 'help.typeDist': 'type 2.7, Enter',
    'help.valuesTip': 'Type while drawing or pushing; the value shows next to the cursor. Rectangle: width;depth (4,3 also works).',
    'help.editing': 'Editing', 'help.selectObj': 'Select a face or edge', 'help.clickIt': 'click it (Select tool)',
    'help.selectNeighbours': '… with its edges / faces', 'help.doubleClick': 'double-click',
    'help.selectConnected': '… with everything connected', 'help.tripleClick': 'triple-click',
    'help.selectAddToggle': 'Add / add or remove', 'help.addToggleHow': `${K('Ctrl')} / ${K('Shift')} + click`, 'help.selectAll': 'Select all',
    'help.deleteObj': 'Delete selected', 'help.deselect': 'Deselect', 'help.undoRedo': 'Undo / redo',
    'help.editingTip': 'Change the colour of the selected faces in the Selection card. Deleting a face keeps its edges; deleting the edge between two flat faces merges them. Back faces show in their own colour (Rendering card); Reverse faces turns them around. Smooth blends the shading across edges where faces meet at less than its angle (a hexagon becomes round); circles with more than 12 sides come out smooth.',
    'help.camera': 'Camera & views', 'help.orbit': 'Orbit', 'help.orbitHow': 'drag (Select tool) or middle-drag',
    'help.pan': 'Pan', 'help.rightDrag': 'right-drag', 'help.zoom': 'Zoom', 'help.wheel': 'mouse wheel',
    'help.home': 'Home: fit the whole scene', 'help.topView': 'Top / bottom / side views', 'help.stdViewsHow': `cube buttons · ${K('T')} = top`, 'help.parallel': 'Parallel projection',
    'help.grid': 'Grid on / off',
    'help.eye': 'Eye view', 'help.enterExit': 'Enter / exit', 'help.look': 'Look around', 'help.drag': 'drag',
    'help.walk': 'Walk', 'help.orArrows': 'or arrows', 'help.run': 'Run', 'help.jump': 'Jump', 'help.fov': 'Field of view',
    'help.eyeTip': 'Walls and other upright faces block you. Without a placed person, eye view drops one at the centre of the view.',
    'help.files': 'Files', 'help.saveDesign': 'Save design', 'help.openDesign': 'Open design', 'help.orDrop': 'or drop a file',
    'help.filesTip': 'A design file holds the whole scene, including every changed setting: send it to someone and they can open it here. Clear removes everything drawn and the person (undoable). The camera button saves a clean image of the 3D view.',
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
    'top.v.top': 'Üstten görünüm', 'top.v.top.tip': 'Üstten görünüm (T) · geri dönmek için tekrar tıkla',
    'top.v.bottom': 'Alttan görünüm', 'top.v.bottom.tip': 'Alttan görünüm · geri dönmek için tekrar tıkla',
    'top.v.left': 'Soldan görünüm', 'top.v.left.tip': 'Soldan görünüm · geri dönmek için tekrar tıkla',
    'top.v.right': 'Sağdan görünüm', 'top.v.right.tip': 'Sağdan görünüm · geri dönmek için tekrar tıkla',
    'top.v.front': 'Önden görünüm', 'top.v.front.tip': 'Önden görünüm · geri dönmek için tekrar tıkla',
    'top.v.back': 'Arkadan görünüm', 'top.v.back.tip': 'Arkadan görünüm · geri dönmek için tekrar tıkla',
    'top.parallel': 'Paralel', 'top.parallel.tip': 'Paralel (ortografik) izdüşüm: perspektif bozulması yok (O)',
    'top.help': 'Yardım', 'top.help.tip': 'Yardım ve kısayollar (?)',
    'top.lang': 'Dil', 'top.lang.tip': 'Dil: Türkçe · English için tıkla',
    'top.panel': 'Ayarlar', 'top.panel.tip': 'Ayarları göster / gizle',
    'act.value': 'Değer', 'act.done': 'Bitti', 'act.cancel': 'İptal',
    'card.drawing': 'Çizim', 'card.view': 'Görünüm', 'card.grid': 'Izgara',
    'card.scene': 'Sahne', 'card.rendering': 'Render',
    'card.selection': 'Seçim',
    'f.newColor': 'Yeni yüzeylerin rengi',
    'tool.sides': '{n} kenar',
    'f.smooth': 'Yumuşat', 'f.smooth.off': 'kapalı',
    'f.smooth.tip': 'Yüzeylerin bu açıdan daha az bir açıyla birleştiği kenarlar yumuşatılır: gizlenir, gölgeleme kaynaşır',
    'f.selected': 'Seçili', 'f.area': 'Alan', 'f.length': 'Uzunluk', 'f.color': 'Renk',
    'sel.face': '{n} yüzey', 'sel.faces': '{n} yüzey', 'sel.edge': '{n} kenar', 'sel.edges': '{n} kenar',
    'f.orbitCenter': 'Dönme merkezini göster', 'f.orbitCenter.tip': 'Görünümün etrafında döndüğü nokta (kaydırınca yer değiştirir)',
    'f.fov': 'Görüş açısı', 'f.personHeight': 'Kişi boyu (m)', 'f.walkSpeed': 'Yürüme hızı',
    'f.walkSpeed.tip': 'Göz görünümünde 2 kat hız için Shift tuşunu basılı tut',
    'f.show': 'Göster', 'f.cellSize': 'Hücre boyutu', 'f.majorEvery': 'Ana çizgi aralığı', 'f.opacity': 'Opaklık', 'f.snap': 'Yakalama',
    'f.cells2': '2 hücre', 'f.cells4': '4 hücre', 'f.cells5': '5 hücre', 'f.cells10': '10 hücre',
    'f.snapCell': 'Izgara hücresi', 'f.snapHalf': '½ hücre', 'f.snapOff': 'Kapalı',
    'btn.removePerson': 'Kişiyi kaldır', 'btn.resetScene': 'Sahneyi sıfırla', 'btn.resetRendering': 'Render ayarlarını sıfırla',
    'btn.reverse': 'Yüzeyleri ters çevir', 'btn.reverse.tip': 'Seçili yüzeyleri ters çevir (ön ↔ arka)',
    'btn.delete': 'Sil', 'btn.deselect': 'Seçimi kaldır', 'btn.deselect.tip': 'Seçimi kaldır (Esc)',
    's.look': 'Stil', 's.look.natural': 'Doğal', 's.look.clean': 'Sade',
    's.showSky': 'Gökyüzünü göster', 's.showGround': 'Zemini göster', 's.background': 'Arka plan',
    's.colors': 'Renkler', 's.sky': 'Gökyüzü', 's.horizon': 'Ufuk / pus', 's.ground': 'Zemin', 's.gridLines': 'Izgara çizgileri',
    's.distance': 'Mesafe ve solma', 's.fog': 'Sis', 's.fogDistance': 'Sis mesafesi', 's.gridFade': 'Izgara solma mesafesi',
    's.lighting': 'Aydınlatma', 's.skyLight': 'Gökyüzü ışığı', 's.sunLight': 'Güneş ışığı',
    's.sunDirection': 'Güneş yönü', 's.sunHeight': 'Güneş yüksekliği',
    's.mode': 'Mod', 's.realism': 'Gerçekçi görüntü',
    's.clarity': 'Netlik', 's.edges': 'Kenar çizgileri', 's.edgeStrength': 'Kenar belirginliği', 's.viewShading': 'Bakış gölgelendirmesi',
    's.backFaces': 'Arka yüzleri renklendir', 's.backColor': 'Arka yüz rengi',
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
    'help.toolsTip': 'Zemine ya da herhangi bir yüzeye düz bir şekil çiz, sonra it / çek ile 3B yap. Kişi aracı: yerleştirirken sürükleyerek baktığı yönü ayarla.',
    'help.drawing': 'Çizim', 'help.linePoints': 'Çizgi: nokta koy', 'help.click': 'tıkla',
    'help.closeLoop': 'Kapatıp yüzey yap', 'help.clickStart': 'başlangıç noktasına tıkla',
    'help.finishLines': 'Çizgi çizmeyi bitir', 'help.finishHow': `çift tıkla, ${K('Enter')} ya da sağ tıkla`,
    'help.rectCorners': 'Dikdörtgen: iki köşe', 'help.circleSteps': 'Daire: merkez, sonra yarıçap',
    'help.clickOrDrag': 'tıkla-tıkla ya da sürükle', 'help.shiftLock': 'Çizgide 45° / kare dikdörtgen', 'help.cancel': 'İptal',
    'help.drawingTip': 'Zemine ya da imlecin altındaki yüzeye (duvarlar dahil) çizilir. Bir yüzeyi kesen çizgi onu böler; kapanan döngüler yüzey olur. Noktalar köşelere (turuncu halka), orta noktalara (camgöbeği), kenarlara (pembe) ve ızgaraya yapışır.',
    'help.pushpull': 'İt / Çek', 'help.grabFace': 'Yüzeyi taşı', 'help.dragOrClick': 'sürükle ya da tıkla, taşı, tıkla',
    'help.topFace': 'Bir katının yüzeyi', 'help.changesHeight': 'dışarı ekler, içeri oyar',
    'help.sideFace': 'Arka yüze kadar it', 'help.movesSide': 'delik açar (kapı, pencere)',
    'help.pushpullTip': 'Serbest bir yüzey katı oluşturur ve tabanı olarak kalır. Yalnızca bir bölümü itip çekmek için önce yüzeye bir şekil çiz. Mesafe diğer köşelerin hizasına yapışır.',
    'help.cancelPull': 'İptal', 'help.escOrRight': `${K('Esc')} ya da sağ tıkla`,
    'help.values': 'Tam değerler', 'help.valueLine': 'Çizgi uzunluğu', 'help.typeLen': '2.5 yaz, Enter',
    'help.valueRect': 'Dikdörtgen boyutu', 'help.typeRect': '4;3 yaz, Enter',
    'help.valueCircle': 'Daire yarıçapı', 'help.typeRadius': '0.6 yaz, Enter',
    'help.valueSides': 'Daire kenar sayısı', 'help.typeSides': 'ilk tıklamadan önce 24 yaz, ya da çizerken 24s',
    'help.valuePull': 'İt / çek mesafesi', 'help.typeDist': '2.7 yaz, Enter',
    'help.valuesTip': 'Çizerken ya da iterken yaz; değer imlecin yanında görünür. Dikdörtgen: genişlik;derinlik (4,3 de olur).',
    'help.editing': 'Düzenleme', 'help.selectObj': 'Yüzey ya da kenar seç', 'help.clickIt': 'üzerine tıkla (Seç aracı)',
    'help.selectNeighbours': '… kenarları / yüzeyleriyle', 'help.doubleClick': 'çift tıkla',
    'help.selectConnected': '… bağlı her şeyle', 'help.tripleClick': 'üç kez tıkla',
    'help.selectAddToggle': 'Ekle / ekle ya da çıkar', 'help.addToggleHow': `${K('Ctrl')} / ${K('Shift')} + tıkla`, 'help.selectAll': 'Tümünü seç',
    'help.deleteObj': 'Seçileni sil', 'help.deselect': 'Seçimi kaldır', 'help.undoRedo': 'Geri al / yinele',
    'help.editingTip': 'Seçili yüzeylerin rengini Seçim kartından değiştir. Yüzey silinince kenarları kalır; iki düz yüzey arasındaki kenar silinince yüzeyler birleşir. Arka yüzler kendi renginde görünür (Render kartı); Yüzeyleri ters çevir onları döndürür. Yumuşat, yüzeylerin bu açıdan küçük açıyla birleştiği kenarlarda gölgelemeyi kaynaştırır (altıgen yuvarlaklaşır); kenar sayısı 12 üzerindeki daireler yumuşak çıkar.',
    'help.camera': 'Kamera ve görünümler', 'help.orbit': 'Döndür', 'help.orbitHow': 'sürükle (Seç aracı) ya da orta tuşla sürükle',
    'help.pan': 'Kaydır', 'help.rightDrag': 'sağ tuşla sürükle', 'help.zoom': 'Yakınlaştır', 'help.wheel': 'fare tekerleği',
    'help.home': 'Başlangıç: tüm sahneyi sığdır', 'help.topView': 'Üst / alt / yan görünümler', 'help.stdViewsHow': `küp düğmeleri · ${K('T')} = üst`, 'help.parallel': 'Paralel izdüşüm',
    'help.grid': 'Izgarayı aç / kapat',
    'help.eye': 'Göz görünümü', 'help.enterExit': 'Gir / çık', 'help.look': 'Etrafa bak', 'help.drag': 'sürükle',
    'help.walk': 'Yürü', 'help.orArrows': 'ya da oklar', 'help.run': 'Koş', 'help.jump': 'Zıpla', 'help.fov': 'Görüş açısı',
    'help.eyeTip': 'Duvarlar ve diğer dik yüzeyler geçişi engeller. Yerleştirilmiş kişi yoksa göz görünümü, görünümün ortasına bir kişi koyar.',
    'help.files': 'Dosyalar', 'help.saveDesign': 'Tasarımı kaydet', 'help.openDesign': 'Tasarım aç', 'help.orDrop': 'ya da dosyayı sürükle bırak',
    'help.filesTip': 'Tasarım dosyası, değiştirilen tüm ayarlar dahil sahnenin tamamını içerir: birine gönder, o da burada açabilsin. Temizle çizilen her şeyi ve kişiyi kaldırır (geri alınabilir). Kamera düğmesi 3B görünümün temiz bir görüntüsünü kaydeder.',
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
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const text = t(el.dataset.i18nTitle);
    if (el._tippy) setTip(el, text);
    else el.setAttribute('title', text);
  }
}
