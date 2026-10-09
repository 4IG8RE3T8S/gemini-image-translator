// background.js — service worker (Manifest V3)

const MENU_IMAGE_ID = "gemini-translate-image";
const MENU_GT_IMAGE_ID = "gemini-translate-gt-image";
const MENU_BG_IMAGE_ID = "gemini-translate-bg-image";
const MENU_AREA_ID = "gemini-translate-area";
const MENU_GT_AREA_ID = "gemini-translate-gt-area";
const MENU_COLLECTOR_ID = "gemini-image-collector";
const MAX_CACHE_ENTRIES = 100;

// โครงสร้าง Gemini Structured Outputs Response Schema ที่เข้มงวด ป้องกันการตอบ JSON ผิดเพี้ยน
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

function mapToGoogleTranslateCode(langNameOrCode) {
  if (!langNameOrCode) return "th";
  const map = {
    thai: "th",
    th: "th",
    english: "en",
    en: "en",
    japanese: "ja",
    ja: "ja",
    chinese: "zh-CN",
    "chinese (simplified)": "zh-CN",
    "chinese (traditional)": "zh-TW",
    zh: "zh-CN",
    korean: "ko",
    ko: "ko",
    spanish: "es",
    es: "es",
    french: "fr",
    fr: "fr",
    german: "de",
    de: "de",
    russian: "ru",
    ru: "ru",
    vietnamese: "vi",
    vi: "vi",
    indonesian: "id",
    id: "id"
  };
  const key = String(langNameOrCode).toLowerCase().trim();
  return map[key] || (key.length === 2 ? key : "th");
}

function mapFromGoogleTranslateCode(code) {
  if (!code) return "Thai";
  const map = {
    th: "Thai",
    en: "English",
    ja: "Japanese",
    "zh-cn": "Chinese",
    "zh-tw": "Chinese (Traditional)",
    zh: "Chinese",
    ko: "Korean",
    es: "Spanish",
    fr: "French",
    de: "German",
    ru: "Russian",
    vi: "Vietnamese",
    id: "Indonesian"
  };
  const key = String(code).toLowerCase().trim();
  return map[key] || "Thai";
}

chrome.runtime.onInstalled.addListener(() => {
  // ลบเมนูเก่าทั้งหมดก่อน เพื่อป้องกัน Duplicate ID Error เมื่อ Extension ถูกอัปเดต
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_IMAGE_ID,
      title: "แปลภาพนี้ด้วย Gemini",
      contexts: ["image"]
    });

    chrome.contextMenus.create({
      id: MENU_GT_IMAGE_ID,
      title: "แปลภาพนี้ด้วย Google Translate (Images)",
      contexts: ["image"]
    });

    chrome.contextMenus.create({
      id: MENU_BG_IMAGE_ID,
      title: "แปลภาพพื้นหลังนี้ด้วย Gemini (CSS Background)",
      contexts: ["page", "frame"]
    });

    chrome.contextMenus.create({
      id: MENU_AREA_ID,
      title: "เลือกพื้นที่หน้าจอเพื่อแปล (Gemini)",
      contexts: ["page", "frame", "selection", "image"]
    });

    chrome.contextMenus.create({
      id: MENU_GT_AREA_ID,
      title: "เลือกพื้นที่เพื่อแปลด้วย Google Translate",
      contexts: ["page", "frame", "selection", "image"]
    });

    chrome.contextMenus.create({
      id: MENU_COLLECTOR_ID,
      title: "ดึงภาพทั้งหมดในหน้านี้เพื่อแปล",
      contexts: ["page", "frame", "selection", "image"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  // 1. กรณีเลือกพื้นที่หน้าจอ
  if (info.menuItemId === MENU_AREA_ID) {
    chrome.tabs.sendMessage(tab.id, { type: "START_AREA_SELECTION" });
    return;
  }

  // 1.1 กรณีเลือกพื้นที่เพื่อแปลด้วย Google Translate
  if (info.menuItemId === MENU_GT_AREA_ID) {
    chrome.tabs.sendMessage(tab.id, { type: "START_AREA_SELECTION_GT" });
    return;
  }

  // 1.2 กรณีเปิดตัวเก็บภาพมังงะ (Image Collector Sidebar)
  if (info.menuItemId === MENU_COLLECTOR_ID) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_IMAGE_COLLECTOR" });
    return;
  }

  // 2. กรณีแปลรูปภาพ <img> ปกติ ด้วย Gemini
  if (info.menuItemId === MENU_IMAGE_ID && info.srcUrl) {
    chrome.tabs.sendMessage(tab.id, { type: "GET_LAST_RIGHT_CLICKED_INFO" }, async (res) => {
      const elementId = res?.elementId || null;
      await handleTranslateImageUrl(info.srcUrl, tab.id, "gemini", elementId);
    });
    return;
  }

  // 2.1 กรณีแปลรูปภาพด้วย Google Translate โดยตรง (แปลและวาดทับบนภาพเดิมในหน้าเว็บ ไม่เปิดแท็บภายนอก)
  if (info.menuItemId === MENU_GT_IMAGE_ID && info.srcUrl) {
    chrome.tabs.sendMessage(tab.id, { type: "GET_LAST_RIGHT_CLICKED_INFO" }, async (res) => {
      const elementId = res?.elementId || null;
      await handleTranslateImageUrl(info.srcUrl, tab.id, "google", elementId);
    });
    return;
  }

  // 3. กรณีแปลรูปภาพจาก CSS background-image
  if (info.menuItemId === MENU_BG_IMAGE_ID) {
    chrome.tabs.sendMessage(tab.id, { type: "GET_LAST_RIGHT_CLICKED_INFO" }, async (res) => {
      if (!res || !res.success || !res.bgUrl) {
        chrome.tabs.sendMessage(tab.id, {
          type: "SHOW_TOAST",
          message: "ไม่พบรูปภาพพื้นหลังในตำแหน่งที่คลิก (แนะนำให้ใช้ 'เลือกพื้นที่หน้าจอเพื่อแปล' หรือคลิกขวาที่แท็กรูปภาพ)",
          isError: false
        });
        return;
      }
      const elementId = res?.elementId || null;
      await handleTranslateImageUrl(res.bgUrl, tab.id, "gemini", elementId);
    });
    return;
  }
});

function safeSendTabMessage(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        // Tab might be closed or navigated away
      }
    });
  } catch {}
}

async function handleTranslateImageUrl(srcUrl, tabId, provider = "gemini", elementId = null) {
  const settings = await chrome.storage.local.get([
    "backendUrl",
    "authToken",
    "model",
    "targetLang",
    "textBackgroundMode",
    "textBgMode",
    "googleTranslateLangCode",
    "enableRetry",
    "maxRetries",
    "retryInitialDelay"
  ]);

  let textBackgroundMode = settings.textBackgroundMode || settings.textBgMode;
  if (!textBackgroundMode && chrome.storage && chrome.storage.sync) {
    try {
      const syncData = await chrome.storage.sync.get(["textBackgroundMode"]);
      if (syncData?.textBackgroundMode) textBackgroundMode = syncData.textBackgroundMode;
    } catch {}
  }
  if (!textBackgroundMode) textBackgroundMode = "blur";

  if (!settings.authToken) {
    safeSendTabMessage(tabId, {
      type: "IT_ERROR",
      srcUrl,
      elementId,
      message: "กรุณาเข้าสู่ระบบหรือตั้งค่า User Auth Token ในหน้า Options ก่อน (คลิกขวาที่ไอคอนส่วนเสริม > Options)"
    });
    return;
  }

  const isGoogle = (provider === "google") || (typeof provider === "object" && provider?.isGoogle === true) || false;
  const backendUrl = settings.backendUrl || "http://127.0.0.1:8000";
  let targetLang = settings.targetLang || "Thai";
  if (isGoogle && settings.googleTranslateLangCode) {
    targetLang = mapFromGoogleTranslateCode(settings.googleTranslateLangCode);
  }
  const model = settings.model || "gemini-2.0-flash";
  const enableRetry = settings.enableRetry !== false;
  const maxRetries = enableRetry ? Math.max(1, parseInt(settings.maxRetries, 10) || 3) : 0;
  const initialDelayMs = (parseInt(settings.retryInitialDelay, 10) || 2) * 1000;

  let currentBase64 = null;
  let currentMimeType = "image/png";

  try {
    safeSendTabMessage(tabId, { type: "IT_LOADING", srcUrl, elementId });

    // ดึงรูปและคำนวณ SHA-256 hash ของรูปภาพ
    const { base64, mimeType, hash, blob, buffer } = await fetchImageAsBase64(srcUrl);
    currentBase64 = base64;
    currentMimeType = mimeType;

    const maxOutputTokens = Math.max(4096, parseInt(settings.maxOutputTokens, 10) || 8192);

    let bitmap = null;
    try {
      if (blob && typeof createImageBitmap === "function") {
        bitmap = await createImageBitmap(blob);
      }
    } catch (bmErr) {
      console.warn("[Gemini Image Translator] createImageBitmap error:", bmErr);
    }

    let segments = [];
    const isUltraTall = !isGoogle && bitmap && bitmap.height > 2500;

    if (isUltraTall) {
      console.log(`[Gemini Image Translator] ตรวจพบรูปภาพขนาดยาวพิเศษ (Webtoon) ขนาด ${bitmap.width}x${bitmap.height}px (>2500px) กำลังตัดแบ่งภาพในแนวตั้ง...`);
      const chunks = await sliceBitmapVerticallyInWorker(bitmap, 2000, 150);
      const allSegments = [];
      let chunkFailCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        safeSendTabMessage(tabId, {
          type: "IT_CHUNKING_PROGRESS",
          srcUrl,
          elementId,
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          message: `กำลังแปล Webtoon ส่วนที่ ${i + 1}/${chunks.length}...`
        });

        try {
          const chunkRes = await processTranslationPipeline({
            base64: chunk.base64,
            mimeType: chunk.mimeType,
            hash: chunk.hash,
            backendUrl,
            authToken: settings.authToken,
            model,
            targetLang,
            maxOutputTokens,
            maxRetries,
            initialDelayMs,
            onRetry: ({ attempt, maxRetries: totalRetries, delaySec, error }) => {
              safeSendTabMessage(tabId, {
                type: "IT_RETRYING",
                srcUrl,
                elementId,
                attempt,
                maxRetries: totalRetries,
                delaySec,
                errorMessage: `[ส่วนที่ ${i + 1}/${chunks.length}] ${error?.message || String(error)}`
              });
            }
          });

          if (chunkRes && Array.isArray(chunkRes.segments)) {
            const adjusted = adjustChunkBoxToFullImage(chunkRes.segments, chunk.startY, chunk.chunkH, chunk.fullH);
            allSegments.push(...adjusted);
          }
        } catch (chunkErr) {
          // Task 3: Error Recovery - If a chunk fails, log chunk index and continue processing remaining chunks
          chunkFailCount++;
          console.warn(`[Gemini Image Translator] แปลชิ้นส่วนที่ ${i + 1}/${chunks.length} ล้มเหลว (${chunkErr.message || chunkErr}) ดำเนินการชิ้นส่วนถัดไป...`);
          safeSendTabMessage(tabId, {
            type: "IT_CHUNK_ERROR",
            srcUrl,
            elementId,
            chunkIndex: i + 1,
            totalChunks: chunks.length,
            error: chunkErr.message || String(chunkErr)
          });
        }
      }

      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }

      if (allSegments.length === 0 && chunkFailCount === chunks.length) {
        throw new Error("การแปลล้มเหลวทุกชิ้นส่วนของภาพ Webtoon");
      }

      segments = deduplicateOverlapSegments(allSegments);
    } else {
      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }

      // ประมวลผลผ่าน Translation Pipeline ส่งไปยัง Backend Proxy Server (พร้อม Exponential Backoff: 2s -> 4s -> 8s)
      const pipeRes = await processTranslationPipeline({
        base64,
        mimeType,
        hash,
        buffer,
        backendUrl,
        authToken: settings.authToken,
        model,
        targetLang,
        maxOutputTokens,
        maxRetries,
        initialDelayMs,
        onRetry: ({ attempt, maxRetries: totalRetries, delaySec, error }) => {
          safeSendTabMessage(tabId, {
            type: "IT_RETRYING",
            srcUrl,
            elementId,
            attempt,
            maxRetries: totalRetries,
            delaySec,
            errorMessage: error?.message || String(error)
          });
        }
      });
      segments = pipeRes.segments;
    }

    const dataUrl = `data:${mimeType};base64,${base64}`;

    safeSendTabMessage(tabId, {
      type: "IT_RESULT",
      srcUrl,
      elementId,
      base64,
      mimeType,
      dataUrl,
      segments,
      targetLang,
      textBackgroundMode: textBackgroundMode,
      textBgMode: textBackgroundMode
    });
  } catch (err) {
    const isQuota = err.isQuotaExceeded === true || err.status === 429 || (err.message && (err.message.includes("โควต้า") || err.message.includes("Quota")));
    const fallbackSettings = await chrome.storage.local.get([
      "enableGoogleTranslateFallback",
      "googleTranslateFallbackMode",
      "googleTranslateLangCode"
    ]);
    const langCode = fallbackSettings.googleTranslateLangCode || mapToGoogleTranslateCode(targetLang);
    const dataUrl = currentBase64 ? `data:${currentMimeType};base64,${currentBase64}` : null;

    safeSendTabMessage(tabId, {
      type: "IT_ERROR",
      srcUrl,
      elementId,
      message: err.message || String(err),
      isQuotaExceeded: isQuota,
      enableFallback: fallbackSettings.enableGoogleTranslateFallback !== false,
      fallbackMode: fallbackSettings.googleTranslateFallbackMode || "ask",
      targetLangCode: langCode,
      dataUrl,
      base64: currentBase64,
      mimeType: currentMimeType
    });
  }
}

// Listener สำหรับ Content Script หรือส่วนอื่นๆ
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "PROXY_FETCH_IMAGE") {
    fetchImageAsBase64(request.url)
      .then(({ base64, mimeType }) => {
        sendResponse({
          success: true,
          base64,
          mimeType,
          dataUrl: `data:${mimeType};base64,${base64}`
        });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: err.message || String(err)
        });
      });
    return true; // เปิด message port ไว้รองรับการตอบกลับแบบ asynchronous
  }

  // แคปเจอร์หน้าจอแท็บที่กำลังทำงานอยู่
  if (request.type === "CAPTURE_VISIBLE_TAB") {
    const windowId = sender.tab?.windowId || null;
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else if (!dataUrl) {
        sendResponse({ success: false, error: "ไม่สามารถจับภาพหน้าจอได้" });
      } else {
        sendResponse({ success: true, dataUrl });
      }
    });
    return true;
  }

  // เปิดแท็บ Google Translate Images
  if (request.type === "OPEN_GOOGLE_TRANSLATE_TAB") {
    const langCode = request.targetLangCode || "th";
    const url = `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(langCode)}&op=images`;
    chrome.tabs.create({ url });
    sendResponse({ success: true, url });
    return true;
  }

  // ส่งข้อมูลรูปภาพที่ถูกครอปแล้ว เข้าสู่ Translation Pipeline
  if (request.type === "TRANSLATE_IMAGE_DATA") {
    (async () => {
      try {
        const settings = await chrome.storage.local.get([
          "backendUrl",
          "authToken",
          "model",
          "targetLang",
          "textBackgroundMode",
          "textBgMode",
          "googleTranslateLangCode",
          "maxOutputTokens",
          "enableRetry",
          "maxRetries",
          "retryInitialDelay"
        ]);
        let textBackgroundMode = settings.textBackgroundMode || settings.textBgMode;
        if (!textBackgroundMode && chrome.storage && chrome.storage.sync) {
          try {
            const syncData = await chrome.storage.sync.get(["textBackgroundMode"]);
            if (syncData?.textBackgroundMode) textBackgroundMode = syncData.textBackgroundMode;
          } catch {}
        }
        if (!textBackgroundMode) textBackgroundMode = "blur";

        const isGoogle = (request?.isGoogle === true) || (request?.provider === "google") || false;
        const backendUrl = settings.backendUrl || "http://127.0.0.1:8000";
        let targetLang = settings.targetLang || "Thai";
        if (isGoogle && settings.googleTranslateLangCode) {
          targetLang = mapFromGoogleTranslateCode(settings.googleTranslateLangCode);
        }
        const model = settings.model || "gemini-2.0-flash";
        const maxOutputTokens = Math.max(4096, parseInt(settings.maxOutputTokens, 10) || 8192);
        const enableRetry = settings.enableRetry !== false;
        const maxRetries = enableRetry ? Math.max(1, parseInt(settings.maxRetries, 10) || 3) : 0;
        const initialDelayMs = (parseInt(settings.retryInitialDelay, 10) || 2) * 1000;
        const tabId = sender.tab?.id;

        let bitmap = null;
        if (!isGoogle && !request.skipSlice && request.base64) {
          try {
            const raw = atob(request.base64);
            const u8 = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
            const blob = new Blob([u8], { type: request.mimeType || "image/png" });
            if (typeof createImageBitmap === "function") {
              bitmap = await createImageBitmap(blob);
            }
          } catch {}
        }

        if (bitmap && bitmap.height > 2500) {
          console.log(`[Gemini Image Translator] TRANSLATE_IMAGE_DATA ตรวจพบภาพ Webtoon ความสูง ${bitmap.height}px (>2500px) กำลังตัดแบ่งภาพ...`);
          const chunks = await sliceBitmapVerticallyInWorker(bitmap, 2000, 150);
          const allSegments = [];
          let chunkFailures = 0;

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            try {
              const { segments: chunkSegs } = await processTranslationPipeline({
                base64: chunk.base64,
                mimeType: chunk.mimeType,
                hash: chunk.hash,
                backendUrl,
                authToken: settings.authToken,
                model,
                targetLang,
                maxOutputTokens,
                maxRetries,
                initialDelayMs
              });
              if (Array.isArray(chunkSegs)) {
                allSegments.push(...adjustChunkBoxToFullImage(chunkSegs, chunk.startY, chunk.chunkH, chunk.fullH));
              }
            } catch (chunkErr) {
              chunkFailures++;
              console.warn(`[Gemini Image Translator] TRANSLATE_IMAGE_DATA ชิ้นส่วนที่ ${i + 1}/${chunks.length} ล้มเหลว:`, chunkErr);
            }
          }

          if (bitmap && typeof bitmap.close === "function") bitmap.close();

          if (allSegments.length === 0 && chunkFailures === chunks.length) {
            throw new Error("การแปลล้มเหลวทุกชิ้นส่วนของภาพ Webtoon");
          }

          const segments = deduplicateOverlapSegments(allSegments);
          sendResponse({
            success: true,
            segments,
            targetLang,
            textBackgroundMode: textBackgroundMode,
            textBgMode: textBackgroundMode,
            fromCache: false
          });
          return;
        }

        if (bitmap && typeof bitmap.close === "function") bitmap.close();

        const { segments, fromCache } = await processTranslationPipeline({
          base64: request.base64,
          mimeType: request.mimeType || "image/png",
          backendUrl,
          authToken: settings.authToken,
          model,
          targetLang,
          maxOutputTokens,
          maxRetries,
          initialDelayMs,
          onRetry: ({ attempt, maxRetries: totalRetries, delaySec, error }) => {
            if (tabId) {
              safeSendTabMessage(tabId, {
                type: "AREA_TRANSLATE_RETRYING",
                attempt,
                maxRetries: totalRetries,
                delaySec,
                errorMessage: error?.message || String(error)
              });
            }
          }
        });

        sendResponse({
          success: true,
          segments,
          targetLang,
          textBackgroundMode: textBackgroundMode,
          textBgMode: textBackgroundMode,
          fromCache
        });
      } catch (err) {
        const isQuota = err.isQuotaExceeded === true || err.status === 429 || (err.message && (err.message.includes("โควต้า") || err.message.includes("Quota")));
        const fallbackSettings = await chrome.storage.local.get([
          "enableGoogleTranslateFallback",
          "googleTranslateFallbackMode",
          "googleTranslateLangCode"
        ]);
        const targetLang = (await chrome.storage.local.get(["targetLang"])).targetLang || "Thai";
        const langCode = fallbackSettings.googleTranslateLangCode || mapToGoogleTranslateCode(targetLang);
        sendResponse({
          success: false,
          error: err.message || String(err),
          isQuotaExceeded: isQuota,
          enableFallback: fallbackSettings.enableGoogleTranslateFallback !== false,
          fallbackMode: fallbackSettings.googleTranslateFallbackMode || "ask",
          targetLangCode: langCode
        });
      }
    })();
    return true;
  }
});

/**
 * Shared Translation Pipeline:
 * ตรวจสอบแคช -> เรียก Backend Proxy Server (พร้อม Exponential Backoff Retry: รอ 2, 4, 8 วินาที) -> บันทึกผลลัพธ์ลงแคช
 */
async function processTranslationPipeline({
  base64,
  mimeType,
  buffer = null,
  hash = null,
  backendUrl,
  authToken,
  model,
  targetLang,
  maxOutputTokens = 8192,
  maxRetries = 3,
  initialDelayMs = 2000,
  onRetry = null
}) {
  if (!authToken) {
    throw new Error("กรุณาเข้าสู่ระบบหรือตั้งค่า User Auth Token ในหน้า Options ก่อน (คลิกขวาที่ไอคอนส่วนเสริม > Options)");
  }

  const finalHash = hash || (buffer ? await computeBufferHash(buffer) : await computeStringHash(base64));

  // 1. ตรวจสอบแคชใน storage
  let segments = await getCachedTranslation(finalHash, targetLang, model);

  if (segments) {
    console.log("[Gemini Image Translator] โหลดผลการแปลจาก Cache สำเร็จ:", finalHash);
    return { segments, hash: finalHash, fromCache: true };
  }

  // 2. หากไม่มีในแคช ให้เรียก Backend Proxy Server ด้วยระบบ Exponential Backoff Retry (รอ 2, 4, 8 วินาทีตามลำดับ)
  segments = await callWithRetry(
    () =>
      callBackendTranslateProxy({
        backendUrl: backendUrl || "http://127.0.0.1:8000",
        authToken,
        model,
        base64,
        mimeType,
        targetLang,
        maxOutputTokens
      }),
    maxRetries,
    initialDelayMs,
    onRetry
  );

  // 3. บันทึกผลลงแคช
  await saveCachedTranslation(finalHash, targetLang, model, segments);

  return { segments, hash: finalHash, fromCache: false };
}

async function digestToHex(bufferOrArray) {
  const digest = await crypto.subtle.digest("SHA-256", bufferOrArray);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function computeStringHash(str) {
  try {
    const encoder = new TextEncoder();
    return await digestToHex(encoder.encode(str));
  } catch {
    return "str_hash_" + str.length;
  }
}

// ---- Cache Management in chrome.storage.local ----

async function getCachedTranslation(hash, targetLang, model) {
  try {
    const key = `cache_${hash}_${targetLang}_${model}`;
    const result = await chrome.storage.local.get([key]);
    if (result[key] && Array.isArray(result[key].segments)) {
      return result[key].segments;
    }
  } catch (e) {
    console.warn("[Gemini Image Translator] ตรวจสอบ Cache ผิดพลาด:", e);
  }
  return null;
}

async function saveCachedTranslation(hash, targetLang, model, segments) {
  try {
    const key = `cache_${hash}_${targetLang}_${model}`;
    const meta = await chrome.storage.local.get(["trans_cache_keys"]);
    let keys = meta.trans_cache_keys || [];

    // จัดการ LRU Cache เพื่อไม่ให้เกินโควต้า storage
    keys = keys.filter((k) => k !== key);
    keys.push(key);

    const toRemove = [];
    while (keys.length > MAX_CACHE_ENTRIES) {
      toRemove.push(keys.shift());
    }

    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }

    await chrome.storage.local.set({
      [key]: { segments, timestamp: Date.now() },
      trans_cache_keys: keys
    });
  } catch (e) {
    console.warn("[Gemini Image Translator] บันทึก Cache ผิดพลาด:", e);
  }
}

// ---- Helpers ----

async function fetchImageAsBase64(url) {
  let blob;
  let buffer;
  let base64;
  let mimeType;

  if (typeof url === "string" && url.startsWith("data:")) {
    mimeType = url.match(/^data:([^;]+);/)?.[1] || "image/png";
    base64 = url.replace(/^data:[^;]+;base64,/, "");
    const rawBinary = atob(base64);
    const u8 = new Uint8Array(rawBinary.length);
    for (let i = 0; i < rawBinary.length; i++) u8[i] = rawBinary.charCodeAt(i);
    buffer = u8.buffer;
    blob = new Blob([buffer], { type: mimeType });
  } else {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(`ไม่สามารถเชื่อมต่อเพื่อดาวน์โหลดรูปภาพได้ (${err.message || String(err)})`);
    }

    if (!res.ok) {
      throw new Error(`โหลดรูปภาพไม่สำเร็จ (HTTP ${res.status}): เซิร์ฟเวอร์ต้นทางปฏิเสธการเข้าถึง`);
    }

    blob = await res.blob();
    buffer = await blob.arrayBuffer();
    base64 = arrayBufferToBase64(buffer);
    mimeType = blob.type || "image/png";
  }

  const hash = await computeBufferHash(buffer);
  return { base64, mimeType, hash, blob, buffer };
}

/**
 * ตัดแบ่ง ImageBitmap ออกเป็นส่วนย่อยๆ ในแนวตั้งโดยใช้ OffscreenCanvas ภายใน Service Worker
 *
 * @param {ImageBitmap} bitmap - อ็อบเจกต์ ImageBitmap ต้นฉบับ
 * @param {number} chunkHeight - ความสูงของแต่ละ chunk (ค่าเริ่มต้น 2000px)
 * @param {number} overlap - ระยะซ้อนทับเพื่อป้องกันข้อความถูกตัดขาด (ค่าเริ่มต้น 150px)
 * @returns {Promise<Array>} - รายการ chunks พร้อม base64, mimeType, hash และพิกัด startY/endY
 */
async function sliceBitmapVerticallyInWorker(bitmap, chunkHeight = 2000, overlap = 150) {
  const fullW = bitmap.width;
  const fullH = bitmap.height;
  const step = Math.max(100, chunkHeight - overlap);
  const chunks = [];

  let startY = 0;
  let index = 0;

  while (startY < fullH) {
    const endY = Math.min(fullH, startY + chunkHeight);
    const chunkH = endY - startY;

    const offscreen = new OffscreenCanvas(fullW, chunkH);
    const ctx = offscreen.getContext("2d");
    ctx.drawImage(bitmap, 0, startY, fullW, chunkH, 0, 0, fullW, chunkH);

    const chunkBlob = await offscreen.convertToBlob({ type: "image/png" });
    const chunkBuffer = await chunkBlob.arrayBuffer();
    const chunkBase64 = arrayBufferToBase64(chunkBuffer);
    const chunkHash = await computeBufferHash(chunkBuffer);

    chunks.push({
      index,
      startY,
      endY,
      chunkH,
      fullH,
      fullW,
      base64: chunkBase64,
      mimeType: "image/png",
      hash: chunkHash
    });

    if (endY >= fullH) break;
    startY += step;
    index++;
  }

  return chunks;
}

/**
 * ปรับค่าพิกัด box_2d [ymin, xmin, ymax, xmax] ของชิ้นส่วนย่อย (chunk)
 * ให้สอดคล้องกับพิกัด 0-1000 ของภาพต้นฉบับเต็ม
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

async function computeBufferHash(buffer) {
  try {
    return await digestToHex(buffer);
  } catch {
    return "hash_" + buffer.byteLength;
  }
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---- Exponential Backoff Retry Helper ----

/**
 * ฟังก์ชัน Retry พร้อมระบบ Exponential Backoff
 * หน่วงเวลาแบบทวีคูณ เช่น เริ่ม 2 วินาที -> รอ 2, 4, 8 วินาทีตามลำดับ
 *
 * @param {Function} operation - ฟังก์ชัน asynchronous ที่ต้องการลองใหม่
 * @param {number} maxRetries - จำนวนครั้งสูงสุดที่จะลองใหม่ (ค่าเริ่มต้น: 3)
 * @param {number} initialDelayMs - เวลาหน่วงเริ่มต้นในหน่วย ms (ค่าเริ่มต้น: 2000 = 2 วินาที)
 * @param {Function|null} onRetry - callback แจ้งสถานะความคืบหน้าการลองใหม่
 */
async function callWithRetry(operation, maxRetries = 3, initialDelayMs = 2000, onRetry = null) {
  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    attempt++;
    try {
      return await operation(attempt);
    } catch (err) {
      const isRetryable = err.isRetryable === true;
      if (attempt > maxRetries || !isRetryable) {
        throw err;
      }

      // คำนวณเวลารอแบบ Exponential Backoff (2s -> 4s -> 8s) + Jitter เล็กน้อย (0-200ms)
      const jitter = Math.floor(Math.random() * 200);
      const waitTime = (err.retryAfterMs || delay) + jitter;
      const waitSec = Math.round(waitTime / 1000);

      console.warn(
        `[Gemini Image Translator] ครั้งที่ ${attempt} ล้มเหลว (${err.message}). กำลังลองใหม่อัตโนมัติ (ครั้งที่ ${attempt}/${maxRetries}) ในอีก ${waitSec} วินาที (Exponential Backoff)...`
      );

      if (typeof onRetry === "function") {
        try {
          onRetry({
            attempt,
            maxRetries,
            delayMs: waitTime,
            delaySec: waitSec,
            error: err
          });
        } catch (cbErr) {
          console.warn("[Gemini Image Translator] Error in onRetry callback:", cbErr);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, waitTime));
      delay *= 2; // เพิ่มเวลารอเป็นเท่าตัวตาม Exponential Backoff (2s -> 4s -> 8s)
    }
  }
}

// ---- Backend Proxy API Call & Error Handling ----

async function callBackendTranslateProxy({ backendUrl, authToken, model, base64, mimeType, targetLang, maxOutputTokens = 8192 }) {
  const cleanBase = backendUrl.replace(/\/+$/, "");
  const url = `${cleanBase}/api/translate`;

  const body = {
    base64,
    mimeType: mimeType || "image/png",
    targetLang: targetLang || "Thai",
    model: model || "gemini-2.0-flash",
    stream: true,
    thinking_budget: 0,
    max_output_tokens: Math.max(4096, parseInt(maxOutputTokens, 10) || 8192),
    response_schema: GEMINI_RESPONSE_SCHEMA
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`
      },
      body: JSON.stringify(body)
    });
  } catch (netErr) {
    const err = new Error(`ไม่สามารถเชื่อมต่อกับ Backend Proxy Server (${cleanBase}) ได้ กรุณาตรวจสอบว่าเซิร์ฟเวอร์เปิดทำงานอยู่หรือไม่`);
    err.isRetryable = true;
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  // หาก res.json() ล้มเหลวแต่ HTTP 200 OK ให้ลองอ่าน Text และใช้ Resilient JSON Parser ซ่อมแซม
  if (!data && res.ok) {
    try {
      const text = await res.text();
      const repaired = repairAndParseJsonInJs(text);
      if (Array.isArray(repaired)) {
        data = { success: true, segments: repaired };
      } else if (repaired && typeof repaired === "object") {
        data = repaired;
      }
    } catch (parseErr) {
      console.warn("[Gemini Image Translator] Text fallback parse error:", parseErr);
    }
  }

  if (!res.ok) {
    const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    let friendlyMsg = data?.detail;
    let isQuota = res.status === 429;

    if (friendlyMsg && typeof friendlyMsg === "object") {
      if (friendlyMsg.quota_exceeded || friendlyMsg.error_code === "GEMINI_QUOTA_EXCEEDED") {
        isQuota = true;
      }
      friendlyMsg = friendlyMsg.message || JSON.stringify(friendlyMsg);
    }

    if (!friendlyMsg) {
      friendlyMsg = `Proxy Server Error (HTTP ${res.status})`;
    }

    if (res.status === 401) {
      friendlyMsg = "User Auth Token ไม่ถูกต้องหรือหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่ในหน้า Options";
    }

    if (typeof friendlyMsg === "string" && (friendlyMsg.includes("โควต้า") || friendlyMsg.includes("Quota"))) {
      isQuota = true;
    }

    const err = new Error(friendlyMsg);
    err.isRetryable = isRetryable;
    err.status = res.status;
    err.isQuotaExceeded = isQuota;

    const retryAfter = res.headers.get("Retry-After");
    if (retryAfter) {
      const sec = parseInt(retryAfter, 10);
      if (!isNaN(sec) && sec > 0) {
        err.retryAfterMs = sec * 1000;
      }
    }
    throw err;
  }

  // ตรวจสอบและบันทึก log finishReason เพื่อความโปร่งใสในการวินิจฉัยปัญหา
  if (data?.finishReason === "MAX_TOKENS") {
    console.warn(
      `[Gemini Image Translator] ⚠️ ผลลัพธ์ถูกตัดทอนเนื่องจากชนขีดจำกัด Token (finishReason: MAX_TOKENS) แต่ระบบได้ซ่อมแซม JSON และกู้คืนข้อความเรียบร้อยแล้ว`
    );
  } else if (data?.finishReason === "SAFETY") {
    console.warn(`[Gemini Image Translator] ⚠️ Gemini API finishReason: SAFETY`);
  }

  let segments = data?.segments || [];
  // กรอง Markdown Code Blocks ออกก่อนหาก segments อยู่ในรูป JSON String
  if (typeof segments === "string") {
    try {
      segments = repairAndParseJsonInJs(segments);
    } catch {
      segments = [];
    }
  }

  return Array.isArray(segments) ? segments : [];
}

/**
 * ระบบ Resilient JSON Parser & Auto-Repair สำหรับ Chrome Extension
 * จัดการกรณี JSON จาก Gemini API ถูกตัดทอน mid-string หรือ mid-array
 */
function repairAndParseJsonInJs(rawText) {
  if (!rawText || typeof rawText !== "string") {
    return [];
  }
  let cleaned = rawText.trim();
  if (!cleaned) return [];

  // 1. กรอง Markdown Code Blocks (ทั้งแบบปิดสมบูรณ์และแบบตัดทอน)
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    cleaned = fenced[1].trim();
  } else {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }

  // 2. ค้นหาจุดเริ่มต้นของ JSON Array [ หรือ Object {
  const startArr = cleaned.indexOf("[");
  const startObj = cleaned.indexOf("{");
  let startIdx = -1;
  if (startArr !== -1 && (startObj === -1 || startArr <= startObj)) {
    startIdx = startArr;
  } else if (startObj !== -1) {
    startIdx = startObj;
  }
  if (startIdx !== -1) {
    cleaned = cleaned.substring(startIdx).trim();
  }

  // ระดับ 1: ลอง parse ตรงๆ
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return normalizeSegmentsInJs(parsed);
    } else if (parsed && typeof parsed === "object") {
      return normalizeSegmentsInJs([parsed]);
    }
  } catch (_) {}

  // ระดับ 2: ซ่อมแซมด้วย State Machine Auto-Repair
  const repaired = autoRepairJsonStringInJs(cleaned);
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired);
      if (Array.isArray(parsed)) {
        const norm = normalizeSegmentsInJs(parsed);
        if (norm.length > 0) return norm;
      } else if (parsed && typeof parsed === "object") {
        return normalizeSegmentsInJs([parsed]);
      }
    } catch (_) {}
  }

  // ระดับ 3: ตัดทอนกลับไปยัง Object Boundary ตัวสุดท้ายที่สมบูรณ์ ('}')
  const lastBrace = cleaned.lastIndexOf("}");
  if (lastBrace !== -1) {
    const trimmed = cleaned.substring(0, lastBrace + 1).trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed + "]");
        if (Array.isArray(parsed)) {
          const norm = normalizeSegmentsInJs(parsed);
          if (norm.length > 0) return norm;
        }
      } catch (_) {}
    }
  }

  // ระดับ 4: สแกนดึงเฉพาะ Object ที่สมบูรณ์
  const extracted = extractValidSegmentObjectsInJs(cleaned);
  if (extracted.length > 0) {
    return normalizeSegmentsInJs(extracted);
  }

  throw new Error("Failed to parse and repair JSON from Gemini: " + cleaned.substring(0, 100));
}

function autoRepairJsonStringInJs(s) {
  if (!s) return "[]";
  let inString = false;
  let escape = false;
  const stack = [];

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
    } else {
      if (c === '"') {
        inString = true;
      } else if (c === "{" || c === "[") {
        stack.push(c);
      } else if (c === "}") {
        if (stack.length > 0 && stack[stack.length - 1] === "{") stack.pop();
      } else if (c === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === "[") stack.pop();
      }
    }
  }

  let repaired = s;
  if (inString) {
    if (repaired.endsWith("\\")) {
      repaired = repaired.slice(0, -1);
    }
    repaired += '"';
  }

  repaired = repaired.trimEnd();

  if (repaired.endsWith(":")) {
    repaired += ' ""';
  } else if (repaired.endsWith(",")) {
    repaired = repaired.slice(0, -1).trimEnd();
  }

  // Re-check open stack
  inString = false;
  escape = false;
  const st = [];
  for (let i = 0; i < repaired.length; i++) {
    const c = repaired[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
    } else {
      if (c === '"') inString = true;
      else if (c === "{" || c === "[") st.push(c);
      else if (c === "}") { if (st.length > 0 && st[st.length - 1] === "{") st.pop(); }
      else if (c === "]") { if (st.length > 0 && st[st.length - 1] === "[") st.pop(); }
    }
  }

  let closeStr = "";
  for (let i = st.length - 1; i >= 0; i--) {
    closeStr += st[i] === "{" ? "}" : "]";
  }

  // Attempt 1: append closing brackets
  const attempt1 = repaired + closeStr;
  try {
    JSON.parse(attempt1);
    return attempt1;
  } catch (_) {}

  // Attempt 2: dangling key without value (e.g. `..., "translated_te"}`)
  const attempt2 = repaired + ': ""' + closeStr;
  try {
    JSON.parse(attempt2);
    return attempt2;
  } catch (_) {}

  // Attempt 3: trim back to the last comma before the dangling key
  const lastComma = repaired.lastIndexOf(",");
  if (lastComma !== -1) {
    const attempt3 = repaired.substring(0, lastComma).trimEnd();
    const st3 = [];
    let inS = false, esc = false;
    for (let i = 0; i < attempt3.length; i++) {
      const c = attempt3[i];
      if (inS) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inS = false;
      } else {
        if (c === '"') inS = true;
        else if (c === "{" || c === "[") st3.push(c);
        else if (c === "}") { if (st3.length > 0 && st3[st3.length - 1] === "{") st3.pop(); }
        else if (c === "]") { if (st3.length > 0 && st3[st3.length - 1] === "[") st3.pop(); }
      }
    }
    let cl3 = "";
    for (let i = st3.length - 1; i >= 0; i--) {
      cl3 += st3[i] === "{" ? "}" : "]";
    }
    const finalAttempt3 = attempt3 + cl3;
    try {
      JSON.parse(finalAttempt3);
      return finalAttempt3;
    } catch (_) {}
  }

  return attempt1;
}

function extractValidSegmentObjectsInJs(s) {
  const results = [];
  const n = s.length;
  for (let i = 0; i < n; i++) {
    if (s[i] === "{") {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < n; j++) {
        const ch = s[j];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else {
          if (ch === '"') inStr = true;
          else if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
              const candidate = s.substring(i, j + 1);
              try {
                const obj = JSON.parse(candidate);
                if (obj && typeof obj === "object" && obj.box_2d) {
                  results.push(obj);
                }
                i = j;
              } catch (_) {}
              break;
            }
          }
        }
      }
    }
  }
  return results;
}

function normalizeSegmentsInJs(data) {
  if (!Array.isArray(data)) return [];
  const normalized = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const box = item.box_2d;
    if (!Array.isArray(box) || box.length < 4) continue;
    const text = String(item.text || "").trim();
    let trans = String(item.translated_text || "").trim();
    if (!text && !trans) continue;
    if (!trans && text) trans = text;
    normalized.push({
      box_2d: box,
      text: text,
      translated_text: trans
    });
  }
  return normalized;
}
