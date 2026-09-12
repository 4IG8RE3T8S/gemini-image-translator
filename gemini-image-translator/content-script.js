// content-script.js — runs on every page, listens for messages from background.js

const FONT_FAMILY =
  "'Noto Sans Thai', 'Noto Sans JP', 'Noto Sans SC', 'Noto Sans KR', 'Sarabun', 'Leelawadee UI', 'Meiryo', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

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
      lastRightClickedInfo = { element: bgEl, bgUrl, srcUrl: bgUrl, isBg: true };
    } else if (target.tagName && target.tagName.toLowerCase() === "img") {
      lastRightClickedInfo = {
        element: target,
        srcUrl: target.currentSrc || target.src || target.getAttribute("data-src") || target.getAttribute("data-original"),
        isBg: false
      };
    } else {
      lastRightClickedInfo = null;
    }
  },
  true
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_AREA_SELECTION") {
    startScreenAreaSelection();
  } else if (msg.type === "GET_LAST_BG_IMAGE") {
    if (lastRightClickedInfo && lastRightClickedInfo.isBg && lastRightClickedInfo.bgUrl) {
      sendResponse({ success: true, bgUrl: lastRightClickedInfo.bgUrl });
    } else {
      sendResponse({ success: false });
    }
    return true;
  } else if (msg.type === "SHOW_TOAST") {
    showToastNotification(msg.message, msg.isError || false);
  } else if (msg.type === "IT_LOADING") {
    const targets = findImages(msg.srcUrl);
    targets.forEach((el) => (el.style.opacity = "0.5"));
  } else if (msg.type === "IT_RESULT") {
    const targets = findImages(msg.srcUrl);
    if (!msg.segments || msg.segments.length === 0) {
      targets.forEach((el) => (el.style.opacity = "1"));
      showToastNotification("ไม่พบข้อความในรูปภาพนี้", false);
      return;
    }
    if (targets.length === 0) {
      showToastNotification("แปลข้อความสำเร็จ แต่ไม่พบ Element รูปภาพบนหน้าเว็บเดิม (แนะนำให้ใช้ 'เลือกพื้นที่หน้าจอเพื่อแปล')", false);
      return;
    }
    const dataUrl = msg.dataUrl || (msg.base64 ? `data:${msg.mimeType || "image/png"};base64,${msg.base64}` : null);
    targets.forEach((el) => {
      renderTranslatedImage(el, msg.segments, dataUrl, msg.targetLang).catch((err) => {
        el.style.opacity = "1";
        console.error("[Gemini Image Translator]", err);
        showToastNotification("เกิดข้อผิดพลาดในการวาดภาพแปล: " + (err.message || String(err)), true);
      });
    });
  } else if (msg.type === "IT_ERROR") {
    findImages(msg.srcUrl).forEach((el) => (el.style.opacity = "1"));
    console.error("[Gemini Image Translator]", msg.message);
    showToastNotification("แปลภาพไม่สำเร็จ:\n" + msg.message, true);
  }
});

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
async function renderTranslatedImage(el, segments, initialDataUrl = null, targetLang = "Thai") {
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

  // 3. สุ่มตัวอย่างสีพื้นหลังรอบกล่องข้อความ และวาดข้อความแปล
  renderSegmentsOnCanvas(canvas, ctx, segments, targetLang);

  let resultDataUrl;
  try {
    resultDataUrl = canvas.toDataURL("image/png");
  } catch (e) {
    throw new Error("Canvas ถูก taint จากรูปข้าม origin: " + (e.message || String(e)));
  }

  // 4.1 จัดการกรณี CSS background-image
  if (!isImage) {
    el.style.opacity = "1";
    if (!el.hasAttribute("data-git-orig-bg")) {
      el.setAttribute("data-git-orig-bg", el.style.backgroundImage || window.getComputedStyle(el).backgroundImage);
    }
    el.style.backgroundImage = `url("${resultDataUrl}")`;
    el.setAttribute("data-git-translated", "true");
    return;
  }

  // 4.2 จัดการกรณี Responsive srcset บน <img>
  // Chromium ให้ความสำคัญกับ srcset มากกว่า src ดังนั้นต้องสำรองและลบ srcset ออก
  if (el.hasAttribute("srcset")) {
    if (!el.hasAttribute("data-git-orig-srcset")) {
      el.setAttribute("data-git-orig-srcset", el.getAttribute("srcset") || "");
    }
    el.removeAttribute("srcset");
  }

  // 4.3 จัดการกรณี <picture> พร้อมแท็ก <source>
  // หากมี <source srcset="..."> พี่น้อง เบราว์เซอร์จะเพิกเฉยต่อ <img> ดังนั้นต้องอัปเดต source ทั้งหมด
  const picture = el.closest("picture");
  if (picture) {
    const sources = picture.querySelectorAll("source");
    sources.forEach((source) => {
      if (!source.hasAttribute("data-git-orig-srcset")) {
        source.setAttribute("data-git-orig-srcset", source.getAttribute("srcset") || "");
      }
      source.setAttribute("srcset", resultDataUrl);
    });
  }

  // 4.4 จัดการกรณี Lazy-Loaded Image & Observers
  // ติด flag เพื่อป้องกัน third-party lazy-loading library (lazysizes, lozad) revert รูปกลับ
  el.setAttribute("data-git-translated", "true");
  const lazyAttrs = ["data-src", "data-original", "data-lazy-src", "data-url", "data-actualsrc"];
  lazyAttrs.forEach((attr) => {
    if (el.hasAttribute(attr)) {
      if (!el.hasAttribute(`data-git-orig-${attr}`)) {
        el.setAttribute(`data-git-orig-${attr}`, el.getAttribute(attr) || "");
      }
      el.setAttribute(attr, resultDataUrl);
    }
  });

  // 4.5 จัดการกรณี Strict Content-Security-Policy (CSP)
  // หากเว็บมี CSP ปฏิเสธ data: ใน img-src ให้สลับไปใช้ Canvas Swap ทันที
  let cspHandled = false;
  const originalOnError = el.onerror;

  el.onerror = (evt) => {
    if (el.src && el.src.startsWith("data:") && !cspHandled) {
      console.warn("[Gemini Image Translator] CSP บล็อก data: URL บน <img> สลับไปใช้ Canvas Swap แทน...");
      cspHandled = true;
      applyCanvasSwap(el, canvas);
    }
    if (originalOnError && !cspHandled) {
      originalOnError.call(el, evt);
    }
  };

  el.style.opacity = "1";
  try {
    el.src = resultDataUrl;
  } catch (assignErr) {
    console.warn("[Gemini Image Translator] img.src assignment failed, applying Canvas Swap fallback:", assignErr);
    applyCanvasSwap(el, canvas);
  }
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

  // ค้นหาขนาดฟอนต์ที่ใหญ่ที่สุดที่ตัดคำแล้วความสูงรวมไม่เกินความสูงกล่อง
  for (let size = maxFontSize; size >= minFontSize; size--) {
    ctx.font = `600 ${size}px ${FONT_FAMILY}`;
    const lineHeight = Math.round(size * 1.28);
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
    const lineHeight = Math.round(minFontSize * 1.28);
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

function drawSegment(ctx, seg, lang = "Thai") {
  const { x, y, w, h, bg } = seg;
  const textToDraw = String(seg.translated_text || seg.text || "").trim();
  if (!textToDraw) return;

  // วาดกล่องสีพื้นหลังที่ตรวจจับได้จากภาพต้นฉบับ
  ctx.fillStyle = bg?.css || "#ffffff";
  ctx.fillRect(x, y, w, h);

  // กำหนด padding เล็กน้อยเพื่อไม่ให้ตัวหนังสือติดขอบกล่อง
  const padX = Math.max(2, Math.min(8, Math.floor(w * 0.05)));
  const padY = Math.max(2, Math.min(6, Math.floor(h * 0.05)));
  const usableW = Math.max(10, w - padX * 2);
  const usableH = Math.max(10, h - padY * 2);

  // คำนวณขนาดฟอนต์และการตัดคำที่พอดีกับกรอบ
  const layout = calculateOptimalLayout(ctx, textToDraw, usableW, usableH, lang);
  if (!layout || !layout.lines || layout.lines.length === 0) return;

  // กำหนดรูปแบบตัวหนังสือและการจัดกึ่งกลาง
  ctx.font = `600 ${layout.fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = bg?.isDark ? "#ffffff" : "#000000";

  // พิกัดจัดกึ่งกลางแนวนอนและแนวตั้ง
  const centerX = x + w / 2;
  const startY = y + (h - layout.totalHeight) / 2 + layout.lineHeight / 2;

  // วาดข้อความแต่ละบรรทัด
  for (let i = 0; i < layout.lines.length; i++) {
    const lineY = startY + i * layout.lineHeight;
    ctx.fillText(layout.lines[i], centerX, lineY);
  }
}

/**
 * วาดกล่องข้อความและคำแปลทั้งหมดลงบน Canvas
 * รวมการตรวจสอบพิกัด, สุ่มตัวอย่างสีพื้นหลัง และการจัดวางข้อความแบบอัจฉริยะ (ใช้ร่วมกันทั้งภาพปกติและภาพครอป)
 */
function renderSegmentsOnCanvas(canvas, ctx, segments, targetLang = "Thai") {
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
    drawSegment(ctx, seg, targetLang);
  }
}

// =========================================================================
// ส่วนการเลือกพื้นที่หน้าจอ (Screen Snipping), ครอปภาพ และแสดงผลแบบ Overlay
// สำหรับเว็บไซต์ที่ใช้ background-image, canvas หรือภาพที่ไม่ใช่ <img> ธรรมดา
// =========================================================================

let activeSelectionMask = null;

function startScreenAreaSelection() {
  if (activeSelectionMask) {
    activeSelectionMask.remove();
    activeSelectionMask = null;
  }

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
  banner.textContent = "📐 ลากเมาส์เพื่อเลือกพื้นที่ที่ต้องการแปล • กด Esc เพื่อยกเลิก";
  banner.style.cssText = `
    position: absolute;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.82);
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
    border: 2px dashed #4285f4;
    background: rgba(66, 133, 244, 0.18);
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
      dpr: window.devicePixelRatio || 1
    };

    // หน่วงเวลาเล็กน้อยเพื่อให้ DOM ลบ overlay ออกจากหน้าจอให้เรียบร้อยก่อน capture
    setTimeout(() => {
      handleAreaCapturedAndTranslate(rect);
    }, 60);
  };

  mask.addEventListener("mousedown", onMouseDown);
  mask.addEventListener("mousemove", onMouseMove);
  mask.addEventListener("mouseup", onMouseUp);
  window.addEventListener("keydown", onKeyDown);

  document.body.appendChild(mask);
}

async function handleAreaCapturedAndTranslate(rect) {
  const overlay = createFloatingOverlay(rect);

  try {
    // 1. ส่งคำขอให้ background service worker แคปเจอร์หน้าจอ
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

    // 3. ส่งข้อมูลภาพที่ครอปแล้วเข้าสู่ Translation Pipeline ใน background
    const transRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "TRANSLATE_IMAGE_DATA", base64, mimeType: "image/png" },
        resolve
      );
    });

    if (!transRes || !transRes.success) {
      throw new Error(transRes?.error || "เกิดข้อผิดพลาดในการแปลภาพ");
    }

    const segments = transRes.segments || [];
    if (segments.length === 0) {
      overlay.showStatus("ไม่พบข้อความในพื้นที่ที่เลือก", true);
      return;
    }

    // 4. วาดข้อความแปลทับลงบน cropCanvas ด้วยระบบสีและฟอนต์เดิม
    await ensureFontsLoaded();
    renderSegmentsOnCanvas(cropCanvas, cropCtx, segments, transRes.targetLang || "Thai");

    const translatedCroppedDataUrl = cropCanvas.toDataURL("image/png");

    // 5. นำภาพผลลัพธ์ใส่ใน Floating Overlay
    overlay.showResult(translatedCroppedDataUrl, originalCroppedDataUrl);
  } catch (err) {
    console.error("[Gemini Image Translator]", err);
    overlay.showStatus(err.message || String(err), false, true);
  }
}

function createFloatingOverlay(rect) {
  const container = document.createElement("div");
  container.className = "git-floating-overlay";
  container.style.cssText = `
    position: absolute;
    left: ${rect.x + rect.scrollX}px;
    top: ${rect.y + rect.scrollY}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    z-index: 2147483640;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
    border: 2px solid #4285f4;
    border-radius: 4px;
    overflow: hidden;
    background: #ffffff;
    box-sizing: border-box;
    font-family: system-ui, sans-serif;
  `;

  // กล่องสถานะ Loading
  const loadingEl = document.createElement("div");
  loadingEl.style.cssText = `
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.92);
    color: #1a73e8;
    font-size: 13px;
    font-weight: 500;
    padding: 12px;
    text-align: center;
    box-sizing: border-box;
  `;
  loadingEl.innerHTML = `
    <div style="width: 24px; height: 24px; border: 3px solid #e8f0fe; border-top-color: #1a73e8; border-radius: 50%; animation: git-spin 0.8s linear infinite; margin-bottom: 8px;"></div>
    <span>กำลังแปลด้วย Gemini...</span>
  `;
  container.appendChild(loadingEl);

  // ปุ่มปิด (✕)
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.title = "ปิด (Close)";
  closeBtn.style.cssText = `
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 2147483646;
    background: rgba(0, 0, 0, 0.65);
    color: #ffffff;
    border: none;
    border-radius: 50%;
    width: 22px;
    height: 22px;
    font-size: 12px;
    line-height: 22px;
    text-align: center;
    cursor: pointer;
    padding: 0;
    transition: background 0.2s;
  `;
  closeBtn.addEventListener("mouseenter", () => (closeBtn.style.background = "#d93025"));
  closeBtn.addEventListener("mouseleave", () => (closeBtn.style.background = "rgba(0, 0, 0, 0.65)"));
  closeBtn.addEventListener("click", () => container.remove());
  container.appendChild(closeBtn);

  // สร้าง animation สำหรับ loading spinner
  if (!document.getElementById("git-spinner-style")) {
    const style = document.createElement("style");
    style.id = "git-spinner-style";
    style.textContent = `@keyframes git-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }

  document.body.appendChild(container);

  return {
    showStatus(msg, autoClose = false, isError = false) {
      loadingEl.innerHTML = `
        <div style="font-size: 13px; color: ${isError ? "#d93025" : "#333"}; padding: 8px; line-height: 1.4;">${msg}</div>
      `;
      if (autoClose) {
        setTimeout(() => container.remove(), 2500);
      }
    },
    showResult(translatedDataUrl, originalDataUrl) {
      loadingEl.style.display = "none";

      const imgEl = document.createElement("img");
      imgEl.src = translatedDataUrl;
      imgEl.style.cssText = `
        width: 100%;
        height: 100%;
        object-fit: fill;
        display: block;
        user-select: none;
      `;
      container.appendChild(imgEl);

      // ปุ่มดูภาพต้นฉบับ (กดค้างไว้เพื่อดูภาพเดิม)
      const peekBtn = document.createElement("button");
      peekBtn.textContent = "👁️ ต้นฉบับ";
      peekBtn.title = "กดค้างเพื่อดูภาพต้นฉบับ";
      peekBtn.style.cssText = `
        position: absolute;
        bottom: 6px;
        right: 6px;
        z-index: 2147483646;
        background: rgba(0, 0, 0, 0.65);
        color: #ffffff;
        border: none;
        border-radius: 12px;
        font-size: 11px;
        padding: 3px 8px;
        cursor: pointer;
        user-select: none;
      `;
      const showOrig = () => {
        imgEl.src = originalDataUrl;
        peekBtn.textContent = "✨ แปลแล้ว";
      };
      const showTrans = () => {
        imgEl.src = translatedDataUrl;
        peekBtn.textContent = "👁️ ต้นฉบับ";
      };

      peekBtn.addEventListener("mousedown", showOrig);
      window.addEventListener("mouseup", () => {
        if (imgEl.src === originalDataUrl) showTrans();
      });

      container.appendChild(peekBtn);
    }
  };
}
