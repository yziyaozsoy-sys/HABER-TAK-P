const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // --- Mevcut fonksiyonlar ---
  fetchRSS: (url) => ipcRenderer.invoke("fetch-rss", url),
  fetchSource: (source) => ipcRenderer.invoke("fetch-source", source),
  getSources: () => ipcRenderer.invoke("get-sources"),
  addSource: (payload) => ipcRenderer.invoke("add-source", payload),
  removeSource: (payload) => ipcRenderer.invoke("remove-source", payload),
  updateSource: (payload) => ipcRenderer.invoke("update-source", payload),

  // --- OZELLIK 3: Bildirim ---
  showNotification: (payload) => ipcRenderer.invoke("show-notification", payload),

  // ✅ YENİ: Arka plan takip sistemi için kelime senkronizasyonu
  syncTrackedKeywords: (payload) => ipcRenderer.invoke("sync-tracked-keywords", payload),

  // --- OZELLIK 6: Disa aktarma ---
  exportNews: (payload) => ipcRenderer.invoke("export-news", payload),

  // --- OZELLIK 7: Tepsiden "Simdi Yenile" sinyali ---
  onTrayRefresh: (callback) => {
    ipcRenderer.on("tray-refresh", () => callback());
  },

    // --- YENİ: Özet (spot) canlı güncelleme ---
  onDescriptionUpdated: (callback) => {
    ipcRenderer.on("description-updated", (event, data) => {
      callback(data);
    });
  },

  // --- YENİ: Uygulama versiyonu ---
  getAppVersion: () => ipcRenderer.invoke("get-app-version")
});

