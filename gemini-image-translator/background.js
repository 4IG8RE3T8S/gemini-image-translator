// background.js — service worker (Manifest V3)

const MENU_IMAGE_ID = "gemini-translate-image";
const MENU_BG_IMAGE_ID = "gemini-translate-bg-image";
const MENU_AREA_ID = "gemini-translate-area";
const MAX_CACHE_ENTRIES = 100;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_IMAGE_ID,
    title: "แปลภาพนี้ด้วย Gemini",
    contexts: ["image"]
  });

  chrome.contextMenus.create({
    id: MENU_BG_IMAGE_ID,
    title: "แปลภาพพื้นหลังนี้ด้วย Gemini (CSS Background)",
    contexts: ["page", "frame"]
  });

  chrome.contextMenus.create({
    id: MENU_AREA_ID,
    title: "เลือกพื้นที่หน้าจอเพื่อแปล (Capture Area)",
    contexts: ["page", "frame", "selection", "image"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  // 1. กรณีเลือกพื้นที่หน้าจอ
  if (info.menuItemId === MENU_AREA_ID) {
    chrome.tabs.sendMessage(tab.id, { type: "START_AREA_SELECTION" });
    return;
  }

  // 2. กรณีแปลรูปภาพ <img> ปกติ หรือ responsive picture
  if (info.menuItemId === MENU_IMAGE_ID && info.srcUrl) {
    await handleTranslateImageUrl(info.srcUrl, tab.id);
    return;
  }

  // 3. กรณีแปลรูปภาพจาก CSS background-image
  if (info.menuItemId === MENU_BG_IMAGE_ID) {
    chrome.tabs.sendMessage(tab.id, { type: "GET_LAST_BG_IMAGE" }, async (res) => {
      if (!res || !res.success || !res.bgUrl) {
        chrome.tabs.sendMessage(tab.id, {
          type: "SHOW_TOAST",
          message: "ไม่พบรูปภาพพื้นหลังในตำแหน่งที่คลิก (แนะนำให้ใช้ 'เลือกพื้นที่หน้าจอเพื่อแปล' หรือคลิกขวาที่แท็กรูปภาพ)",
          isError: false
        });
        return;
      }
      await handleTranslateImageUrl(res.bgUrl, tab.id);
    });
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

async function handleTranslateImageUrl(srcUrl, tabId) {
  const settings = await chrome.storage.local.get(["backendUrl", "authToken", "model", "targetLang"]);

  if (!settings.authToken) {
    safeSendTabMessage(tabId, {
      type: "IT_ERROR",
      srcUrl,
      message: "กรุณาเข้าสู่ระบบหรือตั้งค่า User Auth Token ในหน้า Options ก่อน (คลิกขวาที่ไอคอนส่วนเสริม > Options)"
    });
    return;
  }

  const backendUrl = settings.backendUrl || "http://127.0.0.1:8000";
  const targetLang = settings.targetLang || "Thai";
  const model = settings.model || "gemini-2.5-flash";

  try {
    safeSendTabMessage(tabId, { type: "IT_LOADING", srcUrl });

    // ดึงรูปและคำนวณ SHA-256 hash ของรูปภาพ
    const { base64, mimeType, hash } = await fetchImageAsBase64(srcUrl);

    // ประมวลผลผ่าน Translation Pipeline ส่งไปยัง Backend Proxy Server
    const { segments } = await processTranslationPipeline({
      base64,
      mimeType,
      hash,
      backendUrl,
      authToken: settings.authToken,
      model,
      targetLang
    });

    const dataUrl = `data:${mimeType};base64,${base64}`;

    safeSendTabMessage(tabId, {
      type: "IT_RESULT",
      srcUrl,
      base64,
      mimeType,
      dataUrl,
      segments,
      targetLang
    });
  } catch (err) {
    safeSendTabMessage(tabId, {
      type: "IT_ERROR",
      srcUrl,
      message: err.message || String(err)
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

  // ส่งข้อมูลรูปภาพที่ถูกครอปแล้ว เข้าสู่ Translation Pipeline
  if (request.type === "TRANSLATE_IMAGE_DATA") {
    (async () => {
      try {
        const settings = await chrome.storage.local.get(["backendUrl", "authToken", "model", "targetLang"]);
        const backendUrl = settings.backendUrl || "http://127.0.0.1:8000";
        const targetLang = settings.targetLang || "Thai";
        const model = settings.model || "gemini-2.5-flash";

        const { segments, fromCache } = await processTranslationPipeline({
          base64: request.base64,
          mimeType: request.mimeType || "image/png",
          backendUrl,
          authToken: settings.authToken,
          model,
          targetLang
        });

        sendResponse({
          success: true,
          segments,
          targetLang,
          fromCache
        });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message || String(err)
        });
      }
    })();
    return true;
  }
});

/**
 * Shared Translation Pipeline:
 * ตรวจสอบแคช -> เรียก Backend Proxy Server (พร้อม Exponential Backoff Retry) -> บันทึกผลลัพธ์ลงแคช
 */
async function processTranslationPipeline({ base64, mimeType, buffer = null, hash = null, backendUrl, authToken, model, targetLang }) {
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

  // 2. หากไม่มีในแคช ให้เรียก Backend Proxy Server ด้วยระบบ Retry
  segments = await callWithRetry(
    () =>
      callBackendTranslateProxy({
        backendUrl: backendUrl || "http://127.0.0.1:8000",
        authToken,
        model,
        base64,
        mimeType,
        targetLang
      }),
    3,
    1500
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
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`ไม่สามารถเชื่อมต่อเพื่อดาวน์โหลดรูปภาพได้ (${err.message || String(err)})`);
  }

  if (!res.ok) {
    throw new Error(`โหลดรูปภาพไม่สำเร็จ (HTTP ${res.status}): เซิร์ฟเวอร์ต้นทางปฏิเสธการเข้าถึง`);
  }

  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const mimeType = blob.type || "image/png";
  const hash = await computeBufferHash(buffer);

  return { base64, mimeType, hash };
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

async function callWithRetry(operation, maxRetries = 3, initialDelayMs = 1500) {
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

      // คำนวณเวลารอแบบ Exponential Backoff + Random Jitter
      const jitter = Math.floor(Math.random() * 500);
      const waitTime = (err.retryAfterMs || delay) + jitter;

      console.warn(
        `[Gemini Image Translator] ครั้งที่ ${attempt} ล้มเหลว (${err.message}). กำลังลองใหม่อัตโนมัติในอีก ${(waitTime / 1000).toFixed(1)} วินาที...`
      );

      await new Promise((resolve) => setTimeout(resolve, waitTime));
      delay *= 2; // เพิ่มเวลารอเป็นเท่าตัว (1.5s -> 3s -> 6s)
    }
  }
}

// ---- Backend Proxy API Call & Error Handling ----

async function callBackendTranslateProxy({ backendUrl, authToken, model, base64, mimeType, targetLang }) {
  const cleanBase = backendUrl.replace(/\/+$/, "");
  const url = `${cleanBase}/api/translate`;

  const body = {
    base64,
    mimeType: mimeType || "image/png",
    targetLang: targetLang || "Thai",
    model: model || "gemini-2.5-flash"
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

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    let friendlyMsg = data?.detail || `Proxy Server Error (HTTP ${res.status})`;

    if (res.status === 401) {
      friendlyMsg = "User Auth Token ไม่ถูกต้องหรือหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่ในหน้า Options";
    }

    const err = new Error(friendlyMsg);
    err.isRetryable = isRetryable;
    err.status = res.status;

    const retryAfter = res.headers.get("Retry-After");
    if (retryAfter) {
      const sec = parseInt(retryAfter, 10);
      if (!isNaN(sec) && sec > 0) {
        err.retryAfterMs = sec * 1000;
      }
    }
    throw err;
  }

  return data?.segments || [];
}
