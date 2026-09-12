const $ = (id) => document.getElementById(id);

// โหลดการตั้งค่าจาก storage
chrome.storage.local.get(["backendUrl", "authToken", "model", "targetLang"], (data) => {
  $("backendUrl").value = data.backendUrl || "http://127.0.0.1:8000";
  $("authToken").value = data.authToken || "dev-token-secret-68310545";
  $("model").value = data.model || "gemini-2.5-flash";
  $("targetLang").value = data.targetLang || "Thai";
});

// บันทึกการตั้งค่า
$("save").addEventListener("click", () => {
  const backendUrl = $("backendUrl").value.trim().replace(/\/+$/, "");
  const authToken = $("authToken").value.trim();
  const model = $("model").value.trim() || "gemini-2.5-flash";
  const targetLang = $("targetLang").value.trim() || "Thai";

  chrome.storage.local.set(
    {
      backendUrl,
      authToken,
      model,
      targetLang
    },
    () => {
      const statusEl = $("status");
      statusEl.className = "status-success";
      statusEl.textContent = "✅ บันทึกการตั้งค่าเรียบร้อยแล้ว";
      setTimeout(() => {
        statusEl.textContent = "";
        statusEl.className = "";
      }, 2500);
    }
  );
});

// ทดสอบการเชื่อมต่อกับ Backend Proxy Server
$("testConnection").addEventListener("click", async () => {
  const backendUrl = $("backendUrl").value.trim().replace(/\/+$/, "");
  const authToken = $("authToken").value.trim();
  const testStatus = $("testStatus");

  if (!backendUrl) {
    testStatus.style.color = "#d93025";
    testStatus.textContent = "❌ กรุณากรอก Backend Proxy URL";
    return;
  }

  testStatus.style.color = "#1a73e8";
  testStatus.textContent = backendUrl.includes("onrender.com")
    ? "⏳ กำลังเชื่อมต่อ... (หากเซิร์ฟเวอร์ Render กำลังหลับอยู่ อาจใช้เวลาตื่น ~30-50 วินาที)"
    : "⏳ กำลังทดสอบการเชื่อมต่อ...";

  try {
    const res = await fetch(`${backendUrl}/api/auth/verify`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${authToken}`
      }
    });

    if (res.ok) {
      testStatus.style.color = "#1e8e3e";
      testStatus.textContent = "✅ เชื่อมต่อและยืนยันตัวตนสำเร็จ!";
    } else if (res.status === 401) {
      testStatus.style.color = "#d93025";
      testStatus.textContent = "❌ Auth Token ไม่ถูกต้อง";
    } else {
      testStatus.style.color = "#d93025";
      testStatus.textContent = `❌ เซิร์ฟเวอร์ตอบกลับรหัส ${res.status}`;
    }
  } catch (err) {
    testStatus.style.color = "#d93025";
    testStatus.textContent = backendUrl.includes("onrender.com")
      ? "❌ ไม่สามารถติดต่อเซิร์ฟเวอร์ Render ได้ (ตรวจสอบ URL หรือรอเซิร์ฟเวอร์ตื่น)"
      : "❌ ไม่สามารถติดต่อเซิร์ฟเวอร์ได้ (เปิดรันหรือยัง?)";
  }

  setTimeout(() => {
    testStatus.textContent = "";
  }, 4000);
});

// Quick Login ขอรับ Token อัตโนมัติ
$("loginBtn").addEventListener("click", async () => {
  const backendUrl = $("backendUrl").value.trim().replace(/\/+$/, "");
  const username = $("loginUser").value.trim();
  const password = $("loginPass").value.trim();
  const loginStatus = $("loginStatus");

  if (!username || !password) {
    loginStatus.style.color = "#d93025";
    loginStatus.textContent = "กรุณากรอกทั้งชื่อผู้ใช้และรหัสผ่าน";
    return;
  }

  loginStatus.style.color = "#1a73e8";
  loginStatus.textContent = "กำลังเข้าสู่ระบบ...";

  try {
    const res = await fetch(`${backendUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (res.ok && data.token) {
      $("authToken").value = data.token;
      loginStatus.style.color = "#1e8e3e";
      loginStatus.textContent = `✅ เข้าสู่ระบบสำเร็จในชื่อ "${data.username}"`;
      
      // บันทึกลง storage ให้อัตโนมัติ
      chrome.storage.local.set({ authToken: data.token, backendUrl });
    } else {
      loginStatus.style.color = "#d93025";
      loginStatus.textContent = data.detail || "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง";
    }
  } catch (err) {
    loginStatus.style.color = "#d93025";
    loginStatus.textContent = "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้";
  }
});

// จัดการ Cache
function updateCacheInfo() {
  chrome.storage.local.get(["trans_cache_keys"], (data) => {
    const count = (data.trans_cache_keys || []).length;
    $("cacheInfo").textContent = `มีผลแปลที่บันทึกในแคชแล้ว ${count} รายการ`;
  });
}
updateCacheInfo();

$("clearCache").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(["trans_cache_keys"]);
  const keys = data.trans_cache_keys || [];
  if (keys.length > 0) {
    await chrome.storage.local.remove(keys);
  }
  await chrome.storage.local.remove(["trans_cache_keys"]);
  updateCacheInfo();
  
  const statusEl = $("status");
  statusEl.className = "status-success";
  statusEl.textContent = "ล้างแคชผลแปลเรียบร้อยแล้ว";
  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "";
  }, 2000);
});
