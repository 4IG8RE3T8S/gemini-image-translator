// content-script.js — runs on every page, listens for messages from background.js

const FONT_FAMILY =
  "'Noto Sans Thai', 'Noto Sans JP', 'Noto Sans SC', 'Noto Sans KR', 'Sarabun', 'Leelawadee UI', 'Meiryo', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// โครงสร้าง Gemini Structured Outputs Response Schema ที่เข้มงวด
const GEMINI_RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      box_2d: {
        type: "ARRAY",
        items: { type: "INTEGER" },
        description: "[ymin, xmin, ymax, xmax] normalized to 0-1000"
      },
      text: { type: "STRING" },
      translated_text: { type: "STRING" }
    },
    required: ["box_2d", "text", "translated_text"]
  }
};

let fontLoadingPromise = null;

/**
 * โหลด Google Fonts ที่รองรับภาษาปลายทาง (ไทย, ญี่ปุ่น, จีน, สากล)
 * พร้อมระบบแคชป้องกันการโหลดซ้ำ และรองรับ system fallback fonts
 */
function ensureFontsLoaded() {
  if (!fontLoadingPromise) {
    fontLoadingPromise = (async () => {
      try {
        const fontUrl =
          "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@500;700&family=Noto+Sans+SC:wght@500;700&family=Noto+Sans+Thai:wght@500;700&family=Noto+Sans:wght@500;700&display=swap";
        if (!document.querySelector(`link[href*="fonts.googleapis.com"][href*="Noto+Sans+Thai"]`)) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = fontUrl;
          document.head.appendChild(link);
        }
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
        }
      } catch (e) {
        console.warn("[Gemini Image Translator] โหลด Web Font ไม่สำเร็จ ใช้ System Fonts แทน:", e);
      }
    })();
  }
  return fontLoadingPromise;
}

/**
 * ดึงค่าโหมดพื้นหลังข้อความแปลจาก Storage (sync หรือ local)
 * ค่าเริ่มต้น: "blur" (Frosted Glass / Backdrop Blur)
 * ค่าที่รองรับ: "blur", "solid", "transparent"
 */
async function getStoredTextBackgroundMode() {
  try {
    if (typeof chrome !== "undefined" && chrome?.storage) {
      if (chrome.storage.sync) {
        const syncData = await chrome.storage.sync.get(["textBackgroundMode"]);
        if (syncData?.textBackgroundMode) {
          return syncData.textBackgroundMode;
        }
      }
      if (chrome.storage.local) {
        const localData = await chrome.storage.local.get(["textBackgroundMode", "textBgMode"]);
        if (localData?.textBackgroundMode) {
          return localData.textBackgroundMode;
        }
        if (localData?.textBgMode) {
          return localData.textBgMode;
        }
      }
    }
  } catch (err) {
    console.warn("[ContentScript] ไม่สามารถอ่านค่า textBackgroundMode จาก storage ได้:", err);
  }
  return "blur";
}

// Registry สำหรับผูก Unique ID กับ DOM Element อย่างปลอดภัย ป้องกันการสับสนระหว่างภาพ (Async / Batch Mapping)
const elementRegistry = new Map();
let nextElementUniqueId = 1;

function tagAndRegisterElement(el) {
  if (!el || !(el instanceof Element)) return null;
  let uid = el.getAttribute("data-git-element-id");
  if (!uid) {
    uid = "git-el-" + Date.now() + "-" + (nextElementUniqueId++) + "-" + Math.random().toString(36).substring(2, 7);
    el.setAttribute("data-git-element-id", uid);
  }
  elementRegistry.set(uid, el);
  return uid;
}

function getElementByUniqueId(uid) {
  if (!uid) return null;
  const fromMap = elementRegistry.get(uid);
  if (fromMap && document.body && document.body.contains(fromMap)) return fromMap;
  const fromDom = document.querySelector(`[data-git-element-id="${uid}"]`);
  if (fromDom) {
    elementRegistry.set(uid, fromDom);
    return fromDom;
  }
  return fromMap || null;
}

/**
 * คำนวณ Content Rect ของภาพภายใน Element
 * รองรับทั้งกรณีปกติ และกรณีที่ถูกกำหนด object-fit: contain / scale-down (มีขอบดำ Letterbox / Pillarbox)
 * เพื่อให้พิกัด Gemini วางทับลงบนเนื้อหาภาพจริง ไม่เบี้ยวตามขอบดำ
 */
function getImageContentRect(img) {
  const cw = img.clientWidth || img.offsetWidth || 0;
  const ch = img.clientHeight || img.offsetHeight || 0;
  const nw = img.naturalWidth || cw;
  const nh = img.naturalHeight || ch;

  if (cw === 0 || ch === 0 || nw === 0 || nh === 0) {
    return { left: 0, top: 0, width: cw, height: ch, naturalWidth: nw, naturalHeight: nh, naturalAspect: 1 };
  }

  const naturalAspect = nw / nh;
  const renderedAspect = cw / ch;

  const comp = window.getComputedStyle(img);
  const objFit = comp.objectFit;

  if (objFit === "contain" || objFit === "scale-down") {
    if (objFit === "scale-down" && nw <= cw && nh <= ch) {
      const left = (cw - nw) / 2;
      const top = (ch - nh) / 2;
      return { left, top, width: nw, height: nh, naturalWidth: nw, naturalHeight: nh, naturalAspect };
    }
    if (naturalAspect > renderedAspect) {
      // แนวนอนกว่ากรอบ -> ขอบดำบนและล่าง (Letterbox)
      const renderW = cw;
      const renderH = cw / naturalAspect;
      const top = (ch - renderH) / 2;
      return { left: 0, top, width: renderW, height: renderH, naturalWidth: nw, naturalHeight: nh, naturalAspect };
    } else {
      // แนวตั้งกว่ากรอบ -> ขอบดำซ้ายและขวา (Pillarbox)
      const renderH = ch;
      const renderW = ch * naturalAspect;
      const left = (cw - renderW) / 2;
      return { left, top: 0, width: renderW, height: renderH, naturalWidth: nw, naturalHeight: nh, naturalAspect };
    }
  }

  return { left: 0, top: 0, width: cw, height: ch, naturalWidth: nw, naturalHeight: nh, naturalAspect };
}

/**
 * สร้างหรือดึง Relative Container Wrapper ของรูปภาพ
 * เพื่อให้ Overlay วางตำแหน่งแบบ Relative อิงตาม Element ภาพโดยตรง
 * ไม่ใช้ absolute document coordinates (window.scrollY) เพื่อให้ภาพตรึงแน่นไม่เลื่อนหลุด
 */
function getOrCreateImageWrapper(el) {
  if (!el || !el.parentNode) return null;

  // หากเป็น background-image element อยู่แล้ว (เช่น <div>) ให้ใช้ตัวมันเองเป็น relative container
  if (!(el instanceof HTMLImageElement)) {
    const compPos = window.getComputedStyle(el).position;
    if (compPos === "static") {
      el.style.position = "relative";
    }
    return el;
  }

  // หากอยู่ใน git-image-wrapper อยู่แล้ว ให้ใช้ wrapper เดิม
  if (el.parentElement && el.parentElement.classList.contains("git-image-wrapper")) {
    return el.parentElement;
  }

  // หากอยู่ใน <picture> ให้ใช้ <picture> เป็น relative container
  if (el.parentElement && el.parentElement.tagName.toLowerCase() === "picture") {
    const pic = el.parentElement;
    const picComp = window.getComputedStyle(pic);
    if (picComp.position === "static") {
      pic.style.position = "relative";
    }
    if (picComp.display === "inline") {
      pic.style.display = "inline-block";
    }
    return pic;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "git-image-wrapper";

  const comp = window.getComputedStyle(el);
  const isBlock = comp.display === "block" || comp.display === "flex";
  wrapper.style.cssText = `
    position: relative !important;
    display: ${isBlock ? "block" : "inline-block"} !important;
    vertical-align: ${comp.verticalAlign || "middle"};
    line-height: 0 !important;
    max-width: 100%;
    padding: 0 !important;
    box-sizing: border-box;
  `;

  if (comp.margin && comp.margin !== "0px") {
    wrapper.style.margin = comp.margin;
    el.style.margin = "0";
  }

  el.parentNode.insertBefore(wrapper, el);
  wrapper.appendChild(el);
  return wrapper;
}

// ตัวแปรจัดเก็บข้อมูล Element ที่ผู้ใช้คลิกขวาล่าสุด เพื่อรองรับ CSS background-image
let lastRightClickedInfo = null;

window.addEventListener(
  "contextmenu",
  (e) => {
    const target = e.target;
    let bgUrl = null;
    let bgEl = null;

    // ตรวจสอบ element และ ancestors ขึ้นไป 4 ระดับ เพื่อหา CSS background-image
    let curr = target;
    for (let depth = 0; depth < 5 && curr && curr !== document.body && curr !== document.documentElement; depth++) {
      try {
        const style = window.getComputedStyle(curr);
        const bg = style.backgroundImage;
        if (bg && bg !== "none" && bg.includes("url(")) {
          const match = bg.match(/url\(['"]?(.*?)['"]?\)/);
          if (match && match[1] && !match[1].startsWith("data:")) {
            bgUrl = match[1];
            bgEl = curr;
            break;
          }
        }
      } catch {}
      curr = curr.parentElement;
    }

    if (bgUrl && bgEl) {
      // แปลง relative URL ให้เป็น absolute URL
      try {
        bgUrl = new URL(bgUrl, document.baseURI).href;
      } catch {}
      const elementId = tagAndRegisterElement(bgEl);
      lastRightClickedInfo = { element: bgEl, elementId, bgUrl, srcUrl: bgUrl, isBg: true };
    } else if (target.tagName && target.tagName.toLowerCase() === "img") {
      const elementId = tagAndRegisterElement(target);
      lastRightClickedInfo = {
        element: target,
        elementId,
        srcUrl: target.currentSrc || target.src || target.getAttribute("data-src") || target.getAttribute("data-original"),
        isBg: false
      };
    } else {
      lastRightClickedInfo = null;
    }
  },
  true
);

if (typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "START_AREA_SELECTION") {
    const isGoogle = msg?.isGoogle === true || msg?.provider === "google" || false;
    startScreenAreaSelection(isGoogle ? "google" : (msg?.provider || "gemini"));
  } else if (msg.type === "START_AREA_SELECTION_GT") {
    startScreenAreaSelection("google");
  } else if (msg.type === "TOGGLE_IMAGE_COLLECTOR" || msg.type === "OPEN_IMAGE_COLLECTOR") {
    toggleImageCollectorSidebar();
  } else if (msg.type === "COPY_AND_OPEN_GOOGLE_TRANSLATE") {
    (async () => {
      const targetUrl = msg.srcUrl;
      const targets = findImages(targetUrl);
      if (targets.length > 0) {
        targets.forEach((el) => (el.style.opacity = "0.5"));
        showToastNotification("🌐 กำลังแปลด้วย Google Translate...", false);
        try {
          const dataUrl = await proxyFetchImage(targetUrl);
          const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
          chrome.runtime.sendMessage(
            { type: "TRANSLATE_IMAGE_DATA", base64, mimeType: "image/png", provider: "google" },
            (res) => {
              if (res && res.success && res.segments?.length > 0) {
                targets.forEach((el) => {
                  renderTranslatedImage(el, res.segments, dataUrl, res.targetLang || "Thai").catch(() => {
                    el.style.opacity = "1";
                  });
                });
              } else {
                targets.forEach((el) => (el.style.opacity = "1"));
                showToastNotification("แปลภาพไม่สำเร็จ: " + (res?.error || "ไม่พบข้อความ"), true);
              }
            }
          );
        } catch (err) {
          targets.forEach((el) => (el.style.opacity = "1"));
          showToastNotification("ไม่สามารถดาวน์โหลดรูปภาพได้: " + err.message, true);
        }
      } else {
        const langCode = msg.targetLangCode || "th";
        chrome.runtime.sendMessage({
          type: "OPEN_GOOGLE_TRANSLATE_TAB",
          targetLangCode: langCode
        });
      }
    })();
    return true;
  } else if (msg.type === "GET_LAST_BG_IMAGE") {
    if (lastRightClickedInfo && lastRightClickedInfo.isBg && lastRightClickedInfo.bgUrl) {
      sendResponse({ success: true, bgUrl: lastRightClickedInfo.bgUrl });
    } else {
      sendResponse({ success: false });
    }
    return true;
  } else if (msg.type === "GET_LAST_RIGHT_CLICKED_INFO") {
    if (lastRightClickedInfo) {
      sendResponse({
        success: true,
        elementId: lastRightClickedInfo.elementId || null,
        srcUrl: lastRightClickedInfo.srcUrl || null,
        bgUrl: lastRightClickedInfo.bgUrl || null,
        isBg: lastRightClickedInfo.isBg || false
      });
    } else {
      sendResponse({ success: false });
    }
    return true;
  } else if (msg.type === "SHOW_TOAST") {
    showToastNotification(msg.message, msg.isError || false);
  } else if (msg.type === "IT_LOADING") {
    const target = msg.elementId ? getElementByUniqueId(msg.elementId) : null;
    const targets = target ? [target] : findImages(msg.srcUrl);
    targets.forEach((el) => (el.style.opacity = "0.5"));
  } else if (msg.type === "IT_CHUNKING_PROGRESS") {
    showToastNotification(
      `📜 กำลังแปล Webtoon ส่วนที่ ${msg.chunkIndex}/${msg.totalChunks}...`,
      false
    );
  } else if (msg.type === "IT_CHUNK_ERROR") {
    console.warn(`[Gemini Image Translator] ส่วนที่ ${msg.chunkIndex}/${msg.totalChunks} เกิดข้อผิดพลาด แต่ระบบกำลังประมวลผลส่วนอื่นต่อไป...`);
  } else if (msg.type === "IT_RETRYING") {
    showToastNotification(
      `⏳ คำขอแปลภาพล้มเหลว กำลังลองใหม่ครั้งที่ ${msg.attempt}/${msg.maxRetries} (รอ ${msg.delaySec} วินาที)...`,
      false
    );
  } else if (msg.type === "AREA_TRANSLATE_RETRYING") {
    if (activeAreaOverlay && typeof activeAreaOverlay.showStatus === "function") {
      activeAreaOverlay.showStatus(
        `⏳ คำขอล้มเหลว กำลังลองใหม่ครั้งที่ ${msg.attempt}/${msg.maxRetries} (รอ ${msg.delaySec} วินาที)...`,
        false,
        false,
        true
      );
    }
  } else if (msg.type === "IT_RESULT") {
    const target = msg.elementId ? getElementByUniqueId(msg.elementId) : (lastRightClickedInfo?.element || null);
    const targets = target ? [target] : findImages(msg.srcUrl);
    if (!msg.segments || msg.segments.length === 0) {
      targets.forEach((el) => (el.style.opacity = "1"));
      showToastNotification("ไม่พบข้อความในรูปภาพนี้", false);
      return;
    }
    if (targets.length === 0) {
      showToastNotification("แปลข้อความสำเร็จ แต่ไม่พบ Element รูปภาพบนหน้าเว็บเดิม (แนะนำให้ใช้ 'เลือกพื้นที่หน้าจอเพื่อแปล')", false);
      return;
    }
    const textBackgroundMode = msg.textBackgroundMode || msg.textBgMode || null;
    targets.forEach((el) => {
      renderTranslatedImage(el, msg.segments, msg.dataUrl, msg.targetLang, textBackgroundMode).catch((err) => {
        el.style.opacity = "1";
        console.error("[Gemini Image Translator]", err);
        showToastNotification("เกิดข้อผิดพลาดในการวาดภาพแปล: " + (err.message || String(err)), true);
      });
    });
  } else if (msg.type === "IT_ERROR") {
    const target = msg.elementId ? getElementByUniqueId(msg.elementId) : null;
    const targets = target ? [target] : findImages(msg.srcUrl);
    targets.forEach((el) => (el.style.opacity = "1"));
    console.error("[Gemini Image Translator]", msg.message);

    if (msg.isQuotaExceeded && msg.enableFallback !== false) {
      if (msg.fallbackMode === "auto") {
        (async () => {
          let copied = false;
          const imageToCopy = msg.dataUrl || msg.srcUrl;
          if (imageToCopy) {
            try {
              const url = imageToCopy.startsWith("data:") ? imageToCopy : await proxyFetchImage(imageToCopy);
              copied = await copyImageDataToClipboard(url);
            } catch {}
          }
          chrome.runtime.sendMessage({
            type: "OPEN_GOOGLE_TRANSLATE_TAB",
            targetLangCode: msg.targetLangCode || "th"
          });
          showToastNotification(
            copied
              ? "โควต้า Gemini หมด — คัดลอกภาพและเปิด Google Translate ให้แล้ว (กด Ctrl+V เพื่อแปล) 🚀"
              : "โควต้า Gemini หมด — เปิด Google Translate ให้แล้ว",
            false
          );
        })();
      } else {
        showQuotaExceededToast({
          message: msg.message,
          dataUrl: msg.dataUrl,
          srcUrl: msg.srcUrl,
          targetLangCode: msg.targetLangCode || "th"
        });
      }
    } else {
      showToastNotification("แปลภาพไม่สำเร็จ:\n" + msg.message, true);
    }
  }
});
}

/**
 * ค้นหา Element รูปภาพ รองรับทั้ง <img> ธรรมดา, responsive srcset, <picture>, lazy-load และ CSS background-image
 */
function findImages(srcUrl) {
  if (!srcUrl) return [];

  let parsedSrcUrl = srcUrl;
  try {
    parsedSrcUrl = new URL(srcUrl, document.baseURI).href;
  } catch {}

  const results = [];

  // 1. ตรวจสอบแท็ก <img> ทั้งหมดในหน้าเว็บ
  for (const img of Array.from(document.images)) {
    let matches = false;

    // เช็ค src ปกติ และ currentSrc (ของ responsive srcset)
    if (img.src === srcUrl || img.currentSrc === srcUrl) matches = true;

    // เช็ค absolute URL
    try {
      if (new URL(img.src, document.baseURI).href === parsedSrcUrl) matches = true;
      if (img.currentSrc && new URL(img.currentSrc, document.baseURI).href === parsedSrcUrl) matches = true;
    } catch {}

    // เช็ค attributes ของ Lazy Load ยอดนิยม (data-src, data-original, data-lazy-src, data-url)
    const lazyAttrs = ["data-src", "data-original", "data-lazy-src", "data-url", "data-actualsrc"];
    for (const attr of lazyAttrs) {
      const val = img.getAttribute(attr);
      if (val) {
        if (val === srcUrl) matches = true;
        try {
          if (new URL(val, document.baseURI).href === parsedSrcUrl) matches = true;
        } catch {}
      }
    }

    if (matches && !results.includes(img)) {
      results.push(img);
    }
  }

  // 2. ตรวจสอบ Element ที่มี CSS background-image
  if (lastRightClickedInfo && lastRightClickedInfo.element) {
    if (
      lastRightClickedInfo.srcUrl === srcUrl ||
      lastRightClickedInfo.bgUrl === srcUrl ||
      lastRightClickedInfo.srcUrl === parsedSrcUrl
    ) {
      if (!results.includes(lastRightClickedInfo.element)) {
        results.push(lastRightClickedInfo.element);
      }
    }
  }

  // หากยังไม่พบ ให้ค้นหาจาก DOM elements ที่มี background-image สไตล์
  if (results.length === 0) {
    const styledEls = document.querySelectorAll('[style*="background"]');
    for (const el of styledEls) {
      try {
        const bg = el.style.backgroundImage || window.getComputedStyle(el).backgroundImage;
        if (bg && (bg.includes(srcUrl) || bg.includes(parsedSrcUrl))) {
          results.push(el);
          break;
        }
      } catch {}
    }
  }

  return results;
}

/**
 * ตัดแบ่งภาพขนาดยาวพิเศษ (Webtoon) ในแนวตั้งเป็นชิ้นย่อยซ้อนทับกันโดยใช้ off-screen HTMLCanvasElement
 *
 * @param {HTMLImageElement|HTMLCanvasElement|string} source - รูปภาพ DOM หรือ dataUrl
 * @param {Object} options
 * @param {number} options.chunkHeight - ความสูงของแต่ละ chunk (ค่าเริ่มต้น 2000px)
 * @param {number} options.overlap - ระยะซ้อนทับเพื่อป้องกันข้อความถูกตัดขาด (ค่าเริ่มต้น 150px)
 * @param {number} options.threshold - ความสูงขั้นต่ำที่เริ่มตัดแบ่ง (ค่าเริ่มต้น 2500px)
 * @returns {Promise<{ chunks: Array, fullWidth: number, fullHeight: number, isSliced: boolean }>}
 */
async function sliceImageVertically(source, options = {}) {
  const chunkHeight = options.chunkHeight || 2000;
  const overlap = options.overlap || 150;
  const threshold = options.threshold || 2500;

  let imgEl = source;
  if (typeof source === "string") {
    imgEl = await new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(new Error("ไม่สามารถโหลดภาพสำหรับตัดแบ่งชิ้นส่วนได้"));
      img.src = source;
    });
  }

  const fullW = imgEl.naturalWidth || imgEl.width || 0;
  const fullH = imgEl.naturalHeight || imgEl.height || 0;

  if (fullH <= threshold) {
    return {
      chunks: [],
      fullWidth: fullW,
      fullHeight: fullH,
      isSliced: false
    };
  }

  const step = Math.max(100, chunkHeight - overlap);
  const chunks = [];
  let startY = 0;
  let index = 0;

  while (startY < fullH) {
    const endY = Math.min(fullH, startY + chunkHeight);
    const chunkH = endY - startY;

    // สร้าง Off-screen HTMLCanvasElement
    const canvas = document.createElement("canvas");
    canvas.width = fullW;
    canvas.height = chunkH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("ไม่สามารถสร้าง 2D Canvas context สำหรับตัดแบ่งภาพได้");
    }

    ctx.drawImage(imgEl, 0, startY, fullW, chunkH, 0, 0, fullW, chunkH);
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");

    chunks.push({
      index,
      startY,
      endY,
      chunkH,
      fullH,
      fullW,
      dataUrl,
      base64,
      mimeType: "image/png"
    });

    if (endY >= fullH) break;
    startY += step;
    index++;
  }

  return {
    chunks,
    fullWidth: fullW,
    fullHeight: fullH,
    isSliced: true
  };
}

/**
 * ปรับค่าพิกัด box_2d [ymin, xmin, ymax, xmax] ของชิ้นส่วนย่อย (chunk)
 * ให้กลับมาตรงกับสัดส่วน 0-1000 ของภาพเต็มขนาดจริง
 */
function adjustChunkBoxToFullImage(segments, startY, chunkH, fullH) {
  if (!Array.isArray(segments) || fullH <= 0 || chunkH <= 0) return segments || [];

  return segments.map((seg) => {
    if (!seg || !Array.isArray(seg.box_2d) || seg.box_2d.length < 4) {
      return seg;
    }
    const [yminChunk, xminChunk, ymaxChunk, xmaxChunk] = seg.box_2d;

    const pixelYmin = startY + (yminChunk / 1000) * chunkH;
    const pixelYmax = startY + (ymaxChunk / 1000) * chunkH;

    const yminFull = Math.max(0, Math.min(1000, Math.round((pixelYmin / fullH) * 1000)));
    const ymaxFull = Math.max(0, Math.min(1000, Math.round((pixelYmax / fullH) * 1000)));

    const xminFull = Math.max(0, Math.min(1000, Math.round(Number(xminChunk) || 0)));
    const xmaxFull = Math.max(0, Math.min(1000, Math.round(Number(xmaxChunk) || 0)));

    return {
      ...seg,
      box_2d: [yminFull, xminFull, ymaxFull, xmaxFull]
    };
  });
}

/**
 * รวมและคัดกรอง Segment ที่ซ้ำซ้อนกันในบริเวณรอยต่อซ้อนทับ (Overlap)
 */
function deduplicateOverlapSegments(segments) {
  if (!Array.isArray(segments) || segments.length <= 1) return segments || [];

  const kept = [];

  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.box_2d) || seg.box_2d.length < 4) {
      kept.push(seg);
      continue;
    }

    const [ymin1, xmin1, ymax1, xmax1] = seg.box_2d;
    const area1 = Math.max(0, ymax1 - ymin1) * Math.max(0, xmax1 - xmin1);
    const text1 = (seg.text || "").trim().toLowerCase();

    let isDuplicate = false;

    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i];
      if (!existing || !Array.isArray(existing.box_2d) || existing.box_2d.length < 4) continue;

      const [ymin2, xmin2, ymax2, xmax2] = existing.box_2d;
      const area2 = Math.max(0, ymax2 - ymin2) * Math.max(0, xmax2 - xmin2);

      const intYmin = Math.max(ymin1, ymin2);
      const intYmax = Math.min(ymax1, ymax2);
      const intXmin = Math.max(xmin1, xmin2);
      const intXmax = Math.min(xmax1, xmax2);

      if (intYmax > intYmin && intXmax > intXmin) {
        const intArea = (intYmax - intYmin) * (intXmax - intXmin);
        const minArea = Math.min(area1, area2);
        const overlapRatio = minArea > 0 ? intArea / minArea : 0;
        const unionArea = area1 + area2 - intArea;
        const iou = unionArea > 0 ? intArea / unionArea : 0;

        const text2 = (existing.text || "").trim().toLowerCase();
        const textMatch = Boolean(text1 && text2 && (text1 === text2 || text1.includes(text2) || text2.includes(text1)));

        if (overlapRatio > 0.8 || (overlapRatio > 0.5 && textMatch) || (iou > 0.35 && textMatch)) {
          isDuplicate = true;
          if ((seg.translated_text || "").length > (existing.translated_text || "").length) {
            kept[i] = seg;
          }
          break;
        }
      }
    }

    if (!isDuplicate) {
      kept.push(seg);
    }
  }

  return kept;
}

async function proxyFetchImage(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "PROXY_FETCH_IMAGE", url }, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!response || !response.success) {
        return reject(new Error(response?.error || "ไม่สามารถดึงรูปผ่าน background service worker ได้"));
      }
      resolve(response.dataUrl || `data:${response.mimeType || "image/png"};base64,${response.base64}`);
    });
  });
}

/**
 * เรนเดอร์ภาพแปลและแทนที่บนหน้าเว็บ
 * ครอบคลุม: Standard <img>, Responsive srcset, <picture>, Lazy Load, CSS background-image, Strict CSP
 */
async function renderTranslatedImage(el, segments, initialDataUrl = null, targetLang = "Thai", textBgMode = null) {
  const isImage = el instanceof HTMLImageElement;
  let dataUrl = initialDataUrl;

  if (!dataUrl) {
    let sourceUrl = "";
    if (isImage) {
      sourceUrl =
        el.currentSrc ||
        el.src ||
        el.getAttribute("data-src") ||
        el.getAttribute("data-original") ||
        el.getAttribute("data-lazy-src");
    } else {
      const bg = window.getComputedStyle(el).backgroundImage;
      const m = bg.match(/url\(['"]?(.*?)['"]?\)/);
      if (m && m[1]) sourceUrl = m[1];
    }
    dataUrl = await proxyFetchImage(sourceUrl);
  }

  // 1. โหลดฟอนต์ที่รองรับภาษาปลายทาง
  await ensureFontsLoaded();

  // 2. โหลดภาพเข้า Canvas
  const source = new Image();
  await new Promise((resolve, reject) => {
    source.onload = resolve;
    source.onerror = () => reject(new Error("โหลดรูปเข้า canvas ไม่สำเร็จ"));
    source.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0);

  // 3. สุ่มตัวอย่างสีพื้นหลังรอบกล่องข้อความจากภาพต้นฉบับ เพื่อให้โหมด solid เลือกสีที่ถูกต้องตามมังงะ
  const finalMode = textBgMode || await getStoredTextBackgroundMode();
  let enrichedSegments = segments || [];

  if (source.naturalWidth > 0 && source.naturalHeight > 0 && Array.isArray(segments)) {
    enrichedSegments = segments.map((seg) => {
      if (!seg || !Array.isArray(seg.box_2d) || seg.box_2d.length < 4) return seg;
      let [ymin, xmin, ymax, xmax] = seg.box_2d.map(Number);
      const sx = Math.max(0, (xmin / 1000) * canvas.width);
      const sy = Math.max(0, (ymin / 1000) * canvas.height);
      const sw = Math.min(canvas.width - sx, ((xmax - xmin) / 1000) * canvas.width);
      const sh = Math.min(canvas.height - sy, ((ymax - ymin) / 1000) * canvas.height);
      const bg = sampleDominantBackgroundColor(ctx, sx, sy, sw, sh, canvas.width, canvas.height);
      return { ...seg, bg };
    });
  }

  // 4. เรนเดอร์ Image-Relative DOM Text Overlay ซ้อนทับบน Element ภาพโดยตรง
  // ตรึงพิกัดด้วย Relative Percentages (top: ymin/10%, left: xmin/10%, width: (xmax-xmin)/10%, minHeight: (ymax-ymin)/10%)
  // ไม่ใช้ absolute document coordinates เพื่อป้องกันปัญหาฟองคำพูดเลื่อนคลาดเคลื่อนเวลา scroll หรือ lazy-load
  if (el.parentNode && enrichedSegments.length > 0) {
    renderImageRelativeOverlay(el, enrichedSegments, {
      textBackgroundMode: finalMode,
      targetLang
    });
  } else if (!el.parentNode && enrichedSegments.length > 0) {
    // กรณีที่ Element ไม่ได้อยู่ใน DOM Tree (เช่น รันใน Unit Test หรือ Off-screen) ให้เรนเดอร์ลง Canvas
    renderSegmentsOnCanvas(canvas, ctx, enrichedSegments, targetLang, finalMode);
    try {
      el.src = canvas.toDataURL("image/png");
    } catch {}
  }

  el.setAttribute("data-git-translated", "true");
  el.style.opacity = "1";
}

/**
 * สลับแท็ก <img> ด้วยแท็ก <canvas> ที่วาดในหน่วยความจำโดยตรง
 * เพื่อบายพาสกฎ Content-Security-Policy (CSP) แบบ img-src 'self' อย่างสมบูรณ์
 */
function applyCanvasSwap(img, sourceCanvas) {
  // หากเคย swap ไปแล้ว ให้อัปเดตเนื้อหาของ canvas เดิมแทน
  if (img.dataset.gitCanvasSwapped) {
    const nextEl = img.nextElementSibling;
    if (nextEl && nextEl.tagName.toLowerCase() === "canvas" && nextEl.getAttribute("data-git-translated") === "true") {
      nextEl.width = sourceCanvas.width;
      nextEl.height = sourceCanvas.height;
      const nextCtx = nextEl.getContext("2d");
      nextCtx.drawImage(sourceCanvas, 0, 0);
      return;
    }
  }

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = sourceCanvas.width;
  overlayCanvas.height = sourceCanvas.height;
  const ctx = overlayCanvas.getContext("2d");
  ctx.drawImage(sourceCanvas, 0, 0);

  const comp = window.getComputedStyle(img);
  overlayCanvas.style.cssText = `
    display: ${comp.display === "inline" ? "inline-block" : comp.display};
    width: ${img.clientWidth ? img.clientWidth + "px" : comp.width};
    height: ${img.clientHeight ? img.clientHeight + "px" : comp.height};
    max-width: 100%;
    border-radius: ${comp.borderRadius};
    box-shadow: ${comp.boxShadow};
    margin: ${comp.margin};
    vertical-align: ${comp.verticalAlign};
  `;
  overlayCanvas.className = img.className;
  overlayCanvas.setAttribute("data-git-translated", "true");

  img.style.display = "none";
  img.dataset.gitCanvasSwapped = "true";

  if (img.parentNode) {
    img.parentNode.insertBefore(overlayCanvas, img.nextSibling);
  }
}

/**
 * แสดงข้อความแจ้งเตือน Toast สวยงาม ไม่รบกวนหน้าเว็บ แทน alert()
 */
function showToastNotification(message, isError = false) {
  let toastContainer = document.getElementById("git-toast-container");
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.id = "git-toast-container";
    toastContainer.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
      font-family: system-ui, sans-serif;
    `;
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement("div");
  toast.style.cssText = `
    background: ${isError ? "#d93025" : "#202124"};
    color: #ffffff;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.25);
    max-width: 340px;
    line-height: 1.4;
    pointer-events: auto;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.25s, transform 0.25s;
  `;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/**
 * คัดลอกภาพ (Base64 หรือ Data URL) เข้าสู่ System Clipboard (PNG format)
 */
async function copyImageDataToClipboard(dataUrl) {
  try {
    if (!dataUrl) return false;
    let blob;
    const res = await fetch(dataUrl);
    blob = await res.blob();

    // ถ้าไม่ใช่ image/png ให้แปลงเป็น png ด้วย canvas ก่อนเสมอ
    if (blob.type !== "image/png") {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      blob = await new Promise((r) => c.toBlob(r, "image/png"));
    }

    const item = new ClipboardItem({ "image/png": blob });
    await navigator.clipboard.write([item]);
    return true;
  } catch (err) {
    console.warn("[Gemini Image Translator] คัดลอกภาพลง Clipboard ไม่สำเร็จ:", err);
    return false;
  }
}

/**
 * แสดง Toast พิเศษเมื่อเกิดเหตุการณ์ Token / โควต้า Gemini หมด
 * พร้อมปุ่ม Action Bar สำหรับสลับไปแปลด้วย Google Translate หรือคัดลอกภาพ
 */
function showQuotaExceededToast({ message, dataUrl, srcUrl, targetLangCode = "th" }) {
  let toastContainer = document.getElementById("git-toast-container");
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.id = "git-toast-container";
    toastContainer.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    document.body.appendChild(toastContainer);
  }

  // ป้องกัน XSS โดย escape HTML entities ก่อนใช้ใน innerHTML
  const escapeHtml = (str) => {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  const safeMessage = escapeHtml(message) || "โควต้าการใช้งาน Gemini API เต็มแล้ว (HTTP 429 Rate Limit) สามารถสลับไปใช้ Google Translate Images ได้ทันที";

  const toast = document.createElement("div");
  toast.style.cssText = `
    background: #202124;
    color: #ffffff;
    padding: 14px 16px;
    border-radius: 10px;
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    max-width: 360px;
    line-height: 1.45;
    pointer-events: auto;
    border-left: 4px solid #fbbc04;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.25s, transform 0.25s;
    box-sizing: border-box;
  `;

  toast.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
      <div style="font-weight: 600; color: #fbbc04; font-size: 13px; display: flex; align-items: center; gap: 6px;">
        <span>⚠️</span>
        <span>โควต้า Gemini หมดแล้ว</span>
      </div>
      <button class="git-close-toast" style="background: none; border: none; color: #9aa0a6; cursor: pointer; font-size: 18px; padding: 0; line-height: 1;">&times;</button>
    </div>
    <div style="margin-top: 6px; font-size: 12px; color: #dadce0;">
      ${safeMessage}
    </div>
    <div style="display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;">
      <button class="git-gt-fallback-btn" style="
        background: #1a73e8;
        color: #fff;
        border: none;
        border-radius: 4px;
        padding: 7px 12px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
      ">🌐 แปลด้วย Google Translate</button>
      <button class="git-copy-img-btn" style="
        background: rgba(255,255,255,0.12);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.22);
        border-radius: 4px;
        padding: 7px 10px;
        font-size: 12px;
        cursor: pointer;
      ">📋 คัดลอกภาพ</button>
    </div>
    <div style="margin-top: 8px; font-size: 11px; color: #9aa0a6;">
      💡 ระบบจะคัดลอกรูปภาพลงคลิปบอร์ดแล้วเปิด Google Translate เพื่อให้คุณกด <b style="color:#fff;">Ctrl+V</b> แปลได้ทันที
    </div>
  `;

  const closeBtn = toast.querySelector(".git-close-toast");
  closeBtn.onclick = () => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 250);
  };

  const gtBtn = toast.querySelector(".git-gt-fallback-btn");
  gtBtn.onclick = async () => {
    gtBtn.disabled = true;
    gtBtn.textContent = "⏳ กำลังเตรียมภาพ...";
    let imgData = dataUrl;
    if (!imgData && srcUrl) {
      try {
        imgData = await proxyFetchImage(srcUrl);
      } catch {}
    }
    const targets = findImages(srcUrl);
    if (targets.length > 0 && imgData) {
      toast.remove();
      targets.forEach((el) => (el.style.opacity = "0.5"));
      showToastNotification("🌐 กำลังแปลภาพด้วย Google Translate บนหน้าเว็บ...", false);
      const base64 = imgData.replace(/^data:image\/\w+;base64,/, "");
      chrome.runtime.sendMessage(
        { type: "TRANSLATE_IMAGE_DATA", base64, mimeType: "image/png", provider: "google" },
        (res) => {
          if (res && res.success && res.segments?.length > 0) {
            targets.forEach((el) => {
              renderTranslatedImage(el, res.segments, imgData, res.targetLang || "Thai").catch(() => {
                el.style.opacity = "1";
              });
            });
          } else {
            targets.forEach((el) => (el.style.opacity = "1"));
            showToastNotification("แปลภาพไม่สำเร็จ: " + (res?.error || "ไม่พบข้อความ"), true);
          }
        }
      );
    } else {
      if (imgData) {
        await copyImageDataToClipboard(imgData);
      }
      chrome.runtime.sendMessage({
        type: "OPEN_GOOGLE_TRANSLATE_TAB",
        targetLangCode
      });
      showToastNotification("📋 คัดลอกภาพแล้ว! กด Ctrl+V ในหน้าต่าง Google Translate เพื่อแปลทันที 🚀");
      toast.remove();
    }
  };

  const copyBtn = toast.querySelector(".git-copy-img-btn");
  copyBtn.onclick = async () => {
    let imgData = dataUrl;
    if (!imgData && srcUrl) {
      try {
        imgData = await proxyFetchImage(srcUrl);
      } catch {}
    }
    if (imgData) {
      const ok = await copyImageDataToClipboard(imgData);
      if (ok) {
        showToastNotification("📋 คัดลอกภาพลงคลิปบอร์ดเรียบร้อยแล้ว");
      } else {
        showToastNotification("ไม่สามารถคัดลอกภาพได้", true);
      }
    }
  };

  toastContainer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  // แสดงทิ้งไว้ 18 วินาที เพื่อให้ผู้ใช้มีเวลากด
  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      setTimeout(() => toast.remove(), 300);
    }
  }, 18000);
}

/**
 * สุ่มตัวอย่างสีรอบๆ ขอบของกล่องข้อความ และหาค่าสีหลัก (Dominant Background Color)
 * เพื่อให้กล่องสีที่วาดทับกลืนกับภาพต้นฉบับอย่างเป็นธรรมชาติ
 */
function sampleDominantBackgroundColor(ctx, x, y, w, h, canvasWidth, canvasHeight) {
  const padding = Math.max(2, Math.min(8, Math.round(Math.min(w, h) * 0.1)));
  const minX = Math.max(0, Math.floor(x - padding));
  const minY = Math.max(0, Math.floor(y - padding));
  const maxX = Math.min(canvasWidth, Math.ceil(x + w + padding));
  const maxY = Math.min(canvasHeight, Math.ceil(y + h + padding));
  const sw = maxX - minX;
  const sh = maxY - minY;

  if (sw <= 0 || sh <= 0) {
    return { r: 255, g: 255, b: 255, css: "#ffffff", isDark: false };
  }

  const imgData = ctx.getImageData(minX, minY, sw, sh);
  const data = imgData.data;

  const buckets = new Map();
  const innerX1 = Math.floor(x) - minX;
  const innerY1 = Math.floor(y) - minY;
  const innerX2 = Math.ceil(x + w) - minX;
  const innerY2 = Math.ceil(y + h) - minY;

  // สุ่มตัวอย่างพิกเซลตามขอบนอก (Perimeter) รอบกล่องข้อความ
  // เพื่อหลีกเลี่ยงพิกเซลของตัวหนังสือที่อยู่ด้านในกล่อง
  for (let py = 0; py < sh; py++) {
    for (let px = 0; px < sw; px++) {
      const isOuterPerimeter = px < innerX1 || px >= innerX2 || py < innerY1 || py >= innerY2;
      const isInnerBorder = (px >= innerX1 && px <= innerX1 + 1) || (px >= innerX2 - 2 && px < innerX2) ||
                            (py >= innerY1 && py <= innerY1 + 1) || (py >= innerY2 - 2 && py < innerY2);

      if (isOuterPerimeter || isInnerBorder) {
        const idx = (py * sw + px) * 4;
        const a = data[idx + 3];
        if (a < 128) continue; // ข้ามพิกเซลโปร่งใส

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // จัดกลุ่มสี (Color Quantization) โดยปัดเศษขั้นละ 16 เพื่อรวมเฉดสีที่ใกล้เคียงกัน
        const qr = Math.round(r / 16) * 16;
        const qg = Math.round(g / 16) * 16;
        const qb = Math.round(b / 16) * 16;
        const key = `${qr},${qg},${qb}`;

        if (!buckets.has(key)) {
          buckets.set(key, { count: 0, rSum: 0, gSum: 0, bSum: 0 });
        }
        const bucket = buckets.get(key);
        bucket.count++;
        bucket.rSum += r;
        bucket.gSum += g;
        bucket.bSum += b;
      }
    }
  }

  if (buckets.size === 0) {
    return { r: 255, g: 255, b: 255, css: "#ffffff", isDark: false };
  }

  // หา bucket ที่มีจำนวนพิกเซลมากที่สุด (Dominant Color)
  let maxBucket = null;
  for (const bucket of buckets.values()) {
    if (!maxBucket || bucket.count > maxBucket.count) {
      maxBucket = bucket;
    }
  }

  const avgR = Math.round(maxBucket.rSum / maxBucket.count);
  const avgG = Math.round(maxBucket.gSum / maxBucket.count);
  const avgB = Math.round(maxBucket.bSum / maxBucket.count);

  // คำนวณ Perceived Luminance เพื่อเลือกสีข้อความ (ขาวหรือดำ) ให้อ่านง่าย
  const luminance = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB;
  const isDark = luminance < 128;

  return {
    r: avgR,
    g: avgG,
    b: avgB,
    css: `rgb(${avgR}, ${avgG}, ${avgB})`,
    isDark
  };
}

/**
 * ตัดคำตามภาษาปลายทาง โดยใช้ Intl.Segmenter สำหรับภาษาไทย/ญี่ปุ่น/จีน/สากล
 */
function getWordSegments(text, lang = "Thai") {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    try {
      const langMap = {
        thai: "th",
        th: "th",
        japanese: "ja",
        ja: "ja",
        chinese: "zh",
        zh: "zh",
        korean: "ko",
        ko: "ko",
        english: "en",
        en: "en"
      };
      const locale = langMap[String(lang).toLowerCase()] || "th";
      const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
      return Array.from(segmenter.segment(text), (s) => s.segment);
    } catch (e) {
      console.warn("[Gemini Image Translator] Intl.Segmenter fallback:", e);
    }
  }

  // Fallback สำหรับภาษาที่ไม่มีเว้นวรรค
  const isCjkOrThai = /[\u0E00-\u0E7F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]/.test(text);
  if (isCjkOrThai && !text.includes(" ")) {
    return Array.from(text);
  }
  return text.split(/(\s+)/);
}

/**
 * ตัดคำขึ้นบรรทัดใหม่ (Word-Wrap) ให้พอดีกับความกว้าง maxWidth
 */
function wrapTextIntoLines(ctx, text, maxWidth, lang) {
  if (!text) return [];
  const segments = getWordSegments(text, lang);
  const lines = [];
  let currentLine = "";

  const pushSplitChars = (word) => {
    let subPart = "";
    for (const char of word) {
      if (ctx.measureText(subPart + char).width <= maxWidth || subPart === "") {
        subPart += char;
      } else {
        lines.push(subPart);
        subPart = char;
      }
    }
    return subPart;
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.includes("\n")) {
      const parts = seg.split("\n");
      for (let p = 0; p < parts.length; p++) {
        if (p > 0) {
          if (currentLine) lines.push(currentLine);
          currentLine = "";
        }
        if (parts[p]) {
          const testLine = currentLine + parts[p];
          if (ctx.measureText(testLine).width <= maxWidth) {
            currentLine = testLine;
          } else {
            if (currentLine) lines.push(currentLine);
            if (ctx.measureText(parts[p]).width > maxWidth) {
              currentLine = pushSplitChars(parts[p]);
            } else {
              currentLine = parts[p];
            }
          }
        }
      }
      continue;
    }

    const testLine = currentLine + seg;
    const testWidth = ctx.measureText(testLine).width;

    if (testWidth <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine.trimEnd());
      }
      if (ctx.measureText(seg).width > maxWidth) {
        currentLine = pushSplitChars(seg);
      } else {
        currentLine = seg.trimStart();
      }
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trimEnd());
  }

  return lines.length > 0 ? lines : [text];
}

/**
 * คำนวณขนาดตัวหนังสือ (Font Size) ที่เหมาะสมที่สุด เพื่อให้ข้อความตัดคำแล้วพอดีกรอบ
 * โดยไม่ลดขนาดตัวหนังสือจนเล็กเกินไป
 */
function calculateOptimalLayout(ctx, text, usableW, usableH, lang) {
  if (!text) return { fontSize: 12, lines: [], lineHeight: 14, totalHeight: 0 };
  const maxFontSize = Math.max(12, Math.min(Math.floor(usableH * 0.8), Math.floor(usableW * 0.45), 44));
  const minFontSize = Math.max(9, Math.min(13, Math.floor(usableH * 0.25)));

  let bestLayout = null;

  // ค้นหาขนาดฟอนต์ที่ใหญ่ที่สุดที่ตัดคำแล้วความสูงรวมไม่เกินความสูงกล่อง โดยใช้ line-height แนบสนิท 1.15
  for (let size = maxFontSize; size >= minFontSize; size--) {
    ctx.font = `600 ${size}px ${FONT_FAMILY}`;
    const lineHeight = Math.round(size * 1.15);
    const lines = wrapTextIntoLines(ctx, text, usableW, lang);
    const totalHeight = lines.length * lineHeight;

    if (totalHeight <= usableH) {
      bestLayout = { fontSize: size, lines, lineHeight, totalHeight };
      break;
    }
  }

  // หากแม้ขนาดเล็กสุดแล้วความสูงยังเกินเล็กน้อย ให้ใช้ minFontSize พร้อม lines ที่ตัดแล้ว
  if (!bestLayout) {
    ctx.font = `600 ${minFontSize}px ${FONT_FAMILY}`;
    const lineHeight = Math.round(minFontSize * 1.15);
    const lines = wrapTextIntoLines(ctx, text, usableW, lang);
    bestLayout = {
      fontSize: minFontSize,
      lines,
      lineHeight,
      totalHeight: lines.length * lineHeight
    };
  }

  return bestLayout;
}

/**
 * วาดกล่องข้อความแปลแบบกระชับแนบสนิท (Snug Fit-to-Content Layout)
 * รองรับ 3 โหมดสไตล์พื้นหลัง:
 * - "blur": Frosted glass / backdrop blur effect ฝ้าขาวโปร่งแสง
 * - "solid": กล่องทึบกระชับตามขนาดตัวหนังสือ (padding 1-3px)
 * - "transparent": โปร่งใส 100% พร้อมขอบขาวหนา 1.5px และเงาสีขาว
 */
function drawSegment(ctx, seg, lang = "Thai", textBgMode = "blur") {
  const { x, y, w, h, bg } = seg;
  const textToDraw = String(seg.translated_text || seg.text || "").trim();
  if (!textToDraw) return;

  const mode = (textBgMode === "transparent" || textBgMode === "solid" || textBgMode === "blur")
    ? textBgMode
    : "blur";

  // กำหนด padding เล็กน้อย (padding: 1px 3px) เพื่อความกระชับแนบสนิท
  const padX = 3;
  const padY = 1;
  const usableW = Math.max(10, w - padX * 2);
  const usableH = Math.max(10, h - padY * 2);

  // คำนวณขนาดฟอนต์และการตัดคำที่พอดีกับกรอบ (line-height: 1.15)
  const layout = calculateOptimalLayout(ctx, textToDraw, usableW, usableH, lang);
  if (!layout || !layout.lines || layout.lines.length === 0) return;

  // คำนวณความกว้างสูงสุดของบรรทัดจริง เพื่อให้พื้นหลังแนบชิดตัวหนังสือ (Snug fit-to-content)
  ctx.font = `600 ${layout.fontSize}px ${FONT_FAMILY}`;
  let maxLineWidth = 0;
  for (const line of layout.lines) {
    const lw = ctx.measureText(line).width;
    if (lw > maxLineWidth) maxLineWidth = lw;
  }
  const snugW = Math.min(w, maxLineWidth + padX * 2);
  const snugH = Math.min(h, layout.totalHeight + padY * 2);
  const snugX = x + (w - snugW) / 2;
  const snugY = y + (h - snugH) / 2;

  if (mode === "solid") {
    // วาดพื้นหลังทึบแบบกระชับ (Snug fit) ไม่เต็มกล่องเทอะทะ (padding 1-3px)
    ctx.save();
    ctx.fillStyle = bg?.css || "#ffffff";
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(snugX, snugY, snugW, snugH, 3);
    } else {
      ctx.rect(snugX, snugY, snugW, snugH);
    }
    ctx.fill();
    ctx.restore();
  } else if (mode === "blur") {
    // โหมด Blur บน Canvas (วาดฝ้าขาวโปร่งแสงระเรื่อ เพื่อจำลอง frosted glass snug box)
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(snugX, snugY, snugW, snugH, 4);
    } else {
      ctx.rect(snugX, snugY, snugW, snugH);
    }
    ctx.fill();
    ctx.restore();
  }

  // กำหนดรูปแบบตัวหนังสือและการจัดกึ่งกลาง
  ctx.font = `600 ${layout.fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // พิกัดจัดกึ่งกลางแนวนอนและแนวตั้ง
  const centerX = x + w / 2;
  const startY = y + (h - layout.totalHeight) / 2 + layout.lineHeight / 2;

  // วาดข้อความแต่ละบรรทัด
  for (let i = 0; i < layout.lines.length; i++) {
    const lineY = startY + i * layout.lineHeight;
    const line = layout.lines[i];

    if (mode === "transparent") {
      // โหมด Transparent: เส้นขอบตัวหนังสือสีขาวหนา 1.5px พร้อมเงาสีขาวนุ่มเพื่อให้อ่านง่าย
      ctx.save();
      ctx.lineWidth = Math.max(2, Math.round(layout.fontSize * 0.16));
      ctx.strokeStyle = "#ffffff";
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.shadowColor = "rgba(255, 255, 255, 0.85)";
      ctx.shadowBlur = 4;
      ctx.strokeText(line, centerX, lineY);
      ctx.restore();

      ctx.fillStyle = "#000000";
      ctx.fillText(line, centerX, lineY);
    } else if (mode === "blur") {
      // โหมด Blur: เส้นขอบสีขาวบางเพื่อให้อ่านง่ายคมชัดบนภาพที่เบลอ
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.strokeText(line, centerX, lineY);
      ctx.restore();

      ctx.fillStyle = "#000000";
      ctx.fillText(line, centerX, lineY);
    } else {
      // โหมด Solid
      ctx.fillStyle = (!bg?.isDark) ? "#000000" : "#ffffff";
      ctx.fillText(line, centerX, lineY);
    }
  }
}

/**
 * วาดกล่องข้อความและคำแปลทั้งหมดลงบน Canvas
 * รวมการตรวจสอบพิกัด, สุ่มตัวอย่างสีพื้นหลัง และการจัดวางข้อความแบบอัจฉริยะ (ใช้ร่วมกันทั้งภาพปกติและภาพครอป)
 */
function renderSegmentsOnCanvas(canvas, ctx, segments, targetLang = "Thai", textBgMode = "blur") {
  if (!segments || !Array.isArray(segments) || segments.length === 0) return;

  const validSegments = [];
  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.box_2d) || seg.box_2d.length < 4) continue;
    let [ymin, xmin, ymax, xmax] = seg.box_2d.map(Number);
    if (isNaN(ymin) || isNaN(xmin) || isNaN(ymax) || isNaN(xmax)) continue;

    if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
    if (xmin > xmax) [xmin, xmax] = [xmax, xmin];

    const x = Math.max(0, (xmin / 1000) * canvas.width);
    const y = Math.max(0, (ymin / 1000) * canvas.height);
    const w = Math.min(canvas.width - x, ((xmax - xmin) / 1000) * canvas.width);
    const h = Math.min(canvas.height - y, ((ymax - ymin) / 1000) * canvas.height);

    if (w <= 2 || h <= 2) continue;

    const bg = sampleDominantBackgroundColor(ctx, x, y, w, h, canvas.width, canvas.height);
    validSegments.push({ ...seg, x, y, w, h, bg });
  }

  for (const seg of validSegments) {
    drawSegment(ctx, seg, targetLang, textBgMode);
  }
}

/**
 * เรนเดอร์กล่องข้อความแปลเป็น DOM Elements ซ้อนทับบนภาพ/Overlay (DOM Text Overlay)
 * ใช้รูปแบบกระชับแนบสนิท (Snug Fit-to-Content Layout):
 * - display: inline-block, width: fit-content
 * - padding: 1px 3px, line-height: 1.15
 * - จัดกึ่งกลางเนื้อหาภายในพิกัด box_2d ด้วย Flexbox
 * รองรับ 3 โหมดสไตล์พื้นหลัง (textBackgroundMode):
 * 1. "blur": Frosted glass / backdrop blur effect (backdrop-filter: blur(10px), rgba(255,255,255,0.35))
/**
 * ล้างเลเยอร์ DOM Overlay เดิมทั้งหมดบน container หรือ document
 * ป้องกันการเกิดเลเยอร์ซ้อนทับกันหลายชั้น (Double Overlay / Stacked Layers)
 */
function clearExistingOverlays(parent = document) {
  if (!parent) return;
  try {
    const selector = ".git-dom-text-overlay-layer";
    const layers = parent.querySelectorAll ? parent.querySelectorAll(selector) : [];
    layers.forEach((el) => {
      try { el.remove(); } catch {}
    });
  } catch (e) {
    console.warn("[Gemini Image Translator] clearExistingOverlays error:", e);
  }
}

/**
 * เรนเดอร์กล่องข้อความแปลเป็น DOM Elements ซ้อนทับบนภาพ/Overlay (DOM Text Overlay)
 * ใช้รูปแบบกระชับแนบสนิท (Snug Fit-to-Content Layout):
 * - display: inline-block, width: fit-content
 * - padding: 1px 3px, line-height: 1.15
 * - จัดกึ่งกลางเนื้อหาภายในพิกัด box_2d ด้วย Flexbox
 * รองรับ 3 โหมดสไตล์พื้นหลัง (textBackgroundMode):
 * 1. "blur": Frosted glass / backdrop blur effect (backdrop-filter: blur(10px), rgba(255,255,255,0.35))
 * 2. "solid": Snug fit-to-content background box with minimal padding (1-3px)
 * 3. "transparent": 100% transparent background with white stroke (-webkit-text-stroke: 1.5px #fff) & text-shadow
 */
function renderDomTextOverlay(parentContainer, segments, options = {}) {
  if (!parentContainer || !segments || !Array.isArray(segments) || segments.length === 0) return null;

  const width = options.width || parentContainer.clientWidth || 800;
  const height = options.height || parentContainer.clientHeight || 600;
  const rawMode = options.textBackgroundMode || options.textBgMode || "blur";
  const mode = (rawMode === "transparent" || rawMode === "solid" || rawMode === "blur") ? rawMode : "blur";

  // ล้าง Overlay เก่าออกก่อนเสมอ เพื่อป้องกันการซ้อนทับกันหลายชั้น
  clearExistingOverlays(parentContainer);

  // ตรวจสอบและแทรก/อัปเดต CSS Classes สำหรับ DOM Overlay
  let style = document.getElementById("git-text-overlay-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "git-text-overlay-style";
    document.head.appendChild(style);
  }
  style.textContent = `
    .git-dom-text-overlay-layer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 10000;
      overflow: hidden;
    }
    .git-text-box {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      pointer-events: none;
      overflow: visible;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      padding: 0 !important;
      margin: 0 !important;
    }
    .git-text-content {
      display: inline-block;
      width: fit-content;
      max-width: 100%;
      box-sizing: border-box;
      padding: 1px 3px;
      line-height: 1.15;
      text-align: center;
      word-break: break-word;
      overflow-wrap: break-word;
      pointer-events: auto;
      user-select: text;
    }
    /* Mode 1: Frosted glass / backdrop blur */
    .git-text-content.git-text-mode-blur {
      background: rgba(255, 255, 255, 0.35) !important;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      color: #000000 !important;
      border-radius: 4px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
      -webkit-text-stroke: 0.5px rgba(255, 255, 255, 0.8);
      paint-order: stroke fill;
      text-shadow: 0 0 2px rgba(255, 255, 255, 0.9);
    }
    /* Mode 2: Solid snug fit background box with minimal padding (1-3px) */
    .git-text-content.git-text-mode-solid {
      border-radius: 3px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    }
    /* Mode 3: 100% Transparent with white text stroke & text-shadow */
    .git-text-content.git-text-mode-transparent,
    .git-text-content.git-text-transparent {
      background: transparent !important;
      color: #000000 !important;
      -webkit-text-stroke: 1.5px #ffffff;
      paint-order: stroke fill;
      text-shadow: 0 0 4px #ffffff, 0 0 8px rgba(255, 255, 255, 0.85);
    }
  `;

  const layer = document.createElement("div");
  layer.className = "git-dom-text-overlay-layer";

  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.box_2d) || seg.box_2d.length < 4) continue;
    let [ymin, xmin, ymax, xmax] = seg.box_2d.map(Number);
    if (isNaN(ymin) || isNaN(xmin) || isNaN(ymax) || isNaN(xmax)) continue;
    if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
    if (xmin > xmax) [xmin, xmax] = [xmax, xmin];

    const textToDraw = String(seg.translated_text || seg.text || "").trim();
    if (!textToDraw) continue;

    const topPct = (ymin / 10) + "%";
    const leftPct = (xmin / 10) + "%";
    const widthPct = ((xmax - xmin) / 10) + "%";
    const minHeightPct = ((ymax - ymin) / 10) + "%";

    const boxW = ((xmax - xmin) / 1000) * width;
    const boxH = ((ymax - ymin) / 1000) * height;

    // คำนวณขนาดฟอนต์ให้พอดีกรอบอย่างสมดุล
    const maxS = Math.max(12, Math.min(Math.floor(boxH * 0.7), Math.floor(boxW * 0.45), 36));
    const minS = Math.max(9, Math.min(13, Math.floor(boxH * 0.25)));
    let fontSize = minS;
    for (let s = maxS; s >= minS; s--) {
      const charsPerLine = Math.max(2, Math.floor(boxW / (s * 0.82)));
      const linesCount = Math.ceil(textToDraw.length / charsPerLine);
      if (linesCount * (s * 1.15) <= boxH) {
        fontSize = s;
        break;
      }
    }

    // 1. กล่องพิกัด box_2d ด้านนอก - ทำหน้าที่จัดตำแหน่งและ Flexbox center เท่านั้น
    // ไม่มีการใส่พื้นหลัง ไม่มีการใส่ตัวหนังสือ เพื่อป้องกันปัญหาซ้อนทับสองชั้น (Double rendering)
    const box = document.createElement("div");
    box.className = "git-text-box";
    box.style.cssText = `
      position: absolute;
      top: ${topPct};
      left: ${leftPct};
      width: ${widthPct};
      min-height: ${minHeightPct};
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      pointer-events: none;
      overflow: visible;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      padding: 0 !important;
      margin: 0 !important;
    `;
    box.style.top = topPct;
    box.style.left = leftPct;
    box.style.width = widthPct;
    box.style.minHeight = minHeightPct;

    // 2. ป้ายข้อความฟองคำพูดเดี่ยว (Single Bubble Element) ที่กระชับแนบตามเนื้อหา (Snug Fit)
    // องค์ประกอบเดียวที่มีข้อความและสไตล์พื้นหลังตามโหมดที่ผู้ใช้เลือก (ไม่มีกล่องขาวกวนใจ)
    const textEl = document.createElement("div");
    let modeClass = "git-text-mode-blur";
    let bgStyle = "";

    if (mode === "transparent") {
      modeClass = "git-text-mode-transparent git-text-transparent";
      bgStyle = `
        background: transparent !important;
        color: #000000 !important;
        -webkit-text-stroke: 1.5px #ffffff;
        paint-order: stroke fill;
        text-shadow: 0 0 4px #ffffff, 0 0 8px rgba(255, 255, 255, 0.85);
      `;
    } else if (mode === "solid") {
      modeClass = "git-text-mode-solid";
      // ในโหมด solid: ใช้สีพื้นหลังที่ตรวจจับได้จากภาพต้นฉบับ หากไม่มีจะปรับตามความมืด/สว่าง ไม่ฟิกซ์ขาวล้วน
      const bgCss = seg.bg?.css || (seg.bg?.isDark ? "#111111" : "#ffffff");
      const isDark = seg.bg?.isDark ?? false;
      bgStyle = `
        background: ${bgCss} !important;
        color: ${isDark ? "#ffffff" : "#000000"} !important;
        border-radius: 3px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      `;
    } else {
      // mode === "blur" (Frosted Glass / Backdrop Blur ฝ้ากระจกโปร่งแสง)
      modeClass = "git-text-mode-blur";
      bgStyle = `
        background: rgba(255, 255, 255, 0.35) !important;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        color: #000000 !important;
        border-radius: 4px;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
        -webkit-text-stroke: 0.5px rgba(255, 255, 255, 0.8);
        paint-order: stroke fill;
        text-shadow: 0 0 2px rgba(255, 255, 255, 0.9);
      `;
    }

    textEl.className = `git-text-content ${modeClass}`;
    textEl.style.cssText = `
      display: inline-block;
      width: fit-content;
      max-width: 100%;
      box-sizing: border-box;
      padding: 1px 3px;
      line-height: 1.15;
      font-family: ${FONT_FAMILY};
      font-size: ${fontSize}px;
      font-weight: 600;
      text-align: center;
      word-break: break-word;
      overflow-wrap: break-word;
      white-space: pre-wrap;
      pointer-events: auto;
      user-select: text;
      ${bgStyle}
    `;

    textEl.textContent = textToDraw;
    box.appendChild(textEl);
    layer.appendChild(box);
  }

  parentContainer.appendChild(layer);
  return layer;
}

/**
 * เรนเดอร์ DOM Text Overlay ซ้อนทับบนภาพโดยตรงแบบ Relative (Image-Relative Overlay)
 * - ห่อหุ้ม targetEl ด้วย getOrCreateImageWrapper(targetEl) (position: relative)
 * - คำนวณ Content Rect อิงตาม natural aspect ratio และจัดการ object-fit: contain (letterbox)
 * - คำนวณพิกัดแต่ละฟองคำพูดจาก Gemini box_2d ด้วย Relative Percentage:
 *   top: ymin/10 + '%', left: xmin/10 + '%', width: (xmax-xmin)/10 + '%', minHeight: (ymax-ymin)/10 + '%'
 * - ตรึงแน่นกับกรอบรูปภาพอย่างแม่นยำ ไม่เลื่อนตามการ scroll หรือ lazy-load
 */
function renderImageRelativeOverlay(targetEl, segments, options = {}) {
  if (!targetEl || !segments || !Array.isArray(segments) || segments.length === 0) return null;

  const wrapper = getOrCreateImageWrapper(targetEl);
  if (!wrapper) return null;

  // ล้าง Overlay เดิมใน wrapper นี้ก่อนเสมอ เพื่อป้องกัน duplicate layers
  clearExistingOverlays(wrapper);

  const rawMode = options.textBackgroundMode || options.textBgMode || "blur";
  const mode = (rawMode === "transparent" || rawMode === "solid" || rawMode === "blur") ? rawMode : "blur";

  // ตรวจสอบขนาดของภาพเพื่อคำนวณ font size และตรวจจับ aspect ratio / letterbox
  const contentRect = getImageContentRect(targetEl);
  const renderedW = contentRect.width || targetEl.clientWidth || targetEl.offsetWidth || 800;
  const renderedH = contentRect.height || targetEl.clientHeight || targetEl.offsetHeight || 1200;

  let style = document.getElementById("git-text-overlay-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "git-text-overlay-style";
    document.head.appendChild(style);
  }

  const layer = document.createElement("div");
  layer.className = "git-dom-text-overlay-layer";

  if (contentRect.left !== 0 || contentRect.top !== 0 || (contentRect.width !== (targetEl.clientWidth || 0) && contentRect.width > 0)) {
    layer.style.cssText = `
      position: absolute;
      top: ${contentRect.top}px;
      left: ${contentRect.left}px;
      width: ${contentRect.width}px;
      height: ${contentRect.height}px;
      pointer-events: none;
      z-index: 1000;
      overflow: visible;
      line-height: normal;
    `;
  } else {
    layer.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1000;
      overflow: visible;
      line-height: normal;
    `;
  }

  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.box_2d) || seg.box_2d.length < 4) continue;
    let [ymin, xmin, ymax, xmax] = seg.box_2d.map(Number);
    if (isNaN(ymin) || isNaN(xmin) || isNaN(ymax) || isNaN(xmax)) continue;
    if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
    if (xmin > xmax) [xmin, xmax] = [xmax, xmin];

    const textToDraw = String(seg.translated_text || seg.text || "").trim();
    if (!textToDraw) continue;

    // Relative percentage positioning directly from Gemini's box_2d [ymin, xmin, ymax, xmax] (scaled 0 to 1000)
    const topPct = (ymin / 10) + "%";
    const leftPct = (xmin / 10) + "%";
    const widthPct = ((xmax - xmin) / 10) + "%";
    const minHeightPct = ((ymax - ymin) / 10) + "%";

    const boxW = ((xmax - xmin) / 1000) * renderedW;
    const boxH = ((ymax - ymin) / 1000) * renderedH;

    const maxS = Math.max(12, Math.min(Math.floor(boxH * 0.7), Math.floor(boxW * 0.45), 36));
    const minS = Math.max(9, Math.min(13, Math.floor(boxH * 0.25)));
    let fontSize = minS;
    for (let s = maxS; s >= minS; s--) {
      const charsPerLine = Math.max(2, Math.floor(boxW / (s * 0.82)));
      const linesCount = Math.ceil(textToDraw.length / charsPerLine);
      if (linesCount * (s * 1.15) <= boxH) {
        fontSize = s;
        break;
      }
    }

    const box = document.createElement("div");
    box.className = "git-text-box";
    box.style.cssText = `
      position: absolute;
      top: ${topPct};
      left: ${leftPct};
      width: ${widthPct};
      min-height: ${minHeightPct};
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      pointer-events: none;
      overflow: visible;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      padding: 0 !important;
      margin: 0 !important;
    `;
    box.style.top = topPct;
    box.style.left = leftPct;
    box.style.width = widthPct;
    box.style.minHeight = minHeightPct;

    const textEl = document.createElement("div");
    let modeClass = "git-text-mode-blur";
    let bgStyle = "";

    if (mode === "transparent") {
      modeClass = "git-text-mode-transparent git-text-transparent";
      bgStyle = `
        background: transparent !important;
        color: #000000 !important;
        -webkit-text-stroke: 1.5px #ffffff;
        paint-order: stroke fill;
        text-shadow: 0 0 4px #ffffff, 0 0 8px rgba(255, 255, 255, 0.85);
      `;
    } else if (mode === "solid") {
      modeClass = "git-text-mode-solid";
      const bgCss = seg.bg?.css || (seg.bg?.isDark ? "#111111" : "#ffffff");
      const isDark = seg.bg?.isDark ?? false;
      bgStyle = `
        background: ${bgCss} !important;
        color: ${isDark ? "#ffffff" : "#000000"} !important;
        border-radius: 3px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      `;
    } else {
      modeClass = "git-text-mode-blur";
      bgStyle = `
        background: rgba(255, 255, 255, 0.35) !important;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        color: #000000 !important;
        border-radius: 4px;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
        -webkit-text-stroke: 0.5px rgba(255, 255, 255, 0.8);
        paint-order: stroke fill;
        text-shadow: 0 0 2px rgba(255, 255, 255, 0.9);
      `;
    }

    textEl.className = `git-text-content ${modeClass}`;
    textEl.style.cssText = `
      display: inline-block;
      width: fit-content;
      max-width: 100%;
      box-sizing: border-box;
      padding: 1px 3px;
      line-height: 1.15;
      font-family: ${FONT_FAMILY};
      font-size: ${fontSize}px;
      font-weight: 600;
      text-align: center;
      word-break: break-word;
      overflow-wrap: break-word;
      white-space: pre-wrap;
      pointer-events: auto;
      user-select: text;
      transition: opacity 0.15s ease;
      ${bgStyle}
    `;

    textEl.textContent = textToDraw;
    box.appendChild(textEl);
    layer.appendChild(box);
  }

  wrapper.appendChild(layer);
  targetEl.setAttribute("data-git-translated", "true");
  return layer;
}

if (typeof window !== "undefined") {
  window.clearExistingOverlays = clearExistingOverlays;
  window.gitRenderDomTextOverlay = renderDomTextOverlay;
  window.renderImageRelativeOverlay = renderImageRelativeOverlay;
  window.getOrCreateImageWrapper = getOrCreateImageWrapper;
  window.getImageContentRect = getImageContentRect;
  window.tagAndRegisterElement = tagAndRegisterElement;
  window.getElementByUniqueId = getElementByUniqueId;
}

// =========================================================================
// ส่วนการเลือกพื้นที่หน้าจอ (Screen Snipping), ครอปภาพ และแสดงผลแบบ Overlay
// สำหรับเว็บไซต์ที่ใช้ background-image, canvas หรือภาพที่ไม่ใช่ <img> ธรรมดา
// =========================================================================

let activeSelectionMask = null;

function startScreenAreaSelection(provider = "gemini") {
  if (activeSelectionMask) {
    activeSelectionMask.remove();
    activeSelectionMask = null;
  }

  const isGoogle = (provider === "google") || (typeof provider === "object" && provider?.isGoogle === true) || false;
  const effectiveProvider = isGoogle ? "google" : (typeof provider === "string" ? provider : "gemini");

  const mask = document.createElement("div");
  activeSelectionMask = mask;
  mask.className = "git-snippet-mask";
  mask.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 2147483647;
    cursor: crosshair;
    background: rgba(0, 0, 0, 0.25);
    user-select: none;
    -webkit-user-select: none;
  `;

  // แถบคำแนะนำด้านบน
  const banner = document.createElement("div");
  banner.textContent = isGoogle
    ? "🌐 ลากเมาส์เพื่อเลือกพื้นที่สำหรับ Google Translate (Images) • กด Esc เพื่อยกเลิก"
    : "📐 ลากเมาส์เพื่อเลือกพื้นที่ที่ต้องการแปล • กด Esc เพื่อยกเลิก";
  banner.style.cssText = `
    position: absolute;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: ${isGoogle ? "rgba(26, 115, 232, 0.94)" : "rgba(0, 0, 0, 0.82)"};
    color: #ffffff;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    padding: 8px 20px;
    border-radius: 24px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    pointer-events: none;
    border: 1px solid rgba(255, 255, 255, 0.2);
  `;
  mask.appendChild(banner);

  const selectionBox = document.createElement("div");
  selectionBox.style.cssText = `
    position: absolute;
    border: 2px dashed ${isGoogle ? "#ea4335" : "#4285f4"};
    background: ${isGoogle ? "rgba(234, 67, 53, 0.18)" : "rgba(66, 133, 244, 0.18)"};
    display: none;
    pointer-events: none;
    box-sizing: border-box;
  `;
  mask.appendChild(selectionBox);

  let isDragging = false;
  let startX = 0;
  let startY = 0;

  const onMouseDown = (e) => {
    if (e.button !== 0) return; // คลิกซ้ายเท่านั้น
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    selectionBox.style.left = `${startX}px`;
    selectionBox.style.top = `${startY}px`;
    selectionBox.style.width = "0px";
    selectionBox.style.height = "0px";
    selectionBox.style.display = "block";
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const currX = e.clientX;
    const currY = e.clientY;
    const x = Math.min(startX, currX);
    const y = Math.min(startY, currY);
    const w = Math.abs(currX - startX);
    const h = Math.abs(currY - startY);

    selectionBox.style.left = `${x}px`;
    selectionBox.style.top = `${y}px`;
    selectionBox.style.width = `${w}px`;
    selectionBox.style.height = `${h}px`;
  };

  const cleanup = () => {
    window.removeEventListener("keydown", onKeyDown);
    if (mask && mask.parentNode) {
      mask.parentNode.removeChild(mask);
    }
    activeSelectionMask = null;
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      cleanup();
    }
  };

  const onMouseUp = (e) => {
    if (!isDragging) return;
    isDragging = false;

    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const width = Math.abs(e.clientX - startX);
    const height = Math.abs(e.clientY - startY);

    cleanup();

    // หากลากกรอบเล็กเกินไป ให้ถือว่าเป็นการคลิกเฉยๆ และยกเลิก
    if (width < 15 || height < 15) {
      return;
    }

    const rect = {
      x,
      y,
      width,
      height,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      dpr: window.devicePixelRatio || 1,
      provider: effectiveProvider,
      isGoogle: isGoogle
    };

    // หน่วงเวลาเล็กน้อยเพื่อให้ DOM ลบ overlay ออกจากหน้าจอให้เรียบร้อยก่อน capture
    setTimeout(() => {
      handleAreaCapturedAndTranslate(rect, effectiveProvider);
    }, 60);
  };

  mask.addEventListener("mousedown", onMouseDown);
  mask.addEventListener("mousemove", onMouseMove);
  mask.addEventListener("mouseup", onMouseUp);
  window.addEventListener("keydown", onKeyDown);

  document.body.appendChild(mask);
}

let activeAreaOverlay = null;

async function handleAreaCapturedAndTranslate(rect, provider = "gemini") {
  let overlay = null;
  const isGoogle = (provider === "google") || (typeof provider === "object" && provider?.isGoogle === true) || (rect?.provider === "google") || (rect?.isGoogle === true) || false;
  const effectiveProvider = isGoogle ? "google" : (typeof provider === "string" ? provider : (rect?.provider || "gemini"));

  // ล้าง Overlay เก่าหากมีอยู่ก่อนเริ่มสร้างใหม่
  if (activeAreaOverlay) {
    try { activeAreaOverlay.remove(); } catch {}
    activeAreaOverlay = null;
  }

  try {
    // 1. ส่งคำขอให้ background service worker แคปเจอร์หน้าจอก่อน (ขณะที่ยังไม่มี UI ใดๆ อยู่บนหน้าเว็บ)
    const captureRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" }, resolve);
    });

    if (!captureRes || !captureRes.success || !captureRes.dataUrl) {
      throw new Error(captureRes?.error || "ไม่สามารถจับภาพหน้าจอได้");
    }

    // 2. โหลดภาพที่แคปเจอร์และครอปตามสัดส่วนที่เลือก
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("โหลดภาพแคปเจอร์ไม่สำเร็จ"));
      img.src = captureRes.dataUrl;
    });

    const dpr = rect.dpr || 1;
    const cropCanvas = document.createElement("canvas");
    const sx = Math.round(rect.x * dpr);
    const sy = Math.round(rect.y * dpr);
    const sw = Math.round(rect.width * dpr);
    const sh = Math.round(rect.height * dpr);

    cropCanvas.width = sw;
    cropCanvas.height = sh;
    const cropCtx = cropCanvas.getContext("2d");
    cropCtx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    const originalCroppedDataUrl = cropCanvas.toDataURL("image/png");
    const base64 = originalCroppedDataUrl.replace(/^data:image\/png;base64,/, "");

    // ฟังก์ชันช่วยสุ่มตัวอย่างสีพื้นหลังจาก Canvas สำหรับแต่ละช่องข้อความ เพื่อให้โหมด solid เลือกสีถูกต้องตามมังงะ
    const enrichSegmentsWithBg = (segs) => {
      if (!Array.isArray(segs)) return [];
      return segs.map((seg) => {
        if (!seg || !Array.isArray(seg.box_2d) || seg.box_2d.length < 4) return seg;
        let [ymin, xmin, ymax, xmax] = seg.box_2d.map(Number);
        if (isNaN(ymin) || isNaN(xmin) || isNaN(ymax) || isNaN(xmax)) return seg;
        if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
        if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
        const x = Math.max(0, (xmin / 1000) * cropCanvas.width);
        const y = Math.max(0, (ymin / 1000) * cropCanvas.height);
        const w = Math.min(cropCanvas.width - x, ((xmax - xmin) / 1000) * cropCanvas.width);
        const h = Math.min(cropCanvas.height - y, ((ymax - ymin) / 1000) * cropCanvas.height);
        const bg = sampleDominantBackgroundColor(cropCtx, x, y, w, h, cropCanvas.width, cropCanvas.height);
        return { ...seg, bg };
      });
    };

    // 3. หลังจากแคปภาพและครอปเสร็จเรียบร้อยแล้ว เปิด In-Place Floating Overlay UI แสดงผล
    overlay = createFloatingOverlay(rect, effectiveProvider);
    activeAreaOverlay = overlay;

    // 4. ส่งข้อมูลภาพที่ครอปแล้วเข้าสู่ Translation Pipeline ใน background service worker
    // ทำงานแบบ In-Place Overlay ทันที ไม่เปิดแท็บภายนอก ทั้ง Gemini และ Google Translate
    overlay.showStatus(
      isGoogle ? "🌐 กำลังแปลด้วย Google Translate..." : "✨ กำลังแปลด้วย Gemini AI...",
      false,
      false,
      true
    );

    const transRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "TRANSLATE_IMAGE_DATA", base64, mimeType: "image/png", provider: effectiveProvider, isGoogle },
        resolve
      );
    });

    if (!transRes || !transRes.success) {
      if (transRes?.isQuotaExceeded && transRes?.enableFallback !== false && !isGoogle) {
        if (transRes?.fallbackMode === "auto") {
          // สลับไปแปลด้วย Google Translate บนหน้าเดิมอัตโนมัติ (In-Place Overlay)
          overlay.showStatus("⚠️ โควต้า Gemini หมด — กำลังสลับไปแปลด้วย Google Translate...", false, false, true);
          const gtRes = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { type: "TRANSLATE_IMAGE_DATA", base64, mimeType: "image/png", provider: "google", isGoogle: true },
              resolve
            );
          });
          if (gtRes && gtRes.success && gtRes.segments?.length > 0) {
            const textBgMode = await getStoredTextBackgroundMode();
            // ใช้ภาพต้นฉบับ + DOM overlay พร้อมสีพื้นหลังที่ตรวจจับได้ (ป้องกัน double-layer)
            overlay.showResult(originalCroppedDataUrl, originalCroppedDataUrl, true, enrichSegmentsWithBg(gtRes.segments), textBgMode);
            return;
          }
        }

        overlay.showQuotaFallback({
          message: transRes.error || "โควต้าการใช้งาน Gemini API เต็มแล้ว",
          targetLangCode: transRes.targetLangCode || "th",
          onTranslateWithGoogle: async () => {
            // เมื่อผู้ใช้กดปุ่ม "แปลด้วย Google Translate" ใน Overlay
            overlay.showStatus("🌐 กำลังแปลด้วย Google Translate...", false, false, true);
            try {
              const gtRes = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                  { type: "TRANSLATE_IMAGE_DATA", base64, mimeType: "image/png", provider: "google" },
                  resolve
                );
              });
              if (gtRes && gtRes.success && gtRes.segments?.length > 0) {
                const textBgMode = await getStoredTextBackgroundMode();
                overlay.showResult(originalCroppedDataUrl, originalCroppedDataUrl, true, enrichSegmentsWithBg(gtRes.segments), textBgMode);
              } else {
                overlay.remove();
                showToastNotification("ไม่พบข้อความ หรือแปลด้วย Google Translate ไม่สำเร็จ", true);
              }
            } catch (gtErr) {
              overlay.remove();
              showToastNotification("แปลด้วย Google Translate ไม่สำเร็จ: " + (gtErr.message || String(gtErr)), true);
            }
          },
          onCopyImage: async () => {
            const ok = await copyImageDataToClipboard(originalCroppedDataUrl);
            if (ok) {
              showToastNotification("📋 คัดลอกภาพเรียบร้อยแล้ว");
            } else {
              showToastNotification("ไม่สามารถคัดลอกภาพได้", true);
            }
          }
        });
        return;
      }
      throw new Error(transRes?.error || "เกิดข้อผิดพลาดในการแปลภาพ");
    }

    const segments = transRes.segments || [];
    if (segments.length === 0) {
      overlay.showStatus("ไม่พบข้อความในพื้นที่ที่เลือก", true);
      setTimeout(() => overlay.remove(), 2500);
      return;
    }

    // 5. ใช้ภาพต้นฉบับ (ไม่ bake ข้อความลง canvas) — ปล่อยให้ DOM Text Overlay เรนเดอร์ข้อความชั้นเดียว
    // เพื่อป้องกัน double-layered text (canvas-baked + DOM overlay ซ้อนทับกัน)
    const textBgMode = transRes?.textBackgroundMode || transRes?.textBgMode || await getStoredTextBackgroundMode();
    const translatedCroppedDataUrl = originalCroppedDataUrl;

    // 6. นำภาพต้นฉบับใส่ใน Floating Overlay และให้ DOM Text Overlay วาดข้อความทับชั้นเดียวพร้อมสีพื้นหลังที่ตรวจจับได้
    overlay.showResult(translatedCroppedDataUrl, originalCroppedDataUrl, isGoogle, enrichSegmentsWithBg(segments), textBgMode);
  } catch (err) {
    console.error("[Gemini Image Translator]", err);
    if (overlay) {
      overlay.remove();
    }
    showToastNotification("แปลภาพไม่สำเร็จ: " + (err.message || String(err)), true);
  }
}

function createFloatingOverlay(rect, provider = "gemini") {
  const isGoogle = (provider === "google") || (typeof provider === "object" && provider?.isGoogle === true) || (rect?.provider === "google") || (rect?.isGoogle === true) || false;
  const container = document.createElement("div");
  container.className = "git-floating-overlay";

  const scrollX = rect.scrollX !== undefined ? rect.scrollX : window.scrollX;
  const scrollY = rect.scrollY !== undefined ? rect.scrollY : window.scrollY;
  const pageX = rect.x + scrollX;
  const pageY = rect.y + scrollY;

  container.style.cssText = `
    position: absolute;
    left: ${pageX}px;
    top: ${pageY}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    z-index: 99999;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    border: 2px solid ${isGoogle ? "#ea4335" : "#1a73e8"};
    border-radius: 6px;
    overflow: hidden;
    background: #ffffff;
    box-sizing: border-box;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    pointer-events: auto;
    opacity: 0;
    transition: opacity 0.25s ease-in-out, transform 0.2s ease-out;
  `;

  let isDismissed = false;
  const dismiss = () => {
    if (isDismissed) return;
    isDismissed = true;
    container.style.opacity = "0";
    container.style.transform = "scale(0.97)";
    setTimeout(() => {
      if (container.parentNode) {
        container.remove();
      }
    }, 250);
  };

  // กล่องสถานะ Loading พร้อม Spinner
  const loadingEl = document.createElement("div");
  loadingEl.className = "git-overlay-loading";
  loadingEl.style.cssText = `
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(2px);
    color: ${isGoogle ? "#ea4335" : "#1a73e8"};
    font-size: 13px;
    font-weight: 500;
    padding: 16px;
    text-align: center;
    box-sizing: border-box;
    z-index: 99999;
  `;
  loadingEl.innerHTML = `
    <div style="width: 26px; height: 26px; border: 3px solid ${isGoogle ? "#fce8e6" : "#e8f0fe"}; border-top-color: ${isGoogle ? "#ea4335" : "#1a73e8"}; border-radius: 50%; animation: git-spin 0.8s linear infinite; margin-bottom: 10px;"></div>
    <span class="git-loading-text">${isGoogle ? "🌐 กำลังแปลด้วย Google Translate..." : "✨ กำลังแปลด้วย Gemini AI..."}</span>
  `;
  container.appendChild(loadingEl);

  // ปุ่มปิด (✕)
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.title = "ปิด (Close • ดับเบิลคลิกที่รูปเพื่อปิด)";
  closeBtn.style.cssText = `
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 100000;
    background: rgba(0, 0, 0, 0.65);
    color: #ffffff;
    border: none;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    font-size: 13px;
    line-height: 24px;
    text-align: center;
    cursor: pointer;
    padding: 0;
    transition: background 0.2s, transform 0.15s;
    user-select: none;
  `;
  closeBtn.addEventListener("mouseenter", () => {
    closeBtn.style.background = "#d93025";
    closeBtn.style.transform = "scale(1.1)";
  });
  closeBtn.addEventListener("mouseleave", () => {
    closeBtn.style.background = "rgba(0, 0, 0, 0.65)";
    closeBtn.style.transform = "scale(1)";
  });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
  });
  container.appendChild(closeBtn);

  // รองรับดับเบิลคลิกเพื่อปิด (Double-click to dismiss)
  container.addEventListener("dblclick", (e) => {
    if (e.target && e.target.closest && e.target.closest(".git-overlay-btn")) {
      return;
    }
    dismiss();
  });

  // สร้าง animation สำหรับ loading spinner
  if (!document.getElementById("git-spinner-style")) {
    const style = document.createElement("style");
    style.id = "git-spinner-style";
    style.textContent = `@keyframes git-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }

  document.body.appendChild(container);
  requestAnimationFrame(() => {
    container.style.opacity = "1";
  });

  return {
    remove: dismiss,
    showStatus(msg, autoClose = false, isError = false, showSpinner = false, customIsGoogle = undefined) {
      const isG = customIsGoogle !== undefined ? customIsGoogle : (isGoogle ?? false);
      loadingEl.textContent = "";
      if (showSpinner) {
        const spinner = document.createElement("div");
        spinner.style.cssText =
          `width: 26px; height: 26px; border: 3px solid ${isG ? "#fce8e6" : "#e8f0fe"}; border-top-color: ${isG ? "#ea4335" : "#1a73e8"}; border-radius: 50%; animation: git-spin 0.8s linear infinite; margin-bottom: 10px;`;
        loadingEl.appendChild(spinner);
      }
      const statusDiv = document.createElement("div");
      statusDiv.style.cssText = `font-size: 13px; color: ${isError ? "#d93025" : "#333"}; padding: 8px; line-height: 1.4;`;
      statusDiv.textContent = msg;
      loadingEl.appendChild(statusDiv);
      if (autoClose) {
        setTimeout(dismiss, 2500);
      }
    },
    showQuotaFallback({ message, targetLangCode, onTranslateWithGoogle, onCopyImage }) {
      const escapeOverlayHtml = (str) => {
        if (!str) return "";
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      };
      loadingEl.innerHTML = `
        <div style="font-size: 13px; font-weight: 600; color: #d93025; margin-bottom: 4px; display: flex; align-items: center; justify-content: center; gap: 4px;">
          <span>⚠️</span> <span>โควต้า Gemini หมดแล้ว</span>
        </div>
        <div style="font-size: 11px; color: #5f6368; margin-bottom: 10px; max-width: 95%; line-height: 1.3;">
          ${escapeOverlayHtml(message) || "โควต้าเต็ม (HTTP 429) สลับไปแปลด้วย Google Translate บนหน้าเดิม"}
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px; width: 88%;">
          <button class="git-overlay-gt-btn" style="
            background: #1a73e8;
            color: #ffffff;
            border: none;
            border-radius: 4px;
            padding: 8px 10px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
          ">🌐 แปลด้วย Google Translate (บนหน้าเดิม)</button>
          <button class="git-overlay-copy-btn" style="
            background: #f1f3f4;
            color: #3c4043;
            border: 1px solid #dadce0;
            border-radius: 4px;
            padding: 6px 10px;
            font-size: 11px;
            cursor: pointer;
          ">📋 คัดลอกภาพที่เลือก</button>
        </div>
      `;
      const gtBtn = loadingEl.querySelector(".git-overlay-gt-btn");
      if (gtBtn && onTranslateWithGoogle) {
        gtBtn.onclick = onTranslateWithGoogle;
      }
      const copyBtn = loadingEl.querySelector(".git-overlay-copy-btn");
      if (copyBtn && onCopyImage) {
        copyBtn.onclick = onCopyImage;
      }
    },
    showResult(translatedDataUrl, originalDataUrl, customIsGoogle = undefined, segments = null, textBgMode = "blur") {
      const isG = customIsGoogle !== undefined ? customIsGoogle : (isGoogle ?? false);
      loadingEl.style.display = "none";

      // ล้างผลลัพธ์เก่าหรือเลเยอร์เดิมใน container เพื่อป้องกันการซ้อนทับ (Double Layer Cleanup)
      clearExistingOverlays(container);
      container.querySelectorAll(".git-translated-overlay-img, .git-peek-btn").forEach((el) => el.remove());

      const imgEl = document.createElement("img");
      imgEl.src = translatedDataUrl;
      imgEl.className = "git-translated-overlay-img";
      imgEl.style.cssText = `
        width: 100%;
        height: 100%;
        object-fit: fill;
        display: block;
        user-select: none;
        pointer-events: auto;
        transition: opacity 0.15s ease-in-out;
      `;
      container.appendChild(imgEl);

      // สร้างและแทรก DOM Text Overlay Layer เพื่อให้ตัวหนังสือแนบสนิท (Snug Fit) คมชัดระดับ DOM
      let domOverlayLayer = null;
      if (segments && Array.isArray(segments) && segments.length > 0) {
        const finalMode = textBgMode || "blur";
        domOverlayLayer = renderDomTextOverlay(container, segments, {
          width: rect.width,
          height: rect.height,
          textBackgroundMode: finalMode,
          textBgMode: finalMode,
          targetLang: "Thai"
        });
      }

      container.style.borderColor = isG ? "#34a853" : "#1a73e8";

      // ปุ่มดูภาพต้นฉบับ (Peek Button)
      const peekBtn = document.createElement("button");
      peekBtn.className = "git-overlay-btn git-peek-btn";
      peekBtn.textContent = "👁️ ต้นฉบับ";
      peekBtn.title = "กดค้างไว้หรือกด Spacebar เพื่อดูภาพต้นฉบับ (ดับเบิลคลิกเพื่อปิด)";
      peekBtn.style.cssText = `
        position: absolute;
        bottom: 6px;
        right: 6px;
        z-index: 100000;
        background: rgba(0, 0, 0, 0.72);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 14px;
        font-size: 11px;
        font-weight: 500;
        padding: 4px 10px;
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 4px;
        backdrop-filter: blur(4px);
        transition: background 0.2s, transform 0.1s;
      `;
      peekBtn.addEventListener("mouseenter", () => (peekBtn.style.background = "rgba(0, 0, 0, 0.88)"));
      peekBtn.addEventListener("mouseleave", () => (peekBtn.style.background = "rgba(0, 0, 0, 0.72)"));

      let isShowingOriginal = false;
      const setPeek = (showOrig) => {
        if (isShowingOriginal === showOrig) return;
        isShowingOriginal = showOrig;
        if (showOrig) {
          if (domOverlayLayer) {
            domOverlayLayer.style.opacity = "0";
            domOverlayLayer.style.pointerEvents = "none";
          }
          imgEl.src = originalDataUrl;
          peekBtn.textContent = "✨ แปลแล้ว";
          peekBtn.style.background = isG ? "#ea4335" : "#1a73e8";
        } else {
          if (domOverlayLayer) {
            domOverlayLayer.style.opacity = "1";
            domOverlayLayer.style.pointerEvents = "auto";
          }
          imgEl.src = translatedDataUrl;
          peekBtn.textContent = "👁️ ต้นฉบับ";
          peekBtn.style.background = "rgba(0, 0, 0, 0.72)";
        }
      };

      peekBtn.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        setPeek(true);
      });

      const onWindowMouseUp = () => {
        if (isShowingOriginal) {
          setPeek(false);
        }
      };
      window.addEventListener("mouseup", onWindowMouseUp);

      // Keyboard Shortcut: กดปุ่ม Spacebar ขณะ Hover อยู่บน Overlay เพื่อ Peek ดูต้นฉบับ
      let isHovering = false;
      container.addEventListener("mouseenter", () => {
        isHovering = true;
      });
      container.addEventListener("mouseleave", () => {
        isHovering = false;
        if (isShowingOriginal) setPeek(false);
      });

      const onKeyDown = (e) => {
        if (!isHovering) return;
        if (e.code === "Space" && !e.repeat) {
          e.preventDefault();
          setPeek(true);
        } else if (e.key === "Escape") {
          dismiss();
        }
      };

      const onKeyUp = (e) => {
        if (e.code === "Space") {
          if (isShowingOriginal) {
            e.preventDefault();
            setPeek(false);
          }
        }
      };

      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);

      // ลบ event listeners เมื่อ Overlay ถูกนำออกจาก DOM
      const observer = new MutationObserver(() => {
        if (!container.parentNode) {
          window.removeEventListener("mouseup", onWindowMouseUp);
          window.removeEventListener("keydown", onKeyDown);
          window.removeEventListener("keyup", onKeyUp);
          observer.disconnect();
        }
      });
      if (container.parentNode) {
        observer.observe(container.parentNode, { childList: true });
      }

      container.appendChild(peekBtn);
    }
  };
}

// =========================================================================
// Image Collector Sidebar: สแกน/รวบรวมรูปภาพมังงะในหน้าเว็บ และแปลแบบกลุ่ม (Batch Translation)
// =========================================================================

let collectorSidebarEl = null;
let collectorTriggerBtn = null;
let collectedMangaImages = [];
let isBatchTranslating = false;
let cancelBatchTranslationFlag = false;

/**
 * 1. ฟังก์ชันดึงรูปภาพมังงะ/การ์ตูนทั้งหมดในหน้าเว็บ (Image Extraction)
 * - ค้นหาแท็ก <img> ทั้งหมด พร้อมดึง URL ที่ดีที่สุด (src, data-src, data-lazy-src, data-original, srcset)
 * - กรองไอคอนหรือ Avatar ขนาดเล็กออก (กรองรูปที่ naturalWidth/height < 200px หรือ rendered width/height < 200px)
 * - เก็บ Object ที่มี Reference ชี้ตรงไปยัง DOM <img> Element ต้นฉบับ
 */
function extractMangaImages() {
  const minDimension = 200;
  const seenEls = new Set();
  const collected = [];

  function getBestImageUrl(img) {
    const candidates = [
      img.getAttribute("data-original"),
      img.getAttribute("data-src"),
      img.getAttribute("data-lazy-src"),
      img.getAttribute("data-actualsrc"),
      img.getAttribute("data-url"),
      img.currentSrc,
      img.src
    ];
    for (const c of candidates) {
      if (c && typeof c === "string" && !c.startsWith("data:image/svg") && !c.startsWith("data:image/gif;base64,R0lGOD")) {
        try {
          return new URL(c, document.baseURI).href;
        } catch {
          return c;
        }
      }
    }
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const parts = srcset.split(",").map((p) => p.trim().split(/\s+/)[0]);
      if (parts.length > 0 && parts[parts.length - 1]) {
        try {
          return new URL(parts[parts.length - 1], document.baseURI).href;
        } catch {
          return parts[parts.length - 1];
        }
      }
    }
    return img.src || "";
  }

  function isLikelyMangaImage(img) {
    if (
      img.closest("#git-collector-sidebar") ||
      img.closest(".git-collector-sidebar") ||
      img.closest(".git-floating-overlay") ||
      img.closest("#git-toast-container")
    ) {
      return false;
    }

    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    const cw = img.clientWidth || img.offsetWidth || 0;
    const ch = img.clientHeight || img.offsetHeight || 0;

    // หากทราบขนาด naturalWidth/height และมีด้านใดด้านหนึ่งน้อยกว่า 200px ให้คัดออกทันที
    if (nw > 0 && (nw < minDimension || (nh > 0 && nh < minDimension))) return false;
    if (nh > 0 && (nh < minDimension || (nw > 0 && nw < minDimension))) return false;

    // หากทราบขนาด rendered clientWidth/height และมีด้านใดด้านหนึ่งน้อยกว่า 200px ให้คัดออกทันที
    if (cw > 0 && (cw < minDimension || (ch > 0 && ch < minDimension))) return false;
    if (ch > 0 && (ch < minDimension || (cw > 0 && cw < minDimension))) return false;

    if (nw >= minDimension && nh >= minDimension) return true;
    if (cw >= minDimension && ch >= minDimension) return true;

    const attrW = parseInt(img.getAttribute("width") || "", 10);
    const attrH = parseInt(img.getAttribute("height") || "", 10);
    if (!isNaN(attrW) && !isNaN(attrH)) {
      return attrW >= minDimension && attrH >= minDimension;
    }

    return false;
  }

  const allImages = Array.from(document.querySelectorAll("img"));
  for (const img of allImages) {
    if (seenEls.has(img)) continue;
    if (!isLikelyMangaImage(img)) continue;

    const url = getBestImageUrl(img);
    if (!url || url.startsWith("chrome-extension://") || url.startsWith("data:image/svg")) continue;

    seenEls.add(img);
    const w = img.naturalWidth || img.clientWidth || 0;
    const h = img.naturalHeight || img.clientHeight || 0;

    const isAlreadyTranslated = img.getAttribute("data-git-translated") === "true";
    const elementId = tagAndRegisterElement(img);

    collected.push({
      id: "git-img-" + (collected.length + 1),
      elementId: elementId,
      el: img,
      url: url,
      width: w,
      height: h,
      selected: !isAlreadyTranslated,
      status: isAlreadyTranslated ? "done" : "idle", // "idle" | "processing" | "done" | "error"
      statusText: isAlreadyTranslated ? "แปลแล้ว" : "พร้อมแปล",
      error: null
    });
  }

  return collected;
}

/**
 * ฉีด CSS สไตล์สำหรับ Collector Sidebar
 */
function ensureCollectorSidebarStyles() {
  if (document.getElementById("git-collector-sidebar-style")) return;
  const style = document.createElement("style");
  style.id = "git-collector-sidebar-style";
  style.textContent = `
    .git-collector-sidebar {
      position: fixed;
      right: 0;
      top: 0;
      width: 360px;
      max-width: 90vw;
      height: 100vh;
      z-index: 999999;
      background: #1e1e1e;
      color: #fff;
      box-shadow: -4px 0 16px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      box-sizing: border-box;
      transform: translateX(100%);
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      user-select: none;
    }
    .git-collector-sidebar.git-open {
      transform: translateX(0);
    }
    .git-collector-header {
      padding: 14px 16px;
      background: #252526;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .git-collector-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .git-collector-title {
      font-size: 15px;
      font-weight: 600;
      color: #ffffff;
      margin: 0;
    }
    .git-collector-badge-counter {
      background: #1a73e8;
      color: #ffffff;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
    }
    .git-collector-header-btns {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .git-collector-icon-btn {
      background: transparent;
      border: none;
      color: #9aa0a6;
      font-size: 15px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      transition: background 0.15s, color 0.15s;
    }
    .git-collector-icon-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }
    .git-collector-toolbar {
      padding: 10px 14px;
      background: #202124;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .git-collector-toolbar-controls {
      display: flex;
      gap: 6px;
    }
    .git-collector-select {
      flex: 1;
      background: #2d2e30;
      color: #e8eaed;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      padding: 5px 6px;
      font-size: 11px;
      cursor: pointer;
      outline: none;
    }
    .git-collector-toolbar-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
    }
    .git-collector-select-btns {
      display: flex;
      gap: 6px;
    }
    .git-collector-btn-text {
      background: #2d2e30;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #bdc1c6;
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .git-collector-btn-text:hover {
      background: #3c4043;
      color: #ffffff;
    }
    .git-collector-selected-info {
      color: #9aa0a6;
    }
    .git-collector-body {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .git-collector-empty {
      text-align: center;
      color: #9aa0a6;
      font-size: 13px;
      margin-top: 40px;
      line-height: 1.6;
    }
    .git-collector-item {
      display: flex;
      gap: 10px;
      align-items: center;
      background: #252526;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 8px;
      transition: border-color 0.2s, background 0.2s;
    }
    .git-collector-item:hover {
      background: #2d2e30;
      border-color: rgba(255, 255, 255, 0.18);
    }
    .git-collector-checkbox {
      width: 17px;
      height: 17px;
      accent-color: #1a73e8;
      cursor: pointer;
    }
    .git-collector-thumb-box {
      width: 58px;
      height: 76px;
      border-radius: 4px;
      overflow: hidden;
      background: #141414;
      border: 1px solid rgba(255, 255, 255, 0.12);
      flex-shrink: 0;
      cursor: pointer;
      position: relative;
    }
    .git-collector-thumb-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.2s;
    }
    .git-collector-thumb-box:hover .git-collector-thumb-img {
      transform: scale(1.1);
    }
    .git-collector-item-details {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .git-collector-item-header {
      font-size: 12px;
      font-weight: 600;
      color: #ffffff;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .git-collector-item-dim {
      font-size: 10.5px;
      color: #9aa0a6;
    }
    .git-collector-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 500;
      width: fit-content;
    }
    .git-badge-idle {
      background: rgba(255, 255, 255, 0.08);
      color: #bdc1c6;
    }
    .git-badge-processing {
      background: rgba(26, 115, 232, 0.25);
      color: #8ab4f8;
    }
    .git-badge-done {
      background: rgba(52, 168, 83, 0.25);
      color: #81c995;
    }
    .git-badge-error {
      background: rgba(234, 67, 53, 0.25);
      color: #f28b82;
    }
    .git-collector-btn-locate {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #8ab4f8;
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 10px;
      cursor: pointer;
      align-self: flex-start;
      margin-top: 2px;
    }
    .git-collector-btn-locate:hover {
      background: rgba(138, 180, 248, 0.15);
    }
    .git-collector-footer {
      padding: 12px 16px;
      background: #252526;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .git-collector-progress-bar {
      width: 100%;
      height: 5px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      overflow: hidden;
    }
    .git-collector-progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #1a73e8, #34a853);
      transition: width 0.25s ease-out;
    }
    .git-collector-progress-text {
      font-size: 10.5px;
      color: #9aa0a6;
      text-align: right;
    }
    .git-collector-primary-btn {
      width: 100%;
      background: #1a73e8;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: 0 4px 12px rgba(26, 115, 232, 0.4);
      transition: background 0.15s;
    }
    .git-collector-primary-btn:hover:not(:disabled) {
      background: #1557b0;
    }
    .git-collector-primary-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .git-collector-cancel-btn {
      width: 100%;
      background: #d93025;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .git-collector-trigger-btn {
      position: fixed;
      right: 18px;
      bottom: 84px;
      z-index: 2147483630;
      background: #1a73e8;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 24px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
      transition: background 0.2s, transform 0.15s;
    }
    .git-collector-trigger-btn:hover {
      background: #1557b0;
      transform: translateY(-2px);
    }
    @keyframes git-spin-small {
      to { transform: rotate(360deg); }
    }
    .git-spinner-mini {
      display: inline-block;
      width: 8px;
      height: 8px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: #8ab4f8;
      border-radius: 50%;
      animation: git-spin-small 0.8s linear infinite;
    }
  `;
  document.head.appendChild(style);
}

/**
 * 2. สร้างหรือดึงอินสแตนซ์ของ Floating Sidebar Drawer UI
 */
function createOrGetImageCollectorSidebar() {
  ensureCollectorSidebarStyles();

  if (collectorSidebarEl && document.body.contains(collectorSidebarEl)) {
    return collectorSidebarEl;
  }

  const sidebar = document.createElement("div");
  sidebar.id = "git-collector-sidebar";
  sidebar.className = "git-collector-sidebar";

  sidebar.innerHTML = `
    <div class="git-collector-header">
      <div class="git-collector-title-wrap">
        <span class="git-collector-title">🖼️ เลือกภาพสำหรับแปล</span>
        <span id="git-collector-count-badge" class="git-collector-badge-counter">พบ 0 ภาพ</span>
      </div>
      <div class="git-collector-header-btns">
        <button id="git-collector-rescan-btn" class="git-collector-icon-btn" title="สแกนรูปภาพในหน้าเว็บใหม่">🔄</button>
        <button id="git-collector-close-btn" class="git-collector-icon-btn" title="ปิดแท็บ">✕</button>
      </div>
    </div>

    <div class="git-collector-toolbar">
      <div class="git-collector-toolbar-controls">
        <select id="git-collector-provider" class="git-collector-select" title="เลือกผู้ให้บริการแปล">
          <option value="gemini">✨ Gemini AI</option>
          <option value="google">🌐 Google Translate</option>
        </select>
        <select id="git-collector-bgmode" class="git-collector-select" title="สไตล์พื้นหลังข้อความ">
          <option value="blur">🌫️ Blur (กระจกฝ้า)</option>
          <option value="solid">⬜ Solid (พอดีคำ)</option>
          <option value="transparent">🔍 Transparent (โปร่งใส)</option>
        </select>
      </div>
      <div class="git-collector-toolbar-row">
        <div class="git-collector-select-btns">
          <button id="git-collector-select-all" class="git-collector-btn-text">✓ เลือกทั้งหมด</button>
          <button id="git-collector-deselect-all" class="git-collector-btn-text">✕ ยกเลิก</button>
        </div>
        <span id="git-collector-selected-text" class="git-collector-selected-info">เลือกแล้ว: 0 ภาพ</span>
      </div>
    </div>

    <div id="git-collector-body" class="git-collector-body">
      <div class="git-collector-empty">กำลังค้นหารูปภาพมังงะในหน้านี้...</div>
    </div>

    <div class="git-collector-footer">
      <div class="git-collector-progress-wrap">
        <div class="git-collector-progress-bar">
          <div id="git-collector-progress-fill" class="git-collector-progress-fill"></div>
        </div>
        <div id="git-collector-progress-text" class="git-collector-progress-text">ความคืบหน้า: 0 / 0 ภาพ</div>
      </div>
      <button id="git-collector-primary-btn" class="git-collector-primary-btn">
        <span>⚡ แปลภาพที่เลือก (0 ภาพ)</span>
      </button>
      <button id="git-collector-cancel-btn" class="git-collector-cancel-btn" style="display: none;">
        <span>⏹️ หยุดการแปล</span>
      </button>
    </div>
  `;

  document.body.appendChild(sidebar);
  collectorSidebarEl = sidebar;

  // ผูก Event Listeners ประจำ Sidebar
  const closeBtn = sidebar.querySelector("#git-collector-close-btn");
  closeBtn.addEventListener("click", () => {
    closeImageCollectorSidebar();
  });

  const rescanBtn = sidebar.querySelector("#git-collector-rescan-btn");
  rescanBtn.addEventListener("click", () => {
    refreshCollectedImages();
  });

  const selectAllBtn = sidebar.querySelector("#git-collector-select-all");
  selectAllBtn.addEventListener("click", () => {
    collectedMangaImages.forEach((it) => (it.selected = true));
    renderSidebarItems();
  });

  const deselectAllBtn = sidebar.querySelector("#git-collector-deselect-all");
  deselectAllBtn.addEventListener("click", () => {
    collectedMangaImages.forEach((it) => (it.selected = false));
    renderSidebarItems();
  });

  const primaryBtn = sidebar.querySelector("#git-collector-primary-btn");
  primaryBtn.addEventListener("click", () => {
    runBatchTranslation();
  });

  const cancelBtn = sidebar.querySelector("#git-collector-cancel-btn");
  cancelBtn.addEventListener("click", () => {
    cancelBatchTranslationFlag = true;
    showToastNotification("⏹️ กำลังยกเลิกการแปลคิวที่เหลือ...", false);
  });

  return sidebar;
}

/**
 * อัปเดตรายการรูปภาพใน Body ของ Sidebar
 */
function renderSidebarItems() {
  if (!collectorSidebarEl) return;

  const countBadge = collectorSidebarEl.querySelector("#git-collector-count-badge");
  const selectedText = collectorSidebarEl.querySelector("#git-collector-selected-text");
  const bodyEl = collectorSidebarEl.querySelector("#git-collector-body");
  const primaryBtn = collectorSidebarEl.querySelector("#git-collector-primary-btn");

  const total = collectedMangaImages.length;
  const selectedCount = collectedMangaImages.filter((it) => it.selected).length;

  if (countBadge) countBadge.textContent = `พบ ${total} ภาพ`;
  if (selectedText) selectedText.textContent = `เลือกแล้ว: ${selectedCount} / ${total} ภาพ`;

  if (primaryBtn) {
    const btnSpan = primaryBtn.querySelector("span");
    if (btnSpan) btnSpan.textContent = `⚡ แปลภาพที่เลือก (${selectedCount} ภาพ)`;
    primaryBtn.disabled = selectedCount === 0 || isBatchTranslating;
  }

  if (total === 0) {
    bodyEl.innerHTML = `<div class="git-collector-empty">ไม่พบรูปภาพมังงะขนาดใหญ่ในหน้านี้<br><small style="color:#70757a;">(ระบบกรองภาพที่มีขนาดเล็กกว่า 200px ออก)</small></div>`;
    return;
  }

  bodyEl.innerHTML = "";
  collectedMangaImages.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = `git-collector-item ${item.selected ? "git-item-selected" : ""}`;
    card.id = `git-card-${item.id}`;

    let badgeClass = "git-badge-idle";
    let badgeText = "⏳ พร้อมแปล";

    if (item.status === "processing") {
      badgeClass = "git-badge-processing";
      badgeText = `<span class="git-spinner-mini"></span> ${item.statusText || "กำลังแปล..."}`;
    } else if (item.status === "done") {
      badgeClass = "git-badge-done";
      badgeText = `✓ ${item.statusText || "แปลเสร็จแล้ว"}`;
    } else if (item.status === "error") {
      badgeClass = "git-badge-error";
      badgeText = `⚠️ ${item.statusText || "แปลไม่สำเร็จ"}`;
    }

    card.innerHTML = `
      <input type="checkbox" class="git-collector-checkbox" ${item.selected ? "checked" : ""} ${isBatchTranslating ? "disabled" : ""} />
      <div class="git-collector-thumb-box" title="คลิกเพื่อเลื่อนไปดูภาพนี้บนหน้าเว็บ">
        <img class="git-collector-thumb-img" src="${item.url}" alt="Manga ${index + 1}" loading="lazy" />
      </div>
      <div class="git-collector-item-details">
        <div class="git-collector-item-header">
          <span>ภาพที่ #${index + 1}</span>
          <span class="git-collector-item-dim">${item.width && item.height ? `${item.width}×${item.height}` : ""}</span>
        </div>
        <div class="git-collector-badge ${badgeClass}">${badgeText}</div>
        <button class="git-collector-btn-locate" title="เลื่อนหน้าจอไปยังตำแหน่งภาพนี้">👁️ เลื่อนไปดู</button>
      </div>
    `;

    // ผูก Event Checkbox
    const cb = card.querySelector(".git-collector-checkbox");
    cb.addEventListener("change", (e) => {
      item.selected = e.target.checked;
      card.classList.toggle("git-item-selected", item.selected);
      updateCollectorSelectionStats();
    });

    // คลิก Thumbnail หรือปุ่ม Locate เพื่อเลื่อนหน้าเว็บไปดูภาพนั้น
    const locateImg = () => {
      if (item.el) {
        item.el.scrollIntoView({ behavior: "smooth", block: "center" });
        item.el.style.transition = "outline 0.2s ease, box-shadow 0.2s ease";
        item.el.style.outline = "4px solid #1a73e8";
        item.el.style.boxShadow = "0 0 24px rgba(26, 115, 232, 0.85)";
        setTimeout(() => {
          item.el.style.outline = "";
          item.el.style.boxShadow = "";
        }, 1800);
      }
    };

    const thumb = card.querySelector(".git-collector-thumb-box");
    thumb.addEventListener("click", locateImg);

    const locateBtn = card.querySelector(".git-collector-btn-locate");
    locateBtn.addEventListener("click", locateImg);

    bodyEl.appendChild(card);
  });
}

function updateCollectorSelectionStats() {
  if (!collectorSidebarEl) return;
  const total = collectedMangaImages.length;
  const selectedCount = collectedMangaImages.filter((it) => it.selected).length;
  const selectedText = collectorSidebarEl.querySelector("#git-collector-selected-text");
  const primaryBtn = collectorSidebarEl.querySelector("#git-collector-primary-btn");

  if (selectedText) selectedText.textContent = `เลือกแล้ว: ${selectedCount} / ${total} ภาพ`;
  if (primaryBtn) {
    const btnSpan = primaryBtn.querySelector("span");
    if (btnSpan) btnSpan.textContent = `⚡ แปลภาพที่เลือก (${selectedCount} ภาพ)`;
    primaryBtn.disabled = selectedCount === 0 || isBatchTranslating;
  }
}

/**
 * สแกนรูปภาพใหม่และแสดงผลใน Sidebar
 */
function refreshCollectedImages() {
  collectedMangaImages = extractMangaImages();
  renderSidebarItems();
  updateFloatingTriggerCount();
}

/**
 * อัปเดตตัวเลขบน Floating Trigger Button
 */
function updateFloatingTriggerCount() {
  if (!collectorTriggerBtn) {
    initCollectorTriggerButton();
  }
  const countSpan = document.getElementById("git-trigger-count");
  if (countSpan) {
    countSpan.textContent = String(collectedMangaImages.length);
  }
}

/**
 * 3. ประมวลผลแปลภาพเป็นกลุ่มพร้อมระบบจำกัด Concurrency (1-2 ภาพพร้อมกัน)
 */
async function runBatchTranslation() {
  if (isBatchTranslating) return;

  const selectedItems = collectedMangaImages.filter((it) => it.selected && it.status !== "done");
  if (selectedItems.length === 0) {
    showToastNotification("รูปภาพที่เลือกได้รับการแปลแล้ว หรือยังไม่ได้เลือกภาพ", false);
    return;
  }

  isBatchTranslating = true;
  cancelBatchTranslationFlag = false;

  const sidebar = createOrGetImageCollectorSidebar();
  const providerSelect = sidebar.querySelector("#git-collector-provider");
  const bgModeSelect = sidebar.querySelector("#git-collector-bgmode");
  const provider = providerSelect ? providerSelect.value : "gemini";
  const textBgMode = bgModeSelect ? bgModeSelect.value : "blur";

  const primaryBtn = sidebar.querySelector("#git-collector-primary-btn");
  const cancelBtn = sidebar.querySelector("#git-collector-cancel-btn");
  const progressFill = sidebar.querySelector("#git-collector-progress-fill");
  const progressText = sidebar.querySelector("#git-collector-progress-text");

  if (primaryBtn) primaryBtn.style.display = "none";
  if (cancelBtn) cancelBtn.style.display = "block";

  let completedCount = 0;
  const totalCount = selectedItems.length;

  function updateProgressDisplay() {
    const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
    if (progressFill) progressFill.style.width = pct + "%";
    if (progressText) progressText.textContent = `ความคืบหน้า: ${completedCount} / ${totalCount} ภาพ (${pct}%)`;
  }
  updateProgressDisplay();

  // กำหนด Concurrency = 2 เพื่อป้องกัน Gemini 503 Overload หรือ Quota Rate Limit
  const CONCURRENCY_LIMIT = 2;
  const queue = [...selectedItems];
  let activeWorkers = 0;

  await new Promise((resolve) => {
    function processNext() {
      if (cancelBatchTranslationFlag || queue.length === 0) {
        if (activeWorkers === 0) {
          resolve();
        }
        return;
      }

      while (activeWorkers < CONCURRENCY_LIMIT && queue.length > 0 && !cancelBatchTranslationFlag) {
        const item = queue.shift();
        activeWorkers++;

        item.status = "processing";
        item.statusText = "กำลังดาวน์โหลด...";
        renderSidebarItems();

        (async () => {
          try {
            const dataUrl = await proxyFetchImage(item.url);
            if (cancelBatchTranslationFlag) return;

            const isGoogle = (provider === "google");
            const targetEl = (item.elementId ? getElementByUniqueId(item.elementId) : null) || item.el;

            // ตรวจสอบขนาดความสูงของภาพเพื่อตรวจหาภาพขนาดยาวพิเศษ (Webtoon)
            let imgNaturalHeight = targetEl?.naturalHeight || 0;
            let imgNaturalWidth = targetEl?.naturalWidth || 0;
            if (!imgNaturalHeight || imgNaturalHeight === 0) {
              const dims = await new Promise((r) => {
                const img = new Image();
                img.onload = () => r({ w: img.naturalWidth, h: img.naturalHeight });
                img.onerror = () => r({ w: 0, h: 0 });
                img.src = dataUrl;
              });
              imgNaturalWidth = dims.w;
              imgNaturalHeight = dims.h;
            }

            let segments = [];
            let targetLang = "Thai";

            if (!isGoogle && imgNaturalHeight > 2500) {
              item.statusText = "ตัดแบ่งภาพ Webtoon...";
              renderSidebarItems();

              const sliceRes = await sliceImageVertically(dataUrl, {
                chunkHeight: 2000,
                overlap: 150,
                threshold: 2500
              });

              const chunks = sliceRes.chunks;
              const allSegments = [];
              let chunkFailures = 0;

              for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
                if (cancelBatchTranslationFlag) return;
                const chunk = chunks[cIdx];
                item.statusText = `แปล Webtoon ส่วนที่ ${cIdx + 1}/${chunks.length}...`;
                renderSidebarItems();

                try {
                  const chunkRes = await new Promise((res) => {
                    chrome.runtime.sendMessage(
                      {
                        type: "TRANSLATE_IMAGE_DATA",
                        base64: chunk.base64,
                        mimeType: chunk.mimeType,
                        provider,
                        isGoogle: false,
                        skipSlice: true,
                        response_schema: GEMINI_RESPONSE_SCHEMA
                      },
                      res
                    );
                  });

                  if (chunkRes && chunkRes.success && Array.isArray(chunkRes.segments)) {
                    if (chunkRes.targetLang) targetLang = chunkRes.targetLang;
                    const adjusted = adjustChunkBoxToFullImage(chunkRes.segments, chunk.startY, chunk.chunkH, chunk.fullH);
                    allSegments.push(...adjusted);
                  } else {
                    chunkFailures++;
                    console.warn(`[Gemini Image Translator] Webtoon chunk ${cIdx + 1}/${chunks.length} failed:`, chunkRes?.error);
                  }
                } catch (chunkErr) {
                  // Task 3: Error Recovery - If a chunk fails, log chunk index and continue processing remaining chunks
                  chunkFailures++;
                  console.error(`[Gemini Image Translator] Webtoon chunk ${cIdx + 1}/${chunks.length} error:`, chunkErr);
                }
              }

              if (allSegments.length === 0 && chunkFailures === chunks.length) {
                throw new Error("การแปลล้มเหลวทุกชิ้นส่วนของภาพ Webtoon");
              }

              segments = deduplicateOverlapSegments(allSegments);
            } else {
              item.statusText = "กำลังส่งแปล...";
              renderSidebarItems();

              const mimeType = dataUrl.match(/^data:([^;]+);/)?.[1] || "image/png";
              const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");

              const transRes = await new Promise((res) => {
                chrome.runtime.sendMessage(
                  {
                    type: "TRANSLATE_IMAGE_DATA",
                    base64,
                    mimeType,
                    provider,
                    isGoogle,
                    response_schema: GEMINI_RESPONSE_SCHEMA
                  },
                  res
                );
              });

              if (cancelBatchTranslationFlag) return;

              if (!transRes || !transRes.success) {
                throw new Error(transRes?.error || "เกิดข้อผิดพลาดในการแปล");
              }

              segments = transRes.segments || [];
              if (transRes.targetLang) targetLang = transRes.targetLang;
            }

            if (cancelBatchTranslationFlag) return;

            if (segments.length === 0) {
              item.status = "done";
              item.statusText = "ไม่พบข้อความ";
            } else {
              item.statusText = "กำลังวาดผลลัพธ์...";
              renderSidebarItems();

              await renderTranslatedImage(
                targetEl,
                segments,
                dataUrl,
                targetLang,
                textBgMode
              );

              item.status = "done";
              item.statusText = `แปลแล้ว (${segments.length} ช่อง)`;
            }
          } catch (err) {
            console.error("[Gemini Image Translator] Batch item error:", err);
            item.status = "error";
            item.statusText = err.message || "ล้มเหลว";
          } finally {
            completedCount++;
            renderSidebarItems();
            updateProgressDisplay();
            activeWorkers--;
            processNext();
          }
        })();
      }
    }

    processNext();
  });

  isBatchTranslating = false;
  if (primaryBtn) primaryBtn.style.display = "flex";
  if (cancelBtn) cancelBtn.style.display = "none";
  updateCollectorSelectionStats();

  if (cancelBatchTranslationFlag) {
    showToastNotification("⏹️ หยุดการแปลภาพเรียบร้อยแล้ว", false);
  } else {
    showToastNotification(`🎉 แปลภาพมังงะเสร็จสมบูรณ์ (${completedCount}/${totalCount} ภาพ)`);
  }
}

/**
 * 4. สลับเปิด/ปิด Sidebar Drawer
 */
function toggleImageCollectorSidebar(forceOpen = undefined) {
  const sidebar = createOrGetImageCollectorSidebar();
  const isOpen = sidebar.classList.contains("git-open");
  const shouldOpen = forceOpen !== undefined ? forceOpen : !isOpen;

  if (shouldOpen) {
    sidebar.classList.add("git-open");
    refreshCollectedImages();
    if (collectorTriggerBtn) collectorTriggerBtn.style.display = "none";
  } else {
    sidebar.classList.remove("git-open");
    if (collectorTriggerBtn) collectorTriggerBtn.style.display = "flex";
  }
}

function closeImageCollectorSidebar() {
  toggleImageCollectorSidebar(false);
}

/**
 * ปุ่ม Floating Trigger ด้านขวาล่างของหน้าจอ
 */
function initCollectorTriggerButton() {
  if (collectorTriggerBtn && document.body.contains(collectorTriggerBtn)) return;

  const btn = document.createElement("button");
  btn.id = "git-collector-trigger-btn";
  btn.className = "git-collector-trigger-btn";
  btn.title = "เปิดแผงเลือกภาพมังงะเพื่อแปล (Image Collector)";
  btn.innerHTML = `🖼️ รวมภาพมังงะ (<span id="git-trigger-count">0</span>)`;

  btn.addEventListener("click", () => {
    toggleImageCollectorSidebar(true);
  });

  document.body.appendChild(btn);
  collectorTriggerBtn = btn;
}

// ตรวจสอบและเริ่มต้นสแกนเมื่อโหลดหน้าเว็บ
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      collectedMangaImages = extractMangaImages();
      if (collectedMangaImages.length > 0) {
        initCollectorTriggerButton();
        updateFloatingTriggerCount();
      }
    });
  } else {
    setTimeout(() => {
      collectedMangaImages = extractMangaImages();
      if (collectedMangaImages.length > 0) {
        initCollectorTriggerButton();
        updateFloatingTriggerCount();
      }
    }, 1000);
  }
}

if (typeof window !== "undefined") {
  window.extractMangaImages = extractMangaImages;
  window.toggleImageCollectorSidebar = toggleImageCollectorSidebar;
  window.createOrGetImageCollectorSidebar = createOrGetImageCollectorSidebar;
  window.sliceImageVertically = sliceImageVertically;
  window.adjustChunkBoxToFullImage = adjustChunkBoxToFullImage;
  window.deduplicateOverlapSegments = deduplicateOverlapSegments;
  window.GEMINI_RESPONSE_SCHEMA = GEMINI_RESPONSE_SCHEMA;
}
