document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// จัดการสลับสไตล์พื้นหลังข้อความแปลแบบรวดเร็วใน Popup
const textBgModeSelect = document.getElementById("textBackgroundModePopup");
if (textBgModeSelect) {
  // โหลดค่าปัจจุบันจาก storage (sync ก่อนแล้ว fallback local)
  const initMode = (mode) => {
    if (mode && textBgModeSelect) {
      textBgModeSelect.value = mode;
    }
  };

  chrome.storage.local.get(["textBackgroundMode", "textBgMode"], (localData) => {
    const currentLocal = localData?.textBackgroundMode || localData?.textBgMode || "blur";
    initMode(currentLocal);

    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(["textBackgroundMode"], (syncData) => {
        if (syncData && syncData.textBackgroundMode) {
          initMode(syncData.textBackgroundMode);
        }
      });
    }
  });

  textBgModeSelect.addEventListener("change", () => {
    const chosenMode = textBgModeSelect.value || "blur";
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ textBackgroundMode: chosenMode });
    }
    chrome.storage.local.set({
      textBackgroundMode: chosenMode,
      textBgMode: chosenMode
    });
  });
}

document.getElementById("captureAreaBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "START_AREA_SELECTION" });
      window.close();
    } catch {
      showPopupError("ไม่สามารถใช้งานในหน้านี้ได้ (ลองเปิดเว็บไซต์ปกติก่อน)");
    }
  }
});

document.getElementById("captureAreaGtBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "START_AREA_SELECTION_GT" });
      window.close();
    } catch {
      showPopupError("ไม่สามารถใช้งานในหน้านี้ได้ (ลองเปิดเว็บไซต์ปกติก่อน)");
    }
  }
});

const openCollectorBtn = document.getElementById("openCollectorBtn");
if (openCollectorBtn) {
  openCollectorBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_IMAGE_COLLECTOR" });
        window.close();
      } catch {
        showPopupError("ไม่สามารถเปิด Sidebar ในหน้านี้ได้ (ลองรีเฟรชหน้าเว็บก่อน)");
      }
    }
  });
}

document.getElementById("openGoogleTranslateBtn").addEventListener("click", async () => {
  const settings = await chrome.storage.local.get(["targetLang", "googleTranslateLangCode"]);
  const langCode = settings.googleTranslateLangCode || "th";
  chrome.runtime.sendMessage({
    type: "OPEN_GOOGLE_TRANSLATE_TAB",
    targetLangCode: langCode
  });
  window.close();
});

/**
 * แสดงข้อความแจ้งเตือนภายใน Popup เมื่อ Content Script ไม่สามารถทำงานได้
 * (เช่น ในหน้า chrome://, about:blank, chrome-extension://)
 */
function showPopupError(message) {
  let errorEl = document.getElementById("popup-error");
  if (!errorEl) {
    errorEl = document.createElement("div");
    errorEl.id = "popup-error";
    errorEl.style.cssText = `
      background: #fce8e6;
      color: #d93025;
      font-size: 12px;
      padding: 8px 10px;
      border-radius: 4px;
      margin-top: 8px;
      line-height: 1.4;
    `;
    document.body.appendChild(errorEl);
  }
  errorEl.textContent = message;
  setTimeout(() => {
    if (errorEl.parentNode) errorEl.remove();
  }, 4000);
}
